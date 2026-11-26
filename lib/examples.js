'use strict';
/**
 * Logged request/response examples loaded from CSV/TSV files (one row per call).
 *
 * Required columns (case and spacing ignored): Service, Operation, and Request and/or Response.
 * "Request Extra", "Request Extra 2"... are appended to Request (the same for Response): exports
 * split payloads longer than a spreadsheet cell can hold across those columns.
 *
 * Only non-identifying metadata (timestamps, channel, server, status) is kept for display;
 * user, customer, IP and session columns are ignored.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NS, parseXml } = require('./xml');

const EXTS = new Set(['.csv', '.tsv']);
const INT = new Set(['int', 'integer', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger',
  'negativeInteger', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte', 'decimal', 'float', 'double']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function walkLogs(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walkLogs(p, out);
    else if (EXTS.has(path.extname(it.name).toLowerCase())) out.push(p);
  }
  return out;
}

/* ------------------------------ CSV ------------------------------ */

/** Pick the delimiter that occurs most often (outside quotes) in the header line. */
function sniffDelimiter(text, ext) {
  if (ext === '.tsv') return '\t';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) break;
    else if (!q && c in counts) counts[c]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n ? best : ',';
}

/** RFC 4180 parser: quoted fields may contain delimiters, quotes ("") and any kind of line break. */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const COLUMNS = {
  service: ['service', 'servicename'],
  operation: ['operation', 'operationname', 'method'],
  request: ['request', 'requestpayload', 'requestbody', 'requestmessage', 'requestxml'],
  response: ['response', 'responsepayload', 'responsebody', 'responsemessage', 'responsexml'],
  channel: ['channel'],
  server: ['server', 'host'],
  errorType: ['errortype'],
  errorMessage: ['errormessage'],
  errorNumber: ['errornumber', 'errorcode'],
};

function mapHeader(header) {
  const keys = header.map(norm);
  const col = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const i = keys.findIndex((k) => names.includes(k));
    if (i >= 0) col[field] = i;
  }
  // overflow columns ("Request Extra", "Request Extra 2", ...) in file order
  col.requestExtra = keys.map((k, i) => (/^requestextra\d*$/.test(k) ? i : -1)).filter((i) => i >= 0);
  col.responseExtra = keys.map((k, i) => (/^responseextra\d*$/.test(k) ? i : -1)).filter((i) => i >= 0);
  // timestamps: tolerate spelling such as "Response Timestmap"
  const ts = (prefix) => keys.findIndex((k) => k.startsWith(prefix) && /tim|date/.test(k.slice(prefix.length)));
  col.requestTime = ts('request');
  col.responseTime = ts('response');
  return col;
}

function parseTime(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2').replace(/ ([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Parse one log file into raw example rows. */
function readLogFile(file, rel) {
  const problems = [];
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = parseDelimited(text, sniffDelimiter(text, path.extname(file).toLowerCase()));
  if (!rows.length) return { rows: [], problems };
  const col = mapHeader(rows[0]);
  const missing = ['service', 'operation'].filter((k) => col[k] == null);
  if (col.request == null && col.response == null) missing.push('request or response');
  if (missing.length) {
    problems.push({ file: rel, level: 'error', message: `Log file is missing column(s): ${missing.join(', ')}` });
    return { rows: [], problems };
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.some((v) => v && v.trim())) continue;
    const get = (i) => (i == null || i < 0 ? '' : (cells[i] || '').trim());
    const joined = (main, extras) => [get(main), ...extras.map((i) => cells[i] || '')].join('').trim();
    const reqT = parseTime(get(col.requestTime));
    const resT = parseTime(get(col.responseTime));
    const errorType = get(col.errorType);
    const errorMessage = get(col.errorMessage);
    const errorNumber = get(col.errorNumber);
    const response = joined(col.response, col.responseExtra);
    out.push({
      file: rel,
      row: r + 1, // 1-based line in the sheet, counting the header
      service: get(col.service),
      operation: get(col.operation),
      request: joined(col.request, col.requestExtra),
      response,
      meta: {
        requestTime: get(col.requestTime) || null,
        responseTime: get(col.responseTime) || null,
        durationMs: reqT != null && resT != null && resT >= reqT && resT - reqT < 864e5 ? resT - reqT : null,
        channel: get(col.channel) || null,
        server: get(col.server) || null,
        status: errorType || errorMessage || errorNumber ? 'error' : /<(\w+:)?Fault[\s>]/.test(response) ? 'fault' : 'ok',
        error: [errorNumber, errorType, errorMessage].filter(Boolean).join(' · ') || null,
      },
    });
  }
  return { rows: out, problems };
}

/* ------------------------------ matching ------------------------------ */

