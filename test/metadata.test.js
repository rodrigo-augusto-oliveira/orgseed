'use strict';
/**
 * Testes do módulo de metadados com um sf simulado.
 *   node test/metadata.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const md = require('../engine/metadata');

const calls = [];
let deployMode = 'ok';
let fieldDefsMode = 'vazio'; // resposta da consulta FieldDefinition: 'vazio' | 'total' | 'erro'
let describeTgtErr = null; // erro simulado no describe do destino (que não seja 404)

const SRC_OBJECTS = [
  { fullName: 'Account', type: 'CustomObject', manageableState: 'unmanaged' },
  { fullName: 'Projeto__c', type: 'CustomObject', manageableState: 'unmanaged' },
  { fullName: 'pkg__Coisa__c', type: 'CustomObject', manageableState: 'installed', namespacePrefix: 'pkg' },
];
const TGT_OBJECTS = [{ fullName: 'Account', type: 'CustomObject' }];

async function fakeRunSf(args, opts = {}) {
  calls.push({ args, opts });
  const org = args[args.indexOf('--target-org') + 1];
  const cmd = args.slice(0, 3).join(' ');
  if (cmd === 'org list metadata-types') {
    return { metadataObjects: [
      { xmlName: 'ApexClass', inFolder: false },
      { xmlName: 'CustomObject', inFolder: false, childXmlNames: ['CustomField', 'ValidationRule'] },
      { xmlName: 'Report', inFolder: true },
    ] };
  }
  if (cmd === 'org list metadata') {
    const type = args[args.indexOf('--metadata-type') + 1];
    if (type === 'CustomObject') return org === 'src' ? SRC_OBJECTS : TGT_OBJECTS;
    if (type === 'ApexClass') {
      if (org === 'tgt') throw new Error('sem acesso');
      return { fullName: 'MinhaClasse', type: 'ApexClass', manageableState: 'unmanaged' }; // objeto único, não array
    }
    return [];
  }
  if (cmd === 'project retrieve start') {
    assert.ok(fs.existsSync(path.join(opts.cwd, 'package.xml')));
    assert.ok(fs.existsSync(path.join(opts.cwd, 'sfdx-project.json')));
    return { status: 0, result: { files: [
      { type: 'CustomObject', fullName: 'Projeto__c', state: 'Add', filePath: 'x' },
      { type: 'CustomField', fullName: 'Projeto__c.Valor__c', state: 'Add', filePath: 'x' },
      { type: 'CustomField', fullName: 'Account.Regiao__c', state: 'Add', filePath: 'x' },
    ] } };
  }
  if (cmd === 'project deploy start') {
    if (deployMode === 'ok') {
      return { status: 0, result: { id: '0Af000000000001', success: true, details: { componentSuccesses: [
        { componentType: 'CustomObject', fullName: 'Projeto__c', created: 'true' },
        { componentType: 'CustomField', fullName: 'Account.Regiao__c', changed: 'true', created: 'false' },
        { componentType: '', fullName: 'package.xml' },
      ] } } };
    }
    return { status: 1, name: 'FailedDeployError', message: 'Deploy failed.', result: { id: '0Af000000000002', success: false,
      details: { componentFailures: { componentType: 'CustomField', fullName: 'Account.Regiao__c', problem: 'Picklist value set não encontrado', lineNumber: 12 } } } };
  }
  throw new Error(`comando não simulado: ${args.join(' ')}`);
}

md._setDeps({
  runSf: fakeRunSf,
  describeRaw: async (ref, object) => {
    if (object === 'Projeto__c' && ref === 'tgt') throw new Error('[tgt] GET /describe -> 404: NOT_FOUND');
    if (ref === 'tgt' && describeTgtErr) throw new Error(describeTgtErr);
    const fields = [{ name: 'Name', custom: false, type: 'string', label: 'Nome' },
      { name: 'Valor__c', custom: true, type: 'currency', label: 'Valor' },
      { name: 'Total__c', custom: true, type: 'currency', calculated: true, label: 'Total' }];
    if (ref === 'tgt') return { fields: fields.filter((f) => f.name !== 'Total__c') };
    return { fields };
  },
  fieldDefinitionNames: async (ref, object) => {
    if (fieldDefsMode === 'erro') throw new Error('[tgt] GET /tooling/query -> 400: MALFORMED_QUERY');
    if (fieldDefsMode === 'total' && ref === 'tgt' && object === 'Account') return new Set(['Name', 'Valor__c', 'Total__c']);
    return new Set();
  },
});

(async () => {
  // tipos
  const types = await md.listTypes('src');
  assert.deepStrictEqual(types.map((t) => t.name), ['ApexClass', 'CustomField', 'CustomObject', 'Report', 'ValidationRule']);
  assert.strictEqual(types.find((t) => t.name === 'Report').inFolder, true);
  const n = calls.length;
  await md.listTypes('src');
  assert.strictEqual(calls.length, n, 'segunda chamada vem do cache');

  // objetos com comparação
  const objs = await md.compareComponents('src', 'tgt', 'CustomObject');
  const byName = Object.fromEntries(objs.items.map((i) => [i.fullName, i]));
  assert.strictEqual(byName.Account.exists, true);
  assert.strictEqual(byName.Projeto__c.exists, false);
  assert.strictEqual(byName.pkg__Coisa__c.managed, true);

  // destino com erro: exists = null, sem quebrar
  const apex = await md.compareComponents('src', 'tgt', 'ApexClass');
  assert.strictEqual(apex.items.length, 1);
  assert.strictEqual(apex.items[0].exists, null);
  assert.ok(apex.targetError);

  // campos
  const f1 = await md.compareFields('src', 'tgt', 'Account');
  assert.strictEqual(f1.objectInTarget, true);
  assert.deepStrictEqual(f1.fields.map((f) => [f.name, f.exists]), [['Total__c', false], ['Valor__c', true]]);
  assert.ok(f1.fields[0].fieldType.includes('fórmula'));
  const f2 = await md.compareFields('src', 'tgt', 'Projeto__c');
  assert.strictEqual(f2.objectInTarget, false);
  assert.ok(f2.fields.every((f) => f.exists === false));
  // FieldDefinition (sem FLS) enxerga campo que o describe não mostra
  fieldDefsMode = 'total';
  const f3 = await md.compareFields('src', 'tgt', 'Account');
  assert.deepStrictEqual(f3.fields.map((f) => [f.name, f.exists]), [['Total__c', true], ['Valor__c', true]]);
  // consulta com erro: vale só o describe
  fieldDefsMode = 'erro';
  const f4 = await md.compareFields('src', 'tgt', 'Account');
  assert.deepStrictEqual(f4.fields.map((f) => [f.name, f.exists]), [['Total__c', false], ['Valor__c', true]]);
  // describe do destino falhou (sem ser 404): o FieldDefinition decide; sem nada dele, o status é desconhecido
  describeTgtErr = '[tgt] GET /describe -> 500: ERRO_INTERNO';
  fieldDefsMode = 'total';
  const f5 = await md.compareFields('src', 'tgt', 'Account');
  assert.strictEqual(f5.objectInTarget, null);
  assert.deepStrictEqual(f5.fields.map((f) => f.exists), [true, true]);
  fieldDefsMode = 'vazio';
  const f6 = await md.compareFields('src', 'tgt', 'Account');
  assert.deepStrictEqual(f6.fields.map((f) => f.exists), [null, null]);
  describeTgtErr = null;

  // package.xml
  const xml = md.buildPackageXml([
    { type: 'CustomObject', fullName: 'Projeto__c' },
    { type: 'CustomField', fullName: 'Account.Regiao__c' },
    { type: 'CustomField', fullName: 'Account.Regiao__c' },
    { type: 'Layout', fullName: 'Account-Account Layout & Co' },
  ], '61.0');
  assert.ok(xml.includes('<members>Account.Regiao__c</members>'));
  assert.strictEqual(xml.match(/Account\.Regiao__c/g).length, 1, 'membros sem duplicata');
  assert.ok(xml.includes('Layout &amp; Co'), 'XML escapado');
  assert.ok(xml.indexOf('<name>CustomField</name>') < xml.indexOf('<name>CustomObject</name>'), 'tipos ordenados');

  // validação (dry-run) com sucesso
  const members = [{ type: 'CustomObject', fullName: 'Projeto__c' }, { type: 'CustomField', fullName: 'Account.Regiao__c' }, { type: 'ApexClass', fullName: 'Fantasma' }];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-md-'));
  const events = [];
  const ok = await md.transfer({ source: 'src', target: 'tgt', members, dryRun: true, testLevel: 'NoTestRun', workDir: work, onEvent: (e) => events.push(e) });
  const dep = calls.filter((c) => c.args[1] === 'deploy').pop();
  assert.ok(dep.args.includes('--dry-run') && dep.args.includes('NoTestRun') && dep.opts.cwd === work);
  assert.strictEqual(ok.success, true);
  assert.deepStrictEqual(ok.successes.map((s) => s.change), ['criado', 'alterado']);
  assert.deepStrictEqual(ok.errors.map((e) => e.fullName), ['Fantasma'], 'componente inexistente na origem é reportado');
  assert.ok(fs.existsSync(path.join(work, 'resultado.json')));
  assert.ok(events.some((e) => e.type === 'phase' && e.name.includes('Validando')));

  // implantação com falha de componente
  deployMode = 'fail';
  const bad = await md.transfer({ source: 'src', target: 'tgt', members: members.slice(0, 2), dryRun: false, workDir: work });
  assert.strictEqual(bad.success, false);
  assert.strictEqual(bad.errors[0].problem, 'Picklist value set não encontrado');
  assert.strictEqual(bad.errors[0].line, 12);
  assert.ok(!calls.filter((c) => c.args[1] === 'deploy').pop().args.includes('--dry-run'));

  // entradas inválidas
  await assert.rejects(md.transfer({ source: 'src', target: 'src', members, workDir: work }), /mesma org/);
  await assert.rejects(md.transfer({ source: 'src', target: 'tgt', members: [{ type: 'Apex Class; rm', fullName: 'x' }], workDir: work }), /inválido/);
  await assert.rejects(md.compareComponents('src', 'tgt', 'Custom Object'), /inválido/);

  console.log('OK: testes de metadados passaram');
})().catch((e) => { console.error(e); process.exit(1); });
