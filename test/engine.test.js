'use strict';
/**
 * Teste do motor contra duas orgs Salesforce simuladas em memória.
 *   node test/engine.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine/engine');

// ---------------------------------------------------------------- esquema simulado
const PREFIX = {
  Account: '001', Contact: '003', Opportunity: '006', OpportunityLineItem: '00k', OpportunityContactRole: '00K',
  Pricebook2: '01s', PricebookEntry: '01u', Product2: '01t', RecordType: '012', User: '005', ZonaTransporte__c: 'a15',
  Territorio__c: 'a2T', TerritorioCliente__c: 'a2U',
};
const ref = (name, to, extra = {}) => ({ name, type: 'reference', referenceTo: [to], createable: true, nillable: true, ...extra });
const str = (name, extra = {}) => ({ name, type: 'string', createable: true, nillable: true, ...extra });
const num = (name) => ({ name, type: 'double', createable: true, nillable: true });
const pick = (name, values, restricted) => ({ name, type: 'picklist', createable: true, nillable: true, restrictedPicklist: restricted,
  picklistValues: values.map((v) => ({ value: v, active: true })) });
const ro = (name, type = 'string') => ({ name, type, createable: false, nillable: true });
const FIELDS = {
  Account: [ro('Id', 'id'), str('Name'), ref('OwnerId', 'User'), ref('ParentId', 'Account'), { name: 'BillingAddress', type: 'address', createable: false }],
  Contact: [ro('Id', 'id'), str('LastName'), str('FirstName'), str('Email'), ref('AccountId', 'Account'), ref('OwnerId', 'User')],
  Opportunity: [ro('Id', 'id'), str('Name'), str('StageName'), { name: 'CloseDate', type: 'date', createable: true },
    ref('AccountId', 'Account'), ref('Pricebook2Id', 'Pricebook2'), ref('RecordTypeId', 'RecordType'), ref('OwnerId', 'User'), ro('Amount', 'currency'),
    str('Campo_X__c'), pick('Tipo__c', ['A', 'B'], true), pick('Fase__c', ['X', 'Y'], false)],
  OpportunityLineItem: [ro('Id', 'id'), ref('OpportunityId', 'Opportunity'), ref('PricebookEntryId', 'PricebookEntry'),
    ref('Product2Id', 'Product2'), num('Quantity'), num('UnitPrice'), num('TotalPrice')],
  OpportunityContactRole: [ro('Id', 'id'), ref('OpportunityId', 'Opportunity'), ref('ContactId', 'Contact'), str('Role')],
  Pricebook2: [ro('Id', 'id'), str('Name'), { name: 'IsActive', type: 'boolean', createable: true }, ro('IsStandard', 'boolean')],
  PricebookEntry: [ro('Id', 'id'), ref('Pricebook2Id', 'Pricebook2'), ref('Product2Id', 'Product2'), num('UnitPrice'),
    { name: 'IsActive', type: 'boolean', createable: true }],
  Product2: [ro('Id', 'id'), str('Name'), str('ProductCode')],
  RecordType: [ro('Id', 'id'), ro('SobjectType'), ro('DeveloperName')],
};
const CHILDREN = {
  Opportunity: [
    { relationshipName: 'OpportunityLineItems', childSObject: 'OpportunityLineItem', field: 'OpportunityId' },
    { relationshipName: 'OpportunityContactRoles', childSObject: 'OpportunityContactRole', field: 'OpportunityId' },
  ],
  Account: [{ relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId' }],
};

const id = (obj, n) => (PREFIX[obj] + String(n)).padEnd(18, 'A');

function makeOrg(name, data, opts = {}) {
  const F = (o) => (opts.fields && opts.fields[o]) || FIELDS[o];
  let seq = 900;
  const records = {}; // sobject -> Map(id -> rec)
  for (const [obj, list] of Object.entries(data)) records[obj] = new Map(list.map((r) => [r.Id, { ...r }]));
  const all = (obj) => records[obj] || (records[obj] = new Map());
  const findById = (rid) => { for (const m of Object.values(records)) if (m.has(rid)) return m.get(rid); return null; };

  const parseVal = (s) => {
    s = s.trim();
    if (s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s.startsWith("'")) return s.slice(1, -1).replace(/\\'/g, "'");
    return Number(s);
  };
  const getPath = (rec, p) => {
    if (!p.includes('.')) return rec[p];
    const [rel, f] = p.split('.');
    const parent = findById(rec[`${rel}Id`]);
    return parent ? parent[f] : undefined;
  };
  function soql(text) {
    const m = text.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: LIMIT (\d+))?$/);
    if (!m) throw new Error(`SOQL não suportada no mock: ${text}`);
    const [, fields, obj, where, limit] = m;
    const conds = where ? where.split(' AND ') : [];
    let rows = [...all(obj).values()].filter((rec) => conds.every((c) => {
      let mm = c.match(/^([\w.]+) IN \((.*)\)$/);
      if (mm) return mm[2].split(',').map(parseVal).includes(getPath(rec, mm[1]));
      mm = c.match(/^([\w.]+) = (.*)$/);
      if (mm) { const v = parseVal(mm[2]); const got = getPath(rec, mm[1]); return v === null ? got == null : got === v; }
      throw new Error(`Condição não suportada no mock: ${c}`);
    }));
    if (limit) rows = rows.slice(0, Number(limit));
    const fl = fields.split(',').map((s) => s.trim());
    for (const f of fl) if (f !== 'Id' && !F(obj).some((x) => x.name === f)) throw new Error(`Campo ${f} não existe em ${obj}`);
    return rows.map((r) => { const o = { attributes: { type: obj } }; for (const f of fl) o[f] = r[f] ?? null; return o; });
  }

  function graph(body) {
    const out = [];
    for (const g of body.graphs) {
      const snapshot = JSON.stringify([...Object.entries(records)].map(([k, v]) => [k, [...v.entries()]]));
      const refs = {};
      const responses = [];
      let failed = false;
      for (const r of g.compositeRequest) {
        if (failed) { responses.push({ referenceId: r.referenceId, httpStatusCode: 400, body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }] }); continue; }
        const obj = r.url.split('/').pop();
        const rec = {};
        let err = null;
        let code = 'FIELD_CUSTOM_VALIDATION_EXCEPTION';
        for (const [k, v0] of Object.entries(r.body)) {
          let v = v0;
          const mm = typeof v === 'string' && v.match(/^@\{(\w+)\.id\}$/);
          if (mm) { if (!refs[mm[1]]) err = `referência ${mm[1]} não definida antes`; v = refs[mm[1]]; }
          const f = F(obj).find((x) => x.name === k);
          if (!f || !f.createable) err = `campo ${k} não é gravável`;
          if (f && f.type === 'reference' && v && !findById(v)) err = `${k} aponta para id inexistente no destino: ${v}`;
          rec[k] = v;
        }
        if (obj === 'OpportunityLineItem' && rec.UnitPrice != null && rec.TotalPrice != null) err = 'UnitPrice e TotalPrice juntos';
        if (obj === 'PricebookEntry') {
          const pb = findById(rec.Pricebook2Id);
          if (pb && !pb.IsStandard) {
            const std = [...all('PricebookEntry').values()].find((e) => e.Product2Id === rec.Product2Id && findById(e.Pricebook2Id).IsStandard);
            if (!std) err = 'STANDARD_PRICE_NOT_DEFINED';
          }
        }
        if (obj === 'Opportunity' && rec.Name === 'Falha') err = 'Regra de validação: oportunidade bloqueada';
        for (const f of F(obj)) {
          if (!(f.unique || f.externalId) || rec[f.name] == null) continue;
          const dup = [...all(obj).values()].find((x) => x[f.name] === rec[f.name]);
          if (dup) { code = 'DUPLICATE_VALUE'; err = `valor duplicado encontrado: ${f.name} duplica o valor no registro com ID: ${dup.Id}`; }
        }
        if (err) {
          failed = true;
          responses.push({ referenceId: r.referenceId, httpStatusCode: 400, body: [{ errorCode: code, message: err, fields: [] }] });
          continue;
        }
        rec.Id = (PREFIX[obj] + 'N' + seq++).padEnd(18, 'Z');
        if (obj === 'Pricebook2') rec.IsStandard = false;
        all(obj).set(rec.Id, rec);
        refs[r.referenceId] = rec.Id;
        responses.push({ referenceId: r.referenceId, httpStatusCode: 201, body: { id: rec.Id, success: true, errors: [] } });
      }
      if (failed) {
        const restored = JSON.parse(snapshot);
        for (const k of Object.keys(records)) delete records[k];
        for (const [k, entries] of restored) records[k] = new Map(entries);
      }
      out.push({ graphId: g.graphId, isSuccessful: !failed, graphResponse: { compositeResponse: responses } });
    }
    return { graphs: out };
  }

  const calls = [];
  const updates = [];
  async function handle(method, url, body) {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/services\/data\/v[\d.]+/, '');
    calls.push(`${method} ${p}`);
    if (p === '/sobjects') return { sobjects: Object.entries(PREFIX).map(([n, k]) => ({ name: n, label: n, keyPrefix: k, queryable: true, createable: true })) };
    let m = p.match(/^\/sobjects\/(\w+)\/describe$/);
    if (m) {
      if (!F(m[1])) throw new Error(`O objeto ${m[1]} não existe nesta org`);
      return { name: m[1], label: m[1], fields: F(m[1]).map((f) => ({ updateable: f.createable, ...f })), childRelationships: (opts.children && opts.children[m[1]]) || CHILDREN[m[1]] || [] };
    }
    if (p === '/query') { const r = soql(u.searchParams.get('q')); return { done: true, totalSize: r.length, records: r }; }
    if (p === '/composite/graph' && method === 'POST') return graph(body);
    if (p === '/composite/sobjects' && method === 'PATCH') {
      updates.push(...body.records);
      return body.records.map((r) => {
        const rec = findById(r.id);
        if (!rec) return { id: r.id, success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'registro não existe' }] };
        const fields = Object.entries(r).filter(([k]) => k !== 'attributes' && k !== 'id');
        const bad = fields.find(([k]) => { const f = F(r.attributes.type).find((x) => x.name === k); return !f || (f.updateable ?? f.createable) === false; });
        if (bad) return { id: r.id, success: false, errors: [{ statusCode: 'INVALID_FIELD_FOR_INSERT_UPDATE', message: `campo ${bad[0]} não é atualizável` }] };
        if (fields.some(([, v]) => v === '__falha__')) return { id: r.id, success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Regra de validação no update' }] };
        for (const [k, v] of fields) rec[k] = v;
        return { id: r.id, success: true, errors: [] };
      });
    }
    throw new Error(`rota não suportada no mock: ${method} ${p}`);
  }
  return { name, records, all, calls, updates, instanceUrl: `https://${name}.example.com`, handle };
}

// ---------------------------------------------------------------- dados
const SRC = () => makeOrg('src', {
  User: [{ Id: id('User', 1) }],
  RecordType: [{ Id: id('RecordType', 1), SobjectType: 'Opportunity', DeveloperName: 'Venda' }],
  Account: [{ Id: id('Account', 1), Name: 'Acme', OwnerId: id('User', 1), ParentId: null }],
  Contact: [{ Id: id('Contact', 1), LastName: 'Silva', FirstName: 'Ana', Email: 'ana@acme.com', AccountId: id('Account', 1), OwnerId: id('User', 1) }],
  Pricebook2: [
    { Id: id('Pricebook2', 'STD'), Name: 'Standard Price Book', IsActive: true, IsStandard: true },
    { Id: id('Pricebook2', 'VAR'), Name: 'Varejo', IsActive: true, IsStandard: false },
  ],
  Product2: [
    { Id: id('Product2', 1), Name: 'Widget', ProductCode: 'W1' },
    { Id: id('Product2', 2), Name: 'Gadget', ProductCode: 'G1' },
  ],
  PricebookEntry: [
    { Id: id('PricebookEntry', 'S1'), Pricebook2Id: id('Pricebook2', 'STD'), Product2Id: id('Product2', 1), UnitPrice: 10, IsActive: true },
    { Id: id('PricebookEntry', 'S2'), Pricebook2Id: id('Pricebook2', 'STD'), Product2Id: id('Product2', 2), UnitPrice: 20, IsActive: true },
    { Id: id('PricebookEntry', 'V1'), Pricebook2Id: id('Pricebook2', 'VAR'), Product2Id: id('Product2', 1), UnitPrice: 9, IsActive: true },
  ],
  Opportunity: [
    { Id: id('Opportunity', 1), Name: 'Opp Varejo', Campo_X__c: 'abc', Tipo__c: 'B', Fase__c: 'Y', StageName: 'Closed Won', CloseDate: '2026-09-01', AccountId: id('Account', 1),
      Pricebook2Id: id('Pricebook2', 'VAR'), RecordTypeId: id('RecordType', 1), OwnerId: id('User', 1), Amount: 18 },
    { Id: id('Opportunity', 2), Name: 'Opp Padrão', StageName: 'Closed Won', CloseDate: '2026-09-02', AccountId: id('Account', 1),
      Pricebook2Id: id('Pricebook2', 'STD'), RecordTypeId: id('RecordType', 1), OwnerId: id('User', 1), Amount: 20 },
    { Id: id('Opportunity', 3), Name: 'Falha', StageName: 'Prospecting', CloseDate: '2026-09-03', AccountId: id('Account', 1),
      Pricebook2Id: id('Pricebook2', 'STD'), RecordTypeId: null, OwnerId: id('User', 1), Amount: 0 },
  ],
  OpportunityLineItem: [
    { Id: id('OpportunityLineItem', 1), OpportunityId: id('Opportunity', 1), PricebookEntryId: id('PricebookEntry', 'V1'), Product2Id: id('Product2', 1), Quantity: 2, UnitPrice: 9, TotalPrice: 18 },
    { Id: id('OpportunityLineItem', 2), OpportunityId: id('Opportunity', 2), PricebookEntryId: id('PricebookEntry', 'S2'), Product2Id: id('Product2', 2), Quantity: 1, UnitPrice: 20, TotalPrice: 20 },
  ],
  OpportunityContactRole: [{ Id: id('OpportunityContactRole', 1), OpportunityId: id('Opportunity', 1), ContactId: id('Contact', 1), Role: 'Decision Maker' }],
});

const TGT = () => makeOrg('tgt', {
  RecordType: [{ Id: id('RecordType', 'T1'), SobjectType: 'Opportunity', DeveloperName: 'Venda' }],
  Pricebook2: [{ Id: id('Pricebook2', 'TSTD'), Name: 'Standard Price Book', IsActive: true, IsStandard: true }],
  Product2: [{ Id: id('Product2', 'T2'), Name: 'Gadget', ProductCode: 'G1' }], // já existe: deve ser reaproveitado
  PricebookEntry: [{ Id: id('PricebookEntry', 'TS2'), Pricebook2Id: id('Pricebook2', 'TSTD'), Product2Id: id('Product2', 'T2'), UnitPrice: 20, IsActive: true }],
}, { fields: {
  // destino: sem Campo_X__c e com picklists de menos valores
  Opportunity: FIELDS.Opportunity.filter((f) => f.name !== 'Campo_X__c').map((f) =>
    f.name === 'Tipo__c' ? pick('Tipo__c', ['A'], true) : f.name === 'Fase__c' ? pick('Fase__c', ['X'], false) : f),
} });

function harness(src, tgt) {
  const orgs = { src, tgt };
  return {
    connect: async (alias) => ({ alias, instanceUrl: orgs[alias].instanceUrl, token: 't' }),
    fetch: async (url, init) => {
      const org = Object.values(orgs).find((o) => url.startsWith(o.instanceUrl));
      try {
        const out = await org.handle(init.method, url, init.body ? JSON.parse(init.body) : null);
        return { ok: true, status: 200, text: async () => JSON.stringify(out) };
      } catch (e) {
        return { ok: false, status: 400, text: async () => JSON.stringify([{ message: e.message }]) };
      }
    },
  };
}

const CONFIG = {
  source: 'src', target: 'tgt',
  root: { sobject: 'Opportunity', ids: [id('Opportunity', 1), id('Opportunity', 2)] },
  children: { Opportunity: ['OpportunityLineItems', 'OpportunityContactRoles'] },
  copyObjects: ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem', 'OpportunityContactRole', 'Pricebook2', 'PricebookEntry', 'Product2'],
  matchBy: { Account: ['Name'], Contact: ['Email'], Product2: ['ProductCode'], Pricebook2: ['Name'], PricebookEntry: ['Pricebook2Id', 'Product2Id', 'CurrencyIsoCode?'] },
  skipFields: { '*': ['OwnerId'], Account: ['ParentId'] },
};

module.exports = { SRC, TGT, harness, CONFIG, id, makeOrg, FIELDS, ref, str, ro, pick };
if (require.main === module) (async () => {
  // validação
  assert.ok(engine.validateConfig(engine.normalizeConfig({ ...CONFIG, target: 'src' })).length, 'origem = destino deve falhar');
  assert.ok(engine.validateConfig(engine.normalizeConfig({ ...CONFIG, root: { sobject: 'Opportunity', where: 'SELECT Id FROM X' } })).length);
  assert.deepStrictEqual(engine.validateConfig(engine.normalizeConfig(CONFIG)), []);

  // ---- simulação: não grava nada
  {
    const src = SRC(), tgt = TGT();
    const h = harness(src, tgt);
    const events = [];
    const s = await engine.run(CONFIG, { ...h, dryRun: true, onEvent: (e) => events.push(e) });
    assert.ok(!tgt.calls.some((c) => c.includes('composite')), 'simulação não pode chamar composite');
    const graphs = events.filter((e) => e.type === 'graph');
    assert.strictEqual(graphs.length, 2);
    assert.ok(graphs.every((g) => g.status === 'dry'));
    const w = Object.keys(s.warnings);
    console.log('Avisos:', w);
    assert.ok(w.some((x) => x.includes('Opportunity.Campo_X__c') && x.includes('não existe no destino')), 'campo ausente avisado');
    assert.ok(w.some((x) => x.includes('Opportunity.Tipo__c') && x.includes('"B"')), 'picklist restrita avisada');
    assert.ok(!w.some((x) => x.includes('Fase__c')), 'picklist não restrita não avisa');
    assert.ok(!w.some((x) => x.includes('OwnerId')), 'campo ignorado por config não avisa');
    console.log('Simulação:', JSON.stringify(s.perObject), `reaproveitados=${s.reused} criaria=${s.created}`);
  }

  // ---- execução real
  const src = SRC(), tgt = TGT();
  const h = harness(src, tgt);
  const events = [];
  const s = await engine.run(CONFIG, { ...h, onEvent: (e) => events.push(e) });
  const graphs = events.filter((e) => e.type === 'graph');
  for (const g of graphs) {
    console.log(`${g.status} ${g.rootLabel}: ${g.nodes.map((n) => `${n.role}:${n.sobject}${n.label ? `(${n.label})` : ''}`).join(', ')}`);
    if (g.linked.length) console.log('   ligados:', g.linked.map((l) => `${l.sobject}(${l.label}) ${l.how}`).join('; '));
    for (const e of g.errors || []) console.log('   erro:', e.message);
  }
  assert.ok(graphs.every((g) => g.status === 'ok'), 'todos os graphs devem ter sucesso');
  assert.strictEqual(s.failedGraphs, 0);

  const T = (obj) => [...tgt.all(obj).values()];
  assert.strictEqual(T('Opportunity').length, 2);
  assert.strictEqual(T('Account').length, 1, 'conta compartilhada criada uma vez só');
  assert.strictEqual(T('Product2').length, 2, 'Gadget reaproveitado, Widget criado');
  assert.strictEqual(T('Pricebook2').length, 2, 'padrão não duplicado, Varejo criado');
  assert.strictEqual(T('PricebookEntry').length, 3, 'TS2 existente + padrão Widget + Varejo Widget');
  assert.strictEqual(T('OpportunityLineItem').length, 2);
  assert.strictEqual(T('OpportunityContactRole').length, 1);
  assert.strictEqual(T('Contact').length, 1);
  const oppV = T('Opportunity').find((o) => o.Name === 'Opp Varejo');
  assert.strictEqual(oppV.RecordTypeId, id('RecordType', 'T1'), 'RecordType mapeado');
  assert.ok(!('OwnerId' in oppV), 'OwnerId omitido');
  const oppP = T('Opportunity').find((o) => o.Name === 'Opp Padrão');
  assert.strictEqual(oppP.Pricebook2Id, id('Pricebook2', 'TSTD'), 'Price Book padrão mapeado');
  const li2 = T('OpportunityLineItem').find((l) => l.OpportunityId === oppP.Id);
  assert.strictEqual(li2.PricebookEntryId, id('PricebookEntry', 'TS2'), 'entrada existente reaproveitada');
  assert.ok(!('TotalPrice' in li2));

  // ---- falha com rollback
  {
    const src2 = SRC(), tgt2 = TGT();
    const before = JSON.stringify([...tgt2.all('Account').values()]);
    const ev = [];
    const s2 = await engine.run({ ...CONFIG, root: { sobject: 'Opportunity', ids: [id('Opportunity', 3)] } },
      { ...harness(src2, tgt2), onEvent: (e) => ev.push(e) });
    const g = ev.find((e) => e.type === 'graph');
    assert.strictEqual(g.status, 'fail');
    assert.strictEqual(s2.failedGraphs, 1);
    assert.strictEqual(JSON.stringify([...tgt2.all('Account').values()]), before, 'rollback: conta não criada');
    console.log('Falha esperada:', g.errors.map((e) => `${e.sobject} ${e.label}: ${e.message}`).join('; '));
  }

  // ---- filtro WHERE com cancelamento
  {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      engine.run({ ...CONFIG, root: { sobject: 'Opportunity', where: "WHERE StageName = 'Closed Won'" } }, { ...harness(SRC(), TGT()), signal: ac.signal }),
      /cancelada/
    );
    const ev = [];
    await engine.run({ ...CONFIG, root: { sobject: 'Opportunity', where: "StageName = 'Closed Won'", limit: 5 } },
      { ...harness(SRC(), TGT()), dryRun: true, onEvent: (e) => ev.push(e) });
    assert.strictEqual(ev.filter((e) => e.type === 'graph').length, 2, 'WHERE trouxe as 2 oportunidades Closed Won');
  }

  // ---- graph acima do limite: núcleo (raiz + pais) e lotes de filhos
  const OPP1 = id('Opportunity', 1);
  const grandeOrg = (n, { raizNome = 'Raiz grande', contato = null } = {}) => makeOrg('src', {
    Opportunity: [{ Id: OPP1, Name: raizNome, StageName: 'Prospecting', CloseDate: '2026-09-01' }],
    OpportunityContactRole: Array.from({ length: n }, (_, i) => ({ Id: id('OpportunityContactRole', i + 1), OpportunityId: OPP1, ContactId: contato, Role: `Papel ${i + 1}` })),
    Contact: contato ? [{ Id: contato, LastName: 'Compartilhado', Email: null, AccountId: null }] : [],
  });
  const grandeCfg = (extra = {}) => ({ source: 'src', target: 'tgt', root: { sobject: 'Opportunity', ids: [OPP1] },
    children: { Opportunity: ['OpportunityContactRoles'] }, copyObjects: ['Opportunity', 'OpportunityContactRole', 'Contact'],
    matchBy: {}, skipFields: { '*': ['OwnerId'] }, ...extra });
  const graphsOf = (ev) => ev.filter((e) => e.type === 'graph');
  const logsOf = (ev) => ev.filter((e) => e.type === 'log').map((e) => e.msg);
  const wrapFetch = (h, fn) => { const orig = h.fetch; h.fetch = async (url, init) => fn(url, init, orig); return h; };
  // Destino recusa o graph de id gid (nada é gravado); os demais seguem normalmente
  const falhaLote = (h, gid) => wrapFetch(h, async (url, init, orig) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (!body || !body.graphs || body.graphs[0].graphId !== gid) return orig(url, init);
    const ref = body.graphs[0].compositeRequest[0].referenceId;
    return { ok: true, status: 200, text: async () => JSON.stringify({ graphs: [{ graphId: gid, isSuccessful: false,
      graphResponse: { compositeResponse: [{ referenceId: ref, httpStatusCode: 400, body: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'simulado', fields: [] }] }] } }] }) };
  });

  // a) 1200 filhos, limite 500: núcleo + 3 lotes; cada filho criado uma vez, apontando para a raiz real; idMap completo
  {
    const src = grandeOrg(1200), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-split-'));
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    const g = graphsOf(ev);
    assert.deepStrictEqual(g.map((x) => x.graphId), ['g1', 'g1_2', 'g1_3', 'g1_4']);
    assert.deepStrictEqual(g.map((x) => x.nodes.length), [1, 500, 500, 200]);
    assert.ok(g.every((x) => x.status === 'ok'), JSON.stringify(g.map((x) => x.status)));
    assert.strictEqual(s.failedGraphs, 0);
    assert.strictEqual(s.created, 1201);
    const raiz = [...tgt.all('Opportunity').values()];
    const filhos = [...tgt.all('OpportunityContactRole').values()];
    assert.strictEqual(raiz.length, 1);
    assert.strictEqual(filhos.length, 1200, 'cada filho criado uma vez');
    assert.ok(filhos.every((f) => f.OpportunityId === raiz[0].Id), 'filhos apontam para o Id real da raiz');
    assert.ok(g.slice(1).every((x) => x.nodes.every((n) => n.role === 'filho')), 'lotes só com filhos');
    const log = JSON.parse(fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8'));
    assert.strictEqual(Object.keys(log.idMap).length, 1201, 'idMap completo');
    assert.deepStrictEqual(log.graphs.map((x) => x.graphId), ['g1', 'g1_2', 'g1_3', 'g1_4'], 'um registro de graph por lote');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // b) pai novo compartilhado por filhos de lotes diferentes: criado uma vez, no primeiro lote que precisa dele
  {
    const CT = id('Contact', 'S');
    const src = grandeOrg(1100, { contato: CT }), tgt = makeOrg('tgt', {});
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    const g = graphsOf(ev);
    assert.deepStrictEqual(g.map((x) => x.nodes.length), [1, 500, 500, 101]);
    assert.ok(g.every((x) => x.status === 'ok'));
    assert.strictEqual([...tgt.all('Contact').values()].length, 1, 'contato criado uma vez');
    const contato = [...tgt.all('Contact').values()][0];
    assert.ok(g[1].nodes.some((n) => n.sobject === 'Contact' && n.role === 'pai'), 'primeiro lote cria o contato');
    assert.ok(g.slice(2).every((x) => !x.nodes.some((n) => n.sobject === 'Contact')), 'lotes seguintes não recriam o contato');
    assert.ok([...tgt.all('OpportunityContactRole').values()].every((f) => f.ContactId === contato.Id), 'todos apontam para o contato real');
    assert.strictEqual(s.failedGraphs, 0);
  }

  // c) um lote falha: os outros seguem, a falha entra em failedGraphs e há aviso de gravação parcial
  {
    const src = grandeOrg(1200), tgt = makeOrg('tgt', {});
    const h = falhaLote(harness(src, tgt), 'g1_3');
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...h, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}`), ['g1:ok', 'g1_2:ok', 'g1_3:fail', 'g1_4:ok']);
    assert.strictEqual(s.failedGraphs, 1);
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 700, 'lotes 1 e 3 gravados; o 2 ficou de fora');
    assert.ok(logsOf(ev).some((m) => m.includes('dividido em 4 graphs')), 'resumo da divisão');
    assert.ok(ev.some((e) => e.type === 'log' && e.level === 'warn' && e.msg.includes('1 graph(s) falharam')), 'aviso de gravação parcial');
  }

  // d) o núcleo falha: nenhum lote é enviado
  {
    const src = grandeOrg(1200, { raizNome: 'Falha' }), tgt = makeOrg('tgt', {});
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}`), ['g1:fail']);
    assert.strictEqual(s.failedGraphs, 1);
    assert.strictEqual(tgt.calls.filter((c) => c.includes('composite/graph')).length, 1, 'nenhum lote enviado');
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 0);
  }

  // e) grafo pequeno: mesmos ids e sem campo parte
  {
    const ev = [];
    await engine.run(CONFIG, { ...harness(SRC(), TGT()), onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => x.graphId), ['g1', 'g2']);
    assert.ok(graphsOf(ev).every((x) => !('parte' in x)), 'sem parte fora da divisão');
  }

  // f) simulação mostra a mesma divisão e não chama o destino
  {
    const src = grandeOrg(1200), tgt = makeOrg('tgt', {});
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), dryRun: true, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:dry:1', 'g1_2:dry:500', 'g1_3:dry:500', 'g1_4:dry:200']);
    assert.ok(!tgt.calls.some((c) => c.includes('composite')), 'simulação não grava');
    assert.strictEqual(s.created, 1201);
  }

  // h) limite 5: filho com subárvore grande vira nova raiz (núcleo + lotes dele), sem repetir registros
  {
    const A = (n) => id('Account', n);
    const accs = [{ Id: A(1), Name: 'Raiz', ParentId: null }, { Id: A(2), Name: 'Filha grande', ParentId: A(1) }, { Id: A(3), Name: 'Filha pequena', ParentId: A(1) }];
    for (let i = 1; i <= 8; i++) accs.push({ Id: A(100 + i), Name: `Neta ${i}`, ParentId: A(2) });
    const src = makeOrg('src', { Account: accs }, { children: { Account: [{ relationshipName: 'Filhas', childSObject: 'Account', field: 'ParentId' }] } });
    const tgt = makeOrg('tgt', {});
    const ev = [];
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [A(1)] }, children: { Account: ['Filhas'] },
      copyObjects: ['Account'], matchBy: {}, skipFields: { '*': ['OwnerId'] }, maxGraphNodes: 5 };
    const s = await engine.run(cfg, { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    const g = graphsOf(ev);
    assert.deepStrictEqual(g.map((x) => x.graphId), ['g1', 'g1_2', 'g1_3', 'g1_4', 'g1_5']);
    assert.deepStrictEqual(g.map((x) => x.nodes.length), [1, 1, 5, 3, 1]);
    assert.ok(g.every((x) => x.status === 'ok'));
    const T = [...tgt.all('Account').values()];
    assert.strictEqual(T.length, 11, 'cada conta criada uma vez');
    const porNome = (nm) => T.find((x) => x.Name === nm);
    assert.strictEqual(porNome('Filha grande').ParentId, porNome('Raiz').Id);
    assert.ok(T.filter((x) => x.Name.startsWith('Neta')).every((x) => x.ParentId === porNome('Filha grande').Id), 'netas apontam para a filha real');
    assert.strictEqual(s.failedGraphs, 0);
  }

  // i) nova execução depois de um lote que falhou: a raiz já existe (histórico), então só os filhos que faltam são enviados
  {
    const src = grandeOrg(1200), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-resto-'));
    await engine.run(grandeCfg(), { ...falhaLote(harness(src, tgt), 'g1_3'), logDir });
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 700);
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    // a raiz não tem núcleo: os 500 que faltam cabem num graph só (antes: 'skipped' da raiz + g1_2)
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:ok:500']);
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 1200, 'só o que faltava');
    assert.strictEqual([...tgt.all('Opportunity').values()].length, 1, 'raiz não duplicada');
    assert.strictEqual(s.created, 500);
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // raiz reaproveitada (histórico): filhos que faltam são enviados ligados a ela; a raiz nunca é recriada
  const acrescentaFilhos = (src, n) => {
    for (let i = 1; i <= n; i++) src.all('OpportunityContactRole').set(id('OpportunityContactRole', i), { Id: id('OpportunityContactRole', i), OpportunityId: OPP1, ContactId: null, Role: `Papel ${i}` });
  };

  // j) filho incluído depois da cópia: um graph só, com o filho ligado à raiz do destino; idMap atualizado
  {
    const src = grandeOrg(0), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-filho-novo-'));
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir });
    const novo = id('OpportunityContactRole', 1);
    src.all('OpportunityContactRole').set(novo, { Id: novo, OpportunityId: OPP1, ContactId: null, Role: 'Novo' });
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:ok:1']);
    assert.strictEqual(graphsOf(ev)[0].nodes[0].sourceId, novo);
    const raizes = [...tgt.all('Opportunity').values()];
    const filhos = [...tgt.all('OpportunityContactRole').values()];
    assert.strictEqual(raizes.length, 1, 'raiz não duplicada');
    assert.strictEqual(filhos.length, 1);
    assert.strictEqual(filhos[0].OpportunityId, raizes[0].Id, 'filho aponta para o Id real da raiz');
    assert.strictEqual(s.created, 1);
    assert.strictEqual(s.failedGraphs, 0);
    assert.ok(logsOf(ev).some((m) => m.includes('já existia no destino; enviando 1 registro(s) novo(s) ligados a ele.')), logsOf(ev).join('\n'));
    assert.strictEqual(JSON.parse(fs.readFileSync(s.logFile, 'utf8')).idMap[novo], filhos[0].Id, 'idMap com o filho novo');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // k) nada faltando: 'ignorado' com o mesmo motivo de antes, e nenhum graph enviado
  {
    const src = grandeOrg(2), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-nada-falta-'));
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir });
    const antes = tgt.calls.length;
    const ev = [];
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    assert.ok(!tgt.calls.slice(antes).some((c) => c.includes('composite/graph')), 'nenhum graph enviado');
    const g = graphsOf(ev);
    assert.deepStrictEqual(g.map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:skipped:0']);
    assert.ok(g[0].reason.startsWith('Já copiado antes em '), g[0].reason);
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // l) 1200 filhos novos com limite 500: lotes g1_1 a g1_3 e nenhum núcleo da raiz
  {
    const src = grandeOrg(0), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-lotes-reuso-'));
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir });
    acrescentaFilhos(src, 1200);
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    const g = graphsOf(ev);
    assert.deepStrictEqual(g.map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1_1:ok:500', 'g1_2:ok:500', 'g1_3:ok:200']);
    assert.ok(g.every((x) => x.nodes.every((n) => n.role === 'filho')), 'sem núcleo: só filhos');
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 1200, 'cada filho criado uma vez');
    assert.strictEqual([...tgt.all('Opportunity').values()].length, 1, 'raiz não duplicada');
    assert.strictEqual(s.created, 1200);
    assert.strictEqual(s.failedGraphs, 0);
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // q) o mesmo, com o lote do meio falhando: os outros são gravados, a falha entra em failedGraphs e há aviso de gravação parcial
  {
    const src = grandeOrg(0), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-lotes-falha-'));
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir });
    acrescentaFilhos(src, 1200);
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...falhaLote(harness(src, tgt), 'g1_2'), logDir, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}`), ['g1_1:ok', 'g1_2:fail', 'g1_3:ok']);
    assert.strictEqual(s.failedGraphs, 1);
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 700, 'lotes 1 e 3 gravados; o 2 ficou de fora');
    assert.ok(ev.some((e) => e.type === 'log' && e.level === 'warn' && e.msg.includes('1 graph(s) falharam')), 'aviso de gravação parcial');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // m) filho reaproveitado com neto novo: o neto é criado apontando para o Id real do filho
  {
    const A = (n) => id('Account', n);
    const hierarquia = { children: { Account: [{ relationshipName: 'Filhas', childSObject: 'Account', field: 'ParentId' }] } };
    const src = makeOrg('src', { Account: [{ Id: A(1), Name: 'Raiz', ParentId: null }, { Id: A(2), Name: 'Filha', ParentId: A(1) }] }, hierarquia);
    const tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-neto-'));
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [A(1)] }, children: { Account: ['Filhas'] },
      copyObjects: ['Account'], matchBy: {}, skipFields: { '*': ['OwnerId'] } };
    await engine.run(cfg, { ...harness(src, tgt), logDir });
    src.all('Account').set(A(3), { Id: A(3), Name: 'Neta', ParentId: A(2) });
    const ev = [];
    await engine.run(cfg, { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:ok:1']);
    const T = [...tgt.all('Account').values()];
    const porNome = (nm) => T.find((x) => x.Name === nm);
    assert.strictEqual(T.length, 3, 'cada conta criada uma vez');
    assert.strictEqual(porNome('Neta').ParentId, porNome('Filha').Id, 'neta aponta para a filha real');
    assert.strictEqual(porNome('Filha').ParentId, porNome('Raiz').Id, 'filha continua ligada à raiz');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // n) filho novo que precisa de pai novo (contato): o pai entra no mesmo graph e é criado uma vez só
  {
    const CT = id('Contact', 'S');
    const src = grandeOrg(0), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-pai-novo-'));
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir });
    src.all('Contact').set(CT, { Id: CT, LastName: 'Compartilhado', Email: null, AccountId: null });
    for (const i of [1, 2]) src.all('OpportunityContactRole').set(id('OpportunityContactRole', i), { Id: id('OpportunityContactRole', i), OpportunityId: OPP1, ContactId: CT, Role: `Papel ${i}` });
    const ev = [];
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    const g = graphsOf(ev);
    assert.deepStrictEqual(g.map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:ok:3']);
    assert.deepStrictEqual(g[0].nodes.map((x) => `${x.role}:${x.sobject}`), ['pai:Contact', 'filho:OpportunityContactRole', 'filho:OpportunityContactRole']);
    const contatos = [...tgt.all('Contact').values()];
    assert.strictEqual(contatos.length, 1, 'contato criado uma vez');
    assert.ok([...tgt.all('OpportunityContactRole').values()].every((f) => f.ContactId === contatos[0].Id), 'filhos apontam para o contato real');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // o) raiz nova que bate em DUPLICATE_VALUE no próprio graph (já existe no destino): fica ligada e os filhos são criados
  const raizDuplicada = () => {
    const OPPF = [...FIELDS.Opportunity, str('Codigo__c', { unique: true })];
    const src = makeOrg('src', {
      Opportunity: [{ Id: OPP1, Name: 'Raiz', StageName: 'Prospecting', CloseDate: '2026-09-01', Codigo__c: 'COD1' }],
      OpportunityContactRole: [{ Id: id('OpportunityContactRole', 1), OpportunityId: OPP1, ContactId: null, Role: 'Papel 1' }],
    }, { fields: { Opportunity: OPPF } });
    const T9 = id('Opportunity', 'T9');
    const tgt = makeOrg('tgt', {
      Opportunity: [{ Id: T9, Name: 'Raiz (já existente)', StageName: 'Prospecting', CloseDate: '2026-09-01', Codigo__c: 'COD1' }],
    }, { fields: { Opportunity: OPPF } });
    return { src, tgt, T9 };
  };
  {
    const { src, tgt, T9 } = raizDuplicada();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-duplicada-'));
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:ok:1']);
    assert.deepStrictEqual([...tgt.all('Opportunity').values()].map((x) => x.Id), [T9], 'raiz ligada, não criada');
    const filhos = [...tgt.all('OpportunityContactRole').values()];
    assert.strictEqual(filhos.length, 1);
    assert.strictEqual(filhos[0].OpportunityId, T9, 'filho aponta para a raiz existente');
    assert.strictEqual(s.failedGraphs, 0);
    assert.ok(Object.keys(s.warnings).some((w) => w.includes('já existia no destino (Codigo__c duplicado)')), JSON.stringify(s.warnings));
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // o2) sem histórico (skipAlreadyCopied desligado), a mesma raiz sai como antes: 'ignorado', sem filhos
  {
    const { src, tgt } = raizDuplicada();
    const ev = [];
    const s = await engine.run(grandeCfg({ skipAlreadyCopied: false }), { ...harness(src, tgt), onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:skipped:0']);
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 0, 'sem histórico, filhos não são verificados');
    assert.strictEqual(s.failedGraphs, 0);
  }

  // m2) filho novo sob raiz reaproveitada, com neto reaproveitado que ganha neto novo: cada novo aponta para o pai real
  {
    const A = (n) => id('Account', n);
    const hierarquia = { children: { Account: [{ relationshipName: 'Filhas', childSObject: 'Account', field: 'ParentId' }] } };
    const src = makeOrg('src', { Account: [{ Id: A(1), Name: 'Raiz', ParentId: null }, { Id: A(2), Name: 'Filha', ParentId: A(1) }] }, hierarquia);
    const tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-neto-novo-'));
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [A(1)] }, children: { Account: ['Filhas'] },
      copyObjects: ['Account'], matchBy: {}, skipFields: { '*': ['OwnerId'] } };
    await engine.run(cfg, { ...harness(src, tgt), logDir });
    // A4 é filho novo da raiz; A2 (já copiada) passa a ser filha de A4; A5 é neta nova sob A2
    src.all('Account').set(A(4), { Id: A(4), Name: 'Nova', ParentId: A(1) });
    src.all('Account').get(A(2)).ParentId = A(4);
    src.all('Account').set(A(5), { Id: A(5), Name: 'Neta', ParentId: A(2) });
    const ev = [];
    await engine.run(cfg, { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:ok:2']);
    const T = [...tgt.all('Account').values()];
    const porNome = (nm) => T.find((x) => x.Name === nm);
    assert.strictEqual(T.length, 4, 'cada conta criada uma vez');
    assert.strictEqual(porNome('Nova').ParentId, porNome('Raiz').Id, 'filho novo aponta para a raiz real');
    assert.strictEqual(porNome('Neta').ParentId, porNome('Filha').Id, 'neta nova aponta para a filha reaproveitada');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // r) filho novo com subárvore maior que o limite: é dividido como nova raiz (núcleo + lotes dos netos), sem repetir registros
  {
    const A = (n) => id('Account', n);
    const hierarquia = { children: { Account: [{ relationshipName: 'Filhas', childSObject: 'Account', field: 'ParentId' }] } };
    const src = makeOrg('src', { Account: [{ Id: A(1), Name: 'Raiz', ParentId: null }] }, hierarquia);
    const tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-subarvore-'));
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [A(1)] }, children: { Account: ['Filhas'] },
      copyObjects: ['Account'], matchBy: {}, skipFields: { '*': ['OwnerId'] }, maxGraphNodes: 5 };
    await engine.run(cfg, { ...harness(src, tgt), logDir });
    src.all('Account').set(A(2), { Id: A(2), Name: 'Filha grande', ParentId: A(1) });
    for (let i = 1; i <= 8; i++) src.all('Account').set(A(100 + i), { Id: A(100 + i), Name: `Neta ${i}`, ParentId: A(2) });
    const ev = [];
    await engine.run(cfg, { ...harness(src, tgt), logDir, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1_1:ok:1', 'g1_2:ok:5', 'g1_3:ok:3']);
    const T = [...tgt.all('Account').values()];
    const porNome = (nm) => T.find((x) => x.Name === nm);
    assert.strictEqual(T.length, 10, 'cada conta criada uma vez');
    assert.strictEqual(porNome('Filha grande').ParentId, porNome('Raiz').Id);
    assert.ok(T.filter((x) => x.Name.startsWith('Neta')).every((x) => x.ParentId === porNome('Filha grande').Id), 'netas apontam para a filha real');
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // p) simulação: a raiz reaproveitada mostra o mesmo graph (filho novo), sem chamar o destino para gravar
  {
    const src = grandeOrg(0), tgt = makeOrg('tgt', {});
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgc-sim-reuso-'));
    await engine.run(grandeCfg(), { ...harness(src, tgt), logDir });
    const novo = id('OpportunityContactRole', 1);
    src.all('OpportunityContactRole').set(novo, { Id: novo, OpportunityId: OPP1, ContactId: null, Role: 'Novo' });
    const antes = tgt.calls.length;
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...harness(src, tgt), logDir, dryRun: true, onEvent: (e) => ev.push(e) });
    assert.ok(!tgt.calls.slice(antes).some((c) => c.includes('composite')), 'simulação não grava');
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:dry:1']);
    assert.ok(logsOf(ev).some((m) => m.includes('seriam enviados 1 registro(s) novo(s) ligados a ele.')), logsOf(ev).join('\n'));
    assert.strictEqual(s.created, 1);
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  // campo obrigatório sem valor (texto): simulação e gravação mostram o mesmo fail, com o motivo; o graph não é enviado
  {
    const ACC = [...FIELDS.Account, str('Regiao__c', { nillable: false })];
    const cfg = { source: 'src', target: 'tgt', root: { sobject: 'Account', ids: [id('Account', 1)] }, children: {},
      copyObjects: ['Account'], matchBy: {}, skipFields: { '*': ['OwnerId'], Account: ['ParentId'] } };
    const par = () => ({
      src: makeOrg('src', { Account: [{ Id: id('Account', 1), Name: 'Acme', ParentId: null, OwnerId: null }] }),
      tgt: makeOrg('tgt', {}, { fields: { Account: ACC } }),
    });
    const sim = par();
    const evS = [];
    const sS = await engine.run(cfg, { ...harness(sim.src, sim.tgt), dryRun: true, onEvent: (e) => evS.push(e) });
    const gS = graphsOf(evS);
    assert.deepStrictEqual(gS.map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:fail:1']);
    assert.deepStrictEqual(gS[0].errors.map((x) => x.message), ['Campo obrigatório sem valor: Account.Regiao__c']);
    assert.ok(gS[0].reason.includes('campo obrigatório sem valor'), gS[0].reason);
    assert.strictEqual(sS.failedGraphs, 1);
    assert.strictEqual(sS.created, 0, 'o que falharia não conta como criado');
    assert.ok(Object.keys(sS.warnings).includes('Account.Regiao__c é obrigatório no destino e ficou sem valor (a gravação vai falhar)'), JSON.stringify(sS.warnings));
    assert.ok(!sim.tgt.calls.some((c) => c.includes('composite')), 'simulação não grava');
    const real = par();
    const evR = [];
    const sR = await engine.run(cfg, { ...harness(real.src, real.tgt), onEvent: (e) => evR.push(e) });
    assert.deepStrictEqual(graphsOf(evR).map((x) => x.status), ['fail']);
    assert.strictEqual(sR.failedGraphs, 1);
    assert.ok(!real.tgt.calls.some((c) => c.includes('composite/graph')), 'graph não enviado ao destino');
    assert.strictEqual([...real.tgt.all('Account').values()].length, 0, 'nada criado');
  }

  // lote acima do limite com campo obrigatório vazio: só esse lote não é enviado; os outros são gravados
  {
    const ROLE_ORIGEM = [...FIELDS.OpportunityContactRole, str('Motivo__c')];
    const ROLE_DESTINO = [...FIELDS.OpportunityContactRole, str('Motivo__c', { nillable: false })];
    const src = makeOrg('src', {
      Opportunity: [{ Id: OPP1, Name: 'Raiz grande', StageName: 'Prospecting', CloseDate: '2026-09-01' }],
      OpportunityContactRole: Array.from({ length: 1200 }, (_, i) => ({ Id: id('OpportunityContactRole', i + 1), OpportunityId: OPP1, ContactId: null,
        Role: `Papel ${i + 1}`, Motivo__c: i === 600 ? null : 'Motivo' })),
    }, { fields: { OpportunityContactRole: ROLE_ORIGEM } });
    const tgt = makeOrg('tgt', {}, { fields: { OpportunityContactRole: ROLE_DESTINO } });
    const postados = [];
    const h = wrapFetch(harness(src, tgt), async (url, init, orig) => {
      if (url.includes('composite/graph')) postados.push(JSON.parse(init.body).graphs[0].graphId);
      return orig(url, init);
    });
    const ev = [];
    const s = await engine.run(grandeCfg(), { ...h, onEvent: (e) => ev.push(e) });
    assert.deepStrictEqual(graphsOf(ev).map((x) => `${x.graphId}:${x.status}:${x.nodes.length}`), ['g1:ok:1', 'g1_2:ok:500', 'g1_3:fail:500', 'g1_4:ok:200']);
    assert.deepStrictEqual(graphsOf(ev)[2].errors.map((x) => x.message), ['Campo obrigatório sem valor: OpportunityContactRole.Motivo__c']);
    assert.deepStrictEqual(postados, ['g1', 'g1_2', 'g1_4'], 'o lote com campo vazio não é enviado');
    assert.strictEqual([...tgt.all('OpportunityContactRole').values()].length, 700, 'lotes 1 e 3 gravados');
    assert.strictEqual(s.failedGraphs, 1);
    assert.ok(logsOf(ev).some((m) => m.includes('1 graph(s) falharam')), 'aviso de gravação parcial');
  }

  console.log('\nOK: todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
