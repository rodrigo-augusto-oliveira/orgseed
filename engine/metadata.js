'use strict';
/**
 * Cópia de metadados entre orgs usando o Salesforce CLI:
 *   - listar tipos e componentes (com indicação se já existem no destino);
 *   - baixar da origem (project retrieve start) e implantar/validar no destino (project deploy start).
 */
const fs = require('fs');
const path = require('path');
const sfcli = require('./sf-cli');
const engine = require('./engine');

const deps = { runSf: sfcli.runSf, describeRaw: engine.describeRaw, fieldDefinitionNames: engine.fieldDefinitionNames };
function _setDeps(d) { Object.assign(deps, d); }

const LIST_TIMEOUT = 5 * 60 * 1000;
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const isManaged = (state) => state === 'installed' || state === 'installedEditable' || state === 'deprecated' || state === 'deprecatedEditable';

function checkRef(ref) {
  if (!sfcli.ORG_REF.test(ref || '')) throw new Error(`Org inválida: "${ref}"`);
}

// ---------------------------------------------------------------- listagens (com cache)
const cache = new Map();
async function cached(key, refresh, fn) {
  if (!refresh && cache.has(key)) return cache.get(key);
  const p = fn();
  cache.set(key, p);
  try { return await p; } catch (e) { cache.delete(key); throw e; }
}
function clearCache() { cache.clear(); }

