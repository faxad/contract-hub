'use strict';
const path = require('path');
const { NS, parseXmlFile, kids, attr, qkey, nsDecls } = require('./xml');

const KINDS = {
  element: 'elements',
  complexType: 'complexTypes',
  simpleType: 'simpleTypes',
  group: 'groups',
  attributeGroup: 'attributeGroups',
  attribute: 'attributes',
};

const isRemote = (loc) => /^[a-z]+:\/\//i.test(loc);

/**
 * A resolved set of XML Schema definitions (everything reachable from one WSDL or root XSD).
 * Each registered definition keeps a ctx: { tns, elementQualified, attributeQualified, file }.
 */
class SchemaSet {
  constructor({ nsIndex } = {}) {
    this.nsIndex = nsIndex || new Map(); // namespace -> [xsd files] across the catalogue, for location-less imports
    for (const k of Object.values(KINDS)) this[k] = new Map();
    this.loaded = new Set();
    this.files = new Set();
    this.namespaces = new Set();
    this.prefixHints = new Map(); // ns -> preferred prefix
    this.pendingImports = [];
    this.problems = [];
  }

  warn(file, msg) {
    this.problems.push({ file, level: 'warning', message: msg });
  }

  hint(decls) {
    for (const [p, ns] of decls) {
      if (!this.prefixHints.has(ns) && ![...this.prefixHints.values()].includes(p) && ns !== NS.XSD && ns !== NS.WSDL && !ns.startsWith('http://schemas.xmlsoap.org/wsdl/')) {
        this.prefixHints.set(ns, p);
      }
    }
  }

  loadFile(file, chameleonTns) {
    const id = `${file}|${chameleonTns || ''}`;
    if (this.loaded.has(id)) return;
    this.loaded.add(id);
    let doc;
    try {
      doc = parseXmlFile(file);
    } catch (e) {
      this.warn(file, e.code === 'ENOENT' ? `Referenced schema not found: ${file}` : e.message);
      return;
    }
    this.files.add(file);
    const root = doc.documentElement;
    if (root.namespaceURI === NS.XSD && root.localName === 'schema') {
      this.addSchema(root, file, chameleonTns);
    } else {
      // e.g. a WSDL imported as a schema: pick up its inline schemas
      for (const s of root.getElementsByTagNameNS(NS.XSD, 'schema')) this.addSchema(s, file);
    }
  }

  addSchema(schemaEl, file, chameleonTns) {
    const tns = attr(schemaEl, 'targetNamespace') || chameleonTns || '';
    const ctx = {
      tns,
      elementQualified: attr(schemaEl, 'elementFormDefault') === 'qualified',
      attributeQualified: attr(schemaEl, 'attributeFormDefault') === 'qualified',
      file,
    };
    this.namespaces.add(tns);
    this.files.add(file);
    this.hint(nsDecls(schemaEl));
    const dir = path.dirname(file);

    for (const c of kids(schemaEl, NS.XSD)) {
      const name = c.localName;
      if (name === 'import') {
        const loc = attr(c, 'schemaLocation');
        const ns = attr(c, 'namespace') || '';
        if (loc && !isRemote(loc)) this.loadFile(path.resolve(dir, loc));
        else this.pendingImports.push({ ns, loc, file });
      } else if (name === 'include' || name === 'redefine' || name === 'override') {
        const loc = attr(c, 'schemaLocation');
        if (loc && !isRemote(loc)) this.loadFile(path.resolve(dir, loc), tns);
        else if (loc) this.warn(file, `Remote ${name} not fetched: ${loc}`);
        // redefine/override children replace the included definitions
        for (const d of kids(c, NS.XSD)) this.register(d, ctx);
      } else {
        this.register(c, ctx);
      }
    }
  }

  register(el, ctx) {
    const bucket = KINDS[el.localName];
    const name = attr(el, 'name');
    if (!bucket || !name) return;
    this[bucket].set(qkey({ ns: ctx.tns, local: name }), { node: el, ctx, name, ns: ctx.tns });
  }

  /** Resolve imports that had no (local) schemaLocation, once everything inline is registered. */
  finalize() {
    for (let i = 0; i < this.pendingImports.length; i++) {
      const { ns, loc, file } = this.pendingImports[i];
      if (ns === NS.XSD || ns === NS.XSI || this.namespaces.has(ns)) continue;
      const candidates = this.nsIndex.get(ns) || [];
      const local = candidates.find((f) => path.dirname(f) === path.dirname(file)) || candidates[0];
      if (local) this.loadFile(local);
      else this.warn(file, `Unresolved import of namespace "${ns}"${loc ? ` (${loc})` : ''}`);
    }
    this.pendingImports = [];
    return this;
  }

  get(kind, q) {
    return q ? this[KINDS[kind]].get(qkey(q)) || null : null;
  }

  prefixFor(ns, used) {
    let p = this.prefixHints.get(ns);
    if (!p || /^(xs|xsd|soap|soapenv|wsdl|xsi)$/.test(p) || [...used.values()].includes(p)) {
      let n = 1;
      while ([...used.values()].includes(`ns${n}`)) n++;
      p = `ns${n}`;
    }
    return p;
  }
}

/** Quickly read the targetNamespace of every XSD so location-less imports can be resolved. */
function buildNamespaceIndex(xsdFiles) {
  const index = new Map();
  const info = new Map();
  for (const f of xsdFiles) {
    try {
      const root = parseXmlFile(f).documentElement;
      const tns = attr(root, 'targetNamespace') || '';
      if (!index.has(tns)) index.set(tns, []);
      index.get(tns).push(f);
      const refs = [];
      for (const c of kids(root, NS.XSD, ['import', 'include', 'redefine', 'override'])) {
        const loc = attr(c, 'schemaLocation');
        if (loc && !isRemote(loc)) refs.push(path.resolve(path.dirname(f), loc));
      }
      info.set(f, { tns, refs, ok: true });
    } catch (e) {
      info.set(f, { tns: null, refs: [], ok: false, error: e.message });
    }
  }
  return { index, info };
}

module.exports = { SchemaSet, buildNamespaceIndex };
