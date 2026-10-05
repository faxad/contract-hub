'use strict';
const { NS } = require('./xml');

const INT_TYPES = new Set(['int', 'integer', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger',
  'nonPositiveInteger', 'negativeInteger', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte']);
const NUM_TYPES = new Set(['decimal', 'float', 'double']);

/** A plausible sample value for a simple type, nudged by the field name. Returns a JS value (number/bool/string). */
function sampleValue(type, name = '', node = {}) {
  if (node.fixed != null) return coerce(node.fixed, type);
  if (node.default != null) return coerce(node.default, type);
  const t = type || { base: 'string' };
  if (t.enum && t.enum.length) return coerce(t.enum[0], t);
  if (t.list) return String(sampleValue(t.list, name));
  const base = t.base || t.name || 'string';
  const f = t.facets || {};
  const n = String(name || '').toLowerCase();
  if (INT_TYPES.has(base)) {
    let v = f.minInclusive != null ? Number(f.minInclusive) : f.minExclusive != null ? Number(f.minExclusive) + 1 : null;
    if (v == null) v = base === 'positiveInteger' ? 1 : base === 'negativeInteger' ? -1 : base === 'nonPositiveInteger' ? 0
      : /year/.test(n) ? 2026 : /qty|quantity|count|number|num$|days?$|size$|page/.test(n) ? 1 : 100;
    if (f.maxInclusive != null && v > Number(f.maxInclusive)) v = Number(f.maxInclusive);
    return v;
  }
  if (NUM_TYPES.has(base)) {
    let v = f.minInclusive != null ? Number(f.minInclusive) : /rate|percent/.test(n) ? 2.5 : 99.95;
    if (f.maxInclusive != null && v > Number(f.maxInclusive)) v = Number(f.maxInclusive);
    if (f.fractionDigits != null) v = Number(v.toFixed(Number(f.fractionDigits)));
    return v;
  }
  switch (base) {
    case 'boolean': return true;
    case 'date': return /birth|dob/.test(n) ? '1990-04-12' : '2026-01-15';
    case 'dateTime': return '2026-01-15T10:30:00Z';
    case 'time': return '10:30:00';
    case 'duration': return 'P1D';
    case 'gYear': return '2026';
    case 'gYearMonth': return '2026-01';
    case 'gMonth': return '--01';
    case 'gDay': return '---15';
    case 'base64Binary': return 'U2FtcGxlIGRhdGE=';
    case 'hexBinary': return '0A1B2C3D';
    case 'anyURI': return 'https://example.com/resource';
    case 'QName': return 'tns:Value';
    case 'language': return 'en-GB';
    case 'anyType': case 'anySimpleType': return '?';
    default: break;
  }
  const guess = fitLength(stringFor(n, name), f);
  if (f.pattern) {
    let ok = false;
    try { ok = new RegExp(`^(?:${f.pattern})$`).test(guess); } catch { /* XSD-only regex syntax */ }
    if (!ok) {
      const v = fromPattern(f.pattern.split('|')[0]);
      if (v != null) return v;
    }
  }
  return guess;
}

/**
 * Build a string matching a simple XSD pattern: literals, escapes (\d, \w, \s), character classes
 * and {n} / {n,m} / ? / * / + quantifiers. Returns null for anything it can't handle confidently.
 */
function fromPattern(pattern) {
  const LETTERS = 'ACMEBDFGHK';
  const DIGITS = '1002345678';
  let out = '';
  let i = 0;
  let li = 0;
  let di = 0;
  const pick = (cls) => {
    if (/0-9|\\d/.test(cls)) return DIGITS[di++ % DIGITS.length];
    if (/A-Z/.test(cls)) return LETTERS[li++ % LETTERS.length];
    if (/a-z/.test(cls)) return LETTERS[li++ % LETTERS.length].toLowerCase();
    const m = /^[^\\\]-]/.exec(cls);
    return m ? m[0] : null;
  };
  while (i < pattern.length) {
    let unit;
    const c = pattern[i];
    if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end < 0) return null;
      unit = pattern.slice(i + 1, end);
      i = end + 1;
    } else if (c === '\\') {
      const e = pattern[i + 1];
      unit = e === 'd' ? '0-9' : e === 'w' ? 'A-Z' : e === 's' ? ' ' : null;
      if (unit === null) unit = e; // escaped literal like \+ or \.
      i += 2;
    } else if ('()|^$'.includes(c)) {
      return null;
    } else {
      unit = c === '.' ? 'A-Z' : c;
      i += 1;
    }
    let count = 1;
    const q = /^(\{(\d+)(?:,(\d*))?\}|[?*+])/.exec(pattern.slice(i));
    if (q) {
      i += q[0].length;
      if (q[0] === '?' || q[0] === '*') count = q[0] === '?' ? 1 : 2;
      else if (q[0] === '+') count = 2;
      else count = Math.max(Number(q[2]), q[3] ? Math.min(Number(q[3]), Number(q[2]) || 1) : Number(q[2]));
    }
    for (let k = 0; k < count; k++) {
      const ch = unit.length === 1 && !/[A-Za-z0-9]-/.test(unit) ? unit : pick(unit);
      if (ch == null) return null;
      out += ch;
    }
  }
  return out;
}