async function listTypes(ref, { refresh } = {}) {
  checkRef(ref);
  return cached(`types|${ref}`, refresh, async () => {
    const r = await deps.runSf(['org', 'list', 'metadata-types', '--target-org', ref], { timeout: LIST_TIMEOUT });
    const out = new Map();
    for (const t of asArray(r && r.metadataObjects)) {
      out.set(t.xmlName, { name: t.xmlName, inFolder: !!t.inFolder, parent: null });
      for (const c of asArray(t.childXmlNames)) if (!out.has(c)) out.set(c, { name: c, inFolder: false, parent: t.xmlName });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}

async function listRaw(ref, type, refresh) {
  checkRef(ref);
  if (!/^\w+$/.test(type || '')) throw new Error(`Tipo de metadado inválido: "${type}"`);
  return cached(`list|${ref}|${type}`, refresh, async () => {
    const r = await deps.runSf(['org', 'list', 'metadata', '--metadata-type', type, '--target-org', ref], { timeout: LIST_TIMEOUT });
    return asArray(r).filter((x) => x && x.fullName);
  });
}

/** Componentes de um tipo na origem, marcando se já existem no destino. */
async function compareComponents(source, target, type, { refresh } = {}) {
  const [s, t] = await Promise.allSettled([listRaw(source, type, refresh), listRaw(target, type, refresh)]);
  if (s.status === 'rejected') throw s.reason;
  const inTarget = t.status === 'fulfilled' ? new Set(t.value.map((x) => x.fullName)) : null;
  const items = s.value
    .map((x) => ({
      type: x.type || type,
      fullName: x.fullName,
      managed: isManaged(x.manageableState),
      namespace: x.namespacePrefix || '',
      lastModified: x.lastModifiedDate || '',
      lastModifiedBy: x.lastModifiedByName || '',
      exists: inTarget ? inTarget.has(x.fullName) : null,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { items, targetError: t.status === 'rejected' ? t.reason.message : null };
}

/** Campos personalizados de um objeto na origem, marcando se já existem no destino. */
async function compareFields(source, target, object, { apiVersion, refresh } = {}) {
  if (!/^\w+$/.test(object || '')) throw new Error(`Objeto inválido: "${object}"`);
  if (refresh) engine.clearSchemaCache();
  const [s, t] = await Promise.allSettled([deps.describeRaw(source, object, apiVersion), deps.describeRaw(target, object, apiVersion)]);
  if (s.status === 'rejected') throw new Error(`Não consegui ler ${object} na origem: ${s.reason.message}`);
  let objectInTarget = null;
  let targetFields = null;
  if (t.status === 'fulfilled') { objectInTarget = true; targetFields = new Set(t.value.fields.map((f) => f.name)); }
  else if (/-> 404|NOT_FOUND/.test(t.reason.message)) objectInTarget = false;
  // O describe só traz os campos que o usuário lê (FLS): campo que chegou pelo pacote pode não aparecer nele.
  // O FieldDefinition traz todos. Sem linhas ou com erro, vale só o describe; objeto ausente nem consulta.
  if (objectInTarget !== false) {
    const defs = await deps.fieldDefinitionNames(target, object, apiVersion).catch(() => new Set());
    if (defs.size) targetFields = new Set([...(targetFields || []), ...defs]);
  }
  const fields = s.value.fields
    .filter((f) => f.custom)
    .map((f) => ({
      type: 'CustomField',
      fullName: `${object}.${f.name}`,
      name: f.name,
      label: f.label,
      fieldType: f.calculated ? `fórmula (${f.type})` : f.type,
      managed: /^[A-Za-z0-9]+__\w+__c$/.test(f.name),
      exists: objectInTarget === false ? false : targetFields ? targetFields.has(f.name) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { object, objectInTarget, fields };
}

// ---------------------------------------------------------------- package.xml
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildPackageXml(members, apiVersion) {
  const byType = new Map();
  for (const m of members) {
    if (!byType.has(m.type)) byType.set(m.type, new Set());
    byType.get(m.type).add(m.fullName);
  }
  const types = [...byType.keys()].sort().map((t) =>
    `    <types>\n${[...byType.get(t)].sort().map((n) => `        <members>${xmlEscape(n)}</members>`).join('\n')}\n        <name>${xmlEscape(t)}</name>\n    </types>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types.join('\n')}\n    <version>${apiVersion}</version>\n</Package>\n`;
}

// ---------------------------------------------------------------- baixar + implantar
const TEST_LEVELS = new Set(['NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg']);

async function transfer(opts) {
  const { source, target, members, dryRun, testLevel, workDir } = opts;
  const apiVersion = String(opts.apiVersion || '61.0');
  const emit = opts.onEvent || (() => {});
  const phase = (name) => emit({ type: 'phase', name });
  const log = (msg, level = 'info') => emit({ type: 'log', level, msg });

  checkRef(source); checkRef(target);
  if (source === target) throw new Error('Origem e destino são a mesma org.');
  if (!Array.isArray(members) || !members.length) throw new Error('Selecione ao menos um componente.');
  for (const m of members) {
    if (!/^\w+$/.test(m.type || '') || !m.fullName) throw new Error(`Componente inválido: ${JSON.stringify(m)}`);
  }
  if (testLevel && !TEST_LEVELS.has(testLevel)) throw new Error(`Nível de testes inválido: ${testLevel}`);
  if (!/^\d+\.\d$/.test(apiVersion)) throw new Error('Versão da API inválida.');
  if (!workDir) throw new Error('Pasta de trabalho não informada.');

  fs.mkdirSync(path.join(workDir, 'force-app'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'sfdx-project.json'), JSON.stringify({
    packageDirectories: [{ path: 'force-app', default: true }],
    name: 'orgseed-metadata',
    sourceApiVersion: apiVersion,
  }, null, 2));
  fs.writeFileSync(path.join(workDir, 'package.xml'), buildPackageXml(members, apiVersion));
  log(`${members.length} componente(s) no pacote. Pasta de trabalho: ${workDir}`);

  // 1. Baixar da origem
  phase(`Baixando metadados de ${source}`);
  const ret = await deps.runSf(['project', 'retrieve', 'start', '--target-org', source, '--manifest', 'package.xml'],
    { cwd: workDir, timeout: 30 * 60 * 1000, raw: true });
  if (ret.status !== 0) throw new Error(`Falha ao baixar da origem: ${ret.message || 'erro desconhecido'}`);
  const rFiles = asArray(ret.result && ret.result.files);
  const retrieveErrors = rFiles.filter((f) => f.state === 'Failed').map((f) => ({ type: f.type, fullName: f.fullName, problem: f.error || 'Falha ao baixar' }));
  const got = new Set(rFiles.filter((f) => f.state !== 'Failed').map((f) => `${f.type}:${f.fullName}`));
  const missing = members.filter((m) => !got.has(`${m.type}:${m.fullName}`))
    .map((m) => ({ type: m.type, fullName: m.fullName, problem: 'Não encontrado na origem (não foi baixado)' }));
  for (const w of asArray(ret.warnings)) log(typeof w === 'string' ? w : JSON.stringify(w), 'warn');
  for (const m of asArray(ret.result && ret.result.messages)) log(m.problem || JSON.stringify(m), 'warn');
  log(`${rFiles.length - retrieveErrors.length} arquivo(s) baixado(s).`);
  if (!got.size) {
    const summary = { type: 'summary', dryRun: !!dryRun, success: false, stage: 'retrieve', errors: [...retrieveErrors, ...missing], successes: [], workDir };
    emit(summary);
    return summary;
  }

  // 2. Implantar ou validar no destino
  phase(dryRun ? `Validando em ${target} (nada será gravado)` : `Implantando em ${target}`);
  const args = ['project', 'deploy', 'start', '--target-org', target, '--manifest', 'package.xml', '--wait', '120'];
  if (dryRun) args.push('--dry-run');
  if (testLevel) args.push('--test-level', testLevel);
  const dep = await deps.runSf(args, { cwd: workDir, timeout: 125 * 60 * 1000, raw: true });

  const res = dep.result || dep.data || {};
  const det = res.details || {};
  let errors = asArray(det.componentFailures).map((f) => ({
    type: f.componentType, fullName: f.fullName, problem: f.problem, line: f.lineNumber || null,
  }));
  if (!errors.length) {
    errors = asArray(res.files).filter((f) => f.state === 'Failed').map((f) => ({
      type: f.type, fullName: f.fullName, problem: f.error || f.problem || 'Falha', line: f.lineNumber || null,
    }));
  }
  const tests = det.runTestResult || {};
  for (const t of asArray(tests.failures)) {
    errors.push({ type: 'Teste Apex', fullName: `${t.name}.${t.methodName}`, problem: t.message, line: null });
  }
  for (const c of asArray(tests.codeCoverageWarnings)) {
    errors.push({ type: 'Cobertura', fullName: c.name || '', problem: c.message, line: null });
  }
  const successes = asArray(det.componentSuccesses)
    .filter((s) => s.fullName && s.fullName !== 'package.xml' && s.componentType)
    .map((s) => ({ type: s.componentType, fullName: s.fullName, change: s.created === 'true' || s.created === true ? 'criado' : s.changed === 'true' || s.changed === true ? 'alterado' : 'sem mudança' }));
  const success = dep.status === 0 && res.success !== false && !errors.length;
  if (!success && !errors.length) errors.push({ type: '', fullName: '', problem: dep.message || res.errorMessage || 'Falha na implantação', line: null });

  const summary = {
    type: 'summary',
    dryRun: !!dryRun,
    success,
    stage: 'deploy',
    deployId: res.id || null,
    errors: [...missing, ...retrieveErrors, ...errors],
    successes,
    workDir,
  };
  fs.writeFileSync(path.join(workDir, 'resultado.json'), JSON.stringify({ request: { source, target, members, dryRun, testLevel, apiVersion }, retrieve: ret, deploy: dep }, null, 2));
  emit(summary);
  return summary;
}

module.exports = { listTypes, compareComponents, compareFields, transfer, buildPackageXml, clearCache, _setDeps };
