'use strict';
/**
 * Regras de reaproveitamento: formato das chaves, objetos só para ligar, histórico, sourceIdField,
 * ID externo diferente (outro registro) e um registro de origem por registro do destino.
 *   node test/match.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine/engine');
const { SRC, TGT, harness, CONFIG, id, makeOrg, FIELDS, ref, str, ro } = require('./engine.test');

const OPP = (n) => id('Opportunity', n);
const USER_FIELDS = [ro('Id', 'id'), str('Email'), str('Username'), ro('IsActive', 'boolean')];
const OPP_FIELDS = [...FIELDS.Opportunity, ref('RTV__c', 'User')];
const warnKeys = (s) => Object.keys(s.warnings);

(async () => {
  // ---- formato das chaves
  assert.deepStrictEqual(engine.normalizeMatchKeys(['A', 'B']), [['A', 'B']], 'formato antigo');
  assert.deepStrictEqual(engine.normalizeMatchKeys([['A'], ['B', 'C?']]), [['A'], ['B', 'C?']], 'formato novo');
  assert.deepStrictEqual(engine.normalizeMatchKeys(undefined), []);
  assert.deepStrictEqual(engine.normalizeMatchKeys([]), []);
  assert.strictEqual(engine.normEmail('Ana@X.com.invalid'), 'ana@x.com');
  assert.strictEqual(engine.normEmail('bo@x.com'), 'bo@x.com');
  assert.deepStrictEqual(engine.normalizeMatchKeys('Name'), [['Name']], 'texto solto vira uma regra');
  assert.deepStrictEqual(engine.normalizeMatchKeys([['A'], 'B']), [['A'], ['B']], 'lista mista: cada item é uma regra');
  assert.deepStrictEqual(engine.normalizeMatchKeys(['A', 'B']), [['A', 'B']], 'formato antigo intacto');
  assert.deepStrictEqual(engine.normalizeMatchKeys([['A', 'B'], ['C']]), [['A', 'B'], ['C']], 'formato novo intacto');
  assert.deepStrictEqual(engine.normalizeMatchKeys(42), [], 'valor inválido não compara nada');
  assert.deepStrictEqual(engine.normalizeMatchKeys([['A'], 42]), [], 'item inválido invalida a lista inteira');
  assert.deepStrictEqual(engine.normalizeMatchKeys(['A', '  ']), [['A']], 'vazios descartados');
  assert.strictEqual(engine.matchKeysError('Name'), null);
  assert.strictEqual(engine.matchKeysError([['A'], 'B']), null);
  assert.strictEqual(typeof engine.matchKeysError(42), 'string');
  assert.strictEqual(typeof engine.matchKeysError([{}]), 'string');

  // ---- validação do formato de matchBy e linkOnly
  const withCfg = (extra) => engine.validateConfig(engine.normalizeConfig({ ...CONFIG, ...extra }));
  assert.ok(withCfg({ matchBy: { Account: 42 } }).includes('matchBy de Account: formato inválido. Use ["Campo"] ou [["Campo1"], ["Campo2"]].'));
  assert.ok(withCfg({ linkOnly: { User: [{}] } }).includes('Objetos só para ligar de User: formato inválido. Use ["Campo"] ou [["Campo1"], ["Campo2"]].'));
  assert.deepStrictEqual(withCfg({ matchBy: { Account: 'Name' } }), []);
  assert.deepStrictEqual(withCfg({ matchBy: { Account: [['A'], 'B'] } }), []);

  // ---- linkOnly: User ligado por e-mail, inclusive com o sufixo .invalid da sandbox
  {
    const src = makeOrg('src', {
      User: [{ Id: id('User', 1), Email: 'ana@x.com.invalid' }, { Id: id('User', 2), Email: 'bo@x.com' }, { Id: id('User', 3), Email: 'cy@x.com' }],
      Opportunity: [1, 2, 3].map((n, i) => ({ Id: OPP(n), Name: `Opp ${n}`, StageName: 'Prospecting', CloseDate: '2026-09-01', RTV__c: id('User', i + 1) })),
    }, { fields: { User: USER_FIELDS, Opportunity: OPP_FIELDS } });
    const tgt = makeOrg('tgt', {
      User: [{ Id: id('User', 'T1'), Email: 'ana@x.com.invalid' }, { Id: id('User', 'T2'), Email: 'bo@x.com.invalid' }],
    }, { fields: { User: USER_FIELDS, Opportunity: OPP_FIELDS } });
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Opportunity', ids: [1, 2, 3].map(OPP) }, children: {},
      copyObjects: ['Opportunity'], linkOnly: { User: ['Email'] }, matchBy: {}, skipFields: { '*': ['OwnerId'] } };
    assert.ok(engine.validateConfig(engine.normalizeConfig({ ...cfg, copyObjects: ['Opportunity', 'User'] }))
      .includes("User está em 'Objetos que podem ser criados' e em 'Objetos só para ligar'. Escolha um."));
    const s = await engine.run(cfg, harness(src, tgt));
    const T = [...tgt.all('Opportunity').values()];
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual(s.linked, 2, 'dois usuários ligados');
    assert.strictEqual(T.find((o) => o.Name === 'Opp 1').RTV__c, id('User', 'T1'), 'ana: origem .invalid, destino .invalid');
    assert.strictEqual(T.find((o) => o.Name === 'Opp 2').RTV__c, id('User', 'T2'), 'bo: origem sem sufixo, destino .invalid');
    assert.ok(!('RTV__c' in T.find((o) => o.Name === 'Opp 3')), 'cy não existe no destino: campo omitido');
    assert.ok(warnKeys(s).some((w) => w.includes('User: cy@x.com não encontrado no destino por Email')), 'aviso de não encontrado');
    assert.ok(warnKeys(s).some((w) => w.includes('Opportunity.RTV__c → User não encontrado no destino (campo omitido)')));
  }

  // ---- matchBy com "?": CurrencyIsoCode inexistente é opcional, casa por Pricebook2Id + Product2Id
  {
    const cfg = { ...CONFIG, root: { sobject: 'Opportunity', ids: [OPP(2)] } };
    const s = await engine.run(cfg, harness(SRC(), TGT()));
    assert.strictEqual(s.reused, 2, 'Gadget e a entrada de preço existente são reaproveitados');
    assert.ok(!warnKeys(s).some((w) => w.includes('CurrencyIsoCode')), 'campo opcional não avisa');
  }

  // ---- matchBy com campo obrigatório inexistente: a regra é ignorada, não casa com menos chaves
  {
    const s = await engine.run({ ...CONFIG, root: { sobject: 'Opportunity', ids: [OPP(2)] },
      matchBy: { ...CONFIG.matchBy, PricebookEntry: ['Pricebook2Id', 'Product2Id', 'CurrencyIsoCode'] } }, harness(SRC(), TGT()));
    assert.ok(warnKeys(s).some((w) => w.includes('campo CurrencyIsoCode de matchBy não existe na origem (regra ignorada)')));
    assert.strictEqual(s.reused, 1, 'só Gadget: a entrada de preço não casa só por Pricebook2Id + Product2Id');
  }
  {
    const s = await engine.run({ ...CONFIG, root: { sobject: 'Opportunity', ids: [OPP(2)] },
      matchBy: { PricebookEntry: [], Product2: ['ProductCode', 'CodigoX__c'] } }, harness(SRC(), TGT()));
    assert.ok(warnKeys(s).some((w) => w.includes('Product2: campo CodigoX__c de matchBy não existe na origem (regra ignorada)')));
    assert.strictEqual(s.reused, 0, 'Gadget não casa só por ProductCode');
  }

  // ---- valor vazio na origem não casa com valor vazio no destino
  {
    const src = makeOrg('src', { Contact: [{ Id: id('Contact', 7), LastName: 'Sem', Email: null, AccountId: null, OwnerId: null }] });
    const tgt = makeOrg('tgt', { Contact: [{ Id: id('Contact', 'T7'), LastName: 'Outro', Email: null }] });
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Contact', ids: [id('Contact', 7)] }, children: {},
      copyObjects: ['Contact'], matchBy: { Contact: ['Email'] }, skipFields: { '*': ['OwnerId'] } };
    const s = await engine.run(cfg, harness(src, tgt));
    assert.strictEqual(s.reused, 0);
    assert.strictEqual([...tgt.all('Contact').values()].length, 2, 'contato sem e-mail é criado, não casado');
  }

  // ---- objeto só para ligar que não existe no destino: avisa e omite o lookup, sem derrubar a execução
  {
    const src = makeOrg('src', {
      User: [{ Id: id('User', 1), Email: 'ana@x.com' }],
      Opportunity: [{ Id: OPP(1), Name: 'Opp Sem User', StageName: 'Prospecting', CloseDate: '2026-09-01', RTV__c: id('User', 1) }],
    }, { fields: { User: USER_FIELDS, Opportunity: OPP_FIELDS } });
    const tgt = makeOrg('tgt', {}, { fields: { Opportunity: OPP_FIELDS } });
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Opportunity', ids: [OPP(1)] }, children: {},
      copyObjects: ['Opportunity'], linkOnly: { User: ['Email'] }, matchBy: {}, skipFields: { '*': ['OwnerId'] } };
    const s = await engine.run(cfg, harness(src, tgt));
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual(s.linked, 0);
    assert.ok(warnKeys(s).some((w) => w === 'User não existe no destino (linkOnly ignorado)'));
    assert.ok(!('RTV__c' in [...tgt.all('Opportunity').values()][0]));
  }

  // ---- ambíguo: dois registros com o mesmo Name não casam; com chave única antes, liga pela primeira regra
  {
    const ACC = [...FIELDS.Account, str('Codigo__c')];
    const srcAcc = () => makeOrg('src', { Account: [{ Id: id('Account', 1), Name: 'Acme', Codigo__c: 'C1', ParentId: null, OwnerId: null }] }, { fields: { Account: ACC } });
    const tgtAcc = (rows) => makeOrg('tgt', { Account: rows }, { fields: { Account: ACC } });
    const cfg = (matchBy) => ({ source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1)] }, children: {},
      copyObjects: ['Account'], matchBy, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } });
    const t1 = tgtAcc([{ Id: id('Account', 'A'), Name: 'Acme', Codigo__c: null }, { Id: id('Account', 'B'), Name: 'Acme', Codigo__c: null }]);
    const s1 = await engine.run(cfg({ Account: ['Name'] }), harness(srcAcc(), t1));
    assert.strictEqual(s1.reused, 0, 'ambíguo não liga');
    assert.strictEqual([...t1.all('Account').values()].length, 3, 'cria uma conta nova');
    assert.ok(warnKeys(s1).some((w) => w.includes('casou com mais de um registro no destino por Name (ignorado)')));
    const t2 = tgtAcc([{ Id: id('Account', 'X'), Name: 'Acme', Codigo__c: 'C1' }, { Id: id('Account', 'Y'), Name: 'Acme', Codigo__c: null }]);
    const s2 = await engine.run(cfg({ Account: [['Codigo__c'], ['Name']] }), harness(srcAcc(), t2));
    assert.strictEqual(s2.reused, 1, 'liga pela chave única');
    assert.strictEqual([...t2.all('Account').values()].length, 2, 'não cria nada');
  }

  // ---- formato misto ponta a ponta: [["Codigo__c"], "Name"] liga pela chave única, como [["Codigo__c"], ["Name"]]
  {
    const ACC = [...FIELDS.Account, str('Codigo__c')];
    const src = makeOrg('src', { Account: [{ Id: id('Account', 1), Name: 'Acme', Codigo__c: 'C1', ParentId: null, OwnerId: null }] }, { fields: { Account: ACC } });
    const tgt = makeOrg('tgt', { Account: [{ Id: id('Account', 'X'), Name: 'Acme', Codigo__c: 'C1' }, { Id: id('Account', 'Y'), Name: 'Acme', Codigo__c: null }] }, { fields: { Account: ACC } });
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1)] }, children: {},
      copyObjects: ['Account'], matchBy: { Account: [['Codigo__c'], 'Name'] }, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } };
    const s = await engine.run(cfg, harness(src, tgt));
    assert.strictEqual(s.reused, 1, 'liga pela chave única');
    assert.strictEqual([...tgt.all('Account').values()].length, 2, 'não cria nada');
  }

  // ---- User com o mesmo e-mail: vale o único ativo; dois ativos avisam e não ligam; um inativo sozinho liga
  for (const linkUser of [['Email'], [['Email', 'Username']]]) {
    const run = async (targetUsers) => {
      const src = makeOrg('src', {
        User: [{ Id: id('User', 1), Email: 'dup@x.com', Username: 'dup@x.com' }],
        Opportunity: [{ Id: OPP(1), Name: 'Opp Dup', StageName: 'Prospecting', CloseDate: '2026-09-01', RTV__c: id('User', 1) }],
      }, { fields: { User: USER_FIELDS, Opportunity: OPP_FIELDS } });
      const tgt = makeOrg('tgt', { User: targetUsers }, { fields: { User: USER_FIELDS, Opportunity: OPP_FIELDS } });
      const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Opportunity', ids: [OPP(1)] }, children: {},
        copyObjects: ['Opportunity'], linkOnly: { User: linkUser }, matchBy: {}, skipFields: { '*': ['OwnerId'] } };
      const s = await engine.run(cfg, harness(src, tgt));
      return { s, opp: [...tgt.all('Opportunity').values()][0] };
    };
    const ativo = { Id: id('User', 'T1'), Email: 'dup@x.com.invalid', Username: 'dup@x.com', IsActive: true };
    const inativo = { Id: id('User', 'T2'), Email: 'dup@x.com.invalid', Username: 'dup@x.com', IsActive: false };

    const a = await run([ativo, inativo]);
    assert.strictEqual(a.opp.RTV__c, id('User', 'T1'), `ativo × inativo liga ao ativo (${JSON.stringify(linkUser)})`);
    assert.strictEqual(a.s.linked, 1);
    assert.ok(!warnKeys(a.s).some((w) => w.includes('casou com mais de um registro')), 'sem aviso de ambiguidade');

    const b = await run([ativo, { ...ativo, Id: id('User', 'T3') }]);
    assert.ok(!('RTV__c' in b.opp), 'dois ativos: não liga');
    assert.ok(warnKeys(b.s).some((w) => w.includes('casou com mais de um registro no destino')), 'dois ativos: avisa');

    const c = await run([inativo]);
    assert.strictEqual(c.opp.RTV__c, id('User', 'T2'), 'um inativo sozinho liga normalmente');
  }

  // ---- histórico: a repetição não duplica; registro raiz apagado no destino é criado de novo
  {
    const src = SRC(), tgt = TGT();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-hist-'));
    const cfg = { ...CONFIG, root: { sobject: 'Opportunity', ids: [OPP(1)] } };
    const s1 = await engine.run(cfg, { ...harness(src, tgt), logDir });
    assert.ok(s1.created > 0);
    assert.strictEqual(fs.readdirSync(logDir).length, 1, 'execução real grava um log');
    const oppCount = () => [...tgt.all('Opportunity').values()].length;
    assert.strictEqual(oppCount(), 1);
    const ev = [];
    const s2 = await engine.run(cfg, { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    assert.strictEqual(s2.created, 0, 'nada criado na repetição');
    assert.strictEqual(oppCount(), 1);
    const g = ev.find((e) => e.type === 'graph');
    assert.strictEqual(g.status, 'skipped');
    assert.ok(g.reason.startsWith('Já copiado antes em '), g.reason);
    tgt.all('Opportunity').delete([...tgt.all('Opportunity').keys()][0]);
    await engine.run(cfg, { ...harness(src, tgt), logDir });
    assert.strictEqual([...tgt.all('Opportunity').values()].filter((o) => o.Name === 'Opp Varejo').length, 1, 'raiz apagada é criada de novo');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // ---- sourceIdField: grava o ID de origem no destino e reaproveita por ele, sem histórico
  {
    const withField = () => makeOrg('tgt', {
      RecordType: [{ Id: id('RecordType', 'T1'), SobjectType: 'Opportunity', DeveloperName: 'Venda' }],
      Pricebook2: [{ Id: id('Pricebook2', 'TSTD'), Name: 'Standard Price Book', IsActive: true, IsStandard: true }],
      Product2: [{ Id: id('Product2', 'T2'), Name: 'Gadget', ProductCode: 'G1' }],
      PricebookEntry: [{ Id: id('PricebookEntry', 'TS2'), Pricebook2Id: id('Pricebook2', 'TSTD'), Product2Id: id('Product2', 'T2'), UnitPrice: 20, IsActive: true }],
    }, { fields: { Opportunity: [...FIELDS.Opportunity, str('IdOrigem__c')] } });
    const src = SRC(), tgt = withField();
    const cfg = { ...CONFIG, root: { sobject: 'Opportunity', ids: [OPP(2)] }, sourceIdField: { Opportunity: 'IdOrigem__c' }, skipAlreadyCopied: false };
    const s1 = await engine.run(cfg, harness(src, tgt));
    const opp = [...tgt.all('Opportunity').values()].find((o) => o.Name === 'Opp Padrão');
    assert.strictEqual(opp.IdOrigem__c, OPP(2), 'ID de origem gravado no destino');
    const s2 = await engine.run(cfg, harness(src, tgt));
    assert.strictEqual(s2.created, 0, 'segunda execução reaproveita pelo campo');
    assert.strictEqual([...tgt.all('Opportunity').values()].length, 1, 'não duplica');
    const s3 = await engine.run(cfg, harness(src, TGT()));
    assert.ok(warnKeys(s3).some((w) => w.includes('Opportunity.IdOrigem__c (ID de origem) não existe no destino — ignorado')));
    assert.ok(s1.created > 0);
  }

  // ---- ID externo diferente é outro registro: não liga, avisa e cria; vazio de um dos lados não conflita
  {
    const ACC = [...FIELDS.Account, str('ExtId__c', { externalId: true })];
    const ACC_CI = [...FIELDS.Account, str('ExtId__c', { externalId: true, caseSensitive: false })];
    const run = async (srcExt, tgtExt, fields = ACC) => {
      const src = makeOrg('src', { Account: [{ Id: id('Account', 1), Name: 'X', ExtId__c: srcExt, ParentId: null, OwnerId: null }] }, { fields: { Account: fields } });
      const tgt = makeOrg('tgt', { Account: [{ Id: id('Account', 'T1'), Name: 'X', ExtId__c: tgtExt }] }, { fields: { Account: fields } });
      const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1)] }, children: {},
        copyObjects: ['Account'], matchBy: { Account: ['Name'] }, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } };
      return { tgt, s: await engine.run(cfg, harness(src, tgt)) };
    };

    const a = await run('A', 'B');
    assert.strictEqual(a.s.reused, 0, 'ID externo diferente não liga');
    assert.strictEqual([...a.tgt.all('Account').values()].length, 2, 'conta de origem criada');
    assert.strictEqual(a.tgt.updates.length, 0, 'registro do destino não é tocado');
    assert.ok(warnKeys(a.s).includes('Account "X": "X" existe no destino com outro ExtId__c (origem A, destino B) — não ligado, será criado'));

    const b = await run('A', null);
    assert.strictEqual(b.s.reused, 1, 'destino sem ID externo liga como antes');
    assert.ok(!warnKeys(b.s).some((w) => w.includes('existe no destino com outro')), 'vazio não avisa');

    const c = await run(null, 'B');
    assert.strictEqual(c.s.reused, 1, 'origem sem ID externo liga');

    assert.strictEqual((await run('a', 'A', ACC_CI)).s.reused, 1, 'campo sem caixa sensível: "a" e "A" são o mesmo ID');
    assert.strictEqual((await run('a', 'A')).s.reused, 0, 'campo com caixa sensível: "a" e "A" são IDs diferentes');
    assert.strictEqual((await run(' A ', 'A')).s.reused, 1, 'espaços nas pontas não contam');

    // consulta cortada no limite: sem o registro conflitante, o que sobrou não basta para afirmar que é único
    const srcCut = makeOrg('src', { Account: [{ Id: id('Account', 1), Name: 'X', ExtId__c: 'A', ParentId: null, OwnerId: null }] }, { fields: { Account: ACC } });
    const tgtCut = makeOrg('tgt', { Account: [{ Id: id('Account', 'T1'), Name: 'X', ExtId__c: 'B' }, { Id: id('Account', 'T2'), Name: 'X', ExtId__c: null }] }, { fields: { Account: ACC } });
    const sCut = await engine.run({ source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1)] }, children: {},
      copyObjects: ['Account'], matchBy: { Account: ['Name'] }, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } }, harness(srcCut, tgtCut));
    assert.strictEqual(sCut.reused, 0, 'consulta cortada no limite não liga');
    assert.ok(warnKeys(sCut).some((w) => w.includes('existe no destino com outro ExtId__c')), 'avisa');

    // chave só de ID externo identifica o registro: outro ID externo diferente não impede o reaproveitamento
    const ACC2 = [...FIELDS.Account, str('ExtId__c', { externalId: true }), str('Outro__c', { externalId: true })];
    const src2 = makeOrg('src', { Account: [{ Id: id('Account', 1), Name: 'X', ExtId__c: 'A', Outro__c: 'P', ParentId: null, OwnerId: null }] }, { fields: { Account: ACC2 } });
    const tgt2 = makeOrg('tgt', { Account: [{ Id: id('Account', 'T1'), Name: 'X', ExtId__c: 'A', Outro__c: 'Q' }] }, { fields: { Account: ACC2 } });
    const s2 = await engine.run({ source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1)] }, children: {},
      copyObjects: ['Account'], matchBy: { Account: ['Name'] }, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } }, harness(src2, tgt2));
    assert.strictEqual(s2.reused, 1, 'liga pelo ID externo ExtId__c');
    assert.ok(!warnKeys(s2).some((w) => w.includes('existe no destino com outro') || w.includes('duplicado')), 'liga pela chave, sem conflito nem DUPLICATE_VALUE');
  }

  // ---- dois registros de origem com o mesmo Name não dividem o mesmo registro do destino: o segundo é criado
  {
    const ACC = [...FIELDS.Account, str('Codigo__c')];
    const src = makeOrg('src', { Account: [
      { Id: id('Account', 1), Name: 'Acme', Codigo__c: 'C1', ParentId: null, OwnerId: null },
      { Id: id('Account', 2), Name: 'Acme', Codigo__c: 'C2', ParentId: null, OwnerId: null },
    ] }, { fields: { Account: ACC } });
    const tgt = makeOrg('tgt', { Account: [{ Id: id('Account', 'T1'), Name: 'Acme', Codigo__c: null }] }, { fields: { Account: ACC } });
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1), id('Account', 2)] }, children: {},
      copyObjects: ['Account'], matchBy: { Account: ['Name'] }, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } };
    const s = await engine.run(cfg, harness(src, tgt));
    assert.strictEqual(s.reused, 1, 'só o primeiro liga');
    assert.strictEqual([...tgt.all('Account').values()].length, 2, 'o segundo é criado');
    assert.strictEqual(tgt.updates.filter((r) => r.id === id('Account', 'T1')).length, 1, 'registro do destino atualizado uma vez só');
    assert.strictEqual(tgt.all('Account').get(id('Account', 'T1')).Codigo__c, 'C1', 'o destino ficou com o primeiro');
    assert.ok(warnKeys(s).some((w) => w.includes('casou com o mesmo registro do destino que "Acme"')), 'avisa');
  }

  // ---- histórico antigo com dois registros de origem no mesmo registro do destino: só o primeiro é reaproveitado
  // (logs com o nome atual e com o nome antigo do app, SF Graph Copy)
  for (const prefix of ['orgseed', 'sf-graph-copy']) {
    const ACC = [...FIELDS.Account, str('Codigo__c')];
    const src = makeOrg('src', { Account: [
      { Id: id('Account', 1), Name: 'Acme Matriz', Codigo__c: 'C1', ParentId: null, OwnerId: null },
      { Id: id('Account', 2), Name: 'Acme Filial', Codigo__c: 'C2', ParentId: null, OwnerId: null },
    ] }, { fields: { Account: ACC } });
    const tgt = makeOrg('tgt', { Account: [{ Id: id('Account', 'T1'), Name: 'Acme', Codigo__c: null }] }, { fields: { Account: ACC } });
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-hist2-'));
    fs.writeFileSync(path.join(logDir, `${prefix}-2026-09-01T10-00-00-000Z.json`), JSON.stringify({
      source: 'src', target: 'tgt', dryRun: false, finishedAt: '2026-09-01T10:00:00.000Z',
      idMap: { [id('Account', 1)]: id('Account', 'T1'), [id('Account', 2)]: id('Account', 'T1') },
    }));
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1), id('Account', 2)] }, children: {},
      copyObjects: ['Account'], matchBy: {}, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } };
    const s = await engine.run(cfg, { ...harness(src, tgt), logDir });
    fs.rmSync(logDir, { recursive: true, force: true });
    assert.strictEqual(s.reused, 1, 'só o primeiro do histórico é reaproveitado');
    assert.strictEqual([...tgt.all('Account').values()].length, 2, 'o outro é criado');
    assert.strictEqual(tgt.updates.filter((r) => r.id === id('Account', 'T1')).length, 1, 'registro do destino atualizado uma vez só');
    assert.ok(warnKeys(s).some((w) => w.includes('já copiado antes para o mesmo registro do destino de outro registro de origem')), 'avisa');
  }

  // ---- rede de segurança (DUPLICATE_VALUE): o registro apontado não pode já ser de outro registro de origem
  {
    const ACC = [...FIELDS.Account, str('Codigo__c', { unique: true })];
    const src = makeOrg('src', { Account: [
      { Id: id('Account', 1), Name: 'X', Codigo__c: 'C1', ParentId: null, OwnerId: null },
      { Id: id('Account', 2), Name: 'Z', Codigo__c: 'C1', ParentId: null, OwnerId: null },
    ] }, { fields: { Account: ACC } });
    const tgt = makeOrg('tgt', { Account: [{ Id: id('Account', 'T1'), Name: 'X', Codigo__c: 'C1' }] }, { fields: { Account: ACC } });
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1), id('Account', 2)] }, children: {},
      copyObjects: ['Account'], matchBy: { Account: ['Name'] }, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } };
    const ev = [];
    const s = await engine.run(cfg, { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.strictEqual(s.reused, 1, 'conta 1 liga pelo Name');
    assert.strictEqual(s.failedGraphs, 1, 'conta 2 não liga pelo DUPLICATE: vira falha do graph');
    const fail = ev.find((e) => e.type === 'graph' && e.status === 'fail');
    assert.strictEqual(fail.errors[0].code, 'DUPLICATE_VALUE');
    assert.strictEqual(fail.errors[0].sourceId, id('Account', 2));
    assert.strictEqual([...tgt.all('Account').values()].length, 1, 'nada criado no destino');
  }

  // ---- consulta em bloco: 250 registros com ID externo viram até 3 consultas, com os mesmos resultados e avisos
  {
    const PROD = [...FIELDS.Product2, str('Codigo__c', { externalId: true })];
    const P = (n) => id('Product2', n);
    const src = makeOrg('src', { Product2: Array.from({ length: 250 }, (_, i) => ({ Id: P(i + 1), Name: `Produto ${i + 1}`, ProductCode: `PC${i + 1}`, Codigo__c: `E${i + 1}` })) },
      { fields: { Product2: PROD } });
    const rows = [];
    for (let i = 1; i <= 150; i++) rows.push({ Id: id('Product2', `T${i}`), Name: `Produto ${i}`, ProductCode: `PC${i}`, Codigo__c: `E${i}` }); // liga pelo ID externo
    for (let i = 151; i <= 200; i++) rows.push({ Id: id('Product2', `T${i}`), Name: `Produto ${i}`, ProductCode: `PC${i}`, Codigo__c: `Z${i}` }); // mesmo código, ID externo diferente
    for (let i = 201; i <= 210; i++) {
      rows.push({ Id: id('Product2', `U${i}`), Name: `Produto ${i}`, ProductCode: `PC${i}`, Codigo__c: null });
      rows.push({ Id: id('Product2', `V${i}`), Name: `Produto ${i}`, ProductCode: `PC${i}`, Codigo__c: null }); // dois registros sem ID externo: ambíguo
    }
    const tgt = makeOrg('tgt', { Product2: rows }, { fields: { Product2: PROD } });
    const soqls = [];
    const handleOrig = tgt.handle;
    tgt.handle = (m, url, body) => { const q = new URL(url).searchParams.get('q'); if (q) soqls.push(q); return handleOrig(m, url, body); };
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Product2', ids: Array.from({ length: 250 }, (_, i) => P(i + 1)) }, children: {},
      copyObjects: ['Product2'], matchBy: { Product2: ['ProductCode'] }, skipFields: { '*': ['OwnerId'] } };
    const s = await engine.run(cfg, harness(src, tgt));
    assert.strictEqual(s.reused, 150, 'ligados pelo ID externo');
    assert.ok(soqls.filter((q) => q.includes('FROM Product2 WHERE Codigo__c IN')).length <= 3, 'ID externo: até 3 consultas');
    const soma = (trecho) => Object.entries(s.warnings).filter(([k]) => k.includes(trecho)).reduce((a, [, c]) => a + c, 0);
    assert.strictEqual(soma('existe no destino com outro Codigo__c'), 50, 'ID externo diferente avisa e não liga');
    assert.strictEqual(soma('casou com mais de um registro no destino por ProductCode'), 10, 'ambíguo avisa e não liga');
    assert.strictEqual(s.created, 100, 'o que não liga é criado');
    assert.strictEqual([...tgt.all('Product2').values()].length, 220 + 100, 'nenhum registro duplicado além do criado');
  }

  // ---- ligação automática pelo ID externo: lookup para objeto que não é copiado nem só para ligar (Territorio__c)
  const TERR = [ro('Id', 'id'), str('Name'), str('ExternalId__c', { externalId: true, unique: true })];
  const TERR_SEM_ID = [ro('Id', 'id'), str('Name')];
  const TCLI = [ro('Id', 'id'), str('Name'), ref('Territorio__c', 'Territorio__c', { nillable: false })];
  const TCLI_OPC = [ro('Id', 'id'), str('Name'), ref('Territorio__c', 'Territorio__c')];
  const TER = (n) => id('Territorio__c', n);
  const TCL = (n) => id('TerritorioCliente__c', n);
  // Origem: dois clientes no mesmo território (ID externo TER-N). Destino: o mesmo território, com outro nome
  const ligacao = ({ tgtTer = [{ Id: TER('T1'), Name: 'Norte (destino)', ExternalId__c: 'TER-N' }], terFields = TERR, cliFields = TCLI } = {}) => {
    const fields = { Territorio__c: terFields, TerritorioCliente__c: cliFields };
    const src = makeOrg('src', {
      Territorio__c: [{ Id: TER(1), Name: 'Norte', ExternalId__c: 'TER-N' }],
      TerritorioCliente__c: [{ Id: TCL(1), Name: 'Cliente 1', Territorio__c: TER(1) }, { Id: TCL(2), Name: 'Cliente 2', Territorio__c: TER(1) }],
    }, { fields });
    const tgt = makeOrg('tgt', { Territorio__c: tgtTer }, { fields });
    return { src, tgt };
  };
  const cfgLig = (extra = {}) => ({ source: 'src', target: 'tgt', root: { sobject: 'TerritorioCliente__c', ids: [TCL(1), TCL(2)] }, children: {},
    copyObjects: ['TerritorioCliente__c'], matchBy: {}, skipFields: { '*': ['OwnerId'] }, ...extra });
  const logsDe = (ev) => ev.filter((e) => e.type === 'log').map((e) => e.msg);

  // registro do destino com o mesmo ID externo: o lookup obrigatório é preenchido, sem criar o território
  {
    const { src, tgt } = ligacao();
    const ev = [];
    const s = await engine.run(cfgLig(), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(ev.filter((e) => e.type === 'graph').map((g) => g.status), ['ok', 'ok']);
    assert.strictEqual(s.failedGraphs, 0);
    assert.ok([...tgt.all('TerritorioCliente__c').values()].every((c) => c.Territorio__c === TER('T1')), 'lookup aponta para o registro do destino');
    assert.strictEqual(tgt.all('Territorio__c').size, 1, 'nenhum Territorio__c criado');
    assert.strictEqual(s.linked, 1, 'um território ligado');
    assert.strictEqual(logsDe(ev).filter((m) => m.startsWith('Territorio__c: ligado automaticamente pelo ID externo ExternalId__c')).length, 1, 'uma linha por objeto');
    assert.ok(logsDe(ev).includes('1 registro(s) de referência ligados (Territorio__c 1); 0 não encontrados.'), logsDe(ev).join('\n'));
    const g = ev.find((e) => e.type === 'graph');
    assert.ok(g.linked.some((l) => l.sobject === 'Territorio__c' && l.targetId === TER('T1') && l.how === 'ligado pelo ID externo ExternalId__c'), JSON.stringify(g.linked));
    assert.deepStrictEqual(warnKeys(s), [], 'sem avisos');
  }

  // ID externo sem registro no destino: aviso de não encontrado; lookup obrigatório faz o graph falhar sem ser enviado (também na simulação)
  {
    const { src, tgt } = ligacao({ tgtTer: [] });
    const ev = [];
    const s = await engine.run(cfgLig(), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    const g = ev.filter((e) => e.type === 'graph');
    assert.deepStrictEqual(g.map((x) => x.status), ['fail', 'fail']);
    assert.deepStrictEqual(g[0].errors.map((x) => x.message), ['Campo obrigatório sem valor: TerritorioCliente__c.Territorio__c']);
    assert.ok(g[0].reason.includes('campo obrigatório sem valor'), g[0].reason);
    assert.strictEqual(s.failedGraphs, 2);
    assert.ok(!tgt.calls.some((c) => c.includes('composite/graph')), 'nenhum graph enviado');
    assert.strictEqual([...tgt.all('TerritorioCliente__c').values()].length, 0);
    const w = warnKeys(s);
    assert.ok(w.includes('Territorio__c: Norte não encontrado no destino por ExternalId__c (campo omitido)'), w.join('\n'));
    assert.ok(w.includes('TerritorioCliente__c.Territorio__c → Territorio__c não encontrado no destino (campo omitido)'), w.join('\n'));
    assert.ok(w.includes('TerritorioCliente__c.Territorio__c é obrigatório no destino e ficou sem valor: adicione Territorio__c em "Objetos só para ligar" ou em "Objetos que podem ser criados"'), w.join('\n'));
    const evD = [];
    const sD = await engine.run(cfgLig(), { ...harness(src, tgt), dryRun: true, onEvent: (e) => evD.push(e) });
    assert.deepStrictEqual(evD.filter((e) => e.type === 'graph').map((x) => `${x.status}: ${x.errors[0].message}`),
      ['fail: Campo obrigatório sem valor: TerritorioCliente__c.Territorio__c', 'fail: Campo obrigatório sem valor: TerritorioCliente__c.Territorio__c']);
    assert.strictEqual(sD.failedGraphs, 2);
    assert.ok(!tgt.calls.some((c) => c.includes('composite/graph')), 'simulação não grava');
  }

  // sem ID externo utilizável: continua "não copiado"; o lookup obrigatório ganha o aviso que diz como resolver
  {
    const { src, tgt } = ligacao({ terFields: TERR_SEM_ID, tgtTer: [{ Id: TER('T1'), Name: 'Norte (destino)' }] });
    const ev = [];
    const s = await engine.run(cfgLig(), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    const w = warnKeys(s);
    assert.strictEqual(s.failedGraphs, 2);
    assert.ok(w.includes('TerritorioCliente__c.Territorio__c → Territorio__c não copiado (campo omitido)'), w.join('\n'));
    assert.ok(w.includes('TerritorioCliente__c.Territorio__c é obrigatório no destino e ficou sem valor: adicione Territorio__c em "Objetos só para ligar" ou em "Objetos que podem ser criados"'), w.join('\n'));
    assert.ok(!logsDe(ev).some((m) => m.includes('ligado automaticamente')), 'sem ID externo não liga');
    assert.strictEqual(s.linked, 0);
    assert.strictEqual(tgt.all('Territorio__c').size, 1, 'nada criado');
  }
  // o mesmo com lookup opcional: grava sem o lookup e fica só o aviso de antes
  {
    const { src, tgt } = ligacao({ terFields: TERR_SEM_ID, tgtTer: [{ Id: TER('T1'), Name: 'Norte (destino)' }], cliFields: TCLI_OPC });
    const s = await engine.run(cfgLig(), harness(src, tgt));
    assert.strictEqual(s.failedGraphs, 0);
    assert.deepStrictEqual(warnKeys(s), ['TerritorioCliente__c.Territorio__c → Territorio__c não copiado (campo omitido)']);
    assert.ok([...tgt.all('TerritorioCliente__c').values()].every((c) => !('Territorio__c' in c)), 'gravado sem o lookup');
  }

  // autoExternalId desligado: nenhuma ligação automática; o lookup obrigatório faz o graph falhar
  {
    const { src, tgt } = ligacao();
    const ev = [];
    const s = await engine.run(cfgLig({ autoExternalId: false }), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.strictEqual(s.failedGraphs, 2);
    assert.strictEqual(s.linked, 0);
    assert.ok(!logsDe(ev).some((m) => m.includes('ligado automaticamente')));
    assert.ok(warnKeys(s).includes('TerritorioCliente__c.Territorio__c → Territorio__c não copiado (campo omitido)'));
    assert.strictEqual(tgt.all('TerritorioCliente__c').size, 0);
  }

  // objeto em "Objetos só para ligar" ou copiado: continua como antes, sem passar pela ligação automática
  {
    const { src, tgt } = ligacao();
    const ev = [];
    const s = await engine.run(cfgLig({ linkOnly: { Territorio__c: ['ExternalId__c'] } }), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.strictEqual(s.failedGraphs, 0);
    assert.ok(!logsDe(ev).some((m) => m.includes('ligado automaticamente')), 'só para ligar não passa pela ligação automática');
    assert.ok(logsDe(ev).includes('1 registro(s) de referência ligados (Territorio__c 1); 0 não encontrados.'));
    const g = ev.find((e) => e.type === 'graph');
    assert.ok(g.linked.some((l) => l.sobject === 'Territorio__c' && l.how === 'ligado por ExternalId__c'), JSON.stringify(g.linked));
    assert.strictEqual(tgt.all('Territorio__c').size, 1);
  }
  {
    const { src, tgt } = ligacao();
    const ev = [];
    const s = await engine.run(cfgLig({ copyObjects: ['TerritorioCliente__c', 'Territorio__c'] }), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.strictEqual(s.failedGraphs, 0);
    assert.ok(!logsDe(ev).some((m) => m.includes('ligado automaticamente')), 'objeto copiado não passa pela ligação automática');
    assert.ok(logsDe(ev).some((m) => m.includes('Territorio__c: reconhecido pelo ID externo ExternalId__c')));
    assert.ok([...tgt.all('TerritorioCliente__c').values()].every((c) => c.Territorio__c === TER('T1')));
    assert.strictEqual(tgt.all('Territorio__c').size, 1, 'reaproveitado pelo ID externo, não criado');
  }

  // objeto sem campo Name (ex.: junção): liga pelo ID externo sem consultar Name na origem
  {
    const fields = { Territorio__c: [ro('Id', 'id'), str('ExternalId__c', { externalId: true, unique: true })], TerritorioCliente__c: TCLI };
    const src = makeOrg('src', {
      Territorio__c: [{ Id: TER(1), ExternalId__c: 'TER-N' }],
      TerritorioCliente__c: [{ Id: TCL(1), Name: 'Cliente 1', Territorio__c: TER(1) }],
    }, { fields });
    const tgt = makeOrg('tgt', { Territorio__c: [{ Id: TER('T1'), ExternalId__c: 'TER-N' }] }, { fields });
    const s = await engine.run(cfgLig({ root: { sobject: 'TerritorioCliente__c', ids: [TCL(1)] } }), harness(src, tgt));
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual([...tgt.all('TerritorioCliente__c').values()][0].Territorio__c, TER('T1'));
    assert.strictEqual(s.linked, 1);
  }

  // ID externo que não é único e casa com dois registros: avisa e não liga (igual ao linkOnly)
  {
    const fields = { Territorio__c: [ro('Id', 'id'), str('Name'), str('ExternalId__c', { externalId: true })], TerritorioCliente__c: TCLI };
    const src = makeOrg('src', {
      Territorio__c: [{ Id: TER(1), Name: 'Norte', ExternalId__c: 'TER-N' }],
      TerritorioCliente__c: [{ Id: TCL(1), Name: 'Cliente 1', Territorio__c: TER(1) }],
    }, { fields });
    const tgt = makeOrg('tgt', { Territorio__c: [{ Id: TER('T1'), Name: 'A', ExternalId__c: 'TER-N' }, { Id: TER('T2'), Name: 'B', ExternalId__c: 'TER-N' }] }, { fields });
    const s = await engine.run(cfgLig({ root: { sobject: 'TerritorioCliente__c', ids: [TCL(1)] } }), harness(src, tgt));
    assert.ok(warnKeys(s).includes('Territorio__c: "Norte" casou com mais de um registro no destino por ExternalId__c (ignorado)'), warnKeys(s).join('\n'));
    assert.strictEqual(s.linked, 0);
    assert.strictEqual(s.failedGraphs, 1);
  }

  // com ID externo único e outro não único no mesmo objeto, a ligação usa o único, mesmo que o outro venha antes no describe
  {
    const fields = { Territorio__c: [ro('Id', 'id'), str('Name'), str('Codigo__c', { externalId: true }), str('ExternalId__c', { externalId: true, unique: true })], TerritorioCliente__c: TCLI };
    const src = makeOrg('src', {
      Territorio__c: [{ Id: TER(1), Name: 'Norte', Codigo__c: 'C-1', ExternalId__c: 'TER-N' }],
      TerritorioCliente__c: [{ Id: TCL(1), Name: 'Cliente 1', Territorio__c: TER(1) }],
    }, { fields });
    const tgt = makeOrg('tgt', { Territorio__c: [{ Id: TER('T1'), Name: 'Norte (destino)', Codigo__c: 'C-OUTRO', ExternalId__c: 'TER-N' }] }, { fields });
    const ev = [];
    const s = await engine.run(cfgLig({ root: { sobject: 'TerritorioCliente__c', ids: [TCL(1)] } }), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual([...tgt.all('TerritorioCliente__c').values()][0].Territorio__c, TER('T1'));
    assert.ok(logsDe(ev).some((m) => m.startsWith('Territorio__c: ligado automaticamente pelo ID externo ExternalId__c')), logsDe(ev).join('\n'));
  }

  console.log('\nOK: regras de reaproveitamento passaram');
})().catch((e) => { console.error(e); process.exit(1); });
