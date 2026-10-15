'use strict';
/**
 * Integração com o Salesforce CLI (`sf`): localizar o executável, listar orgs,
 * fazer login e obter o token de acesso de uma org.
 */
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
let sfPathOverride = null;
let resolvedSf = null;
let pathFixed = false;

const ORG_REF = /^[A-Za-z0-9_.@+-]+$/; // alias ou username

function sh(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(
      cmd,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: process.env, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

const quote = (s) =>
  IS_WIN ? `"${String(s).replace(/"/g, '""')}"` : `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Apps gráficos no macOS/Linux não herdam o PATH do terminal, então `sf` e `node`
 * (instalados via Homebrew, nvm etc.) não seriam encontrados. Lê o PATH do shell de login.
 */
async function fixPath() {
  if (pathFixed) return;
  pathFixed = true;
  if (IS_WIN) return;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const { stdout } = await sh(`${shell} -ilc 'printf "__SFGC__%s__SFGC__" "$PATH"'`, { timeout: 15000 });
  const m = stdout.match(/__SFGC__(.*?)__SFGC__/s);
  const extra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
  ];
  const parts = [...(m ? m[1].split(':') : []), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(':');
}

function setSfPath(p) {
  sfPathOverride = p && String(p).trim() ? String(p).trim() : null;
  resolvedSf = null;
}

async function findSf() {
  if (resolvedSf) return resolvedSf;
  await fixPath();
  if (sfPathOverride) {
    if (!fs.existsSync(sfPathOverride)) throw new Error(`Caminho do sf não encontrado: ${sfPathOverride}`);
    resolvedSf = sfPathOverride;
    return resolvedSf;
  }
  const { stdout } = await sh(IS_WIN ? 'where sf' : 'command -v sf');
  const found = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const pick = IS_WIN ? found.find((p) => /\.cmd$/i.test(p)) || found[0] : found[0];
  if (!pick) {
    throw new Error(
      'Salesforce CLI (sf) não encontrado. Instale com "npm install -g @salesforce/cli" ou informe o caminho nas configurações.'
    );
  }
  resolvedSf = pick;
  return resolvedSf;
}

/**
 * Executa o sf com --json. Por padrão devolve `result` e lança erro se status != 0.
 * Com `raw: true` devolve o JSON inteiro (útil quando o erro traz detalhes, como no deploy).
 */
async function runSf(args, { timeout = 120000, cwd, raw = false } = {}) {
  const sf = await findSf();
  const cmd = [quote(sf), ...args.map(quote), '--json'].join(' ');
  const { err, stdout, stderr } = await sh(cmd, {
    timeout,
    cwd,
    env: { ...process.env, SF_AUTOUPDATE_DISABLE: 'true', SF_SKIP_NEW_VERSION_CHECK: 'true', FORCE_COLOR: '0' },
  });
  if (err && err.killed) throw new Error(`O comando sf demorou demais e foi interrompido (${Math.round(timeout / 60000)} min).`);
  let json = null;
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try { json = JSON.parse(stdout.slice(start)); } catch { /* saída não-JSON */ }
  }
  if (!json) throw new Error((stderr || (err && err.message) || 'Falha ao executar o sf').trim());
  if (raw) return json;
  if (json.status !== 0) throw new Error(json.message || json.name || 'Erro retornado pelo sf');
  return json.result;
}

async function sfVersion() {
  const sf = await findSf();
  const { err, stdout, stderr } = await sh(`${quote(sf)} --version`, { timeout: 60000 });
  if (err) throw new Error((stderr || err.message).trim());
  return stdout.trim().split(/\r?\n/)[0];
}

async function listOrgs() {
  const r = await runSf(['org', 'list']);
  const all = [
    ...(r.nonScratchOrgs || []),
    ...(r.sandboxes || []),
    ...(r.devHubs || []),
    ...(r.other || []),
    ...(r.scratchOrgs || []),
  ];
  const seen = new Map();
  for (const o of all) {
    if (!o.username || seen.has(o.username)) continue;
    seen.set(o.username, {
      ref: o.alias || o.username,
      alias: o.alias || null,
      username: o.username,
      instanceUrl: o.instanceUrl || '',
      isSandbox: !!o.isSandbox || /\.sandbox\.my\.salesforce\.com|--/.test(o.instanceUrl || ''),
      status: o.connectedStatus || '',
    });
  }
  return [...seen.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

async function loginWeb(alias, instanceUrl) {
  if (!ORG_REF.test(alias || '')) throw new Error('Apelido inválido. Use letras, números, ponto, hífen ou _.');
  let url;
  try { url = new URL(instanceUrl); } catch { throw new Error('URL de login inválida.'); }
  if (url.protocol !== 'https:') throw new Error('A URL de login precisa começar com https://');
  return runSf(['org', 'login', 'web', '--alias', alias, '--instance-url', url.origin], { timeout: 10 * 60 * 1000 });
}

const deps = { runSf };
function _setDeps(d) { Object.assign(deps, d); }

/** Token de verdade tem a forma "<orgId>!<sessão>"; o sf novo troca o valor por "[REDACTED]...". */
const isUsableToken = (t) => typeof t === 'string' && t.includes('!') && !/^\[RED/i.test(t);

async function connectOrg(ref) {
  if (!ORG_REF.test(ref || '')) throw new Error(`Org inválida: "${ref}"`);
  let r;
  try {
    r = await deps.runSf(['org', 'display', '--target-org', ref]);
  } catch (e) {
    throw new Error(`Não consegui conectar na org "${ref}": ${e.message.replace(/\.$/, '')}. Refaça o login: sf org login web -a ${ref}`);
  }
  // Versões novas do sf redigem o accessToken do `org display`: o real sai do `org auth show-access-token`.
  // Sem esse comando (CLI antiga), usa o token do display, desde que não esteja redigido.
  let token;
  try {
    token = (await deps.runSf(['org', 'auth', 'show-access-token', '--target-org', ref])).accessToken;
  } catch { /* comando inexistente ou falhou */ }
  if (!isUsableToken(token)) token = r && r.accessToken;
  if (!r || !isUsableToken(token)) throw new Error(`A org "${ref}" não retornou um token utilizável. Atualize o Salesforce CLI (npm install -g @salesforce/cli) ou refaça o login: sf org login web -a ${ref}`);
  return { alias: ref, instanceUrl: r.instanceUrl, token };
}

module.exports = { fixPath, setSfPath, findSf, sfVersion, listOrgs, loginWeb, connectOrg, runSf, ORG_REF, _setDeps };