function rootLocalName(payload) {
  const s = String(payload || '').replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '');
  const names = [...s.matchAll(/<\s*(?:[\w.-]+:)?([\w.-]+)[\s>/]/g)].map((m) => m[1]);
  if (names[0] === 'Envelope') return names.find((n, i) => i > 0 && n !== 'Header' && n !== 'Body' && names[i - 1] === 'Body') || null;
  return names[0] || null;
}

/**
 * Keyword query: plain words/"quoted phrases" must all appear somewhere in the call; Name=value
 * requires an element or attribute called Name whose value contains value.
 */
function parseQuery(q) {
  const terms = [];
  const fields = [];
  // Field searches: `name=value`, `name:value` or `name: value` (value may be "quoted"); the value is matched as a
  // case-insensitive substring of the element, attribute or JSON property, so `fo: he` finds "fo": "hello".
  for (const m of String(q || '').matchAll(/([A-Za-z_][\w.-]*)\s*[=:]\s*("[^"]*"|[^\s"]+)|"([^"]+)"|(\S+)/g)) {
    if (m[1]) fields.push({ name: m[1], value: m[2].replace(/^"|"$/g, '').toLowerCase() });
    else terms.push((m[3] || m[4]).toLowerCase());
  }
  return { terms, fields };
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word match: the term may not be glued to letters, digits or underscores on either side. */
const wordRe = (t) => new RegExp(`(?<![\\w])${reEsc(t)}(?![\\w])`, 'g');

function fieldMatches(x, { name, value }, exact) {
  const n = reEsc(name);
  const hay = `${x.request}\n${x.response}`;
  const res = [
    new RegExp(`<(?:[\\w.-]+:)?${n}(?:\\s[^>]*)?>([^<]*)<`, 'gi'), // <ns:Name ...>value<
    new RegExp(`\\s(?:[\\w.-]+:)?${n}\\s*=\\s*"([^"]*)"`, 'gi'), // Name="value"
    new RegExp(`"${n}"\\s*:\\s*"?([^",}\\]]*)`, 'gi'), // "Name": value (JSON payloads)
  ];
  const ok = exact ? (v) => v.trim().toLowerCase() === value : (v) => v.toLowerCase().includes(value);
  return res.some((re) => [...hay.matchAll(re)].some((m) => ok(m[1])));
}

function haystack(x) {
  if (!x._hay) {
    const m = x.meta;
    x._hay = [x.request, x.response, m.channel, m.server, m.status, m.error, m.requestTime, x.file].filter(Boolean).join('\n').toLowerCase();
  }
  return x._hay;
}

/**
 * Number of keyword occurrences in a matching call, or 0 when it doesn't match.
 * exact: keywords must be whole words or phrases and field values must equal the whole value (case is still ignored).
 */
function matchCount(x, query, exact = false) {
  if (!query.terms.length && !query.fields.length) return 1;
  const hay = haystack(x);
  let hits = 0;
  for (const t of query.terms) {
    let n = 0;
    if (exact) n = (hay.match(wordRe(t)) || []).length;
    else for (let i = hay.indexOf(t); i >= 0; i = hay.indexOf(t, i + t.length)) n++;
    if (!n) return 0;
    hits += n;
  }
  for (const f of query.fields) {
    if (!fieldMatches(x, f, exact)) return 0;
    hits++;
  }
  return hits;
}

class ExampleStore {
  constructor() {
    this.byOp = new Map(); // `${entryId}\u0000${operation}` -> examples
    this.byId = new Map(); // stable example id -> { entryId, op, example }
    this.problems = [];
    this.total = 0;
    this.files = 0;
  }

  static key(entryId, op) { return `${entryId}\u0000${op}`; }

