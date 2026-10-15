'use strict';
/**
 * Registro que já existe no destino é ligado e atualizado, nunca duplicado.
 *   node test/update.test.js
 */
const assert = require('assert');
const engine = require('../engine/engine');
const { SRC, TGT, harness, CONFIG, id, makeOrg, FIELDS, ref, str, ro } = require('./engine.test');

const ZONA = [ro('Id', 'id'), str('Name'), str('ExternalId__c', { externalId: true, unique: true })];
const ACC = [...FIELDS.Account, ref('Zona__c', 'ZonaTransporte__c')];
const fields = { ZonaTransporte__c: ZONA, Account: ACC };
const Z = (n) => id('ZonaTransporte__c', n);
const ACCT = (n) => id('Account', n);
const OPP = (n) => id('Opportunity', n);
const warnKeys = (s) => Object.keys(s.warnings);

// Origem: oportunidade → conta → zona de transporte Z01002. Destino: a zona já existe com outro nome.
const src = (zonaName = 'Zona Nova', extra = {}) => makeOrg('src', {
  ZonaTransporte__c: [{ Id: Z(1), Name: zonaName, ExternalId__c: 'Z01002' }, ...(extra.zonas || [])],
  Account: [{ Id: ACCT(1), Name: 'Cliente', Zona__c: extra.accountZona || Z(1), ParentId: null, OwnerId: null }],
  Opportunity: [{ Id: OPP(1), Name: 'Opp Zona', StageName: 'Prospecting', CloseDate: '2026-10-01', AccountId: ACCT(1) }],
}, { fields });
const tgt = (zonaName = 'Zona Velha', extra = {}) => makeOrg('tgt', {
  ZonaTransporte__c: [{ Id: Z('T1'), Name: zonaName, ExternalId__c: 'Z01002' }],
  Account: extra.accounts || [],
}, { fields });
const cfg = (over = {}) => ({
  source: 'src', target: 'tgt', root: { sobject: 'Opportunity', ids: [OPP(1)] }, children: {},
  copyObjects: ['Account', 'Opportunity', 'ZonaTransporte__c'], matchBy: {}, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] },
  ...over,
});
const zonas = (t) => [...t.all('ZonaTransporte__c').values()];
const contas = (t) => [...t.all('Account').values()];

(async () => {
  // 1. O caso real: sem matchBy, reconhece pelo ID externo, atualiza e a oportunidade passa
  {
    const s0 = src(), t = tgt();
    const ev = [];
    const s = await engine.run(cfg(), { ...harness(s0, t), onEvent: (e) => ev.push(e) });
    assert.strictEqual(s.failedGraphs, 0, JSON.stringify(ev.filter((e) => e.status === 'fail')));
    assert.ok(!warnKeys(s).some((w) => w.includes('DUPLICATE')), 'sem DUPLICATE_VALUE');
    assert.strictEqual(zonas(t).length, 1, 'zona não duplicada');
    assert.strictEqual(zonas(t)[0].Name, 'Zona Nova', 'zona atualizada com o nome da origem');
    assert.strictEqual(contas(t)[0].Zona__c, Z('T1'), 'conta aponta para a zona existente');
    assert.strictEqual(s.updated, 1);
    assert.ok(ev.some((e) => e.type === 'log' && e.msg.includes('reconhecido pelo ID externo ExternalId__c')));
    const g = ev.find((e) => e.type === 'graph');
    assert.ok(g.linked.some((l) => l.sobject === 'ZonaTransporte__c' && l.how === 'já existia no destino · atualizado'), JSON.stringify(g.linked));
  }

  // 2. Valor igual no destino: nada é enviado
  {
    const t = tgt('Zona Nova');
    const s = await engine.run(cfg(), harness(src(), t));
    assert.strictEqual(s.updated, 0);
    assert.strictEqual(s.unchanged, 1);
    assert.strictEqual(t.updates.length, 0, 'sem PATCH quando nada mudou');
  }

  // 3. updateExisting desligado: liga sem atualizar
  {
    const t = tgt();
    const s = await engine.run(cfg({ updateExisting: false }), harness(src(), t));
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual(zonas(t)[0].Name, 'Zona Velha');
    assert.strictEqual(contas(t)[0].Zona__c, Z('T1'));
    assert.strictEqual(t.updates.length, 0);
  }

  // 4. Sem reconhecimento automático: o DUPLICATE_VALUE vira ligação + atualização e o graph passa na segunda tentativa
  {
    const t = tgt();
    const s = await engine.run(cfg({ autoExternalId: false }), harness(src(), t));
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual(zonas(t).length, 1);
    assert.strictEqual(zonas(t)[0].Name, 'Zona Nova');
    assert.strictEqual(contas(t).length, 1, 'conta criada uma vez só');
    assert.strictEqual(contas(t)[0].Zona__c, Z('T1'));
    assert.ok(warnKeys(s).some((w) => w.includes('já existia no destino (ExternalId__c duplicado) — ligado e atualizado')), warnKeys(s).join('\n'));
  }

  // 5. Erro ao atualizar não derruba a oportunidade
  {
    const t = tgt();
    const s = await engine.run(cfg(), harness(src('__falha__'), t));
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual(s.updated, 0);
    assert.strictEqual([...t.all('Opportunity').values()].length, 1, 'oportunidade criada');
    assert.strictEqual(zonas(t)[0].Name, 'Zona Velha');
    assert.ok(warnKeys(s).some((w) => w.includes('não atualizado — [FIELD_CUSTOM_VALIDATION_EXCEPTION]')));
  }

  // 6. Conta existente apontando para zona que ainda não existe no destino: o lookup fica fora da atualização
  {
    const s0 = src('Zona Nova', { zonas: [{ Id: Z(2), Name: 'Zona Sem Destino', ExternalId__c: 'Z09999' }], accountZona: Z(2) });
    const t = tgt('Zona Velha', { accounts: [{ Id: ACCT('T1'), Name: 'Cliente', Zona__c: null }] });
    const s = await engine.run(cfg({ matchBy: { Account: ['Name'] } }), harness(s0, t));
    assert.strictEqual(contas(t).length, 1, 'conta reaproveitada');
    assert.strictEqual(contas(t)[0].Zona__c, null, 'lookup não atualizado');
    assert.ok(warnKeys(s).some((w) => w === 'Account.Zona__c: aponta para registro que ainda não existe no destino (não atualizado)'));
  }

  // 7. Simulação: conta, mas não envia
  {
    const t = tgt();
    const s = await engine.run(cfg(), { ...harness(src(), t), dryRun: true });
    assert.strictEqual(s.updated, 1, 'seria atualizado');
    assert.strictEqual(t.updates.length, 0);
    assert.ok(!t.calls.some((c) => c.includes('composite')));
    assert.strictEqual(zonas(t)[0].Name, 'Zona Velha');
  }

  // 8. Entrada do Price Book padrão nunca é atualizada
  {
    const t = TGT();
    t.all('PricebookEntry').get(id('PricebookEntry', 'TS2')).UnitPrice = 25;
    const s = await engine.run({ ...CONFIG, root: { sobject: 'Opportunity', ids: [OPP(2)] } }, harness(SRC(), t));
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual(t.all('PricebookEntry').get(id('PricebookEntry', 'TS2')).UnitPrice, 25, 'preço padrão intacto');
    assert.ok(!t.updates.some((r) => r.attributes.type === 'PricebookEntry'));
  }

  console.log('\nOK: atualização de existentes passou');
})().catch((e) => { console.error(e); process.exit(1); });
