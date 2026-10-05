'use strict';
const { NS, kids, kid, attr, qname, qkey, documentation } = require('./xml');
const { TreeBuilder } = require('./tree');

const BUILTIN = {
  string: { type: 'string' }, normalizedString: { type: 'string' }, token: { type: 'string' },
  language: { type: 'string' }, Name: { type: 'string' }, NCName: { type: 'string' }, NMTOKEN: { type: 'string' },
  NMTOKENS: { type: 'array', items: { type: 'string' } }, ID: { type: 'string' }, IDREF: { type: 'string' },
  IDREFS: { type: 'array', items: { type: 'string' } }, ENTITY: { type: 'string' }, QName: { type: 'string' },
  anyURI: { type: 'string', format: 'uri' },
  boolean: { type: 'boolean' },
  int: { type: 'integer', format: 'int32' }, integer: { type: 'integer' }, long: { type: 'integer', format: 'int64' },
  short: { type: 'integer', minimum: -32768, maximum: 32767 }, byte: { type: 'integer', minimum: -128, maximum: 127 },
  unsignedInt: { type: 'integer', format: 'int64', minimum: 0 }, unsignedLong: { type: 'integer', minimum: 0 },
  unsignedShort: { type: 'integer', minimum: 0, maximum: 65535 }, unsignedByte: { type: 'integer', minimum: 0, maximum: 255 },
  nonNegativeInteger: { type: 'integer', minimum: 0 }, positiveInteger: { type: 'integer', minimum: 1 },
  nonPositiveInteger: { type: 'integer', maximum: 0 }, negativeInteger: { type: 'integer', maximum: -1 },
  decimal: { type: 'number' }, float: { type: 'number', format: 'float' }, double: { type: 'number', format: 'double' },
  date: { type: 'string', format: 'date' }, dateTime: { type: 'string', format: 'date-time' },
  time: { type: 'string', format: 'time' }, duration: { type: 'string', format: 'duration' },
  gYear: { type: 'string', pattern: '^\\d{4}$' }, gYearMonth: { type: 'string' }, gMonth: { type: 'string' },
  gDay: { type: 'string' }, gMonthDay: { type: 'string' },
  base64Binary: { type: 'string', format: 'byte' }, hexBinary: { type: 'string', format: 'binary' },
  anyType: {}, anySimpleType: { type: 'string' },
};

const builtin = (local) => JSON.parse(JSON.stringify(BUILTIN[local] || { type: 'string' }));
const isRef = (s) => s && s.$ref;
const occurs = (el) => ({
  min: attr(el, 'minOccurs') == null ? 1 : Number(attr(el, 'minOccurs')),
  max: attr(el, 'maxOccurs') == null ? 1 : attr(el, 'maxOccurs') === 'unbounded' ? Infinity : Number(attr(el, 'maxOccurs')),
});

/** Attach a description / nullable to a schema, wrapping $refs in allOf as OpenAPI 3.0 requires. */
function decorate(schema, { description, nullable, def } = {}) {
  if (!description && !nullable && def == null) return schema;
  const s = isRef(schema) ? { allOf: [schema] } : schema;
  if (description) s.description = description;
  if (nullable) s.nullable = true;
  if (def != null && !isRef(schema)) s.default = coerceDefault(def, s);
  return s;
}

function coerceDefault(v, s) {
  if (s.type === 'integer' || s.type === 'number') { const n = Number(v); return Number.isNaN(n) ? v : n; }
  if (s.type === 'boolean') return v === 'true' || v === '1';
  return v;
}

function simpleToSchema(t) {
  if (!t) return { type: 'string' };
  if (t.list) return { type: 'array', items: simpleToSchema(t.list), description: 'Whitespace-separated list in XML' };
  const s = builtin(t.base || 'string');
  if (t.enum && t.enum.length) s.enum = t.enum.map((v) => coerceDefault(v, s));
  const f = t.facets || {};
  if (s.type === 'string') {
    if (f.pattern) s.pattern = f.pattern.includes('|') ? `^(?:${f.pattern})$` : `^${f.pattern}$`;
    if (f.length != null) { s.minLength = Number(f.length); s.maxLength = Number(f.length); }
    if (f.minLength != null) s.minLength = Number(f.minLength);
    if (f.maxLength != null) s.maxLength = Number(f.maxLength);
  }
  if (s.type === 'integer' || s.type === 'number') {
    if (f.minInclusive != null) s.minimum = Number(f.minInclusive);
    if (f.maxInclusive != null) s.maximum = Number(f.maxInclusive);
    if (f.minExclusive != null) { s.minimum = Number(f.minExclusive); s.exclusiveMinimum = true; }
    if (f.maxExclusive != null) { s.maximum = Number(f.maxExclusive); s.exclusiveMaximum = true; }
    if (f.totalDigits != null) s['x-totalDigits'] = Number(f.totalDigits);
    if (f.fractionDigits != null) s['x-fractionDigits'] = Number(f.fractionDigits);
  }
  if (t.enumDocs) s['x-enum-descriptions'] = t.enumDocs;
  return s;
}

