#!/usr/bin/env node
/**
 * Linha de comando do OrgSeed (mesmo motor da interface).
 *
 *   node cli.js --config config.json [--dry-run] [--ids 006xx,006yy] [--where "..."]
 */
'use strict';
const fs = require('fs');
const engine = require('./engine/engine');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) o[k] = true;
    else { o[k] = n; i++; }
  }
  return o;
}

const ARGS = parseArgs(process.argv.slice(2));
if (!ARGS.config) {
  console.error('Uso: node cli.js --config config.json [--dry-run] [--ids id1,id2] [--where "..."]');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(ARGS.config, 'utf8'));
cfg.root = cfg.root || {};
if (ARGS.ids) cfg.root.ids = String(ARGS.ids);
if (ARGS.where) { cfg.root.where = String(ARGS.where); cfg.root.ids = []; }

const ICON = { ok: '✔', dry: '•', fail: '✖', skipped: '–' };

engine
  .run(cfg, {
    dryRun: !!ARGS['dry-run'],
    logDir: process.cwd(),
    onEvent(e) {
      if (e.type === 'log') console[e.level === 'warn' ? 'warn' : 'log'](`${e.level === 'warn' ? '⚠ ' : ''}${e.msg}`);
      if (e.type === 'phase') console.log(`\n== ${e.name}`);
      if (e.type === 'graph') {
        const name = e.rootLabel ? `${e.rootLabel} (${e.rootId})` : e.rootId;
        console.log(`${ICON[e.status]} ${e.graphId} ${name}: ${e.nodes.length} registro(s)${e.reason ? ` — ${e.reason}` : ''}`);
        for (const x of e.errors || []) console.error(`   ${x.sobject || ''} ${x.label || x.ref || ''}: ${x.code ? `[${x.code}] ` : ''}${x.message}`);
      }
      if (e.type === 'summary') {
        console.log(`\nReaproveitados: ${e.reused}${e.linked != null ? ` | Ligados: ${e.linked}` : ''}${e.updated != null ? ` | ${e.dryRun ? 'Seriam atualizados' : 'Atualizados'}: ${e.updated}` : ''} | ${e.dryRun ? 'Seriam criados' : 'Criados'}: ${e.created} | Graphs com falha: ${e.failedGraphs}`);
        const w = Object.entries(e.warnings || {});
        if (w.length) { console.log('\nAvisos:'); for (const [k, c] of w) console.log(`  (${c}x) ${k}`); }
        if (e.logFile) console.log(`\nLog completo: ${e.logFile}`);
      }
    },
  })
  .then((s) => process.exit(s.failedGraphs ? 2 : 0))
  .catch((e) => { console.error('Erro:', e.message); process.exit(1); });