  /** Load every log file and attach rows to catalogue operations. */
  load(logsDir, entries, relOf) {
    this.byOp.clear();
    this.byId.clear();
    this.problems = [];
    this.total = 0;
    const files = logsDir ? walkLogs(logsDir) : [];
    this.files = files.length;
    if (!files.length) return this;

    const svcIndex = new Map();
    const addKey = (k, e) => { if (!k) return; if (!svcIndex.has(k)) svcIndex.set(k, new Set()); svcIndex.get(k).add(e); };
    for (const e of entries) {
      addKey(norm(e.name), e);
      addKey(norm(e.portType), e);
      addKey(norm(path.basename(e.source, path.extname(e.source))), e);
      addKey(norm(path.basename(e.folder)), e);
    }
    const findOp = (e, row, root) => e.operations.find((o) => norm(o.name) === norm(row.operation))
      || (root ? e.operations.find((o) => o.inputElement === root) : null);

    const unmatched = new Map();
    for (const file of files) {
      let parsed;
      try {
        parsed = readLogFile(file, relOf(file));
      } catch (err) {
        this.problems.push({ file: relOf(file), level: 'error', message: `Could not read log file: ${err.message}` });
        continue;
      }
      this.problems.push(...parsed.problems);
      for (const row of parsed.rows) {
        const root = rootLocalName(row.request);
        let hit = null;
        for (const e of svcIndex.get(norm(row.service)) || []) {
          const op = findOp(e, row, root);
          if (op) { hit = { e, op }; break; }
        }
        if (!hit) {
          // service name not recognised: accept a unique operation match anywhere in the catalogue
          const all = entries.flatMap((e) => e.operations.filter((o) => norm(o.name) === norm(row.operation)).map((op) => ({ e, op })));
          if (all.length === 1) [hit] = all;
        }
        if (!hit) {
          const k = `${row.file}\u0000${row.service}\u0000${row.operation}`;
          unmatched.set(k, (unmatched.get(k) || 0) + 1);
          continue;
        }
        const key = ExampleStore.key(hit.e.id, hit.op.name);
        if (!this.byOp.has(key)) this.byOp.set(key, []);
        // stable id from the call's content, so favorites survive reloads and reordered rows
        let id = `x${crypto.createHash('sha1').update([row.service, row.operation, row.meta.requestTime, row.request, row.response].join('\u0000')).digest('hex').slice(0, 12)}`;
        for (let k = 2; this.byId.has(id); k++) id = `${id.slice(0, 13)}-${k}`;
        row.id = id;
        this.byOp.get(key).push(row);
        this.byId.set(id, { entryId: hit.e.id, op: hit.op.name, example: row });
        this.total++;
      }
    }
    for (const [k, n] of unmatched) {
      const [file, svc, op] = k.split('\u0000');
      this.problems.push({ file, level: 'warning',
        message: `${n} logged call${n > 1 ? 's' : ''} for ${svc || '(no service)'} / ${op || '(no operation)'} did not match a catalogued operation` });
    }
    // newest first when timestamps are available
    for (const list of this.byOp.values()) {
      list.sort((a, b) => (parseTime(b.meta.requestTime) || 0) - (parseTime(a.meta.requestTime) || 0) || a.row - b.row);
    }
    return this;
  }

  list(entryId, op) { return this.byOp.get(ExampleStore.key(entryId, op)) || []; }

  /** Examples of one operation filtered by keywords and status; each item keeps its position n. */
  search(entryId, op, { q, status, exact } = {}) {
    const query = parseQuery(q);
    const out = [];
    this.list(entryId, op).forEach((x, n) => {
      if (status && x.meta.status !== status) return;
      const hits = matchCount(x, query, exact);
      if (hits) out.push({ n, hits, x });
    });
    return { query: { ...query, exact: !!exact }, items: out };
  }

  count(entryId, op) { return this.list(entryId, op).length; }
}

