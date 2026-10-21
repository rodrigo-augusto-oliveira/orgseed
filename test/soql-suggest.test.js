'use strict';
/**
 * Sugestões da caixa do filtro SOQL.
 *   node test/soql-suggest.test.js
 */
const assert = require('assert');
const { suggest } = require('../app/renderer/soql-suggest');

const f = (name, label, type = 'string', extra = {}) => ({ name, label, type, filterable: true, relationshipName: null, referenceTo: [], picklist: [], ...extra });
const OPP = [
  f('Id', 'ID da oportunidade', 'id'),
  f('Name', 'Nome'),
  f('NameExtra__c', 'Extra'),
  f('StageName', 'Etapa', 'picklist', { picklist: [{ value: 'Closed Won', label: 'Fechada' }, { value: 'Closed Lost', label: 'Perdida' }, { value: "Won't Do", label: "Won't Do" }] }),
  f('AccountId', 'Conta', 'reference', { relationshipName: 'Account', referenceTo: ['Account'] }),
  f('CloseDate', 'Data de fechamento', 'date'),
  f('Description', 'Descrição', 'textarea', { filterable: false }),
];
const ACCOUNT = [f('Name', 'Nome da conta'), f('Type', 'Tipo', 'picklist', { picklist: [{ value: 'Customer', label: 'Cliente' }] })];
const cache = { Account: ACCOUNT };
const ctx = (extra = {}) => ({ fields: OPP, fieldsOf: (o) => cache[o] || null, ...extra });
const at = (text, extra) => suggest(text, text.length, ctx(extra));
const names = (r) => r.items.map((i) => i.name);

// ---- campos
{
  const r = at('Sta');
  assert.deepStrictEqual(names(r).slice(0, 1), ['StageName']);
  assert.strictEqual(r.start, 0);
  assert.strictEqual(r.end, 3);
  assert.deepStrictEqual(names(at('stagen')), ['StageName'], 'sem diferença de caixa');
  assert.ok(names(at('etapa')).includes('StageName'), 'acha pelo rótulo');
  const exato = names(at('Name'));
  assert.ok(!exato.includes('Name'), 'o que já foi digitado por inteiro não é sugerido de novo');
  assert.strictEqual(exato[0], 'NameExtra__c', 'quem começa com o texto vem antes de quem só contém');
  assert.ok(!names(at('Descr')).includes('Description'), 'campo não filtrável fica de fora');
  assert.deepStrictEqual(names(at('zzz')), []);
}

// ---- onde sugere
{
  const t = "StageName = 'Closed Won' AND Clo";
  const r = at(t);
  assert.deepStrictEqual(names(r), ['CloseDate']);
  assert.strictEqual(t.slice(r.start, r.end), 'Clo', 'só a palavra sob o cursor é substituída');
  assert.deepStrictEqual(at('Name = ').items, [], 'palavra vazia não abre a lista');
  assert.ok(at('Name = ', { force: true }).items.length > 3, 'Ctrl+Espaço lista os campos');
  assert.deepStrictEqual(at('Amount > 12').items, [], 'número não sugere');
  const mid = suggest('Sta AND Name = 1', 3, ctx());
  assert.deepStrictEqual(names(mid), ['StageName'], 'funciona com o cursor no meio do texto');
  assert.strictEqual(mid.end, 3);
}

// ---- relacionamentos
{
  const r = at('Acc');
  assert.ok(names(r).includes('AccountId'));
  const rel = r.items.find((i) => i.kind === 'rel');
  assert.strictEqual(rel.insert, 'Account.');
  assert.strictEqual(rel.detail, '→ Account');
  assert.deepStrictEqual(names(at('Account.Ty')), ['Type'], 'campos do objeto relacionado');
  const t = 'Account.Ty';
  const x = at(t);
  assert.strictEqual(t.slice(x.start, x.end), 'Ty');
  const need = suggest('AccountId.Na', 12, { fields: OPP, fieldsOf: () => null });
  assert.strictEqual(need.need, undefined, 'AccountId não é relacionamento');
  const falta = suggest('Account.Na', 10, { fields: OPP, fieldsOf: () => null });
  assert.strictEqual(falta.need, 'Account', 'pede para carregar o objeto relacionado');
  assert.deepStrictEqual(at('Owner.Na').items, [], 'relacionamento desconhecido');
}

// ---- valores de picklist
{
  const t = "StageName = 'Cl";
  const r = at(t);
  assert.deepStrictEqual(names(r), ['Closed Lost', 'Closed Won']);
  assert.strictEqual(t.slice(r.start, r.end), 'Cl');
  assert.strictEqual(r.items[0].insert, "Closed Lost'", 'fecha a aspa');
  assert.strictEqual(r.items[0].detail, 'Perdida');
  assert.strictEqual(suggest("StageName = 'Cl' AND", 15, ctx()).items[0].insert, 'Closed Lost', 'aspa já existe: não duplica');
  assert.strictEqual(at("StageName = '").items.length, 3, 'aspa recém aberta lista tudo');
  assert.deepStrictEqual(names(at("StageName = 'fechada")), ['Closed Won'], 'acha pelo rótulo');
  assert.deepStrictEqual(names(at("StageName = 'Closed Won")), [], 'valor completo não é repetido');
  assert.strictEqual(at("StageName = 'Won").items[0].insert, "Won\\'t Do'", 'aspa no valor é escapada');
  assert.deepStrictEqual(names(at("StageName IN ('Closed Won', 'Closed L")), ['Closed Lost'], 'segundo item de IN');
  assert.strictEqual(at("StageName NOT IN ('Cl").items.length, 2);
  assert.deepStrictEqual(names(at("Account.Type = 'Cu")), ['Customer'], 'picklist do objeto relacionado');
  assert.deepStrictEqual(at("Name = 'Ac").items, [], 'campo que não é picklist não sugere valor');
  assert.deepStrictEqual(at("'Cl").items, [], 'sem campo antes da aspa');
  assert.strictEqual(suggest("Account.Type = 'Cu", 18, { fields: OPP, fieldsOf: () => null }).need, 'Account');
}

// ---- texto fechado volta a sugerir campos; aspa escapada continua dentro do texto
{
  assert.deepStrictEqual(names(at("Name = 'abc' AND Sta")), ['StageName']);
  assert.deepStrictEqual(at("Name = 'it\\'s Sta").items, [], 'ainda dentro do texto');
}

// ---- palavras-chave
{
  const r = at('Name = 1 AN');
  assert.deepStrictEqual(names(r), ['AND']);
  assert.strictEqual(r.items[0].kind, 'kw');
  assert.ok(names(at('CloseDate = LAST_N')).includes('LAST_N_DAYS:'));
  assert.ok(!names(at('Account.TOD')).includes('TODAY'), 'palavra-chave não aparece depois do ponto');
  const e = at('NOT');
  assert.ok(!names(e).includes('NOT'));
  assert.ok(names(e).includes('NOT IN'));
}

// ---- entradas inválidas
{
  assert.deepStrictEqual(suggest('x', 1, null).items, []);
  assert.deepStrictEqual(suggest('x', 1, { fields: null }).items, []);
  assert.deepStrictEqual(suggest('', 0, ctx()).items, []);
}

console.log('OK: testes das sugestões de SOQL passaram');
