'use strict';
/* global api */

// ---------------------------------------------------------------- utilitários
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value' || k === 'open') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
};

function toast(msg, isError = false, ms = 4500) {
  const t = el('div', { class: `toast${isError ? ' err' : ''}`, text: msg });
  $('toasts').append(t);
  setTimeout(() => t.remove(), isError ? ms * 2 : ms);
}

function modal({ title, body, okText = 'OK', cancelText = 'Cancelar' }) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalBody').replaceChildren(...body);
    $('modalOk').textContent = okText;
    $('modalCancel').textContent = cancelText;
    $('modal').hidden = false;
    const first = $('modalBody').querySelector('input, select, textarea');
    if (first) setTimeout(() => first.focus(), 0);
    const ok = () => done(true);
    const cancel = () => done(false);
    const key = (e) => {
      if (e.key === 'Escape') cancel();
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); ok(); }
    };
    function done(v) {
      $('modal').hidden = true;
      $('modalOk').removeEventListener('click', ok);
      $('modalCancel').removeEventListener('click', cancel);
      document.removeEventListener('keydown', key);
      resolve(v);
    }
    $('modalOk').addEventListener('click', ok);
    $('modalCancel').addEventListener('click', cancel);
    document.addEventListener('keydown', key);
  });
}
async function askText(title, label, value = '') {
  const input = el('input', { value });
  const ok = await modal({ title, body: [el('div', { class: 'field' }, el('label', { text: label }), input)] });
  return ok ? input.value.trim() : null;
}

// ---------------------------------------------------------------- estado
const DEFAULT_CFG = {
  source: '',
  target: '',
  apiVersion: '61.0',
  root: { sobject: 'Opportunity', ids: [], where: '', limit: 20 },
  children: { Opportunity: ['OpportunityLineItems', 'OpportunityContactRoles'] },
  copyObjects: ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem', 'OpportunityContactRole', 'Pricebook2', 'PricebookEntry', 'Product2'],
  maxParentDepth: 3,
  reuseExisting: true,
  skipAlreadyCopied: true,
  updateExisting: true,
  autoExternalId: true,
  maxGraphNodes: 500,
  matchBy: {
    Account: ['Name'],
    Contact: ['Email'],
    Product2: ['ProductCode'],
    Pricebook2: ['Name'],
    PricebookEntry: ['Pricebook2Id', 'Product2Id', 'CurrencyIsoCode?'],
  },
  linkOnly: { User: ['Email'] },
  sourceIdField: {},
  skipFields: { '*': ['OwnerId'], Account: ['ParentId'] },
};

const S = {
  orgs: [],
  mode: 'ids',
  rootDesc: null,
  selectedChildren: new Set(),
  copyObjects: [],
  objectsLoadedFor: null,
  pending: {},
  view: 'home',
  profile: '',
  running: false,
  run: null,
};

const apiV = () => $('apiVersion').value.trim() || '61.0';

