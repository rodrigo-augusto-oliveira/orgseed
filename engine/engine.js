'use strict';
/**
 * Motor do OrgSeed: coleta registros raiz, filhos e pais na org de origem
 * e recria tudo na org de destino via Composite Graph API.
 *
 * Usado pela interface (Electron) e pela linha de comando (cli.js).
 */
const fs = require('fs');
const path = require('path');
const sfcli = require('./sf-cli');

const DEFAULTS = {
  apiVersion: '61.0',
  maxParentDepth: 3,
  maxGraphNodes: 500,
  children: {},
  copyObjects: [],
  matchBy: {},
  linkOnly: {},
  sourceIdField: {},
  skipFields: {},
  reuseExisting: true,
  skipAlreadyCopied: true,
  updateExisting: true,
  autoExternalId: true,
};
const NON_COPYABLE_TYPES = new Set(['address', 'location', 'base64']);
const UNQUOTED = new Set(['boolean', 'int', 'double', 'currency', 'percent', 'date', 'datetime', 'time', 'long']);
const NUMERICOS = new Set(['double', 'int', 'long', 'currency', 'percent']);
// Tipos de um campo só que podem ser buscados em bloco (IN). Texto, data e número: a chave é igual à do SOQL.
const LOTE_TIPOS = new Set(['string', 'id', 'phone', 'url', 'picklist', 'date', ...NUMERICOS]);
// Tratados à parte (e-mail de User, DeveloperName de RecordType): ficam fora da ligação automática pelo ID externo
const SEM_LIGACAO_AUTO = new Set(['User', 'RecordType']);

// ---------------------------------------------------------------- chaves de reaproveitamento
/**
 * Formatos aceitos: "Campo" (texto solto = uma regra), ["A", "B"] (um conjunto, formato antigo),
 * [["A"], "B"] e [["A"], ["B", "C"]] (regras em ordem; item texto = regra de 1 campo).
 * Sufixo "?" = campo opcional. Devolve sempre [[campo, ...], ...] sem vazios.
 */
function matchKeysError(value) {
  if (typeof value === 'string') return null;
  if (!Array.isArray(value)) return 'valor deve ser texto ou lista';
  const ok = value.every((x) => typeof x === 'string' || (Array.isArray(x) && x.every((y) => typeof y === 'string')));
  return ok ? null : 'regra inválida: use texto ou lista de textos';
}

function normalizeMatchKeys(value) {
  if (matchKeysError(value)) return [];
  let sets;
  if (typeof value === 'string') sets = [[value]];
  else if (value.some(Array.isArray)) sets = value.map((x) => (Array.isArray(x) ? x : [x]));
  else sets = [value];
  return sets
    .map((set) => set.map((k) => String(k).trim()).filter(Boolean))
    .filter((set) => set.length);
}

/** Remove o sufixo "?" e diz se o campo é opcional. */
const parseKey = (k) => (k.endsWith('?') ? { name: k.slice(0, -1), optional: true } : { name: k, optional: false });

/** E-mail de sandbox: o Salesforce acrescenta ".invalid" ao final. */
const normEmail = (v) => String(v || '').trim().toLowerCase().replace(/\.invalid$/, '');

/** Em User, com mais de um candidato, vale o único ativo. Consulta truncada no limite não basta para decidir. */
function pickActive(sobject, rows, truncated = false) {
  if (sobject !== 'User' || rows.length < 2 || truncated) return rows;
  const active = rows.filter((r) => r.IsActive === true);
  return active.length === 1 ? active : rows;
}

/** Vazio: nulo, indefinido ou só espaços. */
const vazio = (v) => v === null || v === undefined || String(v).trim() === '';

/** Chave de agrupamento do valor na consulta em bloco: texto sem diferença de caixa (como o "=" do SOQL), número pelo valor. */
const chaveLote = (tipo, v) => (NUMERICOS.has(tipo) ? String(Number(v)) : String(v).toLowerCase());

/**
 * Campo de ID externo em que o registro do destino tem valor diferente do da origem (null se não há).
 * ID externo diferente é outro registro. Vazio de qualquer lado não conflita.
 * Compara sem espaços nas pontas; sem diferença de caixa quando o campo não é sensível.
 */
function extIdConflict(data, row, extIds) {
  const norm = (f, v) => (f.caseSensitive === false ? v.trim().toLowerCase() : v.trim());
  for (const f of extIds) {
    const a = data[f.name], b = row[f.name];
    if (vazio(a) || vazio(b)) continue;
    if (norm(f, String(a)) !== norm(f, String(b))) return { campo: f.name, origem: String(a).trim(), destino: String(b).trim() };
  }
  return null;
}

/**
 * Lê os logs de execução reais (não simulação) de logDir para o mesmo par origem/destino.
 * Devolve Map(idOrigem -> { targetId, finishedAt }), ficando com o registro mais recente.
 */
