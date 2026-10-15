'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('../engine/engine');
const metadata = require('../engine/metadata');

const dataDir = () => app.getPath('userData');
const profilesDir = () => path.join(dataDir(), 'perfis');
const logsDir = () => path.join(dataDir(), 'logs');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const metadataDir = () => path.join(dataDir(), 'metadados');

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const loadSettings = () => ({ sfPath: '', ...readJson(settingsFile(), {}) });
const slug = (name) => String(name).trim().replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').slice(0, 80);

let win = null;
let running = null; // AbortController da execução atual

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    title: 'SF Graph Copy',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'Exibir',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Toda chamada devolve { ok, data } ou { ok:false, error } para a tela mostrar mensagens limpas
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
  });
}

// ---------------------------------------------------------------- sf CLI e configurações
handle('sf:status', async () => {
  const p = await engine.sf.findSf();
  const version = await engine.sf.sfVersion();
  return { path: p, version };
});
handle('settings:get', async () => loadSettings());
handle('settings:set', async (s) => {
  const next = { ...loadSettings(), ...s };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  engine.sf.setSfPath(next.sfPath);
  engine.clearSchemaCache();
  return next;
});
handle('settings:pickSf', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Localizar o executável do sf', properties: ['openFile', 'showHiddenFiles'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------------------------------------------------------------- orgs e esquema
handle('orgs:list', async () => engine.sf.listOrgs());
handle('orgs:login', async (alias, url) => {
  const r = await engine.sf.loginWeb(alias, url);
  engine.clearSchemaCache();
  return r;
});
handle('schema:objects', async (ref, v) => engine.listObjects(ref, v));
handle('schema:describe', async (ref, sobject, v) => engine.describeObject(ref, sobject, v));
handle('schema:describeRaw', async (ref, sobject, v) => engine.describeRaw(ref, sobject, v));
// Descarta o que foi lido das orgs (describes e listas de metadados): a próxima consulta vai ao Salesforce
const clearOrgCaches = () => { engine.clearSchemaCache(); metadata.clearCache(); };
handle('schema:refresh', async () => { clearOrgCaches(); return true; });

// ---------------------------------------------------------------- metadados
let mdRunning = false;
handle('md:types', async (ref, refresh) => metadata.listTypes(ref, { refresh }));
handle('md:components', async (src, tgt, type, refresh) => metadata.compareComponents(src, tgt, type, { refresh }));
handle('md:fields', async (src, tgt, object, apiVersion, refresh) => metadata.compareFields(src, tgt, object, { apiVersion, refresh }));
handle('md:transfer', async (req) => {
  if (mdRunning) throw new Error('Já existe uma transferência de metadados em andamento.');
  const n = (req.members || []).length;
  if (!req.dryRun) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancelar', 'Implantar'],
      defaultId: 0,
      cancelId: 0,
      message: `Implantar ${n} componente(s) na org "${req.target}"?`,
      detail: `Origem: ${req.source}\nComponentes que já existem no destino serão sobrescritos.\n\nDica: use "Validar" antes para conferir sem gravar.`,
    });
    if (r.response !== 1) return { cancelled: true };
  }
  mdRunning = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    return await metadata.transfer({
      ...req,
      workDir: path.join(metadataDir(), `${stamp}-${req.dryRun ? 'validacao' : 'implantacao'}`),
      onEvent: (e) => { if (win && !win.isDestroyed()) win.webContents.send('md:event', e); },
    });
  } finally {
    mdRunning = false;
    // Depois de implantar, o destino mudou (mesmo se a resposta falhou): as leituras em cache ficam velhas
    if (!req.dryRun) clearOrgCaches();
  }
});
handle('md:openDir', async (dir) => { if (dir && fs.existsSync(dir)) await shell.openPath(dir); return true; });

// ---------------------------------------------------------------- perfis
handle('profiles:list', async () => {
  fs.mkdirSync(profilesDir(), { recursive: true });
  return fs.readdirSync(profilesDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => a.localeCompare(b));
});
handle('profiles:load', async (name) => {
  const f = path.join(profilesDir(), `${slug(name)}.json`);
  if (!fs.existsSync(f)) throw new Error(`Perfil "${name}" não encontrado.`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
});
handle('profiles:save', async (name, cfg) => {
  const n = slug(name);
  if (!n) throw new Error('Nome de perfil inválido.');
  fs.mkdirSync(profilesDir(), { recursive: true });
  fs.writeFileSync(path.join(profilesDir(), `${n}.json`), JSON.stringify(cfg, null, 2));
  return n;
});
handle('profiles:delete', async (name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancelar', 'Excluir'], defaultId: 0, cancelId: 0,
    message: `Excluir o perfil "${name}"?`,
  });
  if (r.response !== 1) return false;
  fs.rmSync(path.join(profilesDir(), `${slug(name)}.json`), { force: true });
  return true;
});
handle('config:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Importar config', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
});
handle('config:export', async (cfg) => {
  const r = await dialog.showSaveDialog(win, { title: 'Exportar config', defaultPath: 'config.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(cfg, null, 2));
  return r.filePath;
});

// ---------------------------------------------------------------- execução
handle('run:start', async (cfg, dryRun) => {
  if (running) throw new Error('Já existe uma execução em andamento.');
  const norm = engine.normalizeConfig(cfg);
  const errs = engine.validateConfig(norm);
  if (errs.length) throw new Error(errs.join('\n'));

  if (!dryRun) {
    const filtro = norm.root.ids.length ? `${norm.root.ids.length} ID(s) informado(s)` : `WHERE ${norm.root.where}${norm.root.limit ? ` LIMIT ${norm.root.limit}` : ''}`;
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancelar', 'Gravar no destino'],
      defaultId: 0,
      cancelId: 0,
      message: `Gravar registros na org "${norm.target}"?`,
      detail: `Origem: ${norm.source}\nObjeto raiz: ${norm.root.sobject}\nFiltro: ${filtro}\n\nOs registros serão criados de verdade na org destino.`,
    });
    if (r.response !== 1) return { cancelled: true };
  }

  running = new AbortController();
  try {
    return await engine.run(cfg, {
      dryRun: !!dryRun,
      signal: running.signal,
      logDir: logsDir(),
      onEvent: (e) => { if (win && !win.isDestroyed()) win.webContents.send('run:event', e); },
    });
  } finally {
    running = null;
  }
});
handle('run:cancel', async () => { if (running) running.abort(); return true; });
handle('log:show', async (file) => { if (file && fs.existsSync(file)) shell.showItemInFolder(file); return true; });
handle('logs:open', async () => { fs.mkdirSync(logsDir(), { recursive: true }); await shell.openPath(logsDir()); return true; });

// ---------------------------------------------------------------- ciclo de vida
app.whenReady().then(() => {
  engine.sf.setSfPath(loadSettings().sfPath);
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
