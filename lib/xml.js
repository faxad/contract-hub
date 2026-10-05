'use strict';
const fs = require('fs');
const { DOMParser } = require('@xmldom/xmldom');

const NS = {
  XSD: 'http://www.w3.org/2001/XMLSchema',
  XSI: 'http://www.w3.org/2001/XMLSchema-instance',
  WSDL: 'http://schemas.xmlsoap.org/wsdl/',
  WSDL2: 'http://www.w3.org/ns/wsdl',
  SOAP11: 'http://schemas.xmlsoap.org/wsdl/soap/',
  SOAP12: 'http://schemas.xmlsoap.org/wsdl/soap12/',
  WSOAP: 'http://www.w3.org/ns/wsdl/soap',
  ENV11: 'http://schemas.xmlsoap.org/soap/envelope/',
  ENV12: 'http://www.w3.org/2003/05/soap-envelope',
};

function parseXml(text, file) {
  const warnings = [];
  const parser = new DOMParser({
    onError: (level, msg) => { if (level === 'warning') warnings.push(String(msg).split('\n')[0]); },
  });
  let doc;
  try {
    doc = parser.parseFromString(text.replace(/^﻿/, ''), 'text/xml');
  } catch (e) {
    throw new Error(`${file ? file + ': ' : ''}XML parse error: ${String(e.message).split('\n')[0]}`);
  }
  if (!doc || !doc.documentElement) throw new Error(`${file ? file + ': ' : ''}empty or invalid XML document`);
  return doc;
}

function parseXmlFile(file) {
  return parseXml(fs.readFileSync(file, 'utf8'), file);
}

/** Child elements, optionally filtered by namespace and local name(s). */
function kids(node, ns, local) {
  const out = [];
  if (!node) return out;
  const names = local == null ? null : Array.isArray(local) ? local : [local];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    if (ns && c.namespaceURI !== ns) continue;
    if (names && !names.includes(c.localName)) continue;
    out.push(c);
  }
  return out;
}

const kid = (node, ns, local) => kids(node, ns, local)[0] || null;

function attr(el, name) {
  const v = el && el.getAttribute(name);
  return v == null || v === '' ? null : v;
}

/** Resolve a QName attribute value (e.g. "tns:Foo") using the element's in-scope namespaces. */
function qname(el, value) {
  if (!value) return null;
  const i = value.indexOf(':');
  const prefix = i >= 0 ? value.slice(0, i) : null;
  const local = i >= 0 ? value.slice(i + 1) : value;
  const ns = el.lookupNamespaceURI(prefix) || '';
  return { ns, local };
}

const qkey = (q) => (q ? `{${q.ns || ''}}${q.local}` : null);

/** Text of xsd:annotation/xsd:documentation or wsdl:documentation directly under el. */
function documentation(el) {
  if (!el) return null;
  const parts = [];
  for (const a of kids(el, NS.XSD, 'annotation')) {
    for (const d of kids(a, NS.XSD, 'documentation')) parts.push(d.textContent);
  }
  for (const d of kids(el, null, 'documentation')) {
    if (d.namespaceURI !== NS.XSD) parts.push(d.textContent);
  }
  const text = parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return text || null;
}

/** xmlns prefix declarations on an element: [[prefix, ns], ...] */
function nsDecls(el) {
  const out = [];
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a.name.startsWith('xmlns:')) out.push([a.name.slice(6), a.value]);
  }
  return out;
}

module.exports = { NS, parseXml, parseXmlFile, kids, kid, attr, qname, qkey, documentation, nsDecls };