function loadCopyHistory(logDir, source, target) {
  const out = new Map();
  if (!logDir || !fs.existsSync(logDir)) return out;
  const files = fs.readdirSync(logDir).filter((f) => /^(orgseed|sf-graph-copy)-.*\.json$/.test(f) && !f.includes('simulacao'));
  for (const f of files) {
    let log;
    try { log = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8')); } catch { continue; }
    if (!log || log.dryRun === true || log.source !== source || log.target !== target || !log.idMap) continue;
    const finishedAt = log.finishedAt || '';
    for (const [src, tgt] of Object.entries(log.idMap)) {
      if (typeof tgt !== 'string' || tgt.startsWith('DRYRUN_')) continue;
      const prev = out.get(src);
      if (!prev || finishedAt > prev.finishedAt) out.set(src, { targetId: tgt, finishedAt });
    }
  }
  return out;
}

/** dd/mm/aaaa a partir de um ISO (vazio se inválido). */
function fmtData(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ---------------------------------------------------------------- config
function normalizeConfig(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  c.root = { ...((cfg && cfg.root) || {}) };
  if (typeof c.root.ids === 'string') c.root.ids = c.root.ids.split(/[\s,;]+/);
  c.root.ids = (c.root.ids || []).map((s) => String(s).trim()).filter(Boolean);
  c.root.where = String(c.root.where || '').trim().replace(/^where\s+/i, '');
  c.apiVersion = String(c.apiVersion);
  c.maxParentDepth = Number(c.maxParentDepth);
  c.maxGraphNodes = Number(c.maxGraphNodes);
  return c;
}

function validateConfig(c) {
  const e = [];
  if (!c.source) e.push('Escolha a org de origem.');
  if (!c.target) e.push('Escolha a org de destino.');
  if (c.source && c.source === c.target) e.push('Origem e destino são a mesma org.');
  if (!c.root.sobject) e.push('Informe o objeto raiz.');
  else if (!/^\w+$/.test(c.root.sobject)) e.push('Nome de objeto raiz inválido.');
  if (!c.root.ids.length && !c.root.where) e.push('Informe IDs ou um filtro WHERE para os registros raiz.');
  const bad = c.root.ids.filter((id) => !/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id));
  if (bad.length) e.push(`IDs inválidos: ${bad.slice(0, 5).join(', ')}`);
  if (/^\s*select\b/i.test(c.root.where)) e.push('No filtro, use só a cláusula WHERE (sem SELECT ... FROM).');
  if (!/^\d+\.\d$/.test(c.apiVersion)) e.push('Versão da API inválida (ex.: 61.0).');
  if (!(c.maxParentDepth >= 0)) e.push('Profundidade de pais inválida.');
  if (!(c.maxGraphNodes > 0 && c.maxGraphNodes <= 500)) e.push('Limite de nós por graph deve ser entre 1 e 500.');
  for (const o of Object.keys(c.linkOnly || {})) {
    if ((c.copyObjects || []).includes(o)) e.push(`${o} está em 'Objetos que podem ser criados' e em 'Objetos só para ligar'. Escolha um.`);
  }
  for (const [kind, map] of [['matchBy', c.matchBy], ['Objetos só para ligar', c.linkOnly]]) {
    for (const o of Object.keys(map || {})) {
      if (matchKeysError(map[o])) e.push(`${kind} de ${o}: formato inválido. Use ["Campo"] ou [["Campo1"], ["Campo2"]].`);
    }
  }
  return e;
}

// ---------------------------------------------------------------- cliente REST
function createClient(conn, { apiVersion, fetchImpl, connect }) {
  const V = `/services/data/v${apiVersion}`;
  const org = { ...conn, V, describes: {}, global: null, reconnecting: null };

  // Pega um token novo. Requisições 401 ao mesmo tempo dividem um único connect.
  const reconnect = (usedToken) => {
    if (org.token !== usedToken) return Promise.resolve(); // outra chamada já renovou
    org.reconnecting ||= connect(org.alias)
      .then((novo) => Object.assign(org, novo))
      .finally(() => { org.reconnecting = null; });
    return org.reconnecting;
  };

  org.api = async (method, p, body) => {
    for (let attempt = 0; ; attempt++) {
      const url = p.startsWith('http') ? p : org.instanceUrl + p;
      const token = org.token;
      const res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status === 401 && attempt === 0) {
        await reconnect(token); // token expirado: pega um novo
        continue;
      }
      if (res.status === 401) throw new Error(`A sessão da org "${org.alias}" expirou (${method} ${p.split('?')[0]} -> 401). Refaça o login: sf org login web -a ${org.alias}`);
      if (!res.ok) throw new Error(`[${org.alias}] ${method} ${p.split('?')[0]} -> ${res.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    }
  };

  org.query = async (soql) => {
    let r = await org.api('GET', `${V}/query?q=${encodeURIComponent(soql)}`);
    const out = [...r.records];
    while (!r.done) {
      r = await org.api('GET', r.nextRecordsUrl);
      out.push(...r.records);
    }
    return out.map((rec) => { const o = { ...rec }; delete o.attributes; return o; });
  };

  org.describe = async (sobject) => {
    if (!org.describes[sobject]) org.describes[sobject] = await org.api('GET', `${V}/sobjects/${sobject}/describe`);
    return org.describes[sobject];
  };

  org.describeGlobal = async () => {
    if (!org.global) org.global = await org.api('GET', `${V}/sobjects`);
    return org.global;
  };

  return org;
}

// ---------------------------------------------------------------- consultas de esquema (para a interface)
const schemaClients = new Map();
async function schemaClient(ref, apiVersion = DEFAULTS.apiVersion) {
  const key = `${ref}|${apiVersion}`;
  if (!schemaClients.has(key)) {
    const conn = await sfcli.connectOrg(ref);
    schemaClients.set(key, createClient(conn, { apiVersion, fetchImpl: globalThis.fetch, connect: sfcli.connectOrg }));
  }
  return schemaClients.get(key);
}
function clearSchemaCache() { schemaClients.clear(); }

async function listObjects(ref, apiVersion) {
  const org = await schemaClient(ref, apiVersion);
  const g = await org.describeGlobal();
  return g.sobjects
    .filter((s) => s.queryable && s.createable)
    .map((s) => ({ name: s.name, label: s.label, custom: s.custom }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function describeObject(ref, sobject, apiVersion) {
  const org = await schemaClient(ref, apiVersion);
  const d = await org.describe(sobject);
  return {
    name: d.name,
    label: d.label,
    children: d.childRelationships
      .filter((r) => r.relationshipName)
      .map((r) => ({ relationshipName: r.relationshipName, childSObject: r.childSObject, field: r.field, cascadeDelete: r.cascadeDelete }))
      .sort((a, b) => a.relationshipName.localeCompare(b.relationshipName)),
    parents: d.fields
      .filter((f) => f.type === 'reference' && f.createable)
      .map((f) => ({ field: f.name, referenceTo: f.referenceTo, required: !f.nillable && !f.defaultedOnCreate })),
  };
}

async function describeRaw(ref, sobject, apiVersion) {
  const org = await schemaClient(ref, apiVersion);
  return org.describe(sobject);
}

/** Nomes dos campos de um objeto pelo FieldDefinition (Tooling API). Ao contrário do describe, não depende de FLS. */
async function fieldDefinitionNames(ref, sobject, apiVersion) {
  const org = await schemaClient(ref, apiVersion);
  const soql = `SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${sobject}'`;
  let r = await org.api('GET', `${org.V}/tooling/query?q=${encodeURIComponent(soql)}`);
  const names = new Set(r.records.map((f) => f.QualifiedApiName));
  while (!r.done) {
    r = await org.api('GET', r.nextRecordsUrl);
    r.records.forEach((f) => names.add(f.QualifiedApiName));
  }
  return names;
}

// ---------------------------------------------------------------- execução
async function run(cfgIn, opts = {}) {
  const CFG = normalizeConfig(cfgIn);
  const errs = validateConfig(CFG);
  if (errs.length) throw new Error(errs.join('\n'));

  const emit = opts.onEvent || (() => {});
  const log = (msg, level = 'info') => emit({ type: 'log', level, msg });
  const phase = (name) => emit({ type: 'phase', name });
  const checkAbort = () => { if (opts.signal && opts.signal.aborted) throw new Error('Execução cancelada.'); };

  const DRY = !!opts.dryRun;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const connect = opts.connect || sfcli.connectOrg;
  const COPY = new Set(CFG.copyObjects);
  const LINK = new Set(Object.keys(CFG.linkOnly || {}));
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const soqlLiteral = (v, type) => (UNQUOTED.has(type) ? String(v) : q(v));
  const chunks = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
  const refId = (sourceId) => `r_${sourceId}`;
  const isSkipped = (sobject, field) =>
    (CFG.skipFields['*'] || []).includes(field) || (CFG.skipFields[sobject] || []).includes(field);
  const warnings = new Map();
  const warn = (key) => warnings.set(key, (warnings.get(key) || 0) + 1);

  log(`Origem: ${CFG.source} → Destino: ${CFG.target}${DRY ? ' (simulação)' : ''}`);
  phase('Conectando nas orgs');
  const src = createClient(await connect(CFG.source), { apiVersion: CFG.apiVersion, fetchImpl, connect });
  const tgt = createClient(await connect(CFG.target), { apiVersion: CFG.apiVersion, fetchImpl, connect });
  const V = src.V;

  const prefixes = {};
  for (const s of (await src.describeGlobal()).sobjects) if (s.keyPrefix) prefixes[s.keyPrefix] = s.name;
  const typeOf = (id) => prefixes[String(id).slice(0, 3)];

  const idMap = new Map(); // id origem -> id destino
  const reusedIds = new Set(); // ids origem que já existiam no destino (matchBy)

  // Price Book padrão: nunca é criado, sempre mapeado para o padrão do destino
  const [srcStd] = await src.query('SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1').catch(() => []);
  const [tgtStd] = await tgt.query('SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1').catch(() => []);
  if (srcStd && tgtStd) idMap.set(srcStd.Id, tgtStd.Id);
  if (srcStd && !tgtStd) log('A org destino não tem Price Book padrão. Ative Produtos/Price Books no destino.', 'warn');

  // ---------------- 1. Coleta
  phase('Coletando registros na origem');
  const store = new Map();
  const linkNeed = {}; // tipo só para ligar -> Set de ids de origem
  let fresh = [];

  const selectFields = async (sobject) => {
    const d = await src.describe(sobject);
    const f = d.fields.filter((x) => x.createable && !NON_COPYABLE_TYPES.has(x.type)).map((x) => x.name);
    return [...new Set(['Id', ...f])];
  };
  const fetchWhere = async (sobject, where) =>
    src.query(`SELECT ${(await selectFields(sobject)).join(', ')} FROM ${sobject} WHERE ${where}`);
  const fetchIn = async (sobject, field, values) => {
    const out = [];
    for (const c of chunks([...values], 100)) {
      checkAbort();
      out.push(...(await fetchWhere(sobject, `${field} IN (${c.map(q).join(',')})`)));
    }
    return out;
  };

  function add(sobject, rec, depth, expand, from) {
    if (idMap.has(rec.Id) && !store.has(rec.Id)) return;
    const ex = store.get(rec.Id);
    if (ex) {
      if (expand && !ex.expand) { ex.expand = true; fresh.push(ex); }
      if (from && !ex.from) ex.from = from;
      return;
    }
    const n = { id: rec.Id, sobject, data: rec, depth, expand, from };
    store.set(rec.Id, n);
    fresh.push(n);
  }

  const rootWhere = CFG.root.ids.length ? `Id IN (${CFG.root.ids.map(q).join(',')})` : CFG.root.where;
  const limit = CFG.root.limit ? ` LIMIT ${Number(CFG.root.limit)}` : '';
  const roots = await src.query(
    `SELECT ${(await selectFields(CFG.root.sobject)).join(', ')} FROM ${CFG.root.sobject} WHERE ${rootWhere}${limit}`
  );
  if (!roots.length) {
    log('Nenhum registro raiz encontrado na origem.', 'warn');
    const empty = { dryRun: DRY, roots: 0, perObject: {}, reused: 0, linked: 0, updated: 0, unchanged: 0, created: 0, failedGraphs: 0, warnings: {}, logFile: null };
    emit({ type: 'summary', ...empty });
    return empty;
  }
  log(`${roots.length} registro(s) raiz encontrados em ${CFG.root.sobject}.`);
  const rootIds = roots.map((r) => r.Id);
  roots.forEach((r) => add(CFG.root.sobject, r, 0, true, null));

  while (fresh.length) {
    checkAbort();
    const batch = fresh;
    fresh = [];

    const bySobject = {};
    for (const n of batch) if (n.expand) (bySobject[n.sobject] ||= []).push(n.id);
    for (const [sobject, ids] of Object.entries(bySobject)) {
      const rels = CFG.children[sobject] || [];
      if (!rels.length) continue;
      const d = await src.describe(sobject);
      for (const relName of rels) {
        const rel = d.childRelationships.find((r) => r.relationshipName === relName);
        if (!rel) { log(`Relacionamento filho "${relName}" não existe em ${sobject}.`, 'warn'); continue; }
        const kids = await fetchIn(rel.childSObject, rel.field, ids);
        for (const k of kids) add(rel.childSObject, k, 0, true, k[rel.field]);
      }
    }

    const need = {};
    for (const n of batch) {
      const d = await src.describe(n.sobject);
      for (const f of d.fields) {
        if (f.type !== 'reference' || !f.createable || isSkipped(n.sobject, f.name)) continue;
        const v = n.data[f.name];
        if (!v || store.has(v) || idMap.has(v)) continue;
        const t = typeOf(v);
        if (LINK.has(t)) { (linkNeed[t] ||= new Set()).add(v); continue; }
        if (n.depth >= CFG.maxParentDepth || !COPY.has(t)) continue;
        (need[t] ||= new Map()).set(v, Math.min(n.depth + 1, need[t].get(v) ?? Infinity));
      }
    }
    for (const [t, m] of Object.entries(need)) {
      const recs = await fetchIn(t, 'Id', m.keys());
      for (const r of recs) add(t, r, m.get(r.Id), false, null);
    }

    const pbe = batch.filter((n) => n.sobject === 'PricebookEntry' && n.data.Pricebook2Id !== (srcStd && srcStd.Id));
    if (pbe.length) {
      const prods = [...new Set(pbe.map((n) => n.data.Product2Id))];
      for (const c of chunks(prods, 100)) {
        const std = await fetchWhere('PricebookEntry', `Pricebook2.IsStandard = true AND Product2Id IN (${c.map(q).join(',')})`);
        for (const r of std) add('PricebookEntry', r, pbe[0].depth, false, null);
      }
    }
  }
  const perObject = {};
  for (const n of store.values()) perObject[n.sobject] = (perObject[n.sobject] || 0) + 1;
  log(`Coletados: ${Object.entries(perObject).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // ---------------- 2. Ordem topológica
  const order = [];
  const state = new Map();
  for (const n of store.values()) {
    const d = await src.describe(n.sobject);
    n.refs = d.fields
      .filter((f) => f.type === 'reference' && n.data[f.name] && store.has(n.data[f.name]) && n.data[f.name] !== n.id)
      .map((f) => n.data[f.name]);
  }
  // Entrada de Price Book customizado depende da entrada padrão do mesmo produto
  const stdPbe = new Map();
  for (const n of store.values()) {
    if (n.sobject === 'PricebookEntry' && srcStd && n.data.Pricebook2Id === srcStd.Id) stdPbe.set(n.data.Product2Id, n.id);
  }
  for (const n of store.values()) {
    if (n.sobject !== 'PricebookEntry' || (srcStd && n.data.Pricebook2Id === srcStd.Id)) continue;
    const s = stdPbe.get(n.data.Product2Id);
    if (s && !n.refs.includes(s)) n.refs.push(s);
  }
  const visit = (n) => {
    if (state.has(n.id)) return; // visitado ou ciclo (a referência do ciclo é omitida)
    state.set(n.id, 1);
    for (const r of n.refs) visit(store.get(r));
    state.set(n.id, 2);
    order.push(n);
  };
  for (const n of store.values()) visit(n);

  // ---------------- 2a. Já copiados antes (histórico de execuções reais)
  const priorCopy = new Map(); // id origem -> data ISO do último envio (null quando veio do campo de ID de origem)
  // id destino -> id origem que já ficou com ele: um registro do destino recebe no máximo um registro de origem
  const origemDoDestino = new Map([...idMap].map(([sid, tid]) => [tid, sid]));
  const usaHistorico = !!(CFG.skipAlreadyCopied && opts.logDir); // sem histórico, o app não sabe o que já copiou
  if (usaHistorico) {
    const hist = loadCopyHistory(opts.logDir, CFG.source, CFG.target);
    const bySobject = {};
    for (const n of store.values()) if (hist.has(n.id)) (bySobject[n.sobject] ||= []).push(n);
    let hits = 0;
    for (const [sobject, nodes] of Object.entries(bySobject)) {
      const existing = new Set();
      for (const c of chunks(nodes.map((n) => hist.get(n.id).targetId), 100)) {
        checkAbort();
        (await tgt.query(`SELECT Id FROM ${sobject} WHERE Id IN (${c.map(q).join(',')})`)).forEach((r) => existing.add(r.Id));
      }
      for (const n of nodes) {
        const h = hist.get(n.id);
        if (!existing.has(h.targetId)) continue; // foi apagado no destino: será criado de novo
        if (origemDoDestino.has(h.targetId)) {
          // histórico antigo com dois registros de origem no mesmo registro do destino: só o primeiro é reaproveitado
          warn(`${sobject} "${n.data.Name || n.id}": já copiado antes para o mesmo registro do destino de outro registro de origem (${h.targetId}) — não reaproveitado`);
          continue;
        }
        idMap.set(n.id, h.targetId);
        origemDoDestino.set(h.targetId, n.id);
        reusedIds.add(n.id);
        priorCopy.set(n.id, h.finishedAt);
        hits++;
      }
    }
    if (hits) log(`${hits} registro(s) já copiados antes para ${CFG.target} serão reaproveitados.`);
  }

  // ---------------- 2b. Campo no destino que guarda o ID de origem (sourceIdField)
  const sidField = {}; // objeto -> campo válido no destino
  for (const [obj, field] of Object.entries(CFG.sourceIdField || {})) {
    const f = (await tgt.describe(obj)).fields.find((x) => x.name === field);
    if (!f) { warn(`${obj}.${field} (ID de origem) não existe no destino — ignorado`); continue; }
    if (!f.createable) { warn(`${obj}.${field} (ID de origem) não é gravável no destino — ignorado`); continue; }
    sidField[obj] = field;
    const ids = [...store.values()].filter((n) => n.sobject === obj && !idMap.has(n.id)).map((n) => n.id);
    for (const c of chunks(ids, 100)) {
      checkAbort();
      const rows = await tgt.query(`SELECT Id, ${field} FROM ${obj} WHERE ${field} IN (${c.map(q).join(',')})`);
      for (const row of rows) {
        const sid = row[field];
        if (store.has(sid) && !idMap.has(sid)) {
          if (origemDoDestino.has(row.Id)) { warn(`${obj} ${sid}: ID de origem aponta para registro do destino já ligado a outro registro (não reaproveitado)`); continue; }
          idMap.set(sid, row.Id); origemDoDestino.set(row.Id, sid); reusedIds.add(sid); priorCopy.set(sid, null);
        }
      }
    }
  }

  // ---------------- 3. RecordType
  const rtIds = new Set();
  for (const n of store.values()) if (n.data.RecordTypeId) rtIds.add(n.data.RecordTypeId);
  if (rtIds.size) {
    const srcRt = await src.query(`SELECT Id, SobjectType, DeveloperName FROM RecordType WHERE Id IN (${[...rtIds].map(q).join(',')})`);
    const names = [...new Set(srcRt.map((r) => r.DeveloperName))];
    const tgtRt = names.length
      ? await tgt.query(`SELECT Id, SobjectType, DeveloperName FROM RecordType WHERE DeveloperName IN (${names.map(q).join(',')})`)
      : [];
    for (const s of srcRt) {
      const t = tgtRt.find((x) => x.SobjectType === s.SobjectType && x.DeveloperName === s.DeveloperName);
      if (t) idMap.set(s.Id, t.Id);
      else warn(`RecordType ${s.SobjectType}.${s.DeveloperName} não existe no destino (campo omitido)`);
    }
  }

  const labelOf = (n) => {
    const d = n.data;
    const direct = d.Name || [d.FirstName, d.LastName].filter(Boolean).join(' ') || d.Subject || d.Title;
    if (direct) return direct;
    const pbe = d.PricebookEntryId && store.get(d.PricebookEntryId);
    const prodId = d.Product2Id || (pbe && pbe.data.Product2Id);
    const prod = prodId && store.get(prodId);
    if (n.sobject === 'PricebookEntry') {
      const pb = store.get(d.Pricebook2Id);
      const pbName = srcStd && d.Pricebook2Id === srcStd.Id ? 'Padrão' : pb && pb.data.Name;
      return [prod && prod.data.Name, pbName].filter(Boolean).join(' · ') || null;
    }
    if (prod && prod.data.Name) return prod.data.Name;
    return null;
  };

  // ---------------- 4. Reaproveitar existentes (matchBy)
  // Campos de ID externo do destino que também existem na origem. Mesma lista do reconhecimento automático e da checagem de conflito.
  async function extIdsFor(sobject) {
    const srcNames = new Set((await src.describe(sobject)).fields.map((f) => f.name));
    return (await tgt.describe(sobject)).fields
      .filter((f) => f.externalId && f.name !== 'Id' && f.filterable !== false && srcNames.has(f.name))
      .map((f) => ({ name: f.name, type: f.type, caseSensitive: f.caseSensitive, unique: f.unique }));
  }
  // Conjuntos de chaves usáveis para um objeto. Calculado uma vez por objeto, então os avisos também saem uma vez.
  const keySetCache = new Map();
  async function keySetsFor(sobject, rawKeys, kind) {
    const cacheKey = `${kind}|${sobject}`;
    if (keySetCache.has(cacheKey)) return keySetCache.get(cacheKey);
    const srcDesc = await src.describe(sobject);
    let tgtDesc;
    try { tgtDesc = await tgt.describe(sobject); } catch {
      warn(`${sobject} não existe no destino (${kind} ignorado)`);
      keySetCache.set(cacheKey, []);
      return [];
    }
    const srcNames = new Set(srcDesc.fields.map((f) => f.name));
    const tgtType = new Map(tgtDesc.fields.map((f) => [f.name, f.type]));
    const out = [];
    const configured = normalizeMatchKeys(rawKeys);
    // ID externo do destino vem antes das regras configuradas: evita DUPLICATE_VALUE em objetos sem regra
    if (kind === 'matchBy' && CFG.autoExternalId) {
      for (const f of await extIdsFor(sobject)) {
        if (configured.some((set) => set.length === 1 && parseKey(set[0]).name === f.name)) continue;
        out.push([{ name: f.name, type: f.type }]);
        log(`${sobject}: reconhecido pelo ID externo ${f.name}`);
      }
    }
    for (const set of configured) {
      const keys = [];
      let ok = true;
      for (const raw of set) {
        const { name, optional } = parseKey(raw);
        const inSrc = srcNames.has(name), inTgt = tgtType.has(name);
        if (optional && !(inSrc && inTgt)) continue;
        if (!inSrc || !inTgt) {
          warn(`${sobject}: campo ${name} de ${kind} não existe na ${inSrc ? 'destino' : 'origem'} (regra ignorada)`);
          ok = false;
          break;
        }
        keys.push({ name, type: tgtType.get(name) });
      }
      if (ok && keys.length) out.push(keys);
    }
    keySetCache.set(cacheKey, out);
    return out;
  }

  // Consulta em bloco para os conjuntos de um campo só (ex.: ID externo): uma consulta a cada 100 valores,
  // em vez de uma por registro. Devolve Map(conjunto -> Map(chave do valor -> linhas do destino)) para findInTarget.
  async function consultaEmLote(sobject, sets, recs) {
    const out = new Map();
    const extIds = await extIdsFor(sobject);
    const temNome = (await tgt.describe(sobject)).fields.some((f) => f.name === 'Name');
    for (const set of sets) {
      const k = set[0];
      if (set.length !== 1 || k.name === 'Email' || !LOTE_TIPOS.has(k.type)) continue;
      const cols = [...new Set(['Id', k.name, ...(sobject === 'User' ? ['IsActive'] : []), ...(temNome ? ['Name'] : []), ...extIds.map((f) => f.name)])];
      const valores = new Map(); // chave -> um valor de origem (o SOQL já traz as variações de caixa)
      for (const n of recs) {
        const v = n.data[k.name];
        if (v === null || v === undefined || v === '') continue;
        valores.set(chaveLote(k.type, v), v);
      }
      const grupos = new Map();
      for (const c of chunks([...valores.values()], 100)) {
        checkAbort();
        const rows = await tgt.query(`SELECT ${cols.join(', ')} FROM ${sobject} WHERE ${k.name} IN (${c.map((x) => soqlLiteral(x, k.type)).join(',')})`);
        for (const row of rows) {
          const key = chaveLote(k.type, row[k.name]);
          (grupos.get(key) || grupos.set(key, []).get(key)).push(row);
        }
      }
      out.set(set, grupos);
    }
    return out;
  }

  // Procura no destino o registro equivalente ao registro de origem n, testando os conjuntos em ordem.
  // Só aceita quando exatamente um registro casa. Devolve o id do destino ou null.
  async function findInTarget(n, sets, lote = new Map()) {
    const extIds = await extIdsFor(n.sobject);
    const temNome = (await tgt.describe(n.sobject)).fields.some((f) => f.name === 'Name');
    let recusado = null; // primeiro registro do destino descartado por ID externo diferente
    for (const set of sets) {
      const conds = [];
      const emailBase = {};
      let ok = true;
      for (const k of set) {
        let v = n.data[k.name];
        if (v === null || v === undefined || v === '') { ok = false; break; }
        if (k.type === 'reference') {
          if (!idMap.has(v)) { ok = false; break; }
          v = idMap.get(v);
        }
        if (k.name === 'Email') {
          emailBase[k.name] = normEmail(v);
          conds.push(`Email IN (${q(normEmail(v))}, ${q(`${normEmail(v)}.invalid`)})`);
        } else conds.push(`${k.name} = ${soqlLiteral(v, k.type)}`);
      }
      if (!ok || !conds.length) continue;
      const hasEmail = 'Email' in emailBase;
      const isUser = n.sobject === 'User';
      const limit = isUser ? 10 : 2;
      const cols = [...new Set(['Id', ...(hasEmail ? ['Email'] : []), ...(isUser ? ['IsActive'] : []), ...(temNome ? ['Name'] : []), ...extIds.map((f) => f.name)])];
      let raw;
      if (lote.has(set)) {
        // conjunto em lote: as linhas já vieram da consulta em bloco, com o mesmo corte do LIMIT
        raw = (lote.get(set).get(chaveLote(set[0].type, n.data[set[0].name])) || []).slice(0, limit);
      } else raw = await tgt.query(`SELECT ${cols.join(', ')} FROM ${n.sobject} WHERE ${conds.join(' AND ')} LIMIT ${limit}`);
      const truncada = raw.length >= limit;
      let rows = hasEmail ? raw.filter((r) => normEmail(r.Email) === emailBase.Email) : raw;
      // Chave só de ID externo já identifica o registro. Nas demais, ID externo diferente sai antes de contar.
      const porIdExterno = set.every((k) => extIds.some((f) => f.name === k.name));
      const recusados = porIdExterno ? [] : rows.filter((r) => extIdConflict(n.data, r, extIds));
      if (recusados.length) {
        recusado ||= { row: recusados[0], ...extIdConflict(n.data, recusados[0], extIds) };
        // consulta cortada no limite: o que sobrou não basta para afirmar que é único
        if (truncada) continue;
        rows = rows.filter((r) => !extIdConflict(n.data, r, extIds));
      }
      rows = pickActive(n.sobject, rows, truncada);
      if (rows.length === 1) return rows[0].Id;
      if (rows.length > 1) warn(`${n.sobject}: "${labelOf(n) || n.data.Username || n.data.Email || n.id}" casou com mais de um registro no destino por ${set.map((k) => k.name).join(' + ')} (ignorado)`);
    }
    // Aviso só quando nenhum conjunto liga: se outro registro casou, não há o que avisar
    if (recusado) {
      const rotulo = labelOf(n) || n.data.Username || n.data.Email || n.id;
      warn(`${n.sobject} "${rotulo}": "${recusado.row.Name || rotulo}" existe no destino com outro ${recusado.campo} (origem ${recusado.origem}, destino ${recusado.destino}) — não ligado, será criado`);
    }
    return null;
  }

  // Versão em lote (usada no linkOnly): conjunto de 1 campo faz uma consulta por bloco de 100 valores.
  async function matchMany(recs, sobject, sets) {
    const found = new Map();
    const byId = new Map(recs.map((r) => [r.Id, r]));
    for (const set of sets) {
      const pending = recs.filter((r) => !found.has(r.Id));
      if (!pending.length) break;
      if (set.length > 1) {
        for (const r of pending) {
          const hit = await findInTarget({ id: r.Id, sobject, data: r }, [set]);
          if (hit) found.set(r.Id, hit);
        }
        continue;
      }
      const k = set[0];
      const keyOf = (v) => (k.name === 'Email' ? normEmail(v) : v);
      const want = new Map(); // valor (já normalizado) -> ids de origem
      for (const r of pending) {
        let v = r[k.name];
        if (v === null || v === undefined || v === '') continue;
        if (k.type === 'reference') {
          if (!idMap.has(v)) continue;
          v = idMap.get(v);
        }
        const key = keyOf(v);
        (want.get(key) || want.set(key, []).get(key)).push(r.Id);
      }
      const variants = [...new Set([...want.keys()].flatMap((key) => (k.name === 'Email' ? [key, `${key}.invalid`] : [key])))];
      const groups = new Map();
      for (const c of chunks(variants, 100)) {
        checkAbort();
        const rows = await tgt.query(`SELECT Id, ${k.name}${sobject === 'User' ? ', IsActive' : ''} FROM ${sobject} WHERE ${k.name} IN (${c.map((x) => soqlLiteral(x, k.type)).join(',')})`);
        for (const row of rows) {
          const key = keyOf(row[k.name]);
          (groups.get(key) || groups.set(key, []).get(key)).push(row);
        }
      }
      for (const [key, srcIds] of want) {
        const cands = pickActive(sobject, groups.get(key) || []);
        if (cands.length === 1) srcIds.forEach((sid) => found.set(sid, cands[0].Id));
        else if (cands.length > 1) {
          for (const sid of srcIds) {
            const rec = byId.get(sid);
            warn(`${sobject}: "${labelOf({ sobject, id: sid, data: rec }) || rec.Username || rec.Email || sid}" casou com mais de um registro no destino por ${k.name} (ignorado)`);
          }
        }
      }
    }
    return found;
  }

  // ---------------- 3b. Objetos só para ligar (linkOnly) e ligação automática pelo ID externo: procura no destino e não cria nada
  const linkedIds = new Set();
  const linkedList = [];
  const autoTipos = new Set(); // objetos ligados pelo ID externo: lookup que não acha par é avisado como "não encontrado"
  // Ids de origem referenciados por registros que serão gravados, de objetos que não são copiados nem só para ligar
  const autoNeed = {};
  if (CFG.autoExternalId) {
    for (const n of store.values()) {
      if (idMap.has(n.id)) continue;
      const d = await src.describe(n.sobject);
      for (const f of d.fields) {
        if (f.type !== 'reference' || !f.createable || isSkipped(n.sobject, f.name)) continue;
        const v = n.data[f.name];
        if (!v || store.has(v) || idMap.has(v)) continue;
        const t = typeOf(v);
        if (!t || COPY.has(t) || LINK.has(t) || SEM_LIGACAO_AUTO.has(t)) continue;
        (autoNeed[t] ||= new Set()).add(v);
      }
    }
  }
  // Alvos: { t, ids, sets, chaves, how, comNome }. Os de ID externo vêm antes, pois uma regra de só-para-ligar pode usar lookup já ligado
  const alvos = [];
  for (const [t, idSet] of Object.entries(autoNeed)) {
    const ids = [...idSet].filter((id) => !idMap.has(id));
    if (!ids.length) continue;
    let ext;
    try { ext = await extIdsFor(t); } catch { continue; } // objeto que não existe no destino: continua "não copiado"
    const campo = ext.find((f) => f.unique) || ext[0]; // prefere o ID externo único; senão, o primeiro na ordem do describe
    if (!campo) continue;
    log(`${t}: ligado automaticamente pelo ID externo ${campo.name} (não está em "Objetos que podem ser criados" nem em "Objetos só para ligar")`);
    autoTipos.add(t);
    const temNome = (await src.describe(t)).fields.some((f) => f.name === 'Name'); // junções e alguns objetos padrão não têm Name
    alvos.push({ t, ids, sets: [[{ name: campo.name, type: campo.type }]], chaves: campo.name, how: `ligado pelo ID externo ${campo.name}`, comNome: temNome });
  }
  for (const [t, idSet] of Object.entries(linkNeed)) {
    const ids = [...idSet].filter((id) => !idMap.has(id));
    if (!ids.length) continue;
    const sets = await keySetsFor(t, CFG.linkOnly[t], 'linkOnly');
    const chaves = normalizeMatchKeys(CFG.linkOnly[t]).map((s) => s.map((k) => parseKey(k).name).join(' + ')).join(' ou ');
    alvos.push({ t, ids, sets, chaves, how: `ligado por ${chaves}`, comNome: false });
  }
  if (alvos.length || Object.keys(linkNeed).length) {
    phase('Ligando registros de referência no destino');
    const porTipo = {};
    let naoEncontrados = 0;
    for (const { t, ids, sets, chaves, how, comNome } of alvos) {
      checkAbort();
      const names = [...new Set(sets.flat().map((k) => k.name))];
      const recs = [];
      for (const c of chunks(ids, 100)) {
        checkAbort();
        recs.push(...(await src.query(`SELECT ${['Id', ...(comNome ? ['Name'] : []), ...names].join(', ')} FROM ${t} WHERE Id IN (${c.map(q).join(',')})`)));
      }
      const found = await matchMany(recs, t, sets);
      for (const r of recs) {
        if (found.has(r.Id)) {
          idMap.set(r.Id, found.get(r.Id));
          linkedIds.add(r.Id);
          linkedList.push({ sobject: t, sourceId: r.Id, targetId: found.get(r.Id), label: r.Name || r.Username || r.Email || r.Id, how });
          porTipo[t] = (porTipo[t] || 0) + 1;
        } else {
          naoEncontrados++;
          warn(`${t}: ${r.Name || r.Username || r.Email || r.Id} não encontrado no destino por ${chaves} (campo omitido)`);
        }
      }
    }
    const ligados = Object.entries(porTipo).map(([t, x]) => `${t} ${x}`).join(', ');
    log(`${linkedIds.size} registro(s) de referência ligados (${ligados || '—'}); ${naoEncontrados} não encontrados.`);
  }
  const linkedById = new Map(linkedList.map((l) => [l.sourceId, l])); // para mostrar o lookup ligado em cada graph

  if (CFG.reuseExisting) {
    phase('Procurando registros que já existem no destino');
    const lotes = new Map(); // objeto -> consultas em bloco dos conjuntos de um campo (consultaEmLote)
    for (const n of order) {
      checkAbort();
      if (idMap.has(n.id) || (!CFG.matchBy[n.sobject] && !CFG.autoExternalId)) continue;
      const sets = await keySetsFor(n.sobject, CFG.matchBy[n.sobject], 'matchBy');
      if (!sets.length) continue;
      if (!lotes.has(n.sobject)) lotes.set(n.sobject, await consultaEmLote(n.sobject, sets, order.filter((m) => m.sobject === n.sobject && !idMap.has(m.id))));
      const hit = await findInTarget(n, sets, lotes.get(n.sobject));
      if (hit && origemDoDestino.has(hit)) {
        // Dois registros de origem não atualizam o mesmo registro do destino: este fica sem ligação e é criado
        const outra = store.get(origemDoDestino.get(hit));
        warn(`${n.sobject} "${labelOf(n) || n.data.Username || n.data.Email || n.id}": casou com o mesmo registro do destino que "${(outra && labelOf(outra)) || origemDoDestino.get(hit)}" (${hit}) — não ligado, será criado`);
      } else if (hit) {
        idMap.set(n.id, hit);
        origemDoDestino.set(hit, n.id);
        reusedIds.add(n.id);
      }
    }
    if (reusedIds.size) log(`${reusedIds.size} registro(s) já existem no destino e serão reaproveitados.`);
  }

  // ---------------- 4b. Atualizar os registros que já existiam no destino
  const updateStatus = new Map(); // id origem -> 'atualizado' | 'seria atualizado' | 'sem alterações' | 'falhou'
  const updatesLog = [];
  let updated = 0, unchanged = 0;
  const same = (a, b) => (a === null || a === undefined || a === '' ? '' : String(a)) === (b === null || b === undefined || b === '' ? '' : String(b));

  // Só os campos que mudaram. Lookup só entra se o alvo já existe no destino.
  function buildUpdateBody(n, tf, current) {
    const keyFields = new Set((keySetCache.get(`matchBy|${n.sobject}`) || []).flat().map((k) => k.name));
    const body = {};
    for (const [k, v] of Object.entries(n.data)) {
      if (k === 'Id' || isSkipped(n.sobject, k) || k === sidField[n.sobject] || keyFields.has(k)) continue;
      const f = tf.get(k);
      if (!f || !f.updateable || f.externalId) continue;
      let val = v;
      if (f.type === 'reference' && v) {
        if (idMap.has(v)) val = idMap.get(v);
        else {
          if (store.has(v)) warn(`${n.sobject}.${k}: aponta para registro que ainda não existe no destino (não atualizado)`);
          continue;
        }
      }
      if ((f.type === 'picklist' || f.type === 'multipicklist') && f.restrictedPicklist && val !== null && val !== undefined && val !== '') {
        const allowed = new Set((f.picklistValues || []).filter((p) => p.active).map((p) => p.value));
        const bad = (f.type === 'multipicklist' ? String(val).split(';') : [String(val)]).find((x) => !allowed.has(x));
        if (bad !== undefined) { warn(`${n.sobject}.${k}: valor "${bad}" não existe na picklist restrita do destino (campo não atualizado)`); continue; }
      }
      if (!same(val, current[k])) body[k] = val;
    }
    return body;
  }

  async function updateExisting(nodes) {
    const bySobject = {};
    for (const n of nodes) {
      // Preço do Price Book padrão tem efeito amplo: só liga, nunca atualiza
      if (n.sobject === 'PricebookEntry' && srcStd && n.data.Pricebook2Id === srcStd.Id) continue;
      (bySobject[n.sobject] ||= []).push(n);
    }
    for (const [sobject, list] of Object.entries(bySobject)) {
      checkAbort();
      const tf = new Map((await tgt.describe(sobject)).fields.map((f) => [f.name, f]));
      const fields = [...new Set(list.flatMap((n) => Object.keys(n.data)))].filter((k) => k !== 'Id' && tf.has(k));
      const current = new Map();
      for (const c of chunks(list.map((n) => idMap.get(n.id)), 50)) {
        const rows = await tgt.query(`SELECT ${['Id', ...fields].join(', ')} FROM ${sobject} WHERE Id IN (${c.map(q).join(',')})`);
        for (const r of rows) current.set(r.Id, r);
      }
      const pending = [];
      for (const n of list) {
        const targetId = idMap.get(n.id);
        const body = buildUpdateBody(n, tf, current.get(targetId) || {});
        const changed = Object.keys(body);
        if (!changed.length) { unchanged++; updateStatus.set(n.id, 'sem alterações'); continue; }
        const entry = { sobject, sourceId: n.id, targetId, fields: changed, status: DRY ? 'simulado' : 'pendente' };
        updatesLog.push(entry);
        if (DRY) { updated++; updateStatus.set(n.id, 'seria atualizado'); continue; }
        pending.push({ n, entry, record: { attributes: { type: sobject }, id: targetId, ...body } });
      }
      for (const c of chunks(pending, 200)) {
        checkAbort();
        let res;
        try {
          res = await tgt.api('PATCH', `${V}/composite/sobjects`, { allOrNone: false, records: c.map((x) => x.record) });
        } catch (e) {
          res = c.map(() => ({ success: false, errors: [{ statusCode: 'ERRO', message: e.message }] }));
        }
        c.forEach((x, i) => {
          const r = res[i] || {};
          if (r.success) { updated++; x.entry.status = 'ok'; updateStatus.set(x.n.id, 'atualizado'); return; }
          const err = (r.errors && r.errors[0]) || {};
          x.entry.status = 'falhou';
          x.entry.error = `${err.statusCode ? `[${err.statusCode}] ` : ''}${err.message || 'erro desconhecido'}`;
          updateStatus.set(x.n.id, 'falhou');
          warn(`${sobject} ${labelOf(x.n) || x.n.id}: não atualizado — ${x.entry.error}`);
        });
      }
    }
  }

  if (CFG.updateExisting) {
    const toUpdate = order.filter((n) => reusedIds.has(n.id));
    if (toUpdate.length) {
      phase(DRY ? 'Montando a prévia das atualizações' : 'Atualizando registros existentes');
      await updateExisting(toUpdate);
      log(`${updated} registro(s) ${DRY ? 'seriam atualizados' : 'atualizados'}; ${unchanged} sem alterações.`);
    }
  }

  // ---------------- 5. Graphs
  const kidsOf = new Map();
  for (const n of store.values()) if (n.from) (kidsOf.get(n.from) || kidsOf.set(n.from, []).get(n.from)).push(n);

  const closureOf = (rootId) => {
    const set = new Set();
    const walk = (id) => {
      if (set.has(id) || idMap.has(id) || !store.has(id)) return;
      set.add(id);
      const n = store.get(id);
      n.refs.forEach(walk);
      (kidsOf.get(id) || []).forEach((k) => walk(k.id));
    };
    walk(rootId);
    return set;
  };
  // Só o registro e seus pais que ainda não existem no destino (sem descer aos filhos)
  const coreOf = (rootId) => {
    const set = new Set();
    const walk = (id) => {
      if (set.has(id) || idMap.has(id) || !store.has(id)) return;
      set.add(id);
      store.get(id).refs.forEach(walk);
    };
    walk(rootId);
    return set;
  };

  // Descendentes da raiz que ainda não estão no destino. Filho já reaproveitado não entra, mas é atravessado: pode ter filhos novos.
  const faltantesDe = (rid) => {
    const out = [];
    const visto = new Set([rid]);
    const walk = (id) => {
      for (const k of kidsOf.get(id) || []) {
        if (visto.has(k.id)) continue;
        visto.add(k.id);
        if (!idMap.has(k.id)) out.push(k);
        walk(k.id);
      }
    };
    walk(rid);
    return out;
  };

  const tgtFields = async (sobject) => new Map((await tgt.describe(sobject)).fields.map((f) => [f.name, f]));
  async function buildBody(n, defined) {
    const tf = await tgtFields(n.sobject);
    const body = {};
    const sid = sidField[n.sobject];
    const hasValue = (v) => v !== null && v !== undefined && v !== '';
    for (const [k, v] of Object.entries(n.data)) {
      if (k === 'Id' || isSkipped(n.sobject, k) || k === sid) continue;
      const f = tf.get(k);
      if (!f) {
        if (hasValue(v)) warn(`${n.sobject}.${k} não existe no destino (campo omitido)`);
        continue;
      }
      if (!f.createable) {
        if (hasValue(v)) warn(`${n.sobject}.${k} não é gravável no destino (campo omitido)`);
        continue;
      }
      if (f.type === 'reference' && v) {
        if (idMap.has(v)) body[k] = idMap.get(v);
        else if (defined.has(v)) body[k] = `@{${refId(v)}.id}`;
        else {
          const t = typeOf(v) || '?';
          warn(LINK.has(t) || autoTipos.has(t) ? `${n.sobject}.${k} → ${t} não encontrado no destino (campo omitido)` : `${n.sobject}.${k} → ${t} não copiado (campo omitido)`);
        }
        continue;
      }
      if ((f.type === 'picklist' || f.type === 'multipicklist') && f.restrictedPicklist && hasValue(v)) {
        const allowed = new Set((f.picklistValues || []).filter((p) => p.active).map((p) => p.value));
        const values = f.type === 'multipicklist' ? String(v).split(';') : [String(v)];
        for (const val of values) {
          if (!allowed.has(val)) warn(`${n.sobject}.${k}: valor "${val}" não existe na picklist restrita do destino (a gravação vai falhar)`);
        }
      }
      body[k] = v;
    }
    if (sid) body[sid] = n.id;
    if (n.sobject === 'OpportunityLineItem' && body.UnitPrice != null) delete body.TotalPrice;
    // Campos obrigatórios no destino que ficaram sem valor (com um deles, o graph não é enviado)
    const vazios = [];
    for (const f of tf.values()) {
      if (!f.createable || f.nillable || f.defaultedOnCreate || f.type === 'boolean' || hasValue(body[f.name])) continue;
      if (n.sobject === 'OpportunityLineItem' && f.name === 'TotalPrice') continue;
      vazios.push(f.name);
      // Lookup para objeto que não é copiado nem ligado: o aviso diz como resolver
      const t = f.type === 'reference' && n.data[f.name] ? typeOf(n.data[f.name]) : null;
      warn(t && !COPY.has(t) && !LINK.has(t)
        ? `${n.sobject}.${f.name} é obrigatório no destino e ficou sem valor: adicione ${t} em "Objetos só para ligar" ou em "Objetos que podem ser criados"`
        : `${n.sobject}.${f.name} é obrigatório no destino e ficou sem valor (a gravação vai falhar)`);
    }
    return { body, vazios };
  }

  const fullLog = { startedAt: new Date().toISOString(), source: CFG.source, target: CFG.target, dryRun: DRY, config: CFG, graphs: [], linked: linkedList };
  let created = 0, failedGraphs = 0, gi = 0;
  phase(DRY ? 'Montando a prévia' : 'Gravando na org destino');

  // DUPLICATE_VALUE traz o id do registro que já existe: "... with id: <id>" / "... com ID: <id>"
  const duplicateOf = (msg) => {
    const m = String(msg || '').match(/\b(?:with id|com (?:o )?id)\s*:\s*([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\b/i);
    return m && m[1];
  };
  const howOf = (r) => {
    const base = priorCopy.has(r)
      ? (priorCopy.get(r) ? `copiado antes em ${fmtData(priorCopy.get(r))}` : 'copiado antes')
      : reusedIds.has(r) ? 'já existia no destino' : DRY ? 'criado em graph anterior (simulado)' : 'criado em graph anterior';
    return updateStatus.has(r) ? `${base} · ${updateStatus.get(r)}` : base;
  };

  async function buildGraph(rid, closure) {
    const defined = new Set();
    const compositeRequest = [];
    const nodes = [];
    const linked = new Map();
    const erros = []; // registros com campo obrigatório sem valor: o graph não é enviado
    for (const n of order) {
      if (!closure.has(n.id)) continue;
      const { body, vazios } = await buildBody(n, defined);
      compositeRequest.push({ method: 'POST', url: `${V}/sobjects/${n.sobject}`, referenceId: refId(n.id), body });
      if (vazios.length) erros.push({ sobject: n.sobject, sourceId: n.id, label: labelOf(n), message: `Campo obrigatório sem valor: ${vazios.map((c) => `${n.sobject}.${c}`).join(', ')}` });
      defined.add(n.id);
      nodes.push({
        ref: refId(n.id), sobject: n.sobject, sourceId: n.id, label: labelOf(n),
        role: n.id === rid ? 'raiz' : n.from ? 'filho' : 'pai',
      });
      for (const r of n.refs) {
        if (!closure.has(r) && idMap.has(r) && !linked.has(r)) {
          const p = store.get(r);
          linked.set(r, { sobject: p.sobject, sourceId: r, targetId: idMap.get(r), label: labelOf(p), how: howOf(r) });
        }
      }
      // Lookup para registro ligado (só para ligar ou ID externo): não está em n.refs, porque não é copiado
      for (const f of (await src.describe(n.sobject)).fields) {
        const r = f.type === 'reference' ? n.data[f.name] : null;
        if (r && linkedById.has(r) && !linked.has(r)) linked.set(r, { ...linkedById.get(r) });
      }
    }
    return { closure, compositeRequest, nodes, linked, erros };
  }

  const graphErrors = (g, nodes) => g.graphResponse.compositeResponse
    .filter((r) => r.httpStatusCode >= 400 && !JSON.stringify(r.body).includes('PROCESSING_HALTED'))
    .map((r) => {
      const b = Array.isArray(r.body) ? r.body[0] : r.body;
      const node = nodes.find((x) => x.ref === r.referenceId);
      return {
        ref: r.referenceId,
        sobject: node && node.sobject,
        sourceId: node && node.sourceId,
        label: node && node.label,
        code: b && b.errorCode,
        message: (b && b.message) || JSON.stringify(r.body),
        fields: (b && b.fields) || [],
      };
    });

  // Envia um graph (ou só simula) e devolve o status emitido: ok, dry, fail ou skipped.
  // Devolve 'ligada', sem emitir nada, quando a raiz virou registro do destino por DUPLICATE nesta chamada: quem chamou envia os descendentes.
  // closureFn() roda a cada tentativa: o retry por DUPLICATE_VALUE muda o idMap e encolhe o conjunto.
  // raiz: registro que ganha papel 'raiz' no graph (null nos lotes de filhos).
  async function sendGraph(raiz, base, closureFn) {
    const { graphId } = base;
    for (let attempt = 0; ; attempt++) {
      const { closure, compositeRequest, nodes, linked, erros } = await buildGraph(raiz, closureFn());
      if (!closure.size) {
        if (attempt > 0 && raiz && idMap.has(raiz)) return 'ligada';
        const reason = priorCopy.has(raiz)
          ? `Já copiado antes${priorCopy.get(raiz) ? ` em ${fmtData(priorCopy.get(raiz))}` : ''}`
          : 'Já existe no destino';
        emit({ ...base, status: 'skipped', reason, nodes: [], linked: [] });
        return 'skipped';
      }

      const entry = { graphId, rootId: base.rootId, attempt: attempt + 1, nodes: compositeRequest.length, request: compositeRequest };
      fullLog.graphs.push(entry);
      const evt = { ...base, nodes, linked: [...linked.values()] };

      // Campo obrigatório sem valor: o destino recusa o graph inteiro, então ele nem é enviado (na simulação também falha)
      if (erros.length) {
        failedGraphs++;
        entry.error = erros.map((x) => x.message).join('; ');
        emit({ ...evt, status: 'fail', reason: 'Não enviado ao destino: há campo obrigatório sem valor (o graph inteiro falharia).', errors: erros });
        return 'fail';
      }

      if (DRY) {
        for (const id of closure) idMap.set(id, `DRYRUN_${refId(id)}`);
        created += closure.size;
        emit({ ...evt, status: 'dry' });
        return 'dry';
      }

      let res;
      try {
        res = await tgt.api('POST', `${V}/composite/graph`, { graphs: [{ graphId, compositeRequest }] });
      } catch (e) {
        failedGraphs++;
        entry.error = e.message;
        emit({ ...evt, status: 'fail', errors: [{ message: e.message }] });
        return 'fail';
      }
      const g = res.graphs[0];
      entry.response = g;
      if (g.isSuccessful) {
        const createdIds = {};
        for (const r of g.graphResponse.compositeResponse) {
          const sid = r.referenceId.slice(2);
          if (r.body && r.body.id) { idMap.set(sid, r.body.id); createdIds[sid] = r.body.id; }
        }
        created += closure.size;
        emit({ ...evt, status: 'ok', nodes: nodes.map((x) => ({ ...x, targetId: createdIds[x.sourceId] })) });
        return 'ok';
      }

      const errors = graphErrors(g, nodes);
      // Rede de segurança: registro que já existia (campo único duplicado) é ligado, atualizado e o graph vai de novo, uma vez.
      // Não liga a registro do destino que já é de outro registro de origem: o erro segue como falha do graph.
      const dups = [];
      if (attempt === 0) {
        for (const x of errors) {
          const tid = x.code === 'DUPLICATE_VALUE' && x.sourceId && duplicateOf(x.message);
          if (!tid || origemDoDestino.has(tid)) continue;
          origemDoDestino.set(tid, x.sourceId);
          dups.push(x);
        }
      }
      if (!dups.length) {
        failedGraphs++;
        emit({ ...evt, status: 'fail', errors });
        return 'fail';
      }
      for (const x of dups) {
        const field = (String(x.message).match(/:\s*(\w+)\s+dupli/i) || [])[1] || 'campo único';
        idMap.set(x.sourceId, duplicateOf(x.message));
        reusedIds.add(x.sourceId);
        warn(`${x.sobject} ${x.label || x.sourceId}: já existia no destino (${field} duplicado) — ligado${CFG.updateExisting ? ' e atualizado' : ''}`);
      }
      if (CFG.updateExisting) await updateExisting(dups.map((x) => store.get(x.sourceId)));
      log(`${graphId}: ${dups.length} registro(s) já existiam no destino; enviando de novo.`);
    }
  }

  // ---------------- 5b. Graph acima do limite: divisão em graphs sequenciais
  // Núcleo (registro e pais que ainda faltam) vai primeiro; depois lotes de filhos cuja união de closures cabe no limite.
  // Filho que sozinho passa do limite é dividido do mesmo jeito, como nova raiz. Ids: g<N> (núcleo), g<N>_2, g<N>_3…
  const proximoId = (grupo) => `${grupo.prefixo}_${++grupo.seq}`;
  const contar = (grupo, st) => { if (st === 'fail') grupo.falhou++; else if (st === 'skipped') grupo.vazio++; else grupo.ok++; };
  // Resumo de um grupo de graphs (divisão ou lotes) e aviso quando parte falhou e parte já foi gravada
  const resumirGrupo = (grupo, rotulo, descricao) => {
    if (grupo.lotes || grupo.falhou) log(`${rotulo}: ${descricao}; ${grupo.ok} ${DRY ? 'simulado(s)' : 'ok'}, ${grupo.falhou} falhou.`);
    if (!DRY && grupo.falhou && grupo.ok) {
      log(`${rotulo}: ${grupo.falhou} graph(s) falharam; os demais foram gravados. Ao reexecutar, o que já foi gravado é reaproveitado e só o faltante é criado.`, 'warn');
    }
  };

  // tentados: registros já enviados (ou falhos) neste grupo, para a recursão nunca repetir um.
  async function dividir(rid, grupo, tentados, base) {
    tentados.add(rid);
    const alvo = closureOf(rid); // antes do núcleo: depois dele a raiz já sai do idMap
    const nucleo = coreOf(rid);
    if (nucleo.size > CFG.maxGraphNodes) {
      failedGraphs++;
      grupo.falhou++;
      emit({ ...base, status: 'fail', nodes: [], linked: [],
        errors: [{ message: `${nucleo.size} registros (o registro e os pais que faltam) excedem o limite de ${CFG.maxGraphNodes} por graph e não podem ser divididos. Aumente o limite ou reduza a profundidade de pais.` }] });
      return;
    }
    // Só a raiz do grupo tem papel 'raiz'; um filho que vira raiz de recursão aparece como 'filho'
    const st = await sendGraph(rid === grupo.topo ? rid : null, base, () => coreOf(rid));
    if (st !== 'ligada') contar(grupo, st); // raiz ligada por DUPLICATE não foi enviada: não conta
    if (st === 'fail') return; // sem o núcleo no destino, os filhos não têm pai
    const filhos = order.filter((n) => n.from === rid);
    await enviarLotes([...filhos, ...order.filter((n) => alvo.has(n.id) && n.from !== rid)], grupo, tentados);
  }

  // Lotes em ordem: cada lote recebe candidatos enquanto a união das closures cabe no limite.
  // Candidato que sozinho passa do limite é dividido antes. Quem depende de registro que já falhou não é enviado de novo.
  async function enviarLotes(candidatos, grupo, tentados) {
    for (;;) {
      checkAbort();
      const lote = [];
      let uniao = new Set();
      let grande = null;
      for (const n of candidatos) {
        if (tentados.has(n.id) || idMap.has(n.id)) continue;
        const c = closureOf(n.id);
        if ([...c].some((x) => tentados.has(x) && !idMap.has(x))) {
          tentados.add(n.id);
          warn(`${n.sobject} "${labelOf(n) || n.id}": não enviado porque depende de registro que falhou em outro graph`);
          continue;
        }
        if (c.size > CFG.maxGraphNodes) {
          if (!lote.length) { grande = n.id; break; }
          continue;
        }
        const nova = new Set([...uniao, ...c]);
        if (nova.size > CFG.maxGraphNodes) continue;
        uniao = nova;
        lote.push(n.id);
      }
      if (grande) {
        await dividir(grande, grupo, tentados, { ...grupo.base, graphId: proximoId(grupo), parte: `lote ${++grupo.lotes}` });
        continue;
      }
      if (!lote.length) return;
      lote.forEach((x) => tentados.add(x));
      const base = { ...grupo.base, graphId: proximoId(grupo), parte: `lote ${++grupo.lotes}` };
      contar(grupo, await sendGraph(null, base, () => {
        const u = new Set();
        for (const x of lote) closureOf(x).forEach((y) => u.add(y));
        return u;
      }));
    }
  }

  // Raiz que já existe no destino: não há núcleo a enviar, só os descendentes que faltam. Cabendo no limite, vai num graph (g<N>);
  // senão em lotes (g<N>_1, g<N>_2…). Sem nada faltando, sai o 'ignorado' de sempre.
  async function enviarFaltantes(rid, base) {
    // Sem histórico, nenhum filho conta como faltante: não há como saber se um filho sem regra de reaproveitamento já existe no destino
    const faltam = usaHistorico ? faltantesDe(rid) : [];
    const uniao = () => {
      const u = new Set();
      for (const n of faltam) closureOf(n.id).forEach((x) => u.add(x));
      return u;
    };
    const total = uniao().size;
    if (!total) {
      await sendGraph(rid, base, () => closureOf(rid));
      return;
    }
    const rotulo = base.rootLabel || rid;
    log(`${rotulo}: já existia no destino; ${DRY ? 'seriam enviados' : 'enviando'} ${total} registro(s) novo(s) ligados a ele.`);
    const b = { ...base, reason: `Registro raiz já existia no destino: só os registros novos ligados a ele ${DRY ? 'seriam enviados' : 'são enviados'}.` };
    if (total <= CFG.maxGraphNodes) {
      await sendGraph(null, b, uniao);
      return;
    }
    const grupo = { topo: null, base: b, prefixo: base.graphId, seq: 0, lotes: 0, ok: 0, falhou: 0, vazio: 0 };
    await enviarLotes(faltam, grupo, new Set());
    resumirGrupo(grupo, rotulo, `${grupo.lotes} lote(s) de filhos novos`);
  }

  for (const rid of rootIds) {
    checkAbort();
    const rootNode = store.get(rid);
    const graphId = `g${++gi}`;
    const base = { type: 'graph', graphId, rootId: rid, rootLabel: labelOf(rootNode), rootSobject: CFG.root.sobject };

    // Raiz já existente no destino (histórico, ID de origem, matchBy ou DUPLICATE): não é recriada; só os filhos que faltam vão, ligados a ela
    if (idMap.has(rid)) {
      await enviarFaltantes(rid, base);
      continue;
    }
    if (closureOf(rid).size <= CFG.maxGraphNodes) {
      const st = await sendGraph(rid, base, () => closureOf(rid));
      if (st === 'ligada') await enviarFaltantes(rid, base); // a raiz foi ligada por DUPLICATE neste mesmo graph
      continue;
    }
    const grupo = { topo: rid, base, prefixo: graphId, seq: 1, lotes: 0, ok: 0, falhou: 0, vazio: 0 };
    await dividir(rid, grupo, new Set(), { ...base, parte: 'raiz' });
    resumirGrupo(grupo, base.rootLabel || rid, `dividido em ${grupo.ok + grupo.falhou + grupo.vazio} graphs (1 raiz + ${grupo.lotes} lote(s) de filhos)`);
  }

  // ---------------- 6. Resumo
  fullLog.finishedAt = new Date().toISOString();
  fullLog.idMap = Object.fromEntries([...idMap].filter(([k]) => store.has(k)));
  fullLog.warnings = Object.fromEntries(warnings);
  fullLog.updates = updatesLog;
  let logFile = null;
  if (opts.logDir) {
    fs.mkdirSync(opts.logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    logFile = path.join(opts.logDir, `orgseed-${DRY ? 'simulacao-' : ''}${stamp}.json`);
    fs.writeFileSync(logFile, JSON.stringify(fullLog, null, 2));
  }

  const summary = {
    dryRun: DRY,
    roots: rootIds.length,
    perObject,
    reused: reusedIds.size,
    linked: linkedIds.size,
    updated,
    unchanged,
    created,
    failedGraphs,
    warnings: Object.fromEntries(warnings),
    logFile,
  };
  emit({ type: 'summary', ...summary });
  return summary;
}

module.exports = {
  DEFAULTS,
  normalizeConfig,
  validateConfig,
  matchKeysError,
  normalizeMatchKeys,
  normEmail,
  loadCopyHistory,
  run,
  listObjects,
  describeObject,
  describeRaw,
  fieldDefinitionNames,
  clearSchemaCache,
  sf: sfcli,
};