function stringFor(n, raw) {
  if (/e-?mail/.test(n)) return 'jane.doe@example.com';
  if (/phone|mobile|msisdn|^tel$|telephone/.test(n)) return '+441234567890';
  if (/currency/.test(n)) return 'GBP';
  if (/country/.test(n)) return 'GB';
  if (/(post|zip)code|postal/.test(n)) return 'SW1A 1AA';
  if (/city|town/.test(n)) return 'London';
  if (/street|address|line\d?$/.test(n)) return '1 High Street';
  if (/first.?name|given/.test(n)) return 'Jane';
  if (/last.?name|surname|family/.test(n)) return 'Doe';
  if (/^name$|fullname|customername|recipient|signedby/.test(n)) return 'Jane Doe';
  if (/uuid|guid|correlation/.test(n)) return '3f2b8c1e-9d4a-4b7e-a6f1-2c5d8e9f0a1b';
  if (/(^|_)id$|id$|code$|ref(erence)?$|number$|no$/.test(n)) return `${raw.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'ID'}-10042`;
  if (/status|state/.test(n)) return 'ACTIVE';
  if (/url|uri|link/.test(n)) return 'https://example.com';
  if (/desc|comment|note|message|text|reason/.test(n)) return 'Sample text';
  return 'string';
}

function fitLength(s, f) {
  let v = s;
  const max = f.maxLength ?? f.length;
  const min = f.minLength ?? f.length;
  if (max != null && v.length > Number(max)) v = v.slice(0, Number(max));
  if (min != null && v.length < Number(min)) v = v.padEnd(Number(min), 'X');
  return v;
}

function coerce(v, type) {
  const base = type?.base || 'string';
  if (INT_TYPES.has(base) || NUM_TYPES.has(base)) { const n = Number(v); return Number.isNaN(n) ? v : n; }
  if (base === 'boolean') return v === 'true' || v === '1';
  return v;
}