class OpenApiBuilder {
  constructor(set) {
    this.set = set;
    this.tree = new TreeBuilder(set);
    this.schemas = {};
    this.names = new Map(); // def key -> component name
    this.taken = new Set();
  }

  allocate(key, base, alt) {
    if (this.names.has(key)) return this.names.get(key);
    const clean = String(base).replace(/[^A-Za-z0-9_.-]/g, '_');
    let name = clean;
    if (this.taken.has(name)) name = `${clean}${alt}`;
    for (let i = 2; this.taken.has(name); i++) name = `${clean}${alt}${i}`;
    this.taken.add(name);
    this.names.set(key, name);
    return name;
  }

  ref(name) { return { $ref: `#/components/schemas/${name}` }; }

  /** Schema (inline or $ref) for a type QName. */
  typeRef(q) {
    if (!q) return {};
    if (q.ns === NS.XSD) return builtin(q.local);
    const key = qkey(q);
    const st = this.set.get('simpleType', q);
    if (st) {
      const name = this.allocate(`st:${key}`, q.local, 'Type');
      if (!this.schemas[name]) {
        this.schemas[name] = {};
        const t = this.tree.simple(st.node, st.ctx, 0);
        this.schemas[name] = decorate(simpleToSchema(t), { description: documentation(st.node) });
      }
      return this.ref(name);
    }
    const ct = this.set.get('complexType', q);
    if (ct) {
      const name = this.allocate(`ct:${key}`, q.local, 'Type');
      if (!this.schemas[name]) {
        this.schemas[name] = { type: 'object' }; // placeholder guards recursion
        this.schemas[name] = this.complex(ct.node, ct.ctx);
      }
      return this.ref(name);
    }
    return { type: 'string', description: `Unresolved type ${q.local}` };
  }

  /** Component for a global element (carries the XML root name/namespace). */
  elementRef(q) {
    const def = this.set.get('element', q);
    if (!def) return { type: 'object', description: `Unresolved element ${q ? q.local : ''}` };
    const name = this.allocate(`el:${qkey(q)}`, q.local, 'Element');
    if (!this.schemas[name]) {
      this.schemas[name] = { type: 'object' };
      const s = this.elementType(def.node, def.ctx);
      const xml = { name: q.local };
      if (q.ns) xml.namespace = q.ns;
      const wrapped = isRef(s) ? { allOf: [s] } : s;
      wrapped.xml = xml;
      const d = documentation(def.node);
      if (d && !wrapped.description) wrapped.description = d;
      this.schemas[name] = wrapped;
    }
    return this.ref(name);
  }

  elementType(el, ctx) {
    const t = attr(el, 'type');
    if (t) return this.typeRef(qname(el, t));
    const ict = kid(el, NS.XSD, 'complexType');
    if (ict) return this.complex(ict, ctx);
    const ist = kid(el, NS.XSD, 'simpleType');
    if (ist) return simpleToSchema(this.tree.simple(ist, ctx, 0));
    return {};
  }

  complex(ct, ctx) {
    const obj = { type: 'object', properties: {}, required: [] };
    const allOf = [];
    const state = { obj, choices: [] };
    for (const c of kids(ct, NS.XSD)) {
      if (c.localName === 'simpleContent' || c.localName === 'complexContent') {
        const d = kid(c, NS.XSD, ['extension', 'restriction']);
        if (!d) continue;
        const base = qname(d, attr(d, 'base'));
        const baseIsComplex = base && base.ns !== NS.XSD && this.set.get('complexType', base);
        if (c.localName === 'simpleContent') {
          if (baseIsComplex) allOf.push(this.typeRef(base));
          else {
            const vt = base && base.ns === NS.XSD ? { base: base.local } : this.tree.simpleRef(base, 0);
            if (d.localName === 'restriction') Object.assign(vt, this.tree.restrictionFacets(d));
            obj.properties.$value = decorate(simpleToSchema(vt), { description: 'Element text content' });
          }
        } else if (d.localName === 'extension' && baseIsComplex) {
          allOf.push(this.typeRef(base));
        }
        for (const p of kids(d, NS.XSD)) this.member(p, ctx, state, {});
      } else {
        this.member(c, ctx, state, {});
      }
    }
    const desc = [documentation(ct)];
    if (state.choices.length) {
      desc.push(...state.choices.map((ch) => `Choice: exactly one of ${ch.join(' | ')}`));
      obj['x-xsd-choice'] = state.choices;
    }
    if (attr(ct, 'abstract') === 'true') obj['x-abstract'] = true;
    if (!obj.required.length) delete obj.required;
    if (!Object.keys(obj.properties).length && !obj.additionalProperties) delete obj.properties;
    const description = desc.filter(Boolean).join('\n\n') || undefined;
    if (allOf.length) {
      const result = { allOf: [...allOf] };
      if (obj.properties || obj.additionalProperties || obj['x-xsd-choice']) result.allOf.push(obj);
      if (description) result.description = description;
      return result;
    }
    if (description) obj.description = description;
    return obj;
  }

