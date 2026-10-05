'use strict';
const path = require('path');
const { NS, parseXmlFile, kids, kid, attr, qname, qkey, documentation, nsDecls } = require('./xml');

const isRemote = (loc) => /^[a-z]+:\/\//i.test(loc);

function soapVersionOf(el) {
  if (kid(el, NS.SOAP11, 'binding')) return '1.1';
  if (kid(el, NS.SOAP12, 'binding')) return '1.2';
  return null;
}

/* ------------------------------ WSDL 1.1 ------------------------------ */

function load11(file, set, defs, seen, problems) {
  if (seen.has(file)) return;
  seen.add(file);
  let root;
  try {
    root = parseXmlFile(file).documentElement;
  } catch (e) {
    problems.push({ file, level: 'error', message: e.code === 'ENOENT' ? `Imported WSDL not found: ${file}` : e.message });
    return;
  }
  if (root.namespaceURI === NS.XSD) { set.loadFile(file); return; }
  defs.files.add(file);
  const tns = attr(root, 'targetNamespace') || '';
  if (!defs.tns) defs.tns = tns;
  if (!defs.doc) defs.doc = documentation(root);
  set.hint(nsDecls(root));

  for (const imp of kids(root, NS.WSDL, 'import')) {
    const loc = attr(imp, 'location');
    if (!loc || isRemote(loc)) {
      if (loc) problems.push({ file, level: 'warning', message: `Remote WSDL import not fetched: ${loc}` });
      continue;
    }
    load11(path.resolve(path.dirname(file), loc), set, defs, seen, problems);
  }
  for (const types of kids(root, NS.WSDL, 'types')) {
    for (const s of kids(types, NS.XSD, 'schema')) set.addSchema(s, file);
  }
  for (const m of kids(root, NS.WSDL, 'message')) {
    const name = attr(m, 'name');
    defs.messages.set(qkey({ ns: tns, local: name }), {
      name,
      parts: kids(m, NS.WSDL, 'part').map((p) => ({
        name: attr(p, 'name'),
        element: attr(p, 'element') ? qname(p, attr(p, 'element')) : null,
        type: attr(p, 'type') ? qname(p, attr(p, 'type')) : null,
      })),
    });
  }
  for (const pt of kids(root, NS.WSDL, 'portType')) {
    const name = attr(pt, 'name');
    defs.portTypes.set(qkey({ ns: tns, local: name }), {
      name,
      doc: documentation(pt),
      operations: kids(pt, NS.WSDL, 'operation').map((op) => {
        const io = (el) => (el ? { message: qname(el, attr(el, 'message')), name: attr(el, 'name') } : null);
        const input = io(kid(op, NS.WSDL, 'input'));
        const output = io(kid(op, NS.WSDL, 'output'));
        const first = kids(op, NS.WSDL, ['input', 'output'])[0];
        return {
          name: attr(op, 'name'),
          doc: documentation(op),
          input,
          output,
          pattern: input && output ? (first && first.localName === 'output' ? 'solicit-response' : 'request-response')
            : input ? 'one-way' : 'notification',
          faults: kids(op, NS.WSDL, 'fault').map((f) => ({ name: attr(f, 'name'), message: qname(f, attr(f, 'message')) })),
        };
      }),
    });
  }
  for (const b of kids(root, NS.WSDL, 'binding')) {
    const name = attr(b, 'name');
    const version = soapVersionOf(b);
    const soapNs = version === '1.2' ? NS.SOAP12 : NS.SOAP11;
    const sb = kid(b, soapNs, 'binding');
    const ops = new Map();
    for (const op of kids(b, NS.WSDL, 'operation')) {
      const so = kid(op, soapNs, 'operation');
      const ioInfo = (el) => {
        if (!el) return null;
        const body = kid(el, soapNs, 'body');
        return {
          use: body ? attr(body, 'use') || 'literal' : 'literal',
          namespace: body ? attr(body, 'namespace') : null,
          parts: body && attr(body, 'parts') != null ? attr(body, 'parts').split(/\s+/).filter(Boolean) : null,
          headers: kids(el, soapNs, 'header').map((h) => ({ message: qname(h, attr(h, 'message')), part: attr(h, 'part') })),
        };
      };
      ops.set(attr(op, 'name'), {
        soapAction: so ? attr(so, 'soapAction') ?? '' : null,
        style: (so && attr(so, 'style')) || (sb && attr(sb, 'style')) || 'document',
        input: ioInfo(kid(op, NS.WSDL, 'input')),
        output: ioInfo(kid(op, NS.WSDL, 'output')),
      });
    }
    defs.bindings.set(qkey({ ns: tns, local: name }), {
      name,
      type: qname(b, attr(b, 'type')),
      version,
      transport: sb ? attr(sb, 'transport') : null,
      ops,
    });
  }
  for (const s of kids(root, NS.WSDL, 'service')) {
    defs.services.push({
      name: attr(s, 'name'),
      doc: documentation(s),
      ports: kids(s, NS.WSDL, 'port').map((p) => {
        const addr = kid(p, NS.SOAP11, 'address') || kid(p, NS.SOAP12, 'address') || kids(p).find((c) => c.localName === 'address');
        return { name: attr(p, 'name'), binding: qname(p, attr(p, 'binding')), address: addr ? attr(addr, 'location') : null };
      }),
    });
  }
}