/* ------------------------------ XML ------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class XmlWriter {
  constructor(set) {
    this.set = set;
    this.prefixes = new Map(); // ns -> prefix
    this.lines = [];
  }

  pfx(ns) {
    if (!ns) return null;
    if (!this.prefixes.has(ns)) this.prefixes.set(ns, this.set ? this.set.prefixFor(ns, this.prefixes) : `ns${this.prefixes.size + 1}`);
    return this.prefixes.get(ns);
  }

  tag(n) {
    const p = n.qualified && n.ns ? this.pfx(n.ns) : null;
    return p ? `${p}:${n.name}` : n.name;
  }

  comment(ind, text) { this.lines.push(`${ind}<!--${text}-->`); }

  occursComment(ind, n) {
    if (n.max > 1 || n.max === Infinity) {
      this.comment(ind, n.min === 0 ? 'Zero or more repetitions:' : `${n.min} or more repetitions:`);
    } else if (n.min === 0) this.comment(ind, 'Optional:');
  }

  node(n, depth) {
    const ind = '   '.repeat(depth);
    if (n.kind === 'choice') {
      const labels = n.options.map((o) => o.map((x) => x.name || 'any').join(', '));
      this.comment(ind, `Choice of ${labels.length}: ${labels.join(' | ')}`);
      (n.options[0] || []).forEach((c) => this.node(c, depth));
      return;
    }
    if (n.kind === 'any') { this.comment(ind, 'You may enter ANY elements at this point'); return; }
    this.occursComment(ind, n);
    const tag = this.tag(n);
    const attrs = (n.attributes || []).filter((a) => !a.any).map((a) => {
      const an = a.qualified && a.ns ? `${this.pfx(a.ns)}:${a.name}` : a.name;
      return ` ${an}="${esc(sampleValue(a.type, a.name, a))}"`;
    }).join('');
    if (n.recursive) { this.lines.push(`${ind}<${tag}${attrs}><!--recursive: ${n.type?.name || n.name}--></${tag}>`); return; }
    if (n.unresolved && !n.simple) { this.lines.push(`${ind}<${tag}${attrs}><!--unresolved type ${n.type?.name}--></${tag}>`); return; }
    const kids = n.children || [];
    if (n.simple && !kids.length) {
      this.lines.push(`${ind}<${tag}${attrs}>${esc(sampleValue(n.valueType || n.type, n.name, n))}</${tag}>`);
      return;
    }
    if (!kids.length) { this.lines.push(`${ind}<${tag}${attrs}/>`); return; }
    this.lines.push(`${ind}<${tag}${attrs}>`);
    kids.forEach((c) => this.node(c, depth + 1));
    this.lines.push(`${ind}</${tag}>`);
  }

  xmlns(extra = []) {
    return [...extra, ...[...this.prefixes].map(([ns, p]) => [p, ns])].map(([p, ns]) => ` xmlns:${p}="${esc(ns)}"`).join('');
  }
}

/** A full SOAP envelope for the given header/body node trees. */
function soapEnvelope(set, { version = '1.1', headers = [], body = [], fault = null }) {
  const env = version === '1.2' ? NS.ENV12 : NS.ENV11;
  const ep = version === '1.2' ? 'soap' : 'soapenv';
  const w = new XmlWriter(set);
  w.prefixes.set(env, ep);
  const inner = new XmlWriter(set);
  inner.prefixes = w.prefixes;
  if (headers.length) {
    inner.lines.push(`   <${ep}:Header>`);
    headers.forEach((h) => inner.node(h, 2));
    inner.lines.push(`   </${ep}:Header>`);
  } else inner.lines.push(`   <${ep}:Header/>`);
  inner.lines.push(`   <${ep}:Body>`);
  if (fault) {
    const d = new XmlWriter(set);
    d.prefixes = w.prefixes;
    (fault.detail || []).forEach((n) => d.node(n, 4));
    if (version === '1.2') {
      inner.lines.push(`      <${ep}:Fault>`,
        `         <${ep}:Code><${ep}:Value>${ep}:Receiver</${ep}:Value></${ep}:Code>`,
        `         <${ep}:Reason><${ep}:Text xml:lang="en">${esc(fault.name || 'Server error')}</${ep}:Text></${ep}:Reason>`,
        `         <${ep}:Detail>`, ...d.lines, `         </${ep}:Detail>`, `      </${ep}:Fault>`);
    } else {
      inner.lines.push(`      <${ep}:Fault>`, `         <faultcode>${ep}:Server</faultcode>`,
        `         <faultstring>${esc(fault.name || 'Server error')}</faultstring>`,
        '         <detail>', ...d.lines, '         </detail>', `      </${ep}:Fault>`);
    }
  } else {
    body.forEach((b) => inner.node(b, 2));
  }
  inner.lines.push(`   </${ep}:Body>`);
  return [`<${ep}:Envelope${w.xmlns()}>`, ...inner.lines, `</${ep}:Envelope>`].join('\n');
}

/** A standalone XML document for one element tree (used for plain XSD elements). */
function xmlDocument(set, root) {
  const w = new XmlWriter(set);
  w.node(root, 0);
  const lines = w.lines;
  // attach xmlns declarations to the first start tag
  const i = lines.findIndex((l) => /^\s*<[^!]/.test(l));
  if (i >= 0) lines[i] = lines[i].replace(/^(\s*<[^\s>/]+)/, `$1${w.xmlns()}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${lines.join('\n')}`;
}

/* ------------------------------ JSON ------------------------------ */

function jsonValue(n, depth = 0) {
  if (n.recursive || depth > 20) return {};
  const kids = n.children || [];
  const attrs = (n.attributes || []).filter((a) => !a.any);
  if (n.simple && !kids.length) {
    const v = sampleValue(n.valueType || n.type, n.name, n);
    if (!attrs.length) return v;
    const o = {};
    attrs.forEach((a) => { o[a.name] = sampleValue(a.type, a.name, a); });
    o.$value = v;
    return o;
  }
  const o = {};
  attrs.forEach((a) => { o[a.name] = sampleValue(a.type, a.name, a); });
  jsonChildren(kids, o, depth);
  return o;
}

function jsonChildren(kids, o, depth) {
  for (const c of kids) {
    if (c.kind === 'choice') { jsonChildren(c.options[0] || [], o, depth); continue; }
    if (c.kind === 'any') continue;
    const v = jsonValue(c, depth + 1);
    o[c.name] = c.max > 1 ? [v] : v;
  }
  return o;
}

/** JSON body for a list of top-level message nodes: a single element body is unwrapped to its content. */
function jsonBody(nodes) {
  if (!nodes.length) return null;
  if (nodes.length === 1) return jsonValue(nodes[0]);
  const o = {};
  nodes.forEach((n) => { o[n.name] = jsonValue(n); });
  return o;
}

module.exports = { fromPattern, sampleValue, soapEnvelope, xmlDocument, jsonValue, jsonBody };
