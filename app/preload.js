'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });

contextBridge.exposeInMainWorld('api', {
  sfStatus: () => call('sf:status'),
  getSettings: () => call('settings:get'),
  setSettings: (s) => call('settings:set', s),
  pickSf: () => call('settings:pickSf'),

  listOrgs: () => call('orgs:list'),
  loginOrg: (alias, url) => call('orgs:login', alias, url),
  listObjects: (ref, v) => call('schema:objects', ref, v),
  describeObject: (ref, sobject, v) => call('schema:describe', ref, sobject, v),
  describeRaw: (ref, sobject, v) => call('schema:describeRaw', ref, sobject, v),
  refreshSchema: () => call('schema:refresh'),

  listProfiles: () => call('profiles:list'),
  loadProfile: (name) => call('profiles:load', name),
  saveProfile: (name, cfg) => call('profiles:save', name, cfg),
  deleteProfile: (name) => call('profiles:delete', name),
  importConfig: () => call('config:import'),
  exportConfig: (cfg) => call('config:export', cfg),

  runStart: (cfg, dryRun) => call('run:start', cfg, dryRun),
  runCancel: () => call('run:cancel'),
  showLog: (file) => call('log:show', file),
  openLogs: () => call('logs:open'),

  mdTypes: (ref, refresh) => call('md:types', ref, refresh),
  mdComponents: (src, tgt, type, refresh) => call('md:components', src, tgt, type, refresh),
  mdFields: (src, tgt, object, v, refresh) => call('md:fields', src, tgt, object, v, refresh),
  mdTransfer: (req) => call('md:transfer', req),
  mdOpenDir: (dir) => call('md:openDir', dir),
  onMdEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('md:event', h);
    return () => ipcRenderer.removeListener('md:event', h);
  },

  onRunEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('run:event', h);
    return () => ipcRenderer.removeListener('run:event', h);
  },
});
