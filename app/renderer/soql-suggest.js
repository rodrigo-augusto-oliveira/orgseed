'use strict';
/**
 * Sugestões para a caixa do filtro SOQL (só a cláusula WHERE): campos do objeto raiz, relacionamentos
 * ("Account.Name"), valores de picklist dentro de aspas, palavras-chave e datas literais.
 * Lógica pura: a tela cuida de buscar os campos e de desenhar a lista.
 */
(function (root) {
  const KEYWORDS = ['AND', 'OR', 'NOT', 'LIKE', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES', 'NULL', 'TRUE', 'FALSE', 'ORDER BY', 'ASC', 'DESC',
    'TODAY', 'YESTERDAY', 'TOMORROW', 'THIS_WEEK', 'LAST_WEEK', 'NEXT_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'NEXT_MONTH',
    'THIS_QUARTER', 'LAST_QUARTER', 'THIS_YEAR', 'LAST_YEAR', 'NEXT_YEAR', 'LAST_90_DAYS', 'NEXT_90_DAYS',
    'LAST_N_DAYS:', 'NEXT_N_DAYS:', 'LAST_N_MONTHS:', 'NEXT_N_MONTHS:'];
  const MAX = 30;
  const EMPTY = { items: [] };
  const lower = (s) => String(s || '').toLowerCase();

  /** Posição da aspa simples que abriu um texto ainda não fechado antes do cursor (-1 se não há). */
  function openQuote(before) {
    let open = -1;
    for (let i = 0; i < before.length; i++) {
      const c = before[i];
      if (c === '\\') { i++; continue; }
      if (c === "'") open = open === -1 ? i : -1;
    }
    return open;
  }

  /** Segue "Account.Owner" a partir dos campos do objeto raiz. Devolve { list }, { need } (objeto a carregar) ou null. */
  function walk(rels, ctx) {
    let list = ctx.fields;
    for (const rel of rels) {
      const f = list.find((x) => x.relationshipName && lower(x.relationshipName) === lower(rel));
      if (!f || !f.referenceTo || f.referenceTo.length !== 1) return null;
      const next = ctx.fieldsOf(f.referenceTo[0]);
      if (!next) return { need: f.referenceTo[0] };
      list = next;
    }
    return { list };
  }

  // 0 começa com o que foi digitado, 1 contém; -1 não combina
  function rankOf(text, p) {
    const t = lower(text);
    if (t.startsWith(p)) return 0;
    return t.includes(p) ? 1 : -1;
  }

  function fieldItems(prefix, list) {
    const p = lower(prefix);
    const out = [];
    for (const f of list) {
      if (f.filterable === false) continue;
      if (lower(f.name) !== p) {
        const byName = p ? rankOf(f.name, p) : 0;
        const byLabel = p ? rankOf(f.label, p) : 0;
        const rank = byName >= 0 ? byName : byLabel >= 0 ? byLabel + 1 : -1;
        if (rank >= 0) out.push({ name: f.name, insert: f.name, detail: `${f.label} · ${f.type}`, kind: 'field', rank });
      }
      const rel = f.relationshipName;
      if (rel && f.referenceTo && f.referenceTo.length === 1 && lower(rel) !== p) {
        const r = p ? rankOf(rel, p) : 1;
        if (r >= 0) out.push({ name: `${rel}.`, insert: `${rel}.`, detail: `→ ${f.referenceTo[0]}`, kind: 'rel', rank: r + 0.5 });
      }
    }
    return out;
  }

  function keywordItems(prefix) {
    const p = prefix.toUpperCase();
    if (!p) return [];
    return KEYWORDS.filter((k) => k.startsWith(p) && k !== p).map((k) => ({ name: k, insert: k, detail: 'palavra-chave', kind: 'kw', rank: 5 }));
  }

  const escapeValue = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  function valueSuggestions(text, caret, quoteAt, ctx) {
    const pre = text.slice(0, quoteAt);
    const m = pre.match(/([A-Za-z_][\w.]*)\s*(?:=|!=|<>|LIKE|(?:INCLUDES|EXCLUDES|(?:NOT\s+)?IN)\s*\((?:[^()]*,)?)\s*$/i);
    if (!m) return EMPTY;
    const parts = m[1].split('.');
    const name = parts.pop();
    const w = walk(parts, ctx);
    if (!w) return EMPTY;
    const start = quoteAt + 1;
    if (w.need) return { items: [], need: w.need, start, end: caret };
    const f = w.list.find((x) => lower(x.name) === lower(name));
    if (!f || !f.picklist || !f.picklist.length) return EMPTY;
    const partial = lower(text.slice(start, caret));
    const close = text[caret] === "'" ? '' : "'";
    const items = f.picklist
      .filter((v) => lower(v.value) !== partial)
      .map((v) => {
        const r = partial ? Math.min(...[rankOf(v.value, partial), rankOf(v.label, partial)].filter((x) => x >= 0).concat(9)) : 0;
        return { name: v.value, insert: escapeValue(v.value) + close, detail: v.label && v.label !== v.value ? v.label : 'valor', kind: 'value', rank: r };
      })
      .filter((i) => i.rank < 9);
    return { items: sort(items), start, end: caret };
  }

  const sort = (items) => items
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, MAX);

  /**
   * text/caret: conteúdo da caixa e posição do cursor.
   * ctx: { fields, fieldsOf(objeto) -> campos já carregados ou null, force }
   * Devolve { items, start, end } (substituir text[start..end]) e, se falta carregar um objeto relacionado, { need }.
   */
  function suggest(text, caret, ctx) {
    if (!ctx || !ctx.fields) return EMPTY;
    const before = text.slice(0, caret);
    const quoteAt = openQuote(before);
    if (quoteAt !== -1) return valueSuggestions(text, caret, quoteAt, ctx);

    const word = before.match(/[\w.]*$/)[0];
    if ((!word && !ctx.force) || /^\d/.test(word)) return EMPTY;
    const parts = word.split('.');
    const prefix = parts.pop();
    const start = caret - prefix.length;
    const w = walk(parts, ctx);
    if (!w) return EMPTY;
    if (w.need) return { items: [], need: w.need, start, end: caret };
    const items = fieldItems(prefix, w.list);
    if (!parts.length) items.push(...keywordItems(prefix));
    return { items: sort(items), start, end: caret };
  }

  const api = { suggest, openQuote };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoqlSuggest = api;
})(typeof window !== 'undefined' ? window : globalThis);