  /** Process a particle / attribute declaration into the object state. */
  member(el, ctx, state, flags) {
    const { obj } = state;
    const o = occurs(el);
    const optional = flags.optional || o.min === 0;
    const repeat = flags.repeat || o.max > 1;
    switch (el.localName) {
      case 'element': this.property(el, ctx, obj, { optional, repeat: flags.repeat }); break;
      case 'sequence': case 'all':
        for (const c of kids(el, NS.XSD)) this.member(c, ctx, state, { optional, repeat }); break;
      case 'choice': {
        const names = [];
        for (const c of kids(el, NS.XSD)) {
          const before = new Set(Object.keys(obj.properties));
          this.member(c, ctx, state, { optional: true, repeat });
          names.push(Object.keys(obj.properties).filter((k) => !before.has(k)).join('+') || c.localName);
        }
        state.choices.push(names);
        break;
      }
      case 'group': {
        const g = this.set.get('group', qname(el, attr(el, 'ref')));
        if (g) for (const c of kids(g.node, NS.XSD, ['sequence', 'choice', 'all'])) this.member(c, g.ctx, state, { optional, repeat });
        break;
      }
      case 'any': obj.additionalProperties = true; break;
      case 'attribute': case 'attributeGroup': case 'anyAttribute':
        for (const a of this.tree.attributes(el, ctx)) {
          if (a.any) { obj.additionalProperties = true; continue; }
          obj.properties[a.name] = decorate({ ...simpleToSchema(a.type), xml: { attribute: true } }, { description: a.doc, def: a.default });
          if (a.required) obj.required.push(a.name);
        }
        break;
      default: break;
    }
  }

  property(el, ctx, obj, { optional, repeat }) {
    let name; let schema; let doc; let nillable; let def;
    const ref = attr(el, 'ref');
    if (ref) {
      const q = qname(el, ref);
      const g = this.set.get('element', q);
      name = q.local;
      schema = g ? this.elementType(g.node, g.ctx) : { description: `Unresolved element ${q.local}` };
      doc = g && documentation(g.node);
      nillable = g && attr(g.node, 'nillable') === 'true';
    } else {
      name = attr(el, 'name');
      schema = this.elementType(el, ctx);
      doc = documentation(el);
      nillable = attr(el, 'nillable') === 'true';
      def = attr(el, 'default');
    }
    const o = occurs(el);
    if (o.max > 1 || repeat) {
      const arr = { type: 'array', items: schema };
      if (o.min > 1) arr.minItems = o.min;
      if (Number.isFinite(o.max) && o.max > 1) arr.maxItems = o.max;
      if (doc) arr.description = doc;
      obj.properties[name] = arr;
    } else {
      obj.properties[name] = decorate(isRef(schema) ? schema : { ...schema }, { description: doc, nullable: nillable, def });
    }
    if (!optional && o.min > 0) obj.required.push(name);
  }

  /** Request/response body schema for a WSDL message descriptor. */
  messageSchema(msg) {
    if (!msg) return null;
    if (msg.rpc) {
      const s = { type: 'object', properties: {}, required: [], xml: { name: msg.rpc.name } };
      if (msg.rpc.ns) s.xml.namespace = msg.rpc.ns;
      for (const p of msg.parts) {
        s.properties[p.name] = p.element ? this.elementRef(p.element) : this.typeRef(p.type);
        s.required.push(p.name);
      }
      if (!s.required.length) delete s.required;
      return s;
    }
    const parts = msg.parts || [];
    if (parts.length === 1) return parts[0].element ? this.elementRef(parts[0].element) : this.typeRef(parts[0].type);
    const s = { type: 'object', properties: {} };
    for (const p of parts) s.properties[p.element ? p.element.local : p.name] = p.element ? this.elementRef(p.element) : this.typeRef(p.type);
    return s;
  }
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9_.~-]+/g, '-');

/**
 * Build an OpenAPI 3.0 document for a catalogue entry.
 * entry: { name, doc, endpoints, operations: [{ name, doc, input, output, faults, samples, soap... }], elements? }
 */