function message11(defs, msgRef, bindingIo, { style, opName, response, tns }) {
  if (!msgRef) return null;
  const msg = defs.messages.get(qkey(msgRef));
  if (!msg) return { message: msgRef.local, parts: [], headers: [], unresolved: true };
  const headers = [];
  const headerParts = new Set();
  for (const h of (bindingIo && bindingIo.headers) || []) {
    const hm = defs.messages.get(qkey(h.message));
    const part = hm && hm.parts.find((p) => p.name === h.part);
    if (part) headers.push(part);
    if (hm && hm.name === msg.name) headerParts.add(h.part);
  }
  let parts = msg.parts.filter((p) => !headerParts.has(p.name));
  if (bindingIo && bindingIo.parts) parts = parts.filter((p) => bindingIo.parts.includes(p.name));
  const desc = { message: msg.name, parts, headers };
  if (style === 'rpc') desc.rpc = { name: response ? `${opName}Response` : opName, ns: (bindingIo && bindingIo.namespace) || tns };
  return desc;
}

function parse11(file, set) {
  const defs = { messages: new Map(), portTypes: new Map(), bindings: new Map(), services: [], files: new Set(), tns: null, doc: null };
  const problems = [];
  load11(file, set, defs, new Set(), problems);

  let services = defs.services;
  if (!services.length) {
    // abstract WSDL: synthesise a service per binding, or per portType
    services = defs.bindings.size
      ? [...defs.bindings.entries()].map(([k, b]) => ({ name: b.name, ports: [{ name: b.name, binding: keyToQ(k), address: null }] }))
      : [...defs.portTypes.values()].map((pt) => ({ name: pt.name, doc: pt.doc, ports: [], portType: pt }));
  }

  const entries = [];
  for (const svc of services) {
    // group ports by portType
    const groups = new Map();
    for (const port of svc.ports) {
      const b = defs.bindings.get(qkey(port.binding));
      if (!b) { problems.push({ file, level: 'warning', message: `Port ${port.name} references unknown binding ${port.binding && port.binding.local}` }); continue; }
      const ptKey = qkey(b.type);
      if (!groups.has(ptKey)) groups.set(ptKey, []);
      groups.get(ptKey).push({ port, binding: b });
    }
    if (svc.portType) groups.set('abstract', []);
    for (const [ptKey, ports] of groups) {
      const pt = svc.portType || defs.portTypes.get(ptKey);
      if (!pt) { problems.push({ file, level: 'warning', message: `Unknown portType ${ptKey}` }); continue; }
      const soapPorts = ports.filter((p) => p.binding.version);
      const primary = soapPorts[0] || ports[0];
      const versions = [...new Set(soapPorts.map((p) => p.binding.version))];
      if (!versions.length) versions.push('1.1');
      entries.push({
        kind: 'wsdl',
        wsdlVersion: '1.1',
        name: groups.size > 1 ? `${svc.name}.${pt.name}` : svc.name,
        portType: pt.name,
        doc: svc.doc || pt.doc || defs.doc,
        targetNamespace: defs.tns,
        soapVersions: versions,
        endpoints: ports.map(({ port, binding }) => ({
          port: port.name, binding: binding.name, soapVersion: binding.version || 'http', address: port.address,
        })),
        operations: pt.operations.map((op) => {
          const bo = primary ? primary.binding.ops.get(op.name) : null;
          const style = bo ? bo.style : 'document';
          const ctx = { style, opName: op.name, tns: defs.tns };
          return {
            name: op.name,
            doc: op.doc,
            pattern: op.pattern,
            soapAction: bo ? bo.soapAction : null,
            style,
            use: bo && bo.input ? bo.input.use : 'literal',
            input: message11(defs, op.input && op.input.message, bo && bo.input, ctx),
            output: message11(defs, op.output && op.output.message, bo && bo.output, { ...ctx, response: true }),
            faults: op.faults.map((f) => ({ name: f.name, message: message11(defs, f.message, null, { style: 'document' }) })),
          };
        }),
        files: [...defs.files],
      });
    }
  }
  return { entries, problems };
}

function keyToQ(k) {
  const m = /^\{(.*)\}(.*)$/.exec(k);
  return { ns: m[1], local: m[2] };
}

/* ------------------------------ WSDL 2.0 ------------------------------ */

