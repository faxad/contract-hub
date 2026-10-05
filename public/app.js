/* Contract Hub – single-page client (no build step). */
(() => {
  'use strict';

  /* ------------------------------ state ------------------------------ */
  const S = {
    cat: null,
    index: [],
    svcMeta: new Map(),
    details: new Map(),
    q: '',
    scope: 'all',
    folder: '',
    kind: '',
    expanded: new Set(load('expanded', [])),
    favs: new Set(load('favs', [])),
    showAll: null,
    kb: -1,
    ui: { dir: 'request', soap: null, left: 'sample', right: 'json', fieldFilter: '', svcTab: 'ops', specFmt: 'yaml', srcFile: null },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  function load(k, d) { try { const v = localStorage.getItem(`contracthub.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(`contracthub.${k}`, JSON.stringify(v)); } catch { /* ignore */ } }
  const api = async (url, opts) => {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${r.statusText}`);
    return r.json();
  };
  const ICON_CHEV = '<svg viewBox="0 0 10 10"><path d="M3 1l5 4-5 4z"/></svg>';

  /* ------------------------------ highlighting ------------------------------ */
  function hlXml(src) {
    if (!src) return '';
    const re = /(<!--[\s\S]*?-->)|(<\?[\s\S]*?\?>)|(<\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?>)|([^<]+)|(<)/g;
    let out = '';
    let m;
    while ((m = re.exec(src))) {
      if (m[1] || m[2]) out += `<span class="cm">${esc(m[1] || m[2])}</span>`;
      else if (m[4]) {
        const attrs = m[5].replace(/(\s+)([\w:.-]+)(\s*=\s*)("[^"]*")/g, (_, sp, n, eq, v) => `${sp}<span class="at">${esc(n)}</span><span class="pu">${eq}</span><span class="st">${esc(v)}</span>`);
        out += `<span class="pu">${esc(m[3])}</span><span class="tg">${esc(m[4])}</span>${attrs}<span class="pu">${esc(m[6])}</span>`;
      } else out += esc(m[7] || m[8]);
    }
    return out;
  }
  function hlJson(src) {
    return esc(src).replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, str, colon, kw, num) => {
        if (str) return colon ? `<span class="ky">${str}</span><span class="pu">${colon}</span>` : `<span class="st">${str}</span>`;
        if (kw) return `<span class="nu">${kw}</span>`;
        return `<span class="nu">${num}</span>`;
      });
  }
  function hlYamlValue(v) {
    if (!v) return '';
    if (/^(true|false|null|~)$/.test(v) || /^-?\d+(\.\d+)?$/.test(v)) return `<span class="nu">${esc(v)}</span>`;
    if (/^['"]/.test(v)) return `<span class="st">${esc(v)}</span>`;
    if (/^[|>][+-]?$/.test(v)) return `<span class="pu">${esc(v)}</span>`;
    return `<span class="st">${esc(v)}</span>`;
  }
  function hlYaml(src) {
    let block = -1;
    return src.split('\n').map((line) => {
      const indent = line.match(/^\s*/)[0].length;
      if (block >= 0) {
        if (line.trim() === '' || indent > block) return `<span class="st">${esc(line)}</span>`;
        block = -1;
      }
      if (/^\s*#/.test(line)) return `<span class="cm">${esc(line)}</span>`;
      const m = /^(\s*(?:-\s+)?)('[^']*'|"[^"]*"|[^\s:'"#][^:#]*?)(:)(?=\s|$)(\s*)(.*)$/.exec(line);
      if (m) {
        if (/^[|>][+-]?$/.test(m[5])) block = indent;
        return `${esc(m[1])}<span class="ky">${esc(m[2])}</span><span class="pu">:</span>${m[4]}${hlYamlValue(m[5])}`;
      }
      const li = /^(\s*-\s+)(.*)$/.exec(line);
      if (li) return `${esc(li[1])}${hlYamlValue(li[2])}`;
      return esc(line);
    }).join('\n');
  }
  const highlighters = { xml: hlXml, json: hlJson, yaml: hlYaml };

  /* ------------------------------ code viewer: line numbers + folding ------------------------------ */

  /** Split highlighted HTML into lines, closing and reopening token spans that cross line breaks. */
  function splitHighlighted(html) {
    const out = [];
    let open = [];
    for (const line of html.split('\n')) {
      let s = open.join('') + line;
      const re = /<span class="[^"]*">|<\/span>/g;
      let m;
      while ((m = re.exec(line))) { if (m[0] === '</span>') open.pop(); else open.push(m[0]); }
      s += '</span>'.repeat(open.length);
      out.push(s);
    }
    return out;
  }

  /**
   * Foldable regions keyed by start line: { from, to, depth } where from..to are the lines hidden
   * when folded. XML/JSON keep the closing line visible; YAML hides the whole indented block.
   */
  function foldRanges(src, lang) {
    const folds = new Map();
    const add = (start, from, to, depth) => { if (to >= from && !folds.has(start)) folds.set(start, { from, to, depth }); };
    if (lang === 'xml') {
      const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w:.-]+)((?:"[^"]*"|'[^']*'|[^'">/]|\/(?!>))*)(\/?)>/g;
      const stack = [];
      let line = 0;
      let last = 0;
      let m;
      while ((m = re.exec(src))) {
        for (let i = last; i < m.index; i++) if (src.charCodeAt(i) === 10) line++;
        last = m.index;
        if (!m[2] || m[4]) continue; // comment / PI / CDATA / self-closing
        if (!m[1]) { stack.push({ name: m[2], line }); continue; }
        let k = stack.length - 1;
        while (k >= 0 && stack[k].name !== m[2]) k--;
        if (k < 0) continue;
        const open = stack[k];
        stack.length = k;
        add(open.line, open.line + 1, line - 1, k);
      }
    } else if (lang === 'json') {
      const stack = [];
      let line = 0;
      let inStr = false;
      for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\n') { line++; continue; }
        if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') stack.push(line);
        else if (ch === '}' || ch === ']') { const open = stack.pop(); if (open != null) add(open, open + 1, line - 1, stack.length); }
      }
    } else if (lang === 'yaml') {
      const lines = src.split('\n');
      const ind = (l) => l.match(/^\s*/)[0].length;
      const blank = (l) => !l.trim();
      const parents = [];
      for (let i = 0; i < lines.length; i++) {
        if (blank(lines[i])) continue;
        const n = ind(lines[i]);
        while (parents.length && parents[parents.length - 1] >= n) parents.pop();
        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (blank(lines[j])) continue;
          if (ind(lines[j]) > n) end = j; else break;
        }
        add(i, i + 1, end, parents.length);
        parents.push(n);
      }
    }
    return folds;
  }

  const FOLD_ICON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function codeBlock(src, lang) {
    if (src == null) return '<div class="note">Nothing to show</div>';
    const lines = splitHighlighted(highlighters[lang] ? highlighters[lang](src) : esc(src));
    const folds = foldRanges(src, lang);
    const rows = lines.map((h, i) => {
      const f = folds.get(i);
      const btn = f ? `<button class="fold" data-from="${f.from}" data-to="${f.to}" data-d="${f.depth}" title="Collapse (${f.to - f.from + 1} lines)" aria-label="Collapse">${FOLD_ICON}</button>` : '<span class="fold-sp"></span>';
      return `<div class="r">${'<span class="g">'}${btn}<span class="n">${i + 1}</span></span><span class="c">${h || ' '}</span></div>`;
    });
    return `<div class="code cv" style="--gw:${String(lines.length).length}ch">${rows.join('')}</div>`;
  }

  const foldTools = '<button class="icon-btn sm" data-cv="toggle" title="Collapse all"><svg viewBox="0 0 16 16"><path d="M4 3l4 3 4-3M4 13l4-3 4 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';

  function rowsOf(cv) {
    if (!cv._rows) cv._rows = [...cv.children];
    return cv._rows;
  }

  function setFold(btn, closed) {
    if (btn.classList.contains('closed') === closed) return;
    const rows = rowsOf(btn.closest('.cv'));
    const from = Number(btn.dataset.from);
    const to = Number(btn.dataset.to);
    const d = closed ? 1 : -1;
    for (let i = from; i <= to; i++) {
      const h = (Number(rows[i].dataset.h) || 0) + d;
      rows[i].dataset.h = h;
      rows[i].hidden = h > 0;
    }
    btn.classList.toggle('closed', closed);
    btn.title = `${closed ? 'Expand' : 'Collapse'} (${to - from + 1} lines)`;
    const c = btn.closest('.r').querySelector('.c');
    if (closed) c.insertAdjacentHTML('beforeend', `<span class="ph" title="Expand">⋯ ${to - from + 1} line${to === from ? '' : 's'}</span>`);
    else c.querySelector('.ph')?.remove();
  }

  /* ------------------------------ routing ------------------------------ */
  function parseRoute() {
    const [p, qs] = location.hash.replace(/^#/, '').split('?');
    const parts = (p || '/').split('/').filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(qs || '');
    if (parts[0] !== 's' || !parts[1]) return { view: 'home' };
    const r = { view: 'service', id: parts[1], params };
    if (parts[2] === 'op' && parts[3]) Object.assign(r, { view: 'op', op: parts[3] });
    else if (parts[2] === 'el' && parts[3]) Object.assign(r, { view: 'el', el: parts[3] });
    else if (parts[2]) r.tab = parts[2];
    return r;
  }
  const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
  const svcHref = (id, tab) => `#/s/${enc(id)}${tab ? `/${tab}` : ''}`;
  const opHref = (id, op, extra) => `#/s/${enc(id)}/op/${enc(op)}${extra ? `?${extra}` : ''}`;
  const elHref = (id, el, extra) => `#/s/${enc(id)}/el/${enc(el)}${extra ? `?${extra}` : ''}`;

  /* ------------------------------ data ------------------------------ */
  async function refresh() {
    const [cat, idx] = await Promise.all([api('/api/catalogue'), api('/api/index')]);
    S.cat = cat;
    S.index = idx.items;
    S.svcMeta = new Map(cat.services.map((s) => [s.id, s]));
    S.details.clear();
    fillFolders();
  }
  async function detail(id) {
    if (!S.details.has(id)) S.details.set(id, api(`/api/services/${enc(id)}`));
    return S.details.get(id);
  }

  function fillFolders() {
    const sel = $('#f-folder');
    const folders = [...new Set(S.cat.services.map((s) => s.folder))].sort();
    sel.innerHTML = '<option value="">All folders</option>' + folders.map((f) => `<option value="${esc(f)}">${esc(f === '.' ? '(root)' : f)}</option>`).join('');
    if (folders.includes(S.folder)) sel.value = S.folder; else S.folder = '';
  }

  const passesFilters = (svc) => {
    if (!svc) return false;
    if (S.folder && svc.folder !== S.folder) return false;
    switch (S.kind) {
      case '': return true;
      case 'xsd': return svc.kind === 'xsd';
      case 'wsdl2': return svc.wsdlVersion === '2.0';
      case 'rpc': return svc.kind === 'wsdl' && S.rpcIds && S.rpcIds.has(svc.id);
      default: return svc.kind === 'wsdl' && (svc.soapVersions || []).includes(S.kind);
    }
  };

  /* ------------------------------ search ------------------------------ */
  const ALIASES = { s: 'svc', svc: 'svc', service: 'svc', o: 'op', op: 'op', operation: 'op', f: 'field', field: 'field', t: 'type', type: 'type', ns: 'ns', in: 'dir', dir: 'dir' };
  function parseQuery(q) {
    const pq = { terms: [] };
    for (const tok of q.match(/(\w+:"[^"]*"|"[^"]*"|\S+)/g) || []) {
      const m = /^(\w+):(.*)$/.exec(tok);
      const val = (m ? m[2] : tok).replace(/^"|"$/g, '').toLowerCase();
      if (m && ALIASES[m[1].toLowerCase()]) { if (val) pq[ALIASES[m[1].toLowerCase()]] = val; } else if (val) pq.terms.push(val);
    }
    return pq;
  }
  const lc = (s) => String(s || '').toLowerCase();
  function matches(it, pq) {
    const svcName = it.k === 'service' ? it.name : it.svc;
    if (pq.svc && !lc(svcName).includes(pq.svc)) return false;
    if (pq.op) {
      const opName = it.op || it.el || (it.k === 'operation' || it.k === 'element' ? it.name : '');
      if (!lc(opName).includes(pq.op) || it.k === 'service' || it.k === 'type') return false;
    }
    if (pq.field && (it.k !== 'field' || !(lc(it.name).includes(pq.field) || lc(it.path).includes(pq.field)))) return false;
    if (pq.type) {
      if (it.k === 'field') { if (!lc(it.type).includes(pq.type)) return false; } else if (it.k === 'type') { if (!lc(it.name).includes(pq.type)) return false; } else return false;
    }
    if (pq.ns && !lc(it.ns || (S.svcMeta.get(it.id) || {}).targetNamespace).includes(pq.ns)) return false;
    if (pq.dir && (it.k !== 'field' || !lc(it.dir).startsWith(pq.dir))) return false;
    if (pq.terms.length) {
      const hay = lc([it.name, it.path, it.type, it.op, it.el, it.svc, it.doc, it.action, it.in, it.out, it.folder, it.ns].join(' '));
      if (!pq.terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  }
  function score(it, pq) {
    const n = lc(it.name);
    const t = pq.terms[0] || pq.field || pq.op || pq.type || pq.svc || '';
    if (!t) return 0;
    if (n === t) return 100;
    if (n.startsWith(t)) return 60;
    if (n.includes(t)) return 30;
    return 1;
  }
  const GROUPS = [
    { key: 'service', label: 'Services', kinds: ['service'] },
    { key: 'operation', label: 'Operations & elements', kinds: ['operation', 'element'] },
    { key: 'field', label: 'Fields', kinds: ['field'] },
    { key: 'type', label: 'Types', kinds: ['type'] },
  ];
  function search() {
    const pq = parseQuery(S.q);
    const allowed = S.scope === 'all' ? null : GROUPS.find((g) => g.key === S.scope).kinds;
    const res = [];
    for (const it of S.index) {
      if (allowed && !allowed.includes(it.k)) continue;
      if (!passesFilters(S.svcMeta.get(it.id))) continue;
      if (matches(it, pq)) res.push(it);
    }
    res.sort((a, b) => score(b, pq) - score(a, pq) || lc(a.name).localeCompare(lc(b.name)));
    return { pq, res };
  }
  function mark(text, pq) {
    const terms = [...pq.terms, pq.field, pq.op, pq.svc, pq.type].filter(Boolean).sort((a, b) => b.length - a.length);
    let s = esc(text);
    if (!terms.length) return s;
    const re = new RegExp(`(${terms.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return s.replace(re, '<mark>$1</mark>');
  }
  function resultHref(it) {
    if (it.k === 'service' || it.k === 'type') return svcHref(it.id);
    if (it.k === 'operation') return opHref(it.id, it.op);
    if (it.k === 'element') return elHref(it.id, it.el);
    const extra = `dir=${enc(it.dir)}&field=${enc(it.path)}`;
    return it.el ? elHref(it.id, it.el, `field=${enc(it.path)}`) : opHref(it.id, it.op, extra);
  }
  function renderResults() {
    const { pq, res } = search();
    const nav = $('#nav');
    if (!res.length) { nav.innerHTML = `<div class="empty-nav">No matches for <b>${esc(S.q)}</b></div>`; return; }
    let html = '';
    for (const g of GROUPS) {
      const items = res.filter((r) => g.kinds.includes(r.k));
      if (!items.length) continue;
      const cap = S.showAll === g.key || S.scope === g.key ? 400 : 25;
      html += `<div class="res-group"><h4><span>${g.label}</span><span>${items.length}</span></h4>`;
      for (const it of items.slice(0, cap)) {
        let title; let sub;
        if (it.k === 'service') { title = `<span class="badge ${S.svcMeta.get(it.id)?.kind === 'xsd' ? 'xsd' : 'soap'}">${S.svcMeta.get(it.id)?.kind === 'xsd' ? 'XSD' : 'SVC'}</span><span>${mark(it.name, pq)}</span>`; sub = esc(it.folder); }
        else if (it.k === 'operation') { title = `<i class="k-dot"></i><span>${mark(it.name, pq)}</span>`; sub = `${esc(it.svc)}${it.action ? ` · ${mark(it.action, pq)}` : ''}`; }
        else if (it.k === 'element') { title = `<i class="k-dot el"></i><span>${mark(it.name, pq)}</span>`; sub = `${esc(it.svc)} · element`; }
        else if (it.k === 'field') { title = `<span>${mark(it.name, pq)}</span><span class="badge">${esc(it.type || '')}</span>`; sub = `${esc(it.op || it.el)} · ${esc(it.dir.replace('fault:', 'fault '))} · ${mark(it.path, pq)}`; }
        else { title = `<span class="badge xsd">${it.tkind === 'simpleType' ? 'ST' : 'CT'}</span><span>${mark(it.name, pq)}</span>`; sub = `${esc(it.svc)} · ${esc(it.ns || '')}`; }
        html += `<a class="res" href="${resultHref(it)}"><div class="t">${title}</div><div class="s">${sub}</div></a>`;
      }
      if (items.length > cap) html += `<button class="more" data-more="${g.key}">Show all ${items.length} ${g.label.toLowerCase()}</button>`;
      html += '</div>';
    }
    nav.innerHTML = html;
    S.kb = -1;
  }

  /* ------------------------------ sidebar tree ------------------------------ */
  /* ------------------------------ favorites ------------------------------ */
  // Keys: s:<serviceId> | o:<serviceId>/<operation> | e:<serviceId>/<element>. Stored per browser.
  const favKey = {
    svc: (id) => `s:${id}`,
    op: (id, op) => `o:${id}/${op}`,
    el: (id, el) => `e:${id}/${el}`,
  };
  const STAR = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6l2.27 4.6 5.08.74-3.68 3.58.87 5.06L10 14.2l-4.54 2.38.87-5.06L2.65 7.94l5.08-.74z"/></svg>';
  function star(key, cls = '') {
    const on = S.favs.has(key);
    return `<button class="star${on ? ' on' : ''}${cls ? ` ${cls}` : ''}" data-fav="${esc(key)}" aria-pressed="${on}" title="${on ? 'Remove from favorites' : 'Add to favorites'}">${STAR}</button>`;
  }
  /** Favorites that still resolve to something in the catalogue, in the order they were added. */
  function favItems() {
    return [...S.favs].map((k) => {
      const type = k[0];
      const rest = k.slice(2);
      if (type === 's') {
        const svc = S.svcMeta.get(rest);
        return svc && { k, type: 'svc', svc, name: svc.name, href: svcHref(svc.id) };
      }
      const i = rest.indexOf('/');
      const svc = S.svcMeta.get(rest.slice(0, i));
      const name = rest.slice(i + 1);
      if (!svc) return null;
      if (type === 'o' && svc.operations.includes(name)) return { k, type: 'op', svc, name, href: opHref(svc.id, name) };
      if (type === 'e' && svc.elements.includes(name)) return { k, type: 'el', svc, name, href: elHref(svc.id, name) };
      return null;
    }).filter(Boolean);
  }
  function toggleFav(key) {
    if (S.favs.has(key)) S.favs.delete(key); else S.favs.add(key);
    save('favs', [...S.favs]);
    const on = S.favs.has(key);
    $$('[data-fav]').filter((b) => b.dataset.fav === key).forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
      b.title = on ? 'Remove from favorites' : 'Add to favorites';
    });
    renderNav();
    if (parseRoute().view === 'home') renderHome();
  }
  const favIcon = (f) => (f.type === 'svc' ? `<span class="badge ${f.svc.kind === 'xsd' ? 'xsd' : 'soap'}">${f.svc.kind === 'xsd' ? 'XSD' : 'SVC'}</span>`
    : `<i class="k-dot${f.type === 'el' ? ' el' : ''}"></i>`);

  function renderNav() {
    if (!S.cat) return;
    if (S.q.trim()) { renderResults(); renderFoot(); return; }
    const r = parseRoute();
    const svcs = S.cat.services.filter(passesFilters);
    const nav = $('#nav');
    if (!S.cat.services.length) { nav.innerHTML = '<div class="empty-nav">No services yet.<br>Drop WSDL/XSD files into the catalogue folder.</div>'; renderFoot(); return; }
    const favs = favItems();
    let html = '';
    if (favs.length) {
      html += `<div class="nav-group fav-group"><div class="gh"><span>Favorites</span><span>${favs.length}</span></div>`;
      for (const f of favs) {
        const active = (f.type === 'svc' && r.view === 'service' && r.id === f.svc.id) || (f.type === 'op' && r.view === 'op' && r.id === f.svc.id && r.op === f.name)
          || (f.type === 'el' && r.view === 'el' && r.id === f.svc.id && r.el === f.name);
        html += `<a class="fav-link${active ? ' active' : ''}" href="${f.href}">${favIcon(f)}<span class="nm"><span class="t">${esc(f.name)}</span>${f.type === 'svc' ? '' : `<span class="s">${esc(f.svc.name)}</span>`}</span>${star(f.k)}</a>`;
      }
      html += '</div>';
    }
    if (!svcs.length) { nav.innerHTML = `${html}<div class="empty-nav">No services match the filters.</div>`; renderFoot(); return; }
    const byFolder = new Map();
    svcs.forEach((s) => { if (!byFolder.has(s.folder)) byFolder.set(s.folder, []); byFolder.get(s.folder).push(s); });
    for (const [folder, list] of byFolder) {
      html += `<div class="nav-group"><div class="gh"><span>${esc(folder === '.' ? 'root' : folder)}</span><span>${list.length}</span></div>`;
      for (const s of list) {
        const open = S.expanded.has(s.id) || r.id === s.id;
        const active = r.id === s.id && r.view === 'service';
        const count = s.operations.length + s.elements.length;
        html += `<a class="svc${open ? ' open' : ''}${active ? ' active' : ''}" href="${svcHref(s.id)}" data-svc="${esc(s.id)}">
          <span class="tw" data-toggle="${esc(s.id)}">${ICON_CHEV}</span>
          <span class="nm" title="${esc(s.name)}">${esc(s.name)}</span>
          ${s.kind === 'xsd' ? '<span class="badge xsd">XSD</span>' : ''}${star(favKey.svc(s.id), 'hov')}<span class="ct">${count}</span></a>`;
        if (open) {
          html += '<div class="ops">';
          for (const o of s.operations) html += `<a class="op-link${r.view === 'op' && r.id === s.id && r.op === o ? ' active' : ''}" href="${opHref(s.id, o)}"><span class="nm">${esc(o)}</span>${star(favKey.op(s.id, o), 'hov')}</a>`;
          for (const e of s.elements) html += `<a class="op-link${r.view === 'el' && r.id === s.id && r.el === e ? ' active' : ''}" href="${elHref(s.id, e)}"><i class="k-dot el"></i><span class="nm">${esc(e)}</span>${star(favKey.el(s.id, e), 'hov')}</a>`;
          html += '</div>';
        }
      }
      html += '</div>';
    }
    nav.innerHTML = html;
    renderFoot();
  }
  function renderFoot() {
    const c = S.cat;
    if (!c) return;
    const p = c.problems.length;
    $('#foot').innerHTML = `<span>${c.services.length} service${c.services.length === 1 ? '' : 's'} · v${c.version}</span>${p ? `<a href="#/" data-problems>${p} problem${p > 1 ? 's' : ''}</a>` : '<span>No problems</span>'}`;
  }

  /* ------------------------------ views ------------------------------ */
  const main = () => $('#main');
  const badgeRow = (s) => [
    s.kind === 'xsd' ? '<span class="badge xsd">XSD</span>' : `<span class="badge soap">WSDL ${esc(s.wsdlVersion || '1.1')}</span>`,
    ...(s.kind === 'wsdl' ? (s.soapVersions || []).map((v) => `<span class="badge">SOAP ${esc(v)}</span>`) : []),
  ].join(' ');

  function renderHome() {
    const c = S.cat;
    const svcs = c.services.filter(passesFilters);
    const ops = svcs.reduce((n, s) => n + s.operations.length, 0);
    const fields = S.index.filter((i) => i.k === 'field' && passesFilters(S.svcMeta.get(i.id))).length;
    const types = S.index.filter((i) => i.k === 'type' && passesFilters(S.svcMeta.get(i.id))).length;
    const recent = [...svcs].sort((a, b) => b.updatedAt - a.updatedAt);
    let html = `<div class="page"><div class="title-row"><h1>Service catalogue</h1>
      <div class="row-actions"><button class="btn" data-action="rescan">Rescan</button><button class="btn primary" data-action="upload">Add WSDL / XSD</button></div></div>
      <p class="sub">Watching <code>${esc(c.directory)}</code>. New and changed files are parsed automatically, and every service gets an OpenAPI 3.0 spec with sample payloads.</p>
      <div class="stats">
        <div class="card stat"><div class="n">${svcs.length}</div><div class="l">Services</div></div>
        <div class="card stat"><div class="n">${ops}</div><div class="l">Operations</div></div>
        <div class="card stat"><div class="n">${fields.toLocaleString()}</div><div class="l">Fields</div></div>
        <div class="card stat"><div class="n">${types}</div><div class="l">Schema types</div></div>
        <div class="card stat"><div class="n" style="color:${c.problems.length ? 'var(--warn)' : 'var(--ok)'}">${c.problems.length}</div><div class="l">Problems</div></div>
      </div>`;
    if (!c.services.length) {
      html += `<div class="card hero"><h2>Drop your first service</h2>
        <p>Copy WSDL and XSD files (or whole service folders) into <code>${esc(c.directory)}</code>, or drag them onto this window.</p>
        <p>Imports and includes are resolved relative to each file, so keep a service's schemas alongside its WSDL.</p>
        <button class="btn primary" data-action="upload">Choose files…</button></div>`;
    } else {
      const favs = favItems();
      html += `<div class="section-h"><h2>Favorites</h2><span class="c">${favs.length ? favs.length : 'star a service or operation to pin it here'}</span></div>`;
      if (favs.length) {
        html += `<div class="fav-grid">${favs.map((f) => `<a class="card fav-card" href="${f.href}">${favIcon(f)}<span class="nm"><span class="t">${esc(f.name)}</span><span class="s">${f.type === 'svc' ? `${f.svc.operations.length} operations · ${esc(f.svc.folder)}` : `${esc(f.svc.name)} · ${f.type === 'op' ? 'operation' : 'element'}`}</span></span>${star(f.k)}</a>`).join('')}</div>`;
      }
      html += `<div class="section-h"><h2>Services</h2><span class="c">most recently changed first</span></div><div class="svc-grid">`;
      for (const s of recent) {
        const ops = s.operations.length;
        const els = s.elements.length;
        const list = ops ? s.operations : s.elements;
        const shown = list.slice(0, 3);
        html += `<a class="card svc-card" href="${svcHref(s.id)}"><div class="h"><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span><span class="bd">${badgeRow(s)}${star(favKey.svc(s.id))}</span></div>
          <div class="f">${esc(s.source)}</div>
          <div class="count"><span class="n">${ops || els}</span><span class="l">${ops ? `operation${ops === 1 ? '' : 's'}` : `element${els === 1 ? '' : 's'}`}${ops && els ? ` · ${els} element${els === 1 ? '' : 's'}` : ''}</span></div>
          <div class="ops-l">${list.length ? shown.map((o) => `<span class="op-chip">${esc(o)}</span>`).join('') + (list.length > shown.length ? `<span class="op-more">+${list.length - shown.length} more…</span>` : '') : '<i>No operations</i>'}</div></a>`;
      }
      html += '</div>';
    }
    if (c.problems.length) html += problemsBlock(c.problems);
    html += '</div>';
    main().innerHTML = html;
  }

  function problemsBlock(list) {
    return `<div class="section-h" id="problems"><h2>Problems</h2><span class="c">${list.length}</span></div>
      <div class="card"><ul class="problems">${list.map((p) => `<li><span class="badge ${p.level === 'error' ? 'err' : 'warn'}">${esc(p.level)}</span><code>${esc(p.file)}</code><span>${esc(p.message)}</span></li>`).join('')}</ul></div>`;
  }

  async function renderService(r) {
    const d = await detail(r.id);
    const tab = r.tab || 'ops';
    const s = S.svcMeta.get(r.id);
    const probs = S.cat.problems.filter((p) => d.files.includes(p.file));
    let html = `<div class="page"><div class="crumbs"><a href="#/">Catalogue</a><span>/</span><span>${esc(d.folder)}</span></div>
      <div class="title-row"><h1>${esc(d.name)}</h1>${star(favKey.svc(d.id), 'lg')}${badgeRow(s)}
        <div class="row-actions">
          <a class="btn" href="/docs/${enc(d.id)}" target="_blank" rel="noopener">Swagger UI ↗</a>
          <a class="btn" href="/api/services/${enc(d.id)}/openapi.yaml?download=1">OpenAPI YAML</a>
          <a class="btn" href="/api/services/${enc(d.id)}/openapi.json?download=1">OpenAPI JSON</a>
        </div></div>
      ${d.doc ? `<p class="sub">${esc(d.doc)}</p>` : ''}
      <div class="meta">${d.targetNamespace ? `<span><b>Namespace</b><code>${esc(d.targetNamespace)}</code></span>` : ''}
        <span><b>Source</b><code>${esc(d.source)}</code></span>
        ${d.endpoints.filter((e) => e.address).slice(0, 2).map((e) => `<span><b>Endpoint</b><code>${esc(e.address)}</code></span>`).join('')}</div>
      <div class="tabs">
        ${[['ops', d.kind === 'xsd' ? 'Operations & elements' : 'Operations'], ['spec', 'OpenAPI spec'], ['info', 'Endpoints & types'], ['source', 'Source files'], ...(probs.length ? [['problems', `Problems (${probs.length})`]] : [])]
          .map(([k, l]) => `<a href="${svcHref(d.id, k === 'ops' ? '' : k)}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('')}
      </div>`;

    if (tab === 'ops') {
      if (d.operations.length) {
        html += '<div class="op-grid">';
        for (const o of d.operations) {
          html += `<a class="card op-card" href="${opHref(d.id, o.name)}"><div class="h"><i class="k-dot${o.output ? '' : ' oneway'}"></i><span class="nm" title="${esc(o.name)}">${esc(o.name)}</span>
            <span class="bd">${o.inferred ? '<span class="badge xsd">inferred</span>' : ''}<span class="badge">${esc(o.pattern)}</span>${star(favKey.op(d.id, o.name))}</span></div>
            ${o.doc ? `<div class="d">${esc(o.doc)}</div>` : ''}
            <div class="io"><span class="t" title="${esc(o.inputElement || '')}">${esc(o.inputElement || '—')}</span><span class="ar">→</span><span class="t" title="${esc(o.outputElement || '')}">${esc(o.outputElement || '(none)')}</span>${o.faults.length ? `<span class="badge warn">${o.faults.length} fault${o.faults.length > 1 ? 's' : ''}</span>` : ''}</div>
            <div class="io"><span class="t" title="POST ${esc(o.path)}">POST ${esc(o.path)}</span></div></a>`;
        }
        html += '</div>';
      } else if (d.kind !== 'xsd') html += '<p class="note">This WSDL declares no operations.</p>';
      if (d.elements && d.elements.length) {
        html += `<div class="section-h"><h2>Global elements</h2><span class="c">${d.elements.length}</span></div><div class="op-grid">`;
        for (const e of d.elements) {
          html += `<a class="card op-card" href="${elHref(d.id, e.name)}"><div class="h"><i class="k-dot el"></i><span class="nm" title="${esc(e.name)}">${esc(e.name)}</span><span class="bd"><span class="badge">${e.fields.length} fields</span>${star(favKey.el(d.id, e.name))}</span></div>
            ${e.doc ? `<div class="d">${esc(e.doc)}</div>` : ''}<div class="io"><span class="t" title="${esc(e.ns)}">${esc(e.ns)}</span></div></a>`;
        }
        html += '</div>';
      }
    } else if (tab === 'spec') {
      const fmt = S.ui.specFmt;
      const raw = await fetch(`/api/services/${enc(d.id)}/openapi.${fmt}`).then((x) => x.text());
      const text = fmt === 'json' ? JSON.stringify(JSON.parse(raw), null, 2) : raw;
      html += `<div class="toolbar"><div class="seg" data-seg="specFmt">${['yaml', 'json'].map((f) => `<button data-v="${f}" class="${fmt === f ? 'on' : ''}">${f.toUpperCase()}</button>`).join('')}</div>
        <span class="c" style="color:var(--text-3);font-size:12px">${d.operations.length} paths · ${d.schemaCount} schemas</span>
        <div class="row-actions">${foldTools}<button class="btn sm" data-copy="spec">Copy</button></div></div>
        <div class="card"><div class="pane-b" style="max-height:none;border-radius:var(--radius)">${codeBlock(text, fmt)}</div></div>`;
      S.copy = { spec: text };
    } else if (tab === 'info') {
      html += `<div class="section-h"><h2>Endpoints</h2></div><div class="card">${d.endpoints.length ? `<table class="simple"><tr><th>Port</th><th>Binding</th><th>Protocol</th><th>Address</th></tr>
        ${d.endpoints.map((e) => `<tr><td>${esc(e.port)}</td><td>${esc(e.binding || '')}</td><td>${e.soapVersion === 'http' ? 'HTTP' : `SOAP ${esc(e.soapVersion || '')}`}</td><td><code>${esc(e.address || '—')}</code></td></tr>`).join('')}</table>`
        : '<div class="note">No endpoints declared</div>'}</div>
        <div class="section-h"><h2>Namespaces</h2></div><div class="card"><dl class="kv">${d.namespaces.map((n, i) => `<dt>${i === 0 ? 'Namespaces' : ''}</dt><dd>${esc(n)}</dd>`).join('')}</dl></div>
        <div class="section-h"><h2>Schema types</h2><span class="c">${d.types.length}</span></div>
        <div class="card"><table class="simple"><tr><th>Name</th><th>Kind</th><th>Namespace</th></tr>
        ${d.types.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.kind)}</td><td><code>${esc(t.ns)}</code></td></tr>`).join('') || '<tr><td colspan="3" class="note">None</td></tr>'}</table></div>`;
    } else if (tab === 'source') {
      const file = d.files.includes(S.ui.srcFile) ? S.ui.srcFile : d.source;
      const text = await fetch(`/api/source?path=${enc(file)}`).then((x) => x.text());
      html += `<div class="toolbar"><select id="src-file" class="btn" style="max-width:100%">${d.files.map((f) => `<option ${f === file ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
        <div class="row-actions">${foldTools}<button class="btn sm" data-copy="src">Copy</button></div></div>
        <div class="card"><div class="pane-b" style="border-radius:var(--radius)">${codeBlock(text, 'xml')}</div></div>`;
      S.copy = { src: text };
    } else if (tab === 'problems') {
      html += problemsBlock(probs);
    }
    html += '</div>';
    main().innerHTML = html;
  }

  /* ---------- operation & element workspaces ---------- */
  function fieldsTable(groups, focusPath, pq) {
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    let html = `<div class="fields-tools"><input id="field-filter" placeholder="Filter fields…" value="${esc(S.ui.fieldFilter)}"><span class="c" id="field-count">${total} fields</span></div>
      <table class="fields"><thead><tr><th>Field</th><th>Type</th><th>Occurs</th></tr></thead><tbody>`;
    for (const g of groups) {
      if (g.label) html += `<tr><td colspan="3" style="font-weight:650;color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding-top:12px">${esc(g.label)}</td></tr>`;
      for (const r of g.rows) {
        const nm = r.kind === 'attribute' ? `<span class="a">${mark(r.name, pq)}</span>` : r.kind === 'choice' ? '<span class="ch">choice</span>' : r.kind === 'any' ? '<span class="ch">any</span>' : mark(r.name, pq);
        html += `<tr data-path="${esc(r.path)}" data-search="${esc(lc(`${r.name} ${r.type} ${r.path} ${r.constraints} ${r.doc || ''}`))}" class="${focusPath === r.path ? 'focus' : ''}">
          <td class="fn"><span class="ind" style="width:${r.depth * 14}px"></span>${nm}${r.required && r.kind !== 'choice' ? '<span class="req" title="required">*</span>' : ''}${r.choice ? `<span class="opt-tag">option ${r.choice}</span>` : ''}${r.recursive ? '<span class="opt-tag">recursive</span>' : ''}
            ${r.constraints ? `<div class="cn" style="padding-left:${r.depth * 14}px">${esc(r.constraints)}</div>` : ''}
            ${r.doc ? `<div class="dc" style="padding-left:${r.depth * 14}px">${esc(r.doc)}</div>` : ''}</td>
          <td class="ty">${mark(r.type || '', pq)}</td><td class="oc">${esc(r.occurs)}</td></tr>`;
      }
    }
    return `${html}</tbody></table>`;
  }

  function pane({ id, label, cls, tabs, active, body, plain }) {
    return `<section class="card pane" id="${id}"><div class="pane-h"><span class="lbl ${cls || ''}"><i></i>${label}</span>
      <div class="tabs" data-pane="${id}">${tabs.map(([k, l]) => `<button data-v="${k}" class="${active === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="acts">${body.includes('class="code cv"') ? foldTools : ''}<button class="btn sm" data-copy="${id}">Copy</button></div></div>
      <div class="pane-b${plain ? ' plain' : ''}">${body}</div></section>`;
  }

  async function renderOp(r) {
    const d = await detail(r.id);
    const op = d.operations.find((o) => o.name === r.op);
    if (!op) { main().innerHTML = `<div class="page"><p class="note">Operation <b>${esc(r.op)}</b> not found in ${esc(d.name)}.</p></div>`; return; }
    const pq = parseQuery(S.q);
    const versions = Object.keys(op.samples.soap);
    const v = versions.includes(S.ui.soap) ? S.ui.soap : versions[0];
    const dirs = [];
    if (op.input) dirs.push(['request', 'Request']);
    if (op.output) dirs.push(['response', 'Response']);
    op.faults.forEach((f) => dirs.push([`fault:${f.name}`, `Fault: ${f.name}`]));
    let dir = r.params.get('dir') || S.ui.dir;
    if (dir === 'header') dir = 'request';
    if (!dirs.some(([k]) => k === dir)) dir = dirs[0] ? dirs[0][0] : 'request';
    S.ui.dir = dir;
    const focus = r.params.get('field');
    if (focus) S.ui.left = 'fields';

    const faultName = dir.startsWith('fault:') ? dir.slice(6) : null;
    const soap = op.samples.soap[v] || {};
    const xml = faultName ? (soap.faults.find((f) => f.name === faultName) || {}).xml : soap[dir];
    const json = faultName ? (op.samples.json.faults.find((f) => f.name === faultName) || {}).body : op.samples.json[dir];
    const fieldGroups = faultName ? [{ rows: (op.fields.faults.find((f) => f.name === faultName) || { rows: [] }).rows }]
      : dir === 'request' ? [...(op.fields.headers.length ? [{ label: 'SOAP Header', rows: op.fields.headers }, { label: 'SOAP Body', rows: op.fields.request }] : [{ rows: op.fields.request }])]
        : [{ rows: op.fields.response }];

    const specYaml = op.openapiYaml;
    const specJson = JSON.stringify(op.openapi, null, 2);
    const jsonText = json === undefined || json === null ? null : JSON.stringify(json, null, 2);
    S.copy = { left: S.ui.left === 'fields' ? fieldGroups.flatMap((g) => g.rows).map((x) => `${x.path}\t${x.type}\t${x.occurs}`).join('\n') : xml,
      right: S.ui.right === 'json' ? jsonText : S.ui.right === 'yaml' ? specYaml : specJson };

    const ep = d.endpoints.find((e) => e.soapVersion === v && e.address) || d.endpoints.find((e) => e.address);
    const html = `<div class="page">
      <div class="crumbs"><a href="#/">Catalogue</a><span>/</span><span>${esc(d.folder)}</span><span>/</span><a href="${svcHref(d.id)}">${esc(d.name)}</a></div>
      <div class="title-row"><h1>${esc(op.name)}</h1>${star(favKey.op(d.id, op.name), 'lg')}<span class="badge">${esc(op.pattern)}</span><span class="badge">${esc(op.style)}/${esc(op.use || 'literal')}</span>
        ${op.inferred ? '<span class="badge xsd">inferred from XSD</span>' : ''}${op.faults.length ? `<span class="badge warn">${op.faults.length} fault${op.faults.length > 1 ? 's' : ''}</span>` : ''}
        <div class="row-actions"><a class="btn" href="/docs/${enc(d.id)}#/${enc(d.name)}/${enc(op.openapi.paths[op.path]?.post?.operationId || '')}" target="_blank" rel="noopener">Swagger UI ↗</a>
        <a class="btn" href="/api/services/${enc(d.id)}/operations/${enc(op.name)}/openapi.yaml" target="_blank">Spec YAML</a></div></div>
      ${op.doc ? `<p class="sub">${esc(op.doc)}</p>` : ''}
      <div class="meta">
        ${op.soapAction != null ? `<span><b>SOAPAction</b><code>${esc(op.soapAction || '""')}</code></span>` : ''}
        <span><b>Input</b><code>${esc(op.inputElement || '—')}</code></span>
        <span><b>Output</b><code>${esc(op.outputElement || '—')}</code></span>
        <span><b>REST facade</b><code>POST ${esc(op.path)}</code></span>
        ${ep ? `<span><b>Endpoint</b><code>${esc(ep.address)}</code></span>` : ''}
      </div>
      <div class="toolbar">
        <div class="seg" data-seg="dir">${dirs.map(([k, l]) => `<button data-v="${esc(k)}" class="${dir === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
        ${versions.length > 1 ? `<div class="seg" data-seg="soap">${versions.map((x) => `<button data-v="${x}" class="${v === x ? 'on' : ''}">SOAP ${x}</button>`).join('')}</div>` : `<span class="badge">SOAP ${esc(v)}</span>`}
      </div>
      <div class="split">
        ${pane({ id: 'left', label: 'WSDL · SOAP', tabs: [['sample', 'Sample XML'], ['fields', `Fields (${fieldGroups.reduce((n, g) => n + g.rows.length, 0)})`]], active: S.ui.left,
          plain: S.ui.left === 'fields', body: S.ui.left === 'fields' ? fieldsTable(fieldGroups, focus, pq) : codeBlock(xml, 'xml') })}
        ${pane({ id: 'right', label: 'OpenAPI 3.0', cls: 'oas', tabs: [['json', `Sample JSON`], ['yaml', 'Spec YAML'], ['spec-json', 'Spec JSON']], active: S.ui.right,
          body: S.ui.right === 'json' ? (jsonText == null ? `<div class="note">${dir === 'response' ? 'One-way operation: no response body' : 'No body'}</div>` : codeBlock(jsonText, 'json'))
            : S.ui.right === 'yaml' ? codeBlock(specYaml, 'yaml') : codeBlock(specJson, 'json') })}
      </div>
    </div>`;
    main().innerHTML = html;
    afterFields(focus);
  }

  async function renderEl(r) {
    const d = await detail(r.id);
    const el = (d.elements || []).find((e) => e.name === r.el);
    if (!el) { main().innerHTML = `<div class="page"><p class="note">Element <b>${esc(r.el)}</b> not found.</p></div>`; return; }
    const pq = parseQuery(S.q);
    const focus = r.params.get('field');
    if (focus) S.ui.left = 'fields';
    const right = ['json', 'yaml', 'spec-json'].includes(S.ui.right) ? S.ui.right : 'json';
    const specYaml = el.openapiYaml;
    const specJson = JSON.stringify(el.openapi, null, 2);
    const jsonText = JSON.stringify(el.samples.json, null, 2);
    S.copy = { left: S.ui.left === 'fields' ? el.fields.map((x) => `${x.path}\t${x.type}\t${x.occurs}`).join('\n') : el.samples.xml,
      right: right === 'json' ? jsonText : right === 'yaml' ? specYaml : specJson };
    main().innerHTML = `<div class="page">
      <div class="crumbs"><a href="#/">Catalogue</a><span>/</span><span>${esc(d.folder)}</span><span>/</span><a href="${svcHref(d.id)}">${esc(d.name)}</a></div>
      <div class="title-row"><h1>${esc(el.name)}</h1>${star(favKey.el(d.id, el.name), 'lg')}<span class="badge xsd">global element</span>
        <div class="row-actions"><a class="btn" href="/docs/${enc(d.id)}" target="_blank" rel="noopener">Swagger UI ↗</a></div></div>
      ${el.doc ? `<p class="sub">${esc(el.doc)}</p>` : ''}
      <div class="meta"><span><b>Namespace</b><code>${esc(el.ns || '(none)')}</code></span><span><b>Component</b><code>#/components/schemas/${esc(el.component)}</code></span></div>
      <div class="toolbar"></div>
      <div class="split">
        ${pane({ id: 'left', label: 'XSD · XML', tabs: [['sample', 'Sample XML'], ['fields', `Fields (${el.fields.length})`]], active: S.ui.left,
          plain: S.ui.left === 'fields', body: S.ui.left === 'fields' ? fieldsTable([{ rows: el.fields }], focus, pq) : codeBlock(el.samples.xml, 'xml') })}
        ${pane({ id: 'right', label: 'OpenAPI 3.0', cls: 'oas', tabs: [['json', 'Sample JSON'], ['yaml', 'Schema YAML'], ['spec-json', 'Schema JSON']], active: right,
          body: right === 'json' ? codeBlock(jsonText, 'json') : right === 'yaml' ? codeBlock(specYaml, 'yaml') : codeBlock(specJson, 'json') })}
      </div></div>`;
    afterFields(focus);
  }

  function afterFields(focus) {
    applyFieldFilter();
    if (focus) {
      const row = $$('tr[data-path]').find((tr) => tr.dataset.path === focus);
      if (row) row.scrollIntoView({ block: 'center' });
    }
  }
  function applyFieldFilter() {
    const input = $('#field-filter');
    if (!input) return;
    const f = lc(S.ui.fieldFilter).trim();
    let n = 0;
    $$('tr[data-path]').forEach((tr) => {
      const show = !f || tr.dataset.search.includes(f);
      tr.hidden = !show;
      if (show) n++;
    });
    $('#field-count').textContent = f ? `${n} matching` : `${n} fields`;
  }

  /* ------------------------------ render loop ------------------------------ */
  let renderSeq = 0;
  async function render() {
    if (!S.cat) return;
    const seq = ++renderSeq;
    renderNav();
    const r = parseRoute();
    try {
      if (r.view === 'home') renderHome();
      else if (!S.svcMeta.has(r.id)) {
        main().innerHTML = `<div class="page"><p class="note">Service <b>${esc(r.id)}</b> is no longer in the catalogue. <a href="#/">Back to catalogue</a></p></div>`;
      } else if (r.view === 'service') await renderService(r);
      else if (r.view === 'op') await renderOp(r);
      else if (r.view === 'el') await renderEl(r);
    } catch (e) {
      if (seq === renderSeq) main().innerHTML = `<div class="page"><p class="note">Failed to load: ${esc(e.message)}</p></div>`;
    }
  }

  /* ------------------------------ events ------------------------------ */
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { S.q = e.target.value; S.showAll = null; renderNav(); }, 110);
  });
  $('#q').addEventListener('keydown', (e) => {
    const items = $$('#nav .res');
    if (e.key === 'Escape') { e.target.value = ''; S.q = ''; renderNav(); e.target.blur(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      S.kb = Math.max(0, Math.min(items.length - 1, S.kb + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((x, i) => x.classList.toggle('kb', i === S.kb));
      items[S.kb].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const t = items[Math.max(0, S.kb)];
      if (t) location.hash = t.getAttribute('href');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); $('#q').select(); }
  });
  $('#scope').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.scope = b.dataset.scope;
    $$('#scope button').forEach((x) => x.classList.toggle('on', x === b));
    if (!S.q.trim() && S.scope !== 'all') { $('#q').focus(); }
    renderNav();
  });
  $('#f-folder').addEventListener('change', (e) => { S.folder = e.target.value; render(); });
  $('#f-kind').addEventListener('change', async (e) => {
    S.kind = e.target.value;
    if (S.kind === 'rpc' && !S.rpcIds) {
      const ids = S.cat.services.filter((s) => s.kind === 'wsdl').map((s) => s.id);
      const ds = await Promise.all(ids.map((id) => detail(id)));
      S.rpcIds = new Set(ds.filter((d) => d.operations.some((o) => o.style === 'rpc')).map((d) => d.id));
    }
    render();
  });

  $('#nav').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      e.preventDefault();
      const id = t.dataset.toggle;
      if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
      save('expanded', [...S.expanded]);
      renderNav();
      return;
    }
    const m = e.target.closest('[data-more]');
    if (m) { S.showAll = m.dataset.more; renderResults(); }
  });
  $('#foot').addEventListener('click', (e) => {
    if (e.target.closest('[data-problems]')) setTimeout(() => $('#problems')?.scrollIntoView({ behavior: 'smooth' }), 50);
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fav]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    toggleFav(b.dataset.fav);
  }, true);

  main().addEventListener('click', async (e) => {
    const fold = e.target.closest('.cv .fold');
    if (fold) { setFold(fold, !fold.classList.contains('closed')); return; }
    const ph = e.target.closest('.cv .ph');
    if (ph) { setFold(ph.closest('.r').querySelector('.fold'), false); return; }
    const all = e.target.closest('[data-cv]');
    if (all) {
      const cv = (all.closest('.pane') || all.closest('.page')).querySelector('.cv');
      if (!cv) return;
      const btns = [...cv.querySelectorAll('.fold')];
      const anyClosed = btns.some((b) => b.classList.contains('closed'));
      if (anyClosed) btns.forEach((b) => setFold(b, false));
      else btns.filter((b) => Number(b.dataset.d) >= 1).forEach((b) => setFold(b, true));
      all.title = anyClosed ? 'Collapse all' : 'Expand all';
      all.classList.toggle('on', !anyClosed);
      return;
    }
    const seg = e.target.closest('[data-seg] button');
    if (seg && !seg.disabled) {
      const key = seg.parentElement.dataset.seg;
      S.ui[key] = seg.dataset.v;
      if (key === 'dir') {
        const r = parseRoute();
        if (r.params && r.params.get('field')) { location.hash = opHref(r.id, r.op); return; }
      }
      render();
      return;
    }
    const tab = e.target.closest('[data-pane] button');
    if (tab) { S.ui[tab.parentElement.dataset.pane] = tab.dataset.v; render(); return; }
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const text = (S.copy || {})[cp.dataset.copy];
      if (text) { await navigator.clipboard.writeText(text).catch(() => {}); toast('Copied to clipboard'); }
      return;
    }
    const a = e.target.closest('[data-action]');
    if (a && a.dataset.action === 'upload') $('#file-input').click();
    if (a && a.dataset.action === 'rescan') { await api('/api/rescan', { method: 'POST' }); toast('Rescan requested'); }
  });
  main().addEventListener('input', (e) => {
    if (e.target.id === 'field-filter') { S.ui.fieldFilter = e.target.value; applyFieldFilter(); }
  });
  main().addEventListener('change', (e) => {
    if (e.target.id === 'src-file') { S.ui.srcFile = e.target.value; render(); }
  });
  window.addEventListener('hashchange', () => { main().scrollTop = 0; render(); });

  /* theme */
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(load('theme', null));
  $('#btn-theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const t = dark ? 'light' : 'dark';
    applyTheme(t);
    save('theme', t);
  });

  /* toasts */
  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = `toast${err ? ' err' : ''}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  /* ------------------------------ upload / drag & drop ------------------------------ */
  const OK = /\.(wsdl|xsd|xml)$/i;
  async function uploadFiles(list) {
    const files = list.filter((x) => OK.test(x.file.name));
    if (!files.length) { toast('Only .wsdl, .xsd and .xml files are accepted', true); return; }
    const fd = new FormData();
    files.forEach((x) => { fd.append('files', x.file, x.file.name); fd.append('paths', x.path); });
    try {
      const res = await api('/api/upload', { method: 'POST', body: fd });
      toast(`Added ${res.written.length} file${res.written.length === 1 ? '' : 's'}${res.rejected.length ? ` (${res.rejected.length} skipped)` : ''}. Parsing…`);
    } catch (e) { toast(`Upload failed: ${e.message}`, true); }
  }
  async function collect(dt) {
    const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { out.push({ file: f, path: prefix + f.name }); res(); }, res));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const c of batch) await walk(c, `${prefix}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#drop').hidden = false; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop').hidden = true;
    uploadFiles(await collect(e.dataTransfer));
  });
  $('#btn-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    uploadFiles([...e.target.files].map((f) => ({ file: f, path: f.name })));
    e.target.value = '';
  });

  /* ------------------------------ live updates ------------------------------ */
  function connect() {
    const live = $('#live');
    const es = new EventSource('/api/events');
    es.addEventListener('hello', async (e) => {
      live.className = 'live on';
      live.lastElementChild.textContent = 'Live';
      const { version } = JSON.parse(e.data);
      if (S.cat && S.cat.version !== version) { await refresh(); render(); }
    });
    es.addEventListener('updated', async (e) => {
      const s = JSON.parse(e.data);
      await refresh();
      S.rpcIds = null;
      render();
      const parts = [];
      if (s.added.length) parts.push(`added ${s.added.join(', ')}`);
      if (s.changed.length) parts.push(`updated ${s.changed.join(', ')}`);
      if (s.removed.length) parts.push(`removed ${s.removed.join(', ')}`);
      if (parts.length) toast(`Catalogue ${parts.join('; ')}`);
      else if (s.reason === 'manual rescan') toast(`Rescanned: ${s.services} services, ${s.problems} problems`);
    });
    es.onerror = () => { live.className = 'live off'; live.lastElementChild.textContent = 'Reconnecting'; };
  }

  (async () => {
    try {
      await refresh();
      render();
    } catch (e) {
      main().innerHTML = `<div class="page"><p class="note">Could not reach the catalogue API: ${esc(e.message)}</p></div>`;
    }
    connect();
  })();
})();