// ---------------------------------------------------------------- sf CLI
async function refreshSfStatus() {
  const pill = $('sfPill');
  pill.className = 'pill';
  pill.textContent = 'verificando sf…';
  try {
    const s = await api.sfStatus();
    pill.className = 'pill ok';
    pill.textContent = s.version.replace(/^@salesforce\/cli\//, 'sf ').split(' ').slice(0, 2).join(' ');
    pill.title = s.path;
    return true;
  } catch (e) {
    pill.className = 'pill err';
    pill.textContent = 'sf não encontrado';
    pill.title = e.message;
    toast(e.message, true);
    return false;
  }
}

async function openSettings() {
  const settings = await api.getSettings().catch(() => ({ sfPath: '' }));
  const input = el('input', { value: settings.sfPath || '', placeholder: 'Detectar automaticamente', class: 'mono' });
  const status = el('div', { class: 'hint' });
  const body = [
    el('div', { class: 'field' },
      el('label', { text: 'Caminho do executável sf (deixe vazio para detectar)' }),
      el('div', { class: 'row' }, input,
        el('button', { class: 'btn', text: 'Procurar…', onclick: async () => { const p = await api.pickSf(); if (p) input.value = p; } }))),
    status,
    el('div', { class: 'row' },
      el('button', { class: 'btn ghost small', text: 'Abrir pasta de logs', onclick: () => api.openLogs() })),
  ];
  if ((await modal({ title: 'Configurações', body, okText: 'Salvar' })) === false) return;
  await api.setSettings({ sfPath: input.value.trim() });
  if (await refreshSfStatus()) loadOrgs();
}

// ---------------------------------------------------------------- orgs
function setSelect(id, value) {
  const sel = $(id);
  if (value && ![...sel.options].some((o) => o.value === value)) {
    sel.append(el('option', { value, text: `${value} (não conectada)` }));
  }
  sel.value = value || '';
}

const ORG_SELECTS = ['srcOrg', 'tgtOrg', 'mdSrcOrg', 'mdTgtOrg'];

async function loadOrgs() {
  const keep = {};
  for (const id of ORG_SELECTS) keep[id] = $(id).value || S.pending[id] || '';
  document.querySelectorAll('.js-refresh-orgs').forEach((b) => { b.disabled = true; });
  try {
    S.orgs = await api.listOrgs();
  } catch (e) {
    S.orgs = [];
    toast(`Não consegui listar as orgs: ${e.message}`, true);
  } finally {
    document.querySelectorAll('.js-refresh-orgs').forEach((b) => { b.disabled = false; });
  }
  for (const id of ORG_SELECTS) {
    $(id).replaceChildren(
      el('option', { value: '', text: S.orgs.length ? '— escolha —' : '— nenhuma org conectada —' }),
      ...S.orgs.map((o) => el('option', { value: o.ref, text: `${o.ref}${o.isSandbox ? '  · sandbox' : ''}` }))
    );
    setSelect(id, keep[id]);
  }
  S.pending = {};
  onOrgsChanged();
  mdOnOrgsChanged();
  renderHomeStatus();
}

/** Atualiza as linhas de usuário e o alerta de um par origem/destino. */
function orgPairStatus(srcId, tgtId, srcInfoId, tgtInfoId, warnId) {
  const src = $(srcId).value;
  const tgt = $(tgtId).value;
  const si = orgInfo(src), ti = orgInfo(tgt);
  $(srcInfoId).textContent = si ? si.username : '';
  $(tgtInfoId).textContent = ti ? ti.username : '';
  const warn = $(warnId);
  warn.hidden = true;
  warn.className = 'alert';
  if (src && src === tgt) {
    warn.hidden = false; warn.classList.add('bad');
    warn.textContent = 'Origem e destino são a mesma org.';
  } else if (ti && !ti.isSandbox) {
    warn.hidden = false;
    warn.textContent = 'Atenção: o destino não parece ser uma sandbox. Confira antes de executar.';
  }
  return { src, tgt };
}

function orgInfo(ref) { return S.orgs.find((o) => o.ref === ref); }

function onOrgsChanged() {
  const { src } = orgPairStatus('srcOrg', 'tgtOrg', 'srcInfo', 'tgtInfo', 'orgWarn');
  if (src && S.objectsLoadedFor !== src && orgInfo(src)) loadObjects(src);
  loadRootDescribe();
  persist();
}

async function loadObjects(src) {
  S.objectsLoadedFor = src;
  try {
    const objs = await api.listObjects(src, apiV());
    $('objectList').replaceChildren(...objs.map((o) => el('option', { value: o.name, text: o.label })));
  } catch (e) {
    S.objectsLoadedFor = null;
    toast(`Não consegui ler os objetos da origem: ${e.message}`, true);
  }
}

async function addOrgFlow() {
  const alias = el('input', { placeholder: 'ex.: dev-sandbox', spellcheck: 'false' });
  const env = el('select', {},
    el('option', { value: 'https://test.salesforce.com', text: 'Sandbox (test.salesforce.com)' }),
    el('option', { value: 'https://login.salesforce.com', text: 'Produção / Developer (login.salesforce.com)' }),
    el('option', { value: 'custom', text: 'Domínio personalizado…' }));
  const url = el('input', { placeholder: 'https://suaempresa--dev.sandbox.my.salesforce.com', spellcheck: 'false' });
  const urlField = el('div', { class: 'field' }, el('label', { text: 'URL de login' }), url);
  urlField.hidden = true;
  env.addEventListener('change', () => { urlField.hidden = env.value !== 'custom'; });
  const ok = await modal({
    title: 'Conectar org',
    okText: 'Abrir login no navegador',
    body: [
      el('div', { class: 'field' }, el('label', { text: 'Apelido' }), alias),
      el('div', { class: 'field' }, el('label', { text: 'Ambiente' }), env),
      urlField,
      el('div', { class: 'hint', text: 'O login usa o Salesforce CLI (sf org login web).' }),
    ],
  });
  if (!ok) return;
  const instance = env.value === 'custom' ? url.value.trim() : env.value;
  toast('Conclua o login na janela do navegador…');
  try {
    await api.loginOrg(alias.value.trim(), instance);
    toast(`Org "${alias.value.trim()}" conectada.`);
    await loadOrgs();
  } catch (e) {
    toast(`Falha no login: ${e.message}`, true);
  }
}

// ---------------------------------------------------------------- objeto raiz e filhos
function setMode(mode) {
  S.mode = mode;
  $('modeIds').classList.toggle('active', mode === 'ids');
  $('modeWhere').classList.toggle('active', mode === 'where');
  $('idsBox').hidden = mode !== 'ids';
  $('whereBox').hidden = mode !== 'where';
  persist();
}

const loadRootDescribe = debounce(async () => {
  const src = $('srcOrg').value;
  const obj = $('rootObject').value.trim();
  $('soqlObj').textContent = obj || '…';
  if (!src || !obj || !orgInfo(src)) { S.rootDesc = null; renderChildren(); return; }
  try {
    S.rootDesc = await api.describeObject(src, obj, apiV());
  } catch {
    S.rootDesc = { name: obj, children: [], error: `Objeto "${obj}" não encontrado na origem.` };
  }
  renderChildren();
}, 350);

function renderChildren() {
  const list = $('childList');
  const filter = $('childFilter').value.trim().toLowerCase();
  const d = S.rootDesc;
  $('childCount').textContent = S.selectedChildren.size ? `${S.selectedChildren.size} selecionado(s)` : '';
  if (!d) {
    list.replaceChildren(el('div', { class: 'empty', text: 'Escolha a origem e o objeto raiz.' }));
    return;
  }
  const known = new Map(d.children.map((c) => [c.relationshipName, c]));
  const items = [...d.children];
  for (const r of S.selectedChildren) if (!known.has(r)) items.push({ relationshipName: r, childSObject: '?', missing: true });
  const visible = items
    .filter((c) => !filter || `${c.relationshipName} ${c.childSObject}`.toLowerCase().includes(filter))
    .sort((a, b) => (S.selectedChildren.has(b.relationshipName) - S.selectedChildren.has(a.relationshipName)) || a.relationshipName.localeCompare(b.relationshipName));
  if (d.error && !items.length) {
    list.replaceChildren(el('div', { class: 'empty', text: d.error }));
    return;
  }
  if (!visible.length) {
    list.replaceChildren(el('div', { class: 'empty', text: 'Nenhum relacionamento encontrado.' }));
    return;
  }
  list.replaceChildren(...visible.map((c) => {
    const on = S.selectedChildren.has(c.relationshipName);
    const cb = el('input', { type: 'checkbox', checked: on });
    const item = el('label', { class: `item${on ? ' on' : ''}` },
      cb,
      el('span', { text: c.relationshipName }),
      el('span', { class: 'sub', text: c.missing ? 'não encontrado na origem' : `${c.childSObject} · ${c.field}` }));
    cb.addEventListener('change', () => {
      if (cb.checked) {
        S.selectedChildren.add(c.relationshipName);
        if (c.childSObject && c.childSObject !== '?' && !S.copyObjects.includes(c.childSObject)) {
          S.copyObjects.push(c.childSObject);
          renderChips();
        }
      } else S.selectedChildren.delete(c.relationshipName);
      renderChildren();
      persist();
    });
    return item;
  }));
}

// ---------------------------------------------------------------- objetos copiáveis
function renderChips() {
  $('chips').replaceChildren(...S.copyObjects.map((o) =>
    el('span', { class: 'chip' }, o,
      el('button', { title: `Remover ${o}`, text: '×', onclick: () => { S.copyObjects = S.copyObjects.filter((x) => x !== o); renderChips(); persist(); } }))));
}
function addChip(name) {
  const n = name.trim();
  if (!n) return;
  if (!/^\w+$/.test(n)) return toast('Nome de objeto inválido.', true);
  if (!S.copyObjects.includes(n)) S.copyObjects.push(n);
  renderChips();
  persist();
}

// Lê o matchBy como o motor: texto é uma regra; lista com algum item lista tem uma regra por item; lista de textos é uma regra só
function keySetsOf(v) {
  if (typeof v === 'string') return v.trim() ? [[v.trim()]] : [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' || (Array.isArray(x) && x.every((y) => typeof y === 'string')))) return null;
  const sets = v.some(Array.isArray) ? v.map((x) => (Array.isArray(x) ? x : [x])) : [v];
  return sets.map((s) => s.map((k) => k.trim()).filter(Boolean)).filter((s) => s.length);
}

// Campos únicos ou externalId da origem entram como primeira regra de cada objeto; o que já existe fica depois
async function suggestUniqueKeys(src, objects) {
  let matchBy;
  try { matchBy = parseJsonField('matchBy', 'matchBy'); } catch (e) { toast(e.message, true); return []; }
  const added = [];
  for (const obj of objects) {
    const current = matchBy[obj] === undefined ? [] : keySetsOf(matchBy[obj]);
    if (current === null) continue;
    let desc;
    try { desc = await api.describeRaw(src, obj, apiV()); } catch { continue; }
    const unique = desc.fields.filter((f) => f.name !== 'Id' && (f.externalId || f.unique) && f.filterable).map((f) => f.name);
    const fresh = unique.filter((name) => !current.some((set) => set.length === 1 && set[0].replace(/\?$/, '') === name));
    if (!fresh.length) continue;
    matchBy[obj] = [...fresh.map((name) => [name]), ...current];
    added.push(`${obj} por ${fresh.join(', ')}`);
  }
  if (added.length) $('matchBy').value = JSON.stringify(matchBy, null, 2);
  return added;
}

async function suggestObjects() {
  const src = $('srcOrg').value;
  const root = $('rootObject').value.trim();
  if (!src || !root || !orgInfo(src)) return toast('Escolha a origem e o objeto raiz primeiro.', true);
  const btn = $('btnSuggest');
  btn.disabled = true;
  const before = new Set(S.copyObjects);
  const add = new Set(S.copyObjects);
  const IGNORE = new Set(['User', 'Group', 'RecordType', 'Organization', 'Profile', 'UserRole', 'BusinessHours', 'Queue']);
  const STRONG = new Set(['AccountId', 'ContactId', 'Pricebook2Id', 'Product2Id', 'PricebookEntryId', 'OpportunityId']);
  const queue = [[root, 0]];
  add.add(root);
  for (const rel of S.selectedChildren) {
    const c = S.rootDesc && S.rootDesc.children.find((x) => x.relationshipName === rel);
    if (c) { add.add(c.childSObject); queue.push([c.childSObject, 0]); }
  }
  const seen = new Set();
  const depth = Number($('maxDepth').value) || 3;
  try {
    while (queue.length) {
      const [o, d] = queue.shift();
      if (seen.has(o) || d > depth) continue;
      seen.add(o);
      let desc;
      try { desc = await api.describeObject(src, o, apiV()); } catch { continue; }
      for (const p of desc.parents) {
        if (!p.required && !STRONG.has(p.field)) continue;
        for (const t of p.referenceTo) {
          if (IGNORE.has(t)) continue;
          add.add(t);
          queue.push([t, d + 1]);
        }
      }
    }
  } finally {
    btn.disabled = false;
  }
  S.copyObjects = [...add];
  renderChips();
  persist();
  const added = S.copyObjects.filter((x) => !before.has(x));
  toast(added.length ? `Adicionados: ${added.join(', ')}` : 'Nenhum objeto novo para sugerir.');
  // Só objetos criáveis: em linkOnly a chave única costuma variar entre orgs (ex.: Username com sufixo da sandbox)
  const keyAdds = await suggestUniqueKeys(src, S.copyObjects);
  if (keyAdds.length) {
    persist();
    toast(`Chaves únicas sugeridas: ${keyAdds.join('; ')}`);
  }
}

// ---------------------------------------------------------------- formulário <-> config
function parseJsonField(id, label) {
  const box = $(id);
  box.classList.remove('invalid');
  const t = box.value.trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    box.classList.add('invalid');
    box.closest('details') && (box.closest('details').open = true);
    throw new Error(`${label}: JSON inválido.`);
  }
}

function formToConfig() {
  const sobject = $('rootObject').value.trim();
  const root = { sobject };
  if (S.mode === 'ids') {
    root.ids = $('rootIds').value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  } else {
    root.where = $('rootWhere').value.trim();
    const l = parseInt($('rootLimit').value, 10);
    if (l > 0) root.limit = l;
  }
  const children = { ...parseJsonField('extraChildren', 'Filhos de outros níveis') };
  if (sobject && S.selectedChildren.size) children[sobject] = [...S.selectedChildren];
  return {
    source: $('srcOrg').value,
    target: $('tgtOrg').value,
    apiVersion: apiV(),
    root,
    children,
    copyObjects: [...S.copyObjects],
    maxParentDepth: Number($('maxDepth').value) || 0,
    reuseExisting: $('reuseExisting').checked,
    skipAlreadyCopied: $('skipAlreadyCopied').checked,
    updateExisting: $('updateExisting').checked,
    autoExternalId: $('autoExternalId').checked,
    maxGraphNodes: Number($('maxNodes').value) || 500,
    matchBy: parseJsonField('matchBy', 'matchBy'),
    linkOnly: parseJsonField('linkOnly', 'Objetos só para ligar'),
    sourceIdField: parseJsonField('sourceIdField', 'Campo de ID de origem'),
    skipFields: parseJsonField('skipFields', 'skipFields'),
  };
}

function configToForm(cfg) {
  const c = { ...DEFAULT_CFG, ...cfg, root: { ...DEFAULT_CFG.root, ...(cfg.root || {}) } };
  S.pending.srcOrg = c.source;
  S.pending.tgtOrg = c.target;
  setSelect('srcOrg', c.source);
  setSelect('tgtOrg', c.target);
  $('apiVersion').value = c.apiVersion || '61.0';
  $('rootObject').value = c.root.sobject || '';
  const ids = Array.isArray(c.root.ids) ? c.root.ids : String(c.root.ids || '').split(/[\s,;]+/).filter(Boolean);
  $('rootIds').value = ids.join('\n');
  $('rootWhere').value = c.root.where || '';
  $('rootLimit').value = c.root.limit || '';
  setMode(ids.length || !c.root.where ? 'ids' : 'where');
  const children = { ...(c.children || {}) };
  S.selectedChildren = new Set(children[c.root.sobject] || []);
  delete children[c.root.sobject];
  $('extraChildren').value = Object.keys(children).length ? JSON.stringify(children, null, 2) : '';
  S.copyObjects = [...(c.copyObjects || [])];
  $('maxDepth').value = c.maxParentDepth ?? 3;
  $('reuseExisting').checked = c.reuseExisting !== false;
  $('skipAlreadyCopied').checked = c.skipAlreadyCopied !== false;
  $('updateExisting').checked = c.updateExisting !== false;
  $('autoExternalId').checked = c.autoExternalId !== false;
  $('maxNodes').value = c.maxGraphNodes || 500;
  $('matchBy').value = JSON.stringify(c.matchBy || {}, null, 2);
  $('linkOnly').value = Object.keys(c.linkOnly || {}).length ? JSON.stringify(c.linkOnly, null, 2) : '';
  $('sourceIdField').value = Object.keys(c.sourceIdField || {}).length ? JSON.stringify(c.sourceIdField, null, 2) : '';
  $('skipFields').value = JSON.stringify(c.skipFields || {}, null, 2);
  renderChips();
  onOrgsChanged();
}

const persist = debounce(() => {
  try { store.set('sfgc:last', formToConfig()); } catch { /* JSON inválido: não salva */ }
}, 500);

// ---------------------------------------------------------------- perfis
async function refreshProfiles(select) {
  const names = await api.listProfiles().catch(() => []);
  $('profileSelect').replaceChildren(el('option', { value: '', text: '— sem perfil —' }), ...names.map((n) => el('option', { value: n, text: n })));
  const want = select !== undefined ? select : S.profile;
  S.profile = names.includes(want) ? want : '';
  $('profileSelect').value = S.profile;
  store.set('sfgc:profile', S.profile);
}

async function saveProfile(asNew) {
  let cfg;
  try { cfg = formToConfig(); } catch (e) { return toast(e.message, true); }
  let name = S.profile;
  if (asNew || !name) {
    name = await askText('Salvar perfil', 'Nome do perfil', name || cfg.root.sobject || '');
    if (!name) return;
  }
  try {
    const saved = await api.saveProfile(name, cfg);
    await refreshProfiles(saved);
    toast(`Perfil "${saved}" salvo.`);
  } catch (e) { toast(e.message, true); }
}

async function profileMenu(act) {
  $('profileMenu').hidden = true;
  try {
    if (act === 'saveAs') return saveProfile(true);
    if (act === 'import') {
      const cfg = await api.importConfig();
      if (cfg) { configToForm(cfg); await loadOrgs(); toast('Config importada.'); }
    }
    if (act === 'export') {
      const p = await api.exportConfig(formToConfig());
      if (p) toast(`Config exportada para ${p}`);
    }
    if (act === 'delete') {
      if (!S.profile) return toast('Nenhum perfil selecionado.', true);
      if (await api.deleteProfile(S.profile)) { await refreshProfiles(''); toast('Perfil excluído.'); }
    }
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- execução e resultados
function setRunning(on) {
  S.running = on;
  $('btnDry').hidden = on;
  $('btnRun').hidden = on;
  $('btnCancel').hidden = !on;
  $('btnCancel').disabled = false;
  document.querySelector('.config-scroll').classList.toggle('locked', on);
  $('profileSelect').disabled = on;
}

function setPhase(text, busy) {
  $('phase').replaceChildren(...(busy ? [el('span', { class: 'spinner' })] : []), el('span', { text }));
}

function appendLog(msg, level = 'info') {
  const time = new Date().toLocaleTimeString();
  $('tab-log').append(el('div', { class: level === 'warn' ? 'w' : level === 'error' ? 'e' : '' }, `${time}  ${msg}`));
}

function resetRun(dry) {
  S.run = { dry, graphs: 0, created: 0, failed: 0, logFile: null };
  $('emptyState').hidden = true;
  $('runView').hidden = false;
  $('btnShowLog').hidden = true;
  for (const id of ['stRoots', 'stCollected', 'stReused', 'stLinked', 'stUpdated', 'stCreated', 'stFailed']) $(id).textContent = '0';
  $('stCreatedLabel').textContent = dry ? 'Seriam criados' : 'Criados';
  $('stUpdatedLabel').textContent = dry ? 'Seriam atualizados' : 'Atualizados';
  $('perObject').replaceChildren();
  $('tab-graphs').replaceChildren();
  $('tab-warnings').replaceChildren(el('div', { class: 'muted', text: 'Nenhum aviso.' }));
  $('tab-log').replaceChildren();
  $('tcGraphs').textContent = '';
  $('tcWarnings').textContent = '';
  setPhase(dry ? 'Simulando…' : 'Executando…', true);
}

const STATUS = { ok: ['✓', 'criado'], dry: ['•', 'a criar'], fail: ['✕', 'falhou'], skipped: ['–', 'ignorado'] };
const ROLE_TITLE = { raiz: 'Registro raiz', pai: 'Pais necessários', filho: 'Filhos' };

function recRow(obj, label, ids) {
  return el('div', { class: 'rec' },
    el('span', { class: 'obj', text: obj }),
    el('span', { class: 'lbl', text: label || '—', title: label || '' }),
    el('span', { class: 'ids mono' }, ...ids));
}

function renderGraph(e) {
  // Na simulação, o graph que falharia aparece como "falharia" (nada foi enviado)
  const dry = !!(S.run && S.run.dry);
  const [icon, word] = (e.status === 'fail' && dry ? ['✕', 'falharia'] : STATUS[e.status]) || ['?', e.status];
  const body = el('div', { class: 'graph-body' });

  if (e.reason) body.append(el('div', { class: 'muted', text: e.reason }));
  if (e.errors && e.errors.length) {
    body.append(el('div', { class: 'errbox' }, ...e.errors.map((x) =>
      el('div', {}, el('b', { text: [x.sobject, x.label].filter(Boolean).join(' · ') || x.ref || 'Erro' }),
        `: ${x.code ? `[${x.code}] ` : ''}${x.message}${x.fields && x.fields.length ? ` (${x.fields.join(', ')})` : ''}`))));
  }
  for (const role of ['raiz', 'pai', 'filho']) {
    const nodes = e.nodes.filter((n) => n.role === role);
    if (!nodes.length) continue;
    body.append(el('div', { class: 'group' },
      el('h4', { text: `${ROLE_TITLE[role]} (${nodes.length})` }),
      ...nodes.map((n) => recRow(n.sobject, n.label, n.targetId
        ? [n.sourceId, el('span', { class: 'arrow', text: ' → ' }), n.targetId]
        : [n.sourceId]))));
  }
  if (e.linked && e.linked.length) {
    body.append(el('div', { class: 'group' },
      el('h4', { text: `Ligados a registros do destino (${e.linked.length})` }),
      ...e.linked.map((l) => recRow(l.sobject, l.label, [l.how]))));
  }

  const details = el('details', { class: 'graph', open: e.status === 'fail' },
    el('summary', {},
      el('span', { class: `status ${e.status}`, text: icon }),
      el('span', { class: 'title', text: [e.rootLabel || e.rootId, e.parte].filter(Boolean).join(' · '), title: e.rootId }),
      el('span', { class: 'meta', text: `${e.nodes.length} registro(s) · ${word}` })),
    body);
  $('tab-graphs').append(details);
}

function onRunEvent(e) {
  const R = S.run;
  if (!R) return;
  if (e.type === 'log') appendLog(e.msg, e.level);
  if (e.type === 'phase') { setPhase(`${e.name}…`, true); appendLog(`— ${e.name}`); }
  if (e.type === 'graph') {
    R.graphs++;
    if (e.status === 'ok' || e.status === 'dry') R.created += e.nodes.length;
    if (e.status === 'fail') {
      R.failed++;
      for (const x of e.errors || []) appendLog(`${[e.rootLabel || e.rootId, e.parte].filter(Boolean).join(' · ')}: ${x.message}`, 'error');
    }
    $('stCreated').textContent = R.created;
    $('stFailed').textContent = R.failed;
    $('tcGraphs').textContent = R.graphs;
    renderGraph(e);
  }
  if (e.type === 'summary') {
    $('stRoots').textContent = e.roots;
    $('stCollected').textContent = Object.values(e.perObject).reduce((a, b) => a + b, 0);
    $('stReused').textContent = e.reused;
    $('stLinked').textContent = e.linked || 0;
    $('stUpdated').textContent = e.updated || 0;
    $('stCreated').textContent = e.created;
    $('stFailed').textContent = e.failedGraphs;
    $('perObject').replaceChildren(...Object.entries(e.perObject).map(([k, v]) =>
      el('span', { class: 'tag' }, `${k} `, el('b', { text: v }))));
    const isFatal = (msg) => msg.includes('vai falhar') || msg.includes('ficou sem valor');
    const w = Object.entries(e.warnings || {}).sort((a, b) => isFatal(b[0]) - isFatal(a[0]) || a[0].localeCompare(b[0]));
    R.fatal = w.filter(([msg]) => isFatal(msg)).length;
    $('tcWarnings').textContent = w.length || '';
    $('tcWarnings').classList.toggle('bad', R.fatal > 0);
    if (w.length) {
      $('tab-warnings').replaceChildren(...w.map(([msg, count]) =>
        el('div', { class: `warn-row${isFatal(msg) ? ' fatal' : ''}` }, el('b', { text: `${count}×` }), el('span', { text: msg }))));
    }
    R.logFile = e.logFile;
    $('btnShowLog').hidden = !e.logFile;
  }
}

async function start(dry) {
  let cfg;
  try { cfg = formToConfig(); } catch (e) { return toast(e.message, true); }
  store.set('sfgc:last', cfg);
  const hadView = !$('runView').hidden;
  resetRun(dry);
  setRunning(true);
  const off = api.onRunEvent(onRunEvent);
  try {
    const r = await api.runStart(cfg, dry);
    if (r && r.cancelled) {
      if (!hadView) { $('runView').hidden = true; $('emptyState').hidden = false; }
      setPhase('Execução não iniciada.', false);
      return;
    }
    if (dry && S.run.fatal) {
      setPhase(`Simulação concluída — ${S.run.fatal} aviso(s) indicam que a gravação vai falhar. Veja a aba Avisos.`, false);
      switchTab('warnings');
    } else if (dry) setPhase(r.roots ? 'Simulação concluída — nada foi gravado no destino.' : 'Nenhum registro raiz encontrado.', false);
    else setPhase(r.failedGraphs ? `Concluído com ${r.failedGraphs} graph(s) com falha.` : 'Concluído com sucesso.', false);
  } catch (e) {
    setPhase('Erro na execução.', false);
    appendLog(e.message, 'error');
    toast(e.message, true);
  } finally {
    off();
    setRunning(false);
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const n of ['graphs', 'warnings', 'log']) $(`tab-${n}`).hidden = n !== name;
}

// ---------------------------------------------------------------- ligações
function bind() {
  $('sfPill').addEventListener('click', openSettings);
  $('btnSettings').addEventListener('click', openSettings);
  document.querySelectorAll('.js-refresh-orgs').forEach((b) => b.addEventListener('click', async () => {
    await api.refreshSchema();
    S.objectsLoadedFor = null;
    mdResetCaches();
    loadOrgs();
  }));
  document.querySelectorAll('.js-add-org').forEach((b) => b.addEventListener('click', addOrgFlow));
  $('btnHome').addEventListener('click', () => go('home'));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  mdBind();
  $('srcOrg').addEventListener('change', onOrgsChanged);
  $('tgtOrg').addEventListener('change', onOrgsChanged);
  $('btnSwap').addEventListener('click', () => {
    const s = $('srcOrg').value;
    setSelect('srcOrg', $('tgtOrg').value);
    setSelect('tgtOrg', s);
    onOrgsChanged();
  });

  $('rootObject').addEventListener('input', () => { loadRootDescribe(); persist(); });
  $('rootObject').addEventListener('change', () => { S.selectedChildren.clear(); renderChildren(); persist(); });
  $('modeIds').addEventListener('click', () => setMode('ids'));
  $('modeWhere').addEventListener('click', () => setMode('where'));
  $('childFilter').addEventListener('input', renderChildren);

  $('chipInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addChip(e.target.value); e.target.value = ''; }
  });
  $('chipInput').addEventListener('change', (e) => { if (e.target.value) { addChip(e.target.value); e.target.value = ''; } });
  $('btnSuggest').addEventListener('click', suggestObjects);

  for (const id of ['rootIds', 'rootWhere', 'rootLimit', 'maxDepth', 'reuseExisting', 'skipAlreadyCopied', 'updateExisting', 'autoExternalId', 'matchBy', 'linkOnly', 'sourceIdField', 'skipFields', 'extraChildren', 'apiVersion', 'maxNodes']) {
    $(id).addEventListener('input', persist);
    $(id).addEventListener('change', persist);
  }

  $('btnDry').addEventListener('click', () => start(true));
  $('btnRun').addEventListener('click', () => start(false));
  $('btnCancel').addEventListener('click', async () => {
    $('btnCancel').disabled = true;
    await api.runCancel();
    toast('Cancelando após o passo atual…');
  });
  $('btnShowLog').addEventListener('click', () => S.run && api.showLog(S.run.logFile));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('profileSelect').addEventListener('change', async (e) => {
    const name = e.target.value;
    S.profile = name;
    store.set('sfgc:profile', name);
    if (!name) return;
    try { configToForm(await api.loadProfile(name)); } catch (err) { toast(err.message, true); }
  });
  $('btnSaveProfile').addEventListener('click', () => saveProfile(false));
  $('btnProfileMenu').addEventListener('click', (e) => { e.stopPropagation(); $('profileMenu').hidden = !$('profileMenu').hidden; });
  $('profileMenu').addEventListener('click', (e) => { const act = e.target.dataset.act; if (act) profileMenu(act); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('profileMenu').hidden = true; });
}

// ---------------------------------------------------------------- navegação
function go(view) {
  S.view = view;
  for (const v of ['home', 'data', 'meta']) $(`view-${v}`).hidden = v !== view;
  $('crumb').hidden = view === 'home';
  $('crumb').textContent = view === 'data' ? 'Copiar dados' : view === 'meta' ? 'Copiar metadados' : '';
  $('dataTools').hidden = view !== 'data';
  if (view === 'meta') mdLoadCurrent();
  if (view === 'home') renderHomeStatus();
}

function renderHomeStatus() {
  const box = $('homeStatus');
  if (!box) return;
  const pill = $('sfPill');
  const parts = [];
  if (pill.classList.contains('err')) {
    parts.push(el('span', { class: 'badge', text: 'Salesforce CLI não encontrado' }),
      el('button', { class: 'btn ghost small', text: 'Configurar', onclick: openSettings }));
  } else if (pill.classList.contains('ok')) {
    parts.push(el('span', { text: `${pill.textContent} · ${S.orgs.length} org(s) conectada(s)` }));
    if (!S.orgs.length) parts.push(el('button', { class: 'btn ghost small', text: '+ Conectar org', onclick: addOrgFlow }));
  }
  box.replaceChildren(...parts);
}

// ---------------------------------------------------------------- metadados
const M = {
  mode: 'objects',
  selected: new Map(), // "Tipo:Nome" -> { type, fullName, exists }
  objects: null, // { key, loading | error | items }
  fields: {}, // "src|tgt|Objeto" -> { loading | error | object, objectInTarget, fields }
  fieldKey: null,
  types: null, // { src, loading | error | items }
  comps: {}, // "src|tgt|Tipo" -> { loading | error | items }
  compKey: null,
  running: false,
  timer: null,
};
const MAX_ROWS = 400;
const mdSrc = () => $('mdSrcOrg').value;
const mdTgt = () => $('mdTgtOrg').value;
const mdKey = () => `${mdSrc()}|${mdTgt()}`;
const mdReady = () => mdSrc() && mdTgt() && mdSrc() !== mdTgt() && orgInfo(mdSrc()) && orgInfo(mdTgt());
const selKey = (item) => `${item.type}:${item.fullName}`;

function loadingRow(text) {
  return el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', { text }));
}
function emptyRow(text) { return el('div', { class: 'empty', text }); }
function errorRow(msg, retry) {
  return el('div', { class: 'error-row' }, el('span', { text: msg }),
    el('button', { class: 'btn small', text: 'Tentar de novo', onclick: retry }));
}
function badgeFor(item) {
  if (item.managed) return el('span', { class: 'badge muted', text: 'gerenciado', title: 'Componente de pacote gerenciado: não pode ser implantado' });
  if (item.exists === true) return el('span', { class: 'badge', text: 'existe no destino', title: 'Será sobrescrito no destino' });
  if (item.exists === false) return el('span', { class: 'badge new', text: 'novo', title: 'Não existe no destino: será criado' });
  return el('span', { class: 'badge muted', text: '?', title: 'Não foi possível verificar o destino' });
}

function mdResetCaches() {
  M.objects = null;
  M.fields = {};
  M.types = null;
  M.comps = {};
}

function mdPersist() {
  store.set('sfgc:md', { source: mdSrc(), target: mdTgt(), mode: M.mode, showStd: $('mdShowStd').checked, testLevel: $('mdTestLevel').value });
}
function mdRestore() {
  const saved = store.get('sfgc:md') || {};
  const last = store.get('sfgc:last') || {};
  S.pending.mdSrcOrg = saved.source || last.source || '';
  S.pending.mdTgtOrg = saved.target || last.target || '';
  setSelect('mdSrcOrg', S.pending.mdSrcOrg);
  setSelect('mdTgtOrg', S.pending.mdTgtOrg);
  $('mdShowStd').checked = !!saved.showStd;
  $('mdTestLevel').value = saved.testLevel || '';
  mdSetMode(saved.mode || 'objects', true);
  mdRenderPackage();
}

let mdLastSrc = null;
function mdOnOrgsChanged() {
  orgPairStatus('mdSrcOrg', 'mdTgtOrg', 'mdSrcInfo', 'mdTgtInfo', 'mdOrgWarn');
  if (mdLastSrc !== null && mdLastSrc !== mdSrc() && M.selected.size) {
    M.selected.clear();
    toast('A origem mudou: o pacote foi esvaziado.');
  }
  mdLastSrc = mdSrc();
  mdRenderPackage();
  mdPersist();
  if (S.view === 'meta') mdLoadCurrent();
}

function mdSetMode(mode, silent) {
  M.mode = mode;
  document.querySelectorAll('[data-md-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mdMode === mode));
  for (const m of ['objects', 'fields', 'types']) $(`mdPane-${m}`).hidden = m !== mode;
  if (!silent) { mdPersist(); mdLoadCurrent(); }
}

/** Carrega só o que a aba atual precisa, quando ela é aberta. */
function mdLoadCurrent(refresh = false) {
  if (!mdReady()) {
    const msg = 'Escolha a origem e o destino (orgs diferentes).';
    for (const id of ['mdObjList', 'mdFieldList', 'mdCompList']) $(id).replaceChildren(emptyRow(msg));
    return;
  }
  if (M.mode === 'objects') mdLoadObjects(refresh);
  if (M.mode === 'fields') { mdLoadObjects(refresh, true); mdLoadFields(refresh); }
  if (M.mode === 'types') { mdLoadTypes(refresh); mdLoadComps(refresh); }
}

// ---- objetos
async function mdLoadObjects(refresh, quiet) {
  const key = mdKey();
  if (!refresh && M.objects && M.objects.key === key && !M.objects.error) { if (!quiet) mdRenderObjects(); return; }
  if (M.objects && M.objects.key === key && M.objects.loading) return;
  M.objects = { key, loading: true };
  if (!quiet) mdRenderObjects();
  try {
    const r = await api.mdComponents(mdSrc(), mdTgt(), 'CustomObject', !!refresh);
    if (mdKey() !== key) return;
    M.objects = { key, items: r.items, targetError: r.targetError };
    mdSyncSelected(r.items);
    $('mdObjDatalist').replaceChildren(...r.items.filter((i) => !i.managed).map((i) => el('option', { value: i.fullName })));
  } catch (e) {
    if (mdKey() !== key) return;
    M.objects = { key, error: e.message };
  }
  if (M.mode === 'objects') mdRenderObjects();
}

function mdRenderList(listId, items, { filterId, titleOf, subOf }) {
  const f = $(filterId).value.trim().toLowerCase();
  const visible = items.filter((i) => !f || `${i.fullName} ${subOf(i)}`.toLowerCase().includes(f));
  if (!visible.length) return $(listId).replaceChildren(emptyRow(items.length ? 'Nada encontrado com esse filtro.' : 'Nenhum componente encontrado na origem.'));
  const rows = visible.slice(0, MAX_ROWS).map((item) => {
    const on = M.selected.has(selKey(item));
    const cb = el('input', { type: 'checkbox', checked: on, disabled: item.managed });
    const row = el('label', { class: `item md${on ? ' on' : ''}${item.managed ? ' disabled' : ''}` },
      cb, el('span', { class: 'name', text: titleOf(item), title: item.fullName }), badgeFor(item), el('span', { class: 'sub', text: subOf(item) }));
    cb.addEventListener('change', () => { mdToggle(item, cb.checked); row.classList.toggle('on', cb.checked); });
    return row;
  });
  if (visible.length > MAX_ROWS) rows.push(el('div', { class: 'note', text: `Mostrando ${MAX_ROWS} de ${visible.length}. Use o filtro para encontrar os demais.` }));
  $(listId).replaceChildren(...rows);
  return visible;
}

const whenBy = (i) => [i.lastModifiedBy && `alterado por ${i.lastModifiedBy}`, i.lastModified && new Date(i.lastModified).toLocaleDateString('pt-BR')].filter(Boolean).join(' em ');

function mdRenderObjects() {
  const st = M.objects;
  const list = $('mdObjList');
  if (!st) return list.replaceChildren(emptyRow('Escolha a origem e o destino.'));
  if (st.loading) return list.replaceChildren(loadingRow('Buscando objetos na origem e no destino…'));
  if (st.error) return list.replaceChildren(errorRow(st.error, () => mdLoadObjects(true)));
  const std = $('mdShowStd').checked;
  const items = st.items.filter((i) => std || i.fullName.includes('__'));
  mdRenderList('mdObjList', items, { filterId: 'mdObjFilter', titleOf: (i) => i.fullName, subOf: whenBy });
  if (st.targetError) list.prepend(el('div', { class: 'note', text: `Não deu para comparar com o destino: ${st.targetError}` }));
}

// ---- campos
async function mdLoadFields(refresh) {
  const obj = $('mdFieldObject').value.trim();
  $('mdFieldNote').hidden = true;
  if (!obj) { M.fieldKey = null; $('mdFieldList').replaceChildren(emptyRow('Escolha um objeto para ver os campos personalizados.')); return; }
  if (!/^\w+$/.test(obj)) { $('mdFieldList').replaceChildren(emptyRow('Nome de objeto inválido.')); return; }
  const key = `${mdKey()}|${obj}`;
  M.fieldKey = key;
  if (!refresh && M.fields[key] && !M.fields[key].error && !M.fields[key].loading) return mdRenderFields();
  if (!refresh && M.fields[key] && M.fields[key].loading) return mdRenderFields();
  M.fields[key] = { loading: true, object: obj };
  mdRenderFields();
  try {
    M.fields[key] = await api.mdFields(mdSrc(), mdTgt(), obj, apiV(), !!refresh);
  } catch (e) {
    M.fields[key] = { error: e.message, object: obj };
  }
  if (M.fieldKey === key) mdRenderFields();
  // Só a lista que está na tela atualiza o pacote (resposta atrasada de outro objeto ou destino não entra)
  mdSyncSelected(M.fieldKey === key ? M.fields[key].fields || [] : []);
}

function mdRenderFields() {
  const st = M.fields[M.fieldKey];
  const list = $('mdFieldList');
  const note = $('mdFieldNote');
  note.hidden = true;
  if (!st) return list.replaceChildren(emptyRow('Escolha um objeto para ver os campos personalizados.'));
  if (st.loading) return list.replaceChildren(loadingRow(`Buscando campos de ${st.object}…`));
  if (st.error) return list.replaceChildren(errorRow(st.error, () => mdLoadFields(true)));
  if (st.objectInTarget === false) {
    note.hidden = false;
    note.className = 'alert';
    note.replaceChildren(
      el('span', { text: `${st.object} não existe no destino. Leve o objeto junto, senão a implantação dos campos vai falhar. ` }),
      el('button', { class: 'btn ghost small', text: 'Adicionar objeto ao pacote', onclick: () => {
        mdToggle({ type: 'CustomObject', fullName: st.object, exists: false }, true);
      } }));
  }
  mdRenderList('mdFieldList', st.fields, {
    filterId: 'mdFieldFilter',
    titleOf: (f) => f.name,
    subOf: (f) => `${f.label} · ${f.fieldType}`,
  });
}

// ---- outros tipos
async function mdLoadTypes(refresh) {
  const src = mdSrc();
  if (!refresh && M.types && M.types.src === src && (M.types.items || M.types.loading)) return;
  M.types = { src, loading: true };
  $('mdTypeSpin').hidden = false;
  $('mdType').placeholder = 'Buscando tipos de metadados…';
  if (!$('mdType').value.trim()) $('mdCompList').replaceChildren(loadingRow('Buscando tipos de metadados na origem…'));
  try {
    const items = await api.mdTypes(src, !!refresh);
    if (mdSrc() !== src) return;
    M.types = { src, items };
    $('mdTypeDatalist').replaceChildren(...items.map((t) =>
      el('option', { value: t.name, text: t.inFolder ? 'em pastas (não suportado)' : t.parent ? `parte de ${t.parent}` : '' })));
    $('mdType').placeholder = `${items.length} tipos — ex.: ApexClass, Flow, Layout`;
    if (!$('mdType').value.trim()) $('mdCompList').replaceChildren(emptyRow('Escolha um tipo de metadado.'));
  } catch (e) {
    M.types = { src, error: e.message };
    $('mdType').placeholder = 'ApexClass, Flow, Layout…';
    $('mdCompList').replaceChildren(errorRow(`Não consegui listar os tipos: ${e.message}`, () => mdLoadTypes(true)));
  } finally {
    $('mdTypeSpin').hidden = true;
  }
}

async function mdLoadComps(refresh) {
  const type = $('mdType').value.trim();
  if (!type) { M.compKey = null; return; }
  if (!/^\w+$/.test(type)) return $('mdCompList').replaceChildren(emptyRow('Nome de tipo inválido.'));
  const info = M.types && M.types.items && M.types.items.find((t) => t.name === type);
  if (info && info.inFolder) {
    M.compKey = null;
    return $('mdCompList').replaceChildren(emptyRow(`${type} fica em pastas e ainda não é suportado nesta versão.`));
  }
  const key = `${mdKey()}|${type}`;
  M.compKey = key;
  if (!refresh && M.comps[key] && (M.comps[key].items || M.comps[key].loading)) return mdRenderComps();
  M.comps[key] = { loading: true, type };
  mdRenderComps();
  try {
    const r = await api.mdComponents(mdSrc(), mdTgt(), type, !!refresh);
    M.comps[key] = { type, items: r.items, targetError: r.targetError };
  } catch (e) {
    M.comps[key] = { type, error: e.message };
  }
  if (M.compKey === key) {
    mdRenderComps();
    mdSyncSelected(M.comps[key].items || []);
  }
}

function mdRenderComps() {
  const st = M.comps[M.compKey];
  const list = $('mdCompList');
  if (!st) return list.replaceChildren(emptyRow('Escolha um tipo de metadado.'));
  if (st.loading) return list.replaceChildren(loadingRow(`Buscando componentes de ${st.type}…`));
  if (st.error) return list.replaceChildren(errorRow(st.error, () => mdLoadComps(true)));
  mdRenderList('mdCompList', st.items, { filterId: 'mdCompFilter', titleOf: (i) => i.fullName, subOf: whenBy });
  if (st.targetError) list.prepend(el('div', { class: 'note', text: `Não deu para comparar com o destino: ${st.targetError}` }));
}

function mdMarkVisible(listId) {
  $(listId).querySelectorAll('.item input[type=checkbox]:not(:disabled):not(:checked)').forEach((cb) => {
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  });
}

// ---- pacote
function mdToggle(item, on) {
  const k = selKey(item);
  if (on) M.selected.set(k, { type: item.type, fullName: item.fullName, exists: item.exists });
  else M.selected.delete(k);
  mdRenderPackage();
}

/** Atualiza o "existe no destino" dos itens do pacote com uma lista recém-carregada. */
function mdSyncSelected(items) {
  for (const item of items) {
    const it = M.selected.get(selKey(item));
    if (it) it.exists = item.exists;
  }
  mdRenderPackage();
}

function mdRenderPackage() {
  const box = $('mdPackage');
  $('mdCount').textContent = M.selected.size || '';
  $('mdBtnValidate').disabled = $('mdBtnDeploy').disabled = !M.selected.size || M.running;
  $('mdClear').disabled = !M.selected.size || M.running;
  if (!M.selected.size) {
    box.replaceChildren(emptyRow('Marque à esquerda os objetos, campos ou componentes que quer levar.'));
  } else {
    const groups = new Map();
    for (const it of M.selected.values()) {
      if (!groups.has(it.type)) groups.set(it.type, []);
      groups.get(it.type).push(it);
    }
    box.replaceChildren(...[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([type, list]) =>
      el('div', { class: 'pkg-group' },
        el('h4', { text: `${type} (${list.length})` }),
        ...list.sort((a, b) => a.fullName.localeCompare(b.fullName)).map((it) =>
          el('div', { class: 'pkg-row' },
            el('span', { class: 'mono', text: it.fullName, title: it.fullName }),
            badgeFor(it),
            el('button', { title: 'Remover do pacote', text: '×', disabled: M.running, onclick: () => { mdToggle(it, false); mdRerenderCurrentList(); } }))))));
  }
  // Campos de objetos que não existem no destino e não estão no pacote
  const missing = new Set();
  for (const it of M.selected.values()) {
    if (it.type !== 'CustomField') continue;
    const obj = it.fullName.split('.')[0];
    const st = M.fields[`${mdKey()}|${obj}`];
    if (st && st.objectInTarget === false && !M.selected.has(`CustomObject:${obj}`)) missing.add(obj);
  }
  const warn = $('mdPkgWarn');
  warn.hidden = !missing.size;
  if (missing.size === 1) warn.textContent = `O objeto ${[...missing][0]} não existe no destino e não está no pacote: os campos dele vão falhar.`;
  else if (missing.size) warn.textContent = `Os objetos ${[...missing].join(', ')} não existem no destino e não estão no pacote: os campos deles vão falhar.`;
}

function mdRerenderCurrentList() {
  if (M.mode === 'objects') mdRenderObjects();
  if (M.mode === 'fields') mdRenderFields();
  if (M.mode === 'types') mdRenderComps();
}

// ---- validar / implantar
function mdSetPhase(text, busy) {
  clearInterval(M.timer);
  const started = Date.now();
  const label = el('span', { text });
  $('mdPhase').replaceChildren(...(busy ? [el('span', { class: 'spinner' })] : []), label);
  if (busy) {
    M.timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      label.textContent = `${text} · ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    }, 1000);
  }
}

function mdLog(msg, level) {
  $('mdLog').append(el('div', { class: level === 'warn' ? 'w' : level === 'error' ? 'e' : '' }, `${new Date().toLocaleTimeString()}  ${msg}`));
}

function mdSetRunning(on) {
  M.running = on;
  $('mdConfig').classList.toggle('locked', on);
  mdRenderPackage();
}

async function mdStart(dryRun) {
  if (!mdReady()) return toast('Escolha a origem e o destino (orgs diferentes).', true);
  if (!M.selected.size) return toast('O pacote está vazio.', true);
  const members = [...M.selected.values()].map(({ type, fullName }) => ({ type, fullName }));
  $('mdResult').hidden = false;
  $('mdResultBody').replaceChildren();
  $('mdLog').replaceChildren();
  $('mdOpenDir').hidden = true;
  mdSetPhase(dryRun ? 'Preparando validação' : 'Preparando implantação', true);
  mdSetRunning(true);
  const off = api.onMdEvent((e) => {
    if (e.type === 'log') mdLog(e.msg, e.level);
    if (e.type === 'phase') { mdSetPhase(e.name, true); mdLog(`— ${e.name}`); }
  });
  let cancelled = false;
  try {
    const r = await api.mdTransfer({
      source: mdSrc(), target: mdTgt(), members, dryRun,
      testLevel: $('mdTestLevel').value || undefined, apiVersion: apiV(),
    });
    if (r && r.cancelled) {
      cancelled = true;
      mdSetPhase('Implantação não iniciada.', false);
      return;
    }
    mdRenderResult(r);
    // Componentes implantados com sucesso já estão no destino: não precisam esperar a releitura
    if (!dryRun && r.success) mdSyncSelected(r.successes.map((s) => ({ type: s.type, fullName: s.fullName, exists: true })));
  } catch (e) {
    mdSetPhase('Erro.', false);
    $('mdResultBody').replaceChildren(el('div', { class: 'errbox', text: e.message }));
    mdLog(e.message, 'error');
  } finally {
    off();
    mdSetRunning(false);
    // Depois de uma implantação, o destino mudou: relê a lista da tela sem usar o cache
    if (!dryRun && !cancelled) { mdResetCaches(); mdLoadCurrent(true); }
  }
}

function mdRenderResult(r) {
  const n = r.successes.length;
  let banner;
  if (r.success && r.dryRun) {
    mdSetPhase('Validação concluída.', false);
    banner = el('div', { class: 'result-banner ok' },
      el('span', { text: `✓ Validação OK: ${n || 'os'} componente(s) podem ser implantados. Nada foi gravado.` }),
      el('button', { class: 'btn primary small', text: 'Implantar agora', onclick: () => mdStart(false) }));
  } else if (r.success) {
    mdSetPhase('Implantação concluída.', false);
    banner = el('div', { class: 'result-banner ok', text: `✓ Implantação concluída: ${n} componente(s) processado(s).` });
  } else {
    mdSetPhase(r.dryRun ? 'Validação com erros.' : 'Implantação com erros.', false);
    const what = r.stage === 'retrieve'
      ? '✕ Nada foi baixado da origem.'
      : `✕ ${r.dryRun ? 'A validação falhou' : 'A implantação falhou'}: nenhuma alteração foi feita no destino.`;
    banner = el('div', { class: 'result-banner fail', text: what });
  }
  const parts = [banner];
  if (r.errors.length) {
    parts.push(el('div', { class: 'result-list' }, ...r.errors.map((e) =>
      el('div', { class: 'r' },
        el('span', { class: 't', text: e.type || 'Erro' }),
        el('span', { class: 'mono', text: e.fullName || '—' }),
        el('span', { class: 'p', text: `${e.problem}${e.line ? ` (linha ${e.line})` : ''}` })))));
  }
  if (n) {
    parts.push(el('details', { class: 'result-list' },
      el('summary', { class: 'muted', text: `Componentes processados (${n})` }),
      ...r.successes.map((s) => el('div', { class: 'r' },
        el('span', { class: 't', text: s.type }),
        el('span', {}, el('span', { class: 'mono', text: s.fullName }), el('span', { class: 'muted', text: `  · ${s.change}` }))))));
  }
  $('mdResultBody').replaceChildren(...parts);
  if (r.workDir) {
    $('mdOpenDir').hidden = false;
    $('mdOpenDir').onclick = () => api.mdOpenDir(r.workDir);
  }
}

function mdBind() {
  $('mdSrcOrg').addEventListener('change', mdOnOrgsChanged);
  $('mdTgtOrg').addEventListener('change', mdOnOrgsChanged);
  $('mdSwap').addEventListener('click', () => {
    const s = mdSrc();
    setSelect('mdSrcOrg', mdTgt());
    setSelect('mdTgtOrg', s);
    mdOnOrgsChanged();
  });
  document.querySelectorAll('[data-md-mode]').forEach((b) => b.addEventListener('click', () => mdSetMode(b.dataset.mdMode)));
  $('mdRefresh').addEventListener('click', () => mdLoadCurrent(true));
  $('mdObjFilter').addEventListener('input', mdRenderObjects);
  $('mdShowStd').addEventListener('change', () => { mdPersist(); mdRenderObjects(); });
  $('mdFieldObject').addEventListener('change', () => mdLoadFields(false));
  $('mdFieldObject').addEventListener('keydown', (e) => { if (e.key === 'Enter') mdLoadFields(false); });
  $('mdFieldFilter').addEventListener('input', mdRenderFields);
  $('mdFieldAll').addEventListener('click', () => mdMarkVisible('mdFieldList'));
  $('mdType').addEventListener('change', () => mdLoadComps(false));
  $('mdType').addEventListener('keydown', (e) => { if (e.key === 'Enter') mdLoadComps(false); });
  $('mdCompFilter').addEventListener('input', mdRenderComps);
  $('mdCompAll').addEventListener('click', () => mdMarkVisible('mdCompList'));
  $('mdClear').addEventListener('click', () => { M.selected.clear(); mdRenderPackage(); mdRerenderCurrentList(); });
  $('mdTestLevel').addEventListener('change', mdPersist);
  $('mdBtnValidate').addEventListener('click', () => mdStart(true));
  $('mdBtnDeploy').addEventListener('click', () => mdStart(false));
}

// ---------------------------------------------------------------- início
(async function init() {
  bind();
  configToForm(store.get('sfgc:last') || DEFAULT_CFG);
  mdRestore();
  go('home');
  await refreshProfiles(store.get('sfgc:profile') || '');
  if (await refreshSfStatus()) await loadOrgs();
  renderHomeStatus();
})();
