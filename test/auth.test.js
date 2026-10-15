'use strict';
/**
 * Testes da autenticação: token obtido pelo sf (sf-cli.connectOrg) e renovação da sessão no cliente REST (engine).
 * O sf e o Salesforce são simulados; os tokens são fictícios.
 *   node test/auth.test.js
 */
const assert = require('assert');
const sf = require('../engine/sf-cli');
const engine = require('../engine/engine');

const REDIGIDO = '[REDACTED]...';
const TOKEN_1 = '00D000000000001!SESSAO_1';
const TOKEN_2 = '00D000000000001!SESSAO_2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sf simulado. Como nas versões novas, o `org display` devolve o token redigido.
// `show-access-token` devolve state.token; showMode 'falha' simula CLI sem o comando e 'redigido' devolve o token mascarado.
const state = { token: TOKEN_1, displayToken: REDIGIDO, displayFalha: false, showMode: 'ok', showCalls: 0, delay: 0 };
async function fakeRunSf(args) {
  if (state.delay) await sleep(state.delay);
  const cmd = args.join(' ');
  if (cmd === 'org display --target-org qa') {
    if (state.displayFalha) throw new Error('Sessão do sf inválida');
    return { instanceUrl: 'https://qa.example.com', accessToken: state.displayToken };
  }
  if (cmd === 'org auth show-access-token --target-org qa') {
    state.showCalls++;
    if (state.showMode === 'falha') throw new Error("Command 'org auth show-access-token' not found");
    return { accessToken: state.showMode === 'redigido' ? REDIGIDO : state.token };
  }
  throw new Error(`comando não simulado: ${cmd}`);
}

// Salesforce simulado: só aceita o token em http.aceito; qualquer outro recebe 401, como a API real.
// http.atraso (objeto -> ms) segura a resposta de um objeto, para controlar a ordem dos 401.
const http = { aceito: TOKEN_1, n401: 0, atraso: {} };
globalThis.fetch = async (url, init) => {
  const objeto = url.match(/\/sobjects\/(\w+)\/describe$/)[1];
  const ms = http.atraso[objeto] ?? state.delay;
  if (ms) await sleep(ms);
  if (init.headers.Authorization !== `Bearer ${http.aceito}`) {
    http.n401++;
    return { ok: false, status: 401, text: async () => '[{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]' };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ name: objeto, fields: [{ name: 'Id' }] }) };
};

function reset(extra = {}) {
  Object.assign(state, { token: TOKEN_1, displayToken: REDIGIDO, displayFalha: false, showMode: 'ok', showCalls: 0, delay: 0 }, extra);
  Object.assign(http, { aceito: TOKEN_1, n401: 0, atraso: {} });
  engine.clearSchemaCache();
}

sf._setDeps({ runSf: fakeRunSf });

(async () => {
  // a) display redigido: o token vem do show-access-token
  reset();
  assert.deepStrictEqual(await sf.connectOrg('qa'), { alias: 'qa', instanceUrl: 'https://qa.example.com', token: TOKEN_1 });
  assert.strictEqual(state.showCalls, 1);

  // b) CLI sem show-access-token: usa o token do display, desde que não esteja redigido
  reset({ showMode: 'falha', displayToken: TOKEN_2 });
  assert.strictEqual((await sf.connectOrg('qa')).token, TOKEN_2);

  // c) nenhum token utilizável: erro claro em pt-BR; falha no display mantém a mensagem de antes
  reset({ showMode: 'falha' });
  await assert.rejects(sf.connectOrg('qa'), /não retornou um token utilizável.*npm install -g @salesforce\/cli.*sf org login web -a qa/);
  reset({ showMode: 'redigido' });
  await assert.rejects(sf.connectOrg('qa'), /não retornou um token utilizável/);
  reset({ displayFalha: true });
  await assert.rejects(sf.connectOrg('qa'), /Não consegui conectar na org "qa".*sf org login web -a qa/);

  // d) 401 com o token antigo: renova uma vez e a chamada passa
  reset();
  await engine.describeRaw('qa', 'Account');
  state.token = TOKEN_2;
  http.aceito = TOKEN_2;
  assert.strictEqual((await engine.describeRaw('qa', 'Contact')).name, 'Contact');
  assert.strictEqual(state.showCalls, 2, 'conexão inicial + uma renovação');
  assert.strictEqual(http.n401, 1);

  // e) 401 de novo depois da renovação: erro de sessão expirada, sem laço
  reset();
  await engine.describeRaw('qa', 'Account');
  state.token = TOKEN_2; // o sf entrega um token novo, mas a org não aceita
  http.aceito = 'outro';
  await assert.rejects(engine.describeRaw('qa', 'Contact'), /A sessão da org "qa" expirou.*sf org login web -a qa/);
  assert.strictEqual(state.showCalls, 2, 'só uma renovação');
  assert.strictEqual(http.n401, 2);

  // f) várias requisições 401 ao mesmo tempo: um único connect
  reset();
  await engine.describeRaw('qa', 'Account');
  state.token = TOKEN_2;
  http.aceito = TOKEN_2;
  state.delay = 10; // o connect demora, então as outras 401 chegam enquanto ele roda
  const objetos = ['Contact', 'Opportunity', 'Product2', 'Pricebook2'];
  const descs = await Promise.all(objetos.map((o) => engine.describeRaw('qa', o)));
  assert.deepStrictEqual(descs.map((d) => d.name), objetos);
  assert.strictEqual(http.n401, objetos.length, 'todas receberam 401');
  assert.strictEqual(state.showCalls, 2, 'um único connect para as quatro');

  // g) 401 que chega depois de outra chamada já ter renovado: repete com o token novo, sem novo connect
  reset();
  await engine.describeRaw('qa', 'Account');
  state.token = TOKEN_2;
  http.aceito = TOKEN_2;
  http.atraso = { Contact: 40 }; // a resposta de Contact (com o token antigo) chega depois da renovação
  state.delay = 10;
  const [lento, rapido] = await Promise.all([engine.describeRaw('qa', 'Contact'), engine.describeRaw('qa', 'Opportunity')]);
  assert.deepStrictEqual([lento.name, rapido.name], ['Contact', 'Opportunity']);
  assert.strictEqual(http.n401, 2, 'as duas receberam 401 com o token antigo');
  assert.strictEqual(state.showCalls, 2, 'a renovação tardia não gera outro connect');

  // h) conexão que falhou não fica em cache: a próxima chamada tenta de novo
  reset({ displayFalha: true });
  await assert.rejects(engine.describeRaw('qa', 'Account'), /Não consegui conectar/);
  state.displayFalha = false;
  assert.strictEqual((await engine.describeRaw('qa', 'Account')).name, 'Account');

  console.log('OK: testes de autenticação passaram');
})().catch((e) => { console.error(e); process.exit(1); });