/* ------------------------------ rendering ------------------------------ */

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Indented serialisation that keeps the original prefixes and namespace declarations. */
function prettyXml(node, depth = 0) {
  const ind = '   '.repeat(depth);
  if (node.nodeType === 9) return [...node.childNodes].map((c) => prettyXml(c, 0)).filter(Boolean).join('\n');
  if (node.nodeType === 8) return `${ind}<!--${node.data}-->`;
  if (node.nodeType === 4) return `${ind}<![CDATA[${node.data}]]>`;
  if (node.nodeType === 7) return `${ind}<?${node.target} ${node.data}?>`;
  if (node.nodeType === 3) { const t = node.data.trim(); return t ? `${ind}${escText(t)}` : ''; }
  if (node.nodeType !== 1) return '';
  const attrs = [...node.attributes].map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('');
  const kids = [...node.childNodes].filter((c) => !(c.nodeType === 3 && !c.data.trim()));
  if (!kids.length) return `${ind}<${node.tagName}${attrs}/>`;
  if (kids.every((c) => c.nodeType === 3 || c.nodeType === 4)) {
    const inner = kids.map((c) => (c.nodeType === 4 ? `<![CDATA[${c.data}]]>` : escText(c.data.trim()))).join('');
    return `${ind}<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
  }
  return [`${ind}<${node.tagName}${attrs}>`, ...kids.map((c) => prettyXml(c, depth + 1)).filter(Boolean), `${ind}</${node.tagName}>`].join('\n');
}

const elements = (el) => [...el.childNodes].filter((c) => c.nodeType === 1);

function coerce(text, base) {
  if (base && INT.has(base) && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  if (base === 'boolean' && /^(true|false|1|0)$/.test(text.trim())) return text.trim() === 'true' || text.trim() === '1';
  return text;
}

/** XML element -> JSON value, guided by the operation's field table (repeats -> arrays, typed scalars). */
function toJson(el, p, guide) {
  if (el.getAttributeNS(NS.XSI, 'nil') === 'true') return null;
  const attrs = [...el.attributes].filter((a) => a.name !== 'xmlns' && !a.name.startsWith('xmlns:') && a.namespaceURI !== NS.XSI);
  const kids = elements(el);
  if (!kids.length) {
    const v = coerce(el.textContent.trim(), (guide.get(p) || {}).base);
    if (!attrs.length) return v;
    const o = {};
    for (const a of attrs) o[a.localName || a.name] = coerce(a.value, (guide.get(`${p}/@${a.localName || a.name}`) || {}).base);
    o.$value = v;
    return o;
  }
  const o = {};
  for (const a of attrs) o[a.localName || a.name] = coerce(a.value, (guide.get(`${p}/@${a.localName || a.name}`) || {}).base);
  const groups = new Map();
  for (const k of kids) {
    const name = k.localName || k.tagName;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(k);
  }
  for (const [name, list] of groups) {
    const cp = `${p}/${name}`;
    const vals = list.map((k) => toJson(k, cp, guide));
    o[name] = vals.length > 1 || (guide.get(cp) || {}).repeat ? vals : vals[0];
  }
  return o;
}

function guideFrom(rows) {
  const g = new Map();
  for (const r of rows || []) {
    const max = String(r.occurs || '1').split('..').pop();
    g.set(r.path, { repeat: max === '*' || Number(max) > 1, base: r.base || null });
  }
  return g;
}

/** JSON -> XML for payloads that were logged as JSON (element names only; namespaces from the root row). */
function jsonToXml(value, name, depth, ns) {
  const ind = '   '.repeat(depth);
  const open = ns ? `${name} xmlns="${escAttr(ns)}"` : name;
  if (Array.isArray(value)) return value.map((v) => jsonToXml(v, name, depth, ns)).join('\n');
  if (value === null) return `${ind}<${open} xsi:nil="true" xmlns:xsi="${NS.XSI}"/>`;
  if (typeof value !== 'object') return `${ind}<${open}>${escText(value)}</${name}>`;
  const entries = Object.entries(value).filter(([k]) => k !== '$value');
  if (!entries.length) return value.$value != null ? `${ind}<${open}>${escText(value.$value)}</${name}>` : `${ind}<${open}/>`;
  return [`${ind}<${open}>`, ...entries.map(([k, v]) => jsonToXml(v, k, depth + 1)), `${ind}</${name}>`].join('\n');
}

/**
 * Render one logged payload as { xml, json, note }:
 * xml is a pretty SOAP envelope (a bare body is wrapped), json mirrors the OpenAPI body.
 */
function renderPayload(raw, { rows, soapVersion, rootName, rootNs }) {
  const text = String(raw || '').trim();
  if (!text) return { xml: null, json: null, note: 'Not logged' };
  const guide = guideFrom(rows);
  const env = soapVersion === '1.2' ? NS.ENV12 : NS.ENV11;
  const ep = soapVersion === '1.2' ? 'soap' : 'soapenv';

  if (/^[[{]/.test(text)) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return { xml: null, json: null, raw: text, note: `Logged JSON could not be parsed: ${e.message}` }; }
    const body = jsonToXml(data, rootName || 'Body', 2, rootNs);
    return {
      json: JSON.stringify(data, null, 2),
      xml: `<${ep}:Envelope xmlns:${ep}="${env}">\n   <${ep}:Header/>\n   <${ep}:Body>\n${body}\n   </${ep}:Body>\n</${ep}:Envelope>`,
      note: 'Logged as JSON; XML reconstructed from it',
    };
  }

  const body = text.replace(/^<\?xml[\s\S]*?\?>\s*/, '');
  let doc;
  let wrapped = false;
  try {
    doc = parseXml(body);
    if (doc.documentElement.localName !== 'Envelope') {
      doc = parseXml(`<${ep}:Envelope xmlns:${ep}="${env}"><${ep}:Header/><${ep}:Body>${body}</${ep}:Body></${ep}:Envelope>`);
      wrapped = true;
    }
  } catch (e) {
    return { xml: text, json: null, note: `Logged payload is not well-formed XML (${String(e.message).split(':').pop().trim()}); shown as logged` };
  }
  const bodyEl = elements(doc.documentElement).find((c) => c.localName === 'Body');
  const parts = bodyEl ? elements(bodyEl) : [];
  let json = null;
  if (parts.length === 1) json = toJson(parts[0], `/${parts[0].localName}`, guide);
  else if (parts.length > 1) json = Object.fromEntries(parts.map((p) => [p.localName, toJson(p, `/${p.localName}`, guide)]));
  return {
    xml: prettyXml(doc),
    json: json == null ? null : JSON.stringify(json, null, 2),
    note: wrapped ? 'Logged as a SOAP body; envelope added for display' : null,
  };
}

module.exports = { ExampleStore, renderPayload, walkLogs, parseDelimited, readLogFile, parseQuery, EXTS };