function parse20(file, root, set) {
  const problems = [];
  const tns = attr(root, 'targetNamespace') || '';
  set.hint(nsDecls(root));
  for (const types of kids(root, NS.WSDL2, 'types')) {
    for (const s of kids(types, NS.XSD, 'schema')) set.addSchema(s, file);
    for (const imp of kids(types, NS.XSD, 'import')) {
      const loc = attr(imp, 'schemaLocation');
      if (loc && !isRemote(loc)) set.loadFile(path.resolve(path.dirname(file), loc));
    }
  }
  const interfaces = new Map();
  for (const itf of kids(root, NS.WSDL2, 'interface')) {
    const faults = new Map(kids(itf, NS.WSDL2, 'fault').map((f) => [attr(f, 'name'), f]));
    const elementMsg = (el) => {
      if (!el) return null;
      const e = attr(el, 'element');
      if (!e || e === '#none') return { parts: [], headers: [] };
      if (e === '#any' || e === '#other') return { parts: [], headers: [], any: true };
      const q = qname(el, e);
      return { message: q.local, parts: [{ name: q.local, element: q }], headers: [] };
    };
    interfaces.set(qkey({ ns: tns, local: attr(itf, 'name') }), {
      name: attr(itf, 'name'),
      doc: documentation(itf),
      operations: kids(itf, NS.WSDL2, 'operation').map((op) => {
        const pattern = (attr(op, 'pattern') || '').split('/').pop() || 'in-out';
        return {
          name: attr(op, 'name'),
          doc: documentation(op),
          pattern: pattern === 'in-out' ? 'request-response' : pattern === 'in-only' || pattern === 'robust-in-only' ? 'one-way' : pattern,
          input: elementMsg(kid(op, NS.WSDL2, 'input')),
          output: elementMsg(kid(op, NS.WSDL2, 'output')),
          faults: kids(op, NS.WSDL2, 'outfault').map((of) => {
            const ref = qname(of, attr(of, 'ref'));
            return { name: ref.local, message: elementMsg(faults.get(ref.local)) };
          }).filter((f) => f.message),
        };
      }),
    });
  }
  const bindings = new Map();
  for (const b of kids(root, NS.WSDL2, 'binding')) {
    const isSoap = attr(b, 'type') === NS.WSOAP;
    const ver = attr(b, 'wsoap:version') || (isSoap ? '1.2' : null);
    bindings.set(qkey({ ns: tns, local: attr(b, 'name') }), {
      name: attr(b, 'name'),
      interface: qkey(qname(b, attr(b, 'interface'))),
      version: isSoap ? ver : null,
      actions: new Map(kids(b, NS.WSDL2, 'operation').map((o) => [qname(o, attr(o, 'ref')).local, o.getAttributeNS(NS.WSOAP, 'action')])),
    });
  }
  const entries = [];
  const services = kids(root, NS.WSDL2, 'service');
  const list = services.length ? services.map((s) => ({
    name: attr(s, 'name'), doc: documentation(s), itf: qkey(qname(s, attr(s, 'interface'))),
    endpoints: kids(s, NS.WSDL2, 'endpoint').map((e) => ({ port: attr(e, 'name'), bindingKey: qkey(qname(e, attr(e, 'binding'))), address: attr(e, 'address') })),
  })) : [...interfaces.entries()].map(([k, i]) => ({ name: i.name, itf: k, endpoints: [] }));
  for (const s of list) {
    const itf = interfaces.get(s.itf);
    if (!itf) { problems.push({ file, level: 'warning', message: `Unknown interface for service ${s.name}` }); continue; }
    const eps = s.endpoints.map((e) => ({ ...e, b: bindings.get(e.bindingKey) }));
    const primary = eps.find((e) => e.b && e.b.version);
    entries.push({
      kind: 'wsdl', wsdlVersion: '2.0', name: s.name, portType: itf.name, doc: s.doc || itf.doc, targetNamespace: tns,
      soapVersions: primary ? [...new Set(eps.filter((e) => e.b && e.b.version).map((e) => e.b.version))] : ['1.2'],
      endpoints: eps.map((e) => ({ port: e.port, binding: e.b ? e.b.name : null, soapVersion: e.b ? e.b.version || 'http' : null, address: e.address })),
      operations: itf.operations.map((op) => ({
        ...op, style: 'document', use: 'literal',
        soapAction: primary ? primary.b.actions.get(op.name) || '' : null,
      })),
      files: [file],
    });
  }
  return { entries, problems };
}

/** Parse a WSDL file into catalogue entries. All schemas are loaded into `set`. */
function parseWsdl(file, set) {
  const root = parseXmlFile(file).documentElement;
  if (root.namespaceURI === NS.WSDL2) return parse20(file, root, set);
  if (root.namespaceURI === NS.WSDL && root.localName === 'definitions') return parse11(file, set);
  throw new Error(`Not a WSDL document (root <${root.tagName}>)`);
}

module.exports = { parseWsdl };