function buildOpenApi(entry, set) {
  const b = new OpenApiBuilder(set);
  const doc = {
    openapi: '3.0.3',
    info: {
      title: entry.name,
      version: entry.version || '1.0.0',
      description: [entry.doc, `Auto-generated from \`${entry.source}\` (${entry.kind === 'xsd' ? 'XML Schema' : `WSDL ${entry.wsdlVersion || '1.1'}`}). `
        + 'Each SOAP operation is exposed as `POST /{service}/{operation}`; JSON bodies mirror the XML message content.'].filter(Boolean).join('\n\n'),
    },
    servers: [],
    tags: [{ name: entry.name, description: entry.targetNamespace ? `Target namespace: ${entry.targetNamespace}` : undefined }],
    paths: {},
    components: { schemas: b.schemas },
  };
  const urls = [...new Set((entry.endpoints || []).map((e) => e.address).filter(Boolean))];
  doc.servers = urls.length ? urls.map((url) => ({ url })) : [{ url: '/', description: 'No endpoint address declared' }];

  const opPaths = {};
  for (const op of entry.operations || []) {
    const p = `/${slug(entry.name)}/${slug(op.name)}`;
    const reqSchema = b.messageSchema(op.input);
    const resSchema = b.messageSchema(op.output);
    const s = op.samples || {};
    const v = s.soap ? Object.keys(s.soap)[0] : null;
    const post = {
      tags: [entry.name],
      operationId: `${slug(entry.name)}_${slug(op.name)}`.replace(/[-.~]/g, '_'),
      summary: op.name,
    };
    if (op.doc) post.description = op.doc;
    if (op.soapAction != null) post['x-soap-action'] = op.soapAction;
    if (op.style) post['x-soap-style'] = op.style;
    if (op.inferred) post['x-inferred-from-xsd'] = true;
    if (op.input && op.input.headers && op.input.headers.length) {
      post['x-soap-headers'] = op.input.headers.map((h) => (h.element ? h.element.local : h.name));
    }
    if (reqSchema) {
      post.requestBody = { required: true, content: { 'application/json': { schema: reqSchema } } };
      if (s.json && s.json.request != null) post.requestBody.content['application/json'].example = s.json.request;
      if (v) post.requestBody.content['text/xml'] = { schema: reqSchema, example: s.soap[v].request };
    }
    post.responses = {};
    if (resSchema) {
      post.responses['200'] = { description: 'Successful response', content: { 'application/json': { schema: resSchema } } };
      if (s.json && s.json.response != null) post.responses['200'].content['application/json'].example = s.json.response;
      if (v && s.soap[v].response) post.responses['200'].content['text/xml'] = { schema: resSchema, example: s.soap[v].response };
    } else {
      post.responses['202'] = { description: 'Accepted (one-way operation, no response body)' };
    }
    const faults = (op.faults || []).map((f) => ({ f, schema: b.messageSchema(f.message) })).filter((x) => x.schema);
    if (faults.length) {
      const schema = faults.length === 1 ? faults[0].schema : { oneOf: faults.map((x) => x.schema) };
      post.responses['500'] = {
        description: `SOAP Fault: ${faults.map((x) => x.f.name).join(', ')}`,
        content: { 'application/json': { schema } },
      };
      if (s.json && s.json.faults && s.json.faults[0]) post.responses['500'].content['application/json'].example = s.json.faults[0].body;
    } else {
      post.responses.default = { description: 'SOAP Fault' };
    }
    doc.paths[p] = { post };
    opPaths[op.name] = p;
  }

  // plain XSD entries: expose every global element as a component
  for (const e of entry.elements || []) b.elementRef(e.qname);

  if (!doc.paths || !Object.keys(doc.paths).length) doc.paths = {};
  return { doc, opPaths, elementNames: Object.fromEntries((entry.elements || []).map((e) => [e.name, b.names.get(`el:${qkey(e.qname)}`)])) };
}

/** Minimal valid OpenAPI doc containing just one path (or schema) plus the components it references. */
function fragment(full, { path, schemaName }) {
  const all = full.components.schemas;
  const keep = new Set();
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === '$ref' && typeof v === 'string') {
        const n = v.split('/').pop();
        if (!keep.has(n) && all[n]) { keep.add(n); visit(all[n]); }
      } else if (k !== 'example') visit(v);
    }
  };
  const doc = { openapi: full.openapi, info: full.info, servers: full.servers, paths: {}, components: { schemas: {} } };
  if (path) { doc.paths[path] = full.paths[path]; visit(full.paths[path]); }
  if (schemaName) { keep.add(schemaName); visit(all[schemaName]); }
  for (const n of Object.keys(all)) if (keep.has(n)) doc.components.schemas[n] = all[n];
  return doc;
}

module.exports = { buildOpenApi, fragment, simpleToSchema };
