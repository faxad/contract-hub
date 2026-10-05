'use strict';
/**
 * Turns XSD definitions into a resolved, self-contained tree of nodes that the
 * sample generators and field tables walk. Node shapes:
 *   element:   { kind:'element', name, ns, qualified, min, max, type, simple, children, attributes, ... }
 *   attribute: { kind:'attribute', name, ns, required, type }
 *   choice:    { kind:'choice', min, max, options: Node[][] }
 *   any:       { kind:'any', min, max, namespace }
 * type: { name, ns, builtin, base, enum, facets, list }
 */
const { NS, kids, kid, attr, qname, qkey, documentation } = require('./xml');

const MAX_DEPTH = 15;

const occurs = (el, def = 1) => {
  const min = attr(el, 'minOccurs');
  const max = attr(el, 'maxOccurs');
  return {
    min: min == null ? def : Number(min),
    max: max == null ? def : max === 'unbounded' ? Infinity : Number(max),
  };
};

const FACETS = ['length', 'minLength', 'maxLength', 'pattern', 'minInclusive', 'maxInclusive',
  'minExclusive', 'maxExclusive', 'totalDigits', 'fractionDigits', 'whiteSpace'];

class TreeBuilder {
  constructor(set) {
    this.set = set;
  }

  /** Tree for a global element by QName. */
  element(q) {
    const def = this.set.get('element', q);
    if (!def) {
      return { kind: 'element', name: q ? q.local : '?', ns: q ? q.ns : '', qualified: true, min: 1, max: 1,
        unresolved: true, type: { name: q ? q.local : '?', builtin: false }, children: [], attributes: [] };
    }
    return this.elementNode(def.node, def.ctx, true, new Set(), 0);
  }

  /** Synthetic element (RPC parts, element-less doc parts) with a named type. */
  typed(name, ns, qualified, typeQ) {
    const node = { kind: 'element', name, ns: qualified ? ns : '', qualified, min: 1, max: 1, children: [], attributes: [] };
    this.applyTypeRef(node, typeQ, new Set(), 0);
    return node;
  }

  elementNode(el, ctx, global, stack, depth, occ) {
    const ref = attr(el, 'ref');
    if (ref) {
      const q = qname(el, ref);
      const def = this.set.get('element', q);
      const o = occurs(el);
      if (!def) {
        return { kind: 'element', name: q.local, ns: q.ns, qualified: true, ...o, unresolved: true,
          type: { name: q.local, builtin: false }, children: [], attributes: [] };
      }
      return this.elementNode(def.node, def.ctx, true, stack, depth, o);
    }
    const name = attr(el, 'name');
    const form = attr(el, 'form');
    const qualified = global || form === 'qualified' || (form !== 'unqualified' && ctx.elementQualified);
    const o = occ || (global ? { min: 1, max: 1 } : occurs(el));
    const node = {
      kind: 'element', name, ns: qualified ? ctx.tns : '', qualified, min: o.min, max: o.max,
      nillable: attr(el, 'nillable') === 'true', default: attr(el, 'default'), fixed: attr(el, 'fixed'),
      doc: documentation(el), children: [], attributes: [],
    };
    const key = global ? `el:${qkey({ ns: ctx.tns, local: name })}` : null;
    if (key && stack.has(key)) return { ...node, recursive: true, type: { name, builtin: false } };
    if (depth > MAX_DEPTH) return { ...node, truncated: true, type: { name: '…', builtin: false } };
    const inner = key ? new Set(stack).add(key) : stack;

    const typeAttr = attr(el, 'type');
    const inlineComplex = kid(el, NS.XSD, 'complexType');
    const inlineSimple = kid(el, NS.XSD, 'simpleType');
    if (typeAttr) this.applyTypeRef(node, qname(el, typeAttr), inner, depth);
    else if (inlineComplex) {
      node.type = { name: null, builtin: false, anonymous: true };
      this.complex(node, inlineComplex, ctx, inner, depth);
    } else if (inlineSimple) {
      node.simple = true;
      node.type = this.simple(inlineSimple, ctx, 0);
    } else {
      node.simple = true;
      node.type = { name: 'anyType', builtin: true, base: 'anyType' };
    }
    return node;
  }

  applyTypeRef(node, q, stack, depth) {
    if (!q) return;
    if (q.ns === NS.XSD) {
      node.simple = q.local !== 'anyType';
      node.type = { name: q.local, ns: q.ns, builtin: true, base: q.local };
      if (q.local === 'anyType') node.children.push({ kind: 'any', min: 0, max: Infinity });
      return;
    }
    const st = this.set.get('simpleType', q);
    if (st) {
      node.simple = true;
      node.type = { ...this.simple(st.node, st.ctx, 0), name: q.local, ns: q.ns };
      return;
    }
    const ct = this.set.get('complexType', q);
    if (!ct) {
      node.unresolved = true;
      node.simple = true;
      node.type = { name: q.local, ns: q.ns, builtin: false, base: 'string' };
      return;
    }
    node.type = { name: q.local, ns: q.ns, builtin: false };
    const key = `ct:${qkey(q)}`;
    if (stack.has(key)) { node.recursive = true; return; }
    if (depth > MAX_DEPTH) { node.truncated = true; return; }
    this.complex(node, ct.node, ct.ctx, new Set(stack).add(key), depth + 1);
  }

  /** Populate node.children / node.attributes from a complexType definition. */
  complex(node, ct, ctx, stack, depth) {
    if (attr(ct, 'mixed') === 'true') node.mixed = true;
    if (attr(ct, 'abstract') === 'true') node.abstract = true;
    for (const c of kids(ct, NS.XSD)) {
      switch (c.localName) {
        case 'simpleContent': this.simpleContent(node, c, ctx, stack, depth); break;
        case 'complexContent': this.complexContent(node, c, ctx, stack, depth); break;
        case 'sequence': case 'all': case 'choice': case 'group':
          node.children.push(...this.particle(c, ctx, stack, depth)); break;
        case 'attribute': case 'attributeGroup': case 'anyAttribute':
          node.attributes.push(...this.attributes(c, ctx)); break;
        default: break;
      }
    }
  }

  simpleContent(node, sc, ctx, stack, depth) {
    const d = kid(sc, NS.XSD, ['extension', 'restriction']);
    if (!d) return;
    node.simple = true;
    const base = qname(d, attr(d, 'base'));
    if (base && base.ns !== NS.XSD) {
      const ct = this.set.get('complexType', base);
      if (ct) {
        // base is itself a complex type with simple content: inherit its value type + attributes
        const tmp = { children: [], attributes: [], type: null };
        this.complex(tmp, ct.node, ct.ctx, stack, depth + 1);
        node.attributes.push(...tmp.attributes);
        node.valueType = tmp.valueType || { name: 'string', builtin: true, base: 'string' };
      } else {
        node.valueType = this.simpleRef(base, 0);
      }
    } else if (base) {
      node.valueType = { name: base.local, ns: base.ns, builtin: true, base: base.local };
    }
    if (d.localName === 'restriction') {
      const r = this.restrictionFacets(d);
      node.valueType = { ...(node.valueType || {}), ...r, facets: { ...(node.valueType?.facets || {}), ...r.facets } };
      if (!r.enum) delete node.valueType.enum;
    }
    for (const c of kids(d, NS.XSD, ['attribute', 'attributeGroup', 'anyAttribute'])) node.attributes.push(...this.attributes(c, ctx));
    if (!node.type || node.type.anonymous) node.type = { ...(node.type || {}), base: node.valueType?.base };
  }

  complexContent(node, cc, ctx, stack, depth) {
    if (attr(cc, 'mixed') === 'true') node.mixed = true;
    const d = kid(cc, NS.XSD, ['extension', 'restriction']);
    if (!d) return;
    const base = qname(d, attr(d, 'base'));
    if (d.localName === 'extension' && base && base.ns !== NS.XSD) {
      const ct = this.set.get('complexType', base);
      const key = `ct:${qkey(base)}`;
      if (ct && !stack.has(key)) {
        this.complex(node, ct.node, ct.ctx, new Set(stack).add(key), depth + 1);
        node.baseType = base.local;
      }
    } else if (d.localName === 'restriction' && base && base.ns !== NS.XSD) {
      // restrictions re-declare content; only inherit the base's attributes
      const ct = this.set.get('complexType', base);
      if (ct) {
        const tmp = { children: [], attributes: [] };
        this.complex(tmp, ct.node, ct.ctx, stack, depth + 1);
        node.attributes.push(...tmp.attributes);
      }
    }
    for (const c of kids(d, NS.XSD)) {
      if (['sequence', 'all', 'choice', 'group'].includes(c.localName)) node.children.push(...this.particle(c, ctx, stack, depth));
      else if (['attribute', 'attributeGroup', 'anyAttribute'].includes(c.localName)) {
        for (const a of this.attributes(c, ctx)) {
          const i = node.attributes.findIndex((x) => x.name === a.name);
          if (i >= 0) node.attributes[i] = a; else node.attributes.push(a);
        }
      }
    }
  }

  /** Returns a flat list of child nodes for a model group (sequence/all flattened, choice kept). */
  particle(el, ctx, stack, depth) {
    const o = occurs(el);
    switch (el.localName) {
      case 'element':
        return [this.elementNode(el, ctx, false, stack, depth + 1)];
      case 'any':
        return [{ kind: 'any', ...occurs(el), namespace: attr(el, 'namespace') || '##any' }];
      case 'group': {
        const ref = attr(el, 'ref');
        if (!ref) return kids(el, NS.XSD, ['sequence', 'choice', 'all']).flatMap((c) => this.particle(c, ctx, stack, depth));
        const q = qname(el, ref);
        const g = this.set.get('group', q);
        if (!g) return [];
        const key = `grp:${qkey(q)}`;
        if (stack.has(key)) return [];
        const inner = new Set(stack).add(key);
        const items = kids(g.node, NS.XSD, ['sequence', 'choice', 'all']).flatMap((c) => this.particle(c, g.ctx, inner, depth));
        return this.applyGroupOccurs(items, o);
      }
      case 'sequence':
      case 'all': {
        const items = kids(el, NS.XSD).flatMap((c) => this.particle(c, ctx, stack, depth));
        return this.applyGroupOccurs(items, o);
      }
      case 'choice': {
        const options = kids(el, NS.XSD).map((c) => this.particle(c, ctx, stack, depth)).filter((x) => x.length);
        return [{ kind: 'choice', min: o.min, max: o.max, options }];
      }
      default:
        return [];
    }
  }

  /** Optional/repeating sequences make their members optional/repeating (good enough for docs + samples). */
  applyGroupOccurs(items, o) {
    if (o.min === 1 && o.max === 1) return items;
    return items.map((n) => ({
      ...n,
      min: o.min === 0 ? 0 : n.min,
      max: o.max > 1 ? Math.max(n.max, o.max) : n.max,
    }));
  }

  attributes(el, ctx) {
    if (el.localName === 'anyAttribute') return [{ kind: 'attribute', any: true, name: '*', required: false }];
    if (el.localName === 'attributeGroup') {
      const q = qname(el, attr(el, 'ref'));
      const g = this.set.get('attributeGroup', q);
      if (!g) return [];
      return kids(g.node, NS.XSD, ['attribute', 'attributeGroup', 'anyAttribute']).flatMap((c) => this.attributes(c, g.ctx));
    }
    let a = el;
    let actx = ctx;
    let global = false;
    const ref = attr(el, 'ref');
    if (ref) {
      const q = qname(el, ref);
      const def = this.set.get('attribute', q);
      if (!def) return [{ kind: 'attribute', name: q.local, ns: q.ns, required: attr(el, 'use') === 'required', type: { name: 'string', builtin: true, base: 'string' } }];
      a = def.node; actx = def.ctx; global = true;
    }
    if (attr(el, 'use') === 'prohibited') return [];
    const form = attr(a, 'form');
    const qualified = global || form === 'qualified' || (form !== 'unqualified' && actx.attributeQualified);
    const typeAttr = attr(a, 'type');
    const inline = kid(a, NS.XSD, 'simpleType');
    const type = typeAttr ? this.simpleRef(qname(a, typeAttr), 0)
      : inline ? this.simple(inline, actx, 0)
        : { name: 'string', builtin: true, base: 'string' };
    return [{
      kind: 'attribute', name: attr(a, 'name'), ns: qualified ? actx.tns : '', qualified,
      required: attr(el, 'use') === 'required', default: attr(el, 'default') || attr(a, 'default'),
      fixed: attr(el, 'fixed') || attr(a, 'fixed'), doc: documentation(a), type,
    }];
  }

  simpleRef(q, depth) {
    if (!q) return { name: 'string', builtin: true, base: 'string' };
    if (q.ns === NS.XSD) return { name: q.local, ns: q.ns, builtin: true, base: q.local };
    const st = this.set.get('simpleType', q);
    if (!st || depth > 10) return { name: q.local, ns: q.ns, builtin: false, base: 'string', unresolved: !st };
    return { ...this.simple(st.node, st.ctx, depth + 1), name: q.local, ns: q.ns };
  }

  restrictionFacets(r) {
    const facets = {};
    const enums = [];
    const enumDocs = {};
    for (const f of kids(r, NS.XSD)) {
      const v = attr(f, 'value');
      if (f.localName === 'enumeration') {
        enums.push(v ?? '');
        const d = documentation(f);
        if (d) enumDocs[v] = d;
      } else if (FACETS.includes(f.localName)) {
        facets[f.localName] = f.localName === 'pattern' && facets.pattern ? `${facets.pattern}|${v}` : v;
      }
    }
    return { facets, enum: enums.length ? enums : undefined, enumDocs: Object.keys(enumDocs).length ? enumDocs : undefined };
  }

  /** Resolve a simpleType definition into { base (builtin local name), enum, facets, list }. */
  simple(st, ctx, depth) {
    const doc = documentation(st);
    const r = kid(st, NS.XSD, 'restriction');
    if (r) {
      const baseAttr = attr(r, 'base');
      const inlineBase = kid(r, NS.XSD, 'simpleType');
      const base = baseAttr ? this.simpleRef(qname(r, baseAttr), depth + 1)
        : inlineBase ? this.simple(inlineBase, ctx, depth + 1) : { base: 'string' };
      const own = this.restrictionFacets(r);
      return {
        name: null, builtin: false, base: base.base || 'string', doc,
        enum: own.enum || base.enum, enumDocs: own.enumDocs || base.enumDocs,
        facets: { ...(base.facets || {}), ...own.facets }, list: base.list,
      };
    }
    const l = kid(st, NS.XSD, 'list');
    if (l) {
      const item = attr(l, 'itemType') ? this.simpleRef(qname(l, attr(l, 'itemType')), depth + 1)
        : this.simple(kid(l, NS.XSD, 'simpleType'), ctx, depth + 1);
      return { name: null, builtin: false, base: item.base, list: item, doc };
    }
    const u = kid(st, NS.XSD, 'union');
    if (u) {
      const members = (attr(u, 'memberTypes') || '').split(/\s+/).filter(Boolean).map((m) => this.simpleRef(qname(u, m), depth + 1));
      for (const s of kids(u, NS.XSD, 'simpleType')) members.push(this.simple(s, ctx, depth + 1));
      const first = members[0] || { base: 'string' };
      return { name: null, builtin: false, base: first.base, union: members, enum: members.flatMap((m) => m.enum || []).filter(Boolean).length ? members.flatMap((m) => m.enum || []) : undefined, doc };
    }
    return { name: null, builtin: false, base: 'string', doc };
  }
}

/* ---------- field flattening (for tables + search) ---------- */

const fmtMax = (m) => (m === Infinity ? '*' : String(m));
const occursLabel = (n) => (n.min === n.max ? String(n.min) : `${n.min}..${fmtMax(n.max)}`);

function typeLabel(n) {
  const t = n.kind === 'element' && n.valueType && !n.type?.name ? n.valueType : n.type;
  if (!t) return n.kind === 'any' ? 'any' : '';
  if (t.name) return t.name;
  if (t.list) return `list<${t.list.name || t.base}>`;
  if (t.anonymous) return n.simple ? (n.valueType?.name || n.valueType?.base || 'string') : '(anonymous)';
  return t.base || '';
}

function constraintsLabel(n) {
  const t = n.valueType || n.type || {};
  const parts = [];
  if (t.enum && t.enum.length) parts.push(`enum: ${t.enum.slice(0, 8).join(' | ')}${t.enum.length > 8 ? ' …' : ''}`);
  const f = t.facets || {};
  if (f.pattern) parts.push(`pattern: ${f.pattern}`);
  if (f.length) parts.push(`length: ${f.length}`);
  if (f.minLength || f.maxLength) parts.push(`length: ${f.minLength || 0}..${f.maxLength || '*'}`);
  if (f.minInclusive || f.maxInclusive) parts.push(`range: ${f.minInclusive ?? '…'}..${f.maxInclusive ?? '…'}`);
  if (f.minExclusive || f.maxExclusive) parts.push(`exclusive: ${f.minExclusive ?? '…'}..${f.maxExclusive ?? '…'}`);
  if (f.totalDigits) parts.push(`digits: ${f.totalDigits}${f.fractionDigits ? `.${f.fractionDigits}` : ''}`);
  if (n.default) parts.push(`default: ${n.default}`);
  if (n.fixed) parts.push(`fixed: ${n.fixed}`);
  if (n.nillable) parts.push('nillable');
  return parts.join('; ');
}

/** Depth-first list of rows: { path, name, depth, kind, type, occurs, required, constraints, doc, choice } */
function flatten(root, { includeRoot = true } = {}) {
  const rows = [];
  const walk = (n, parentPath, depth, extra = {}) => {
    if (n.kind === 'choice') {
      const names = n.options.map((opt) => opt.map((o) => o.name || 'any').join('+'));
      rows.push({ path: `${parentPath}/(choice)`, name: 'choice', depth, kind: 'choice', type: '', occurs: occursLabel(n),
        required: n.min > 0, constraints: `one of: ${names.join(' | ')}`, doc: null });
      n.options.forEach((opt, i) => opt.forEach((o) => walk(o, parentPath, depth + 1, { choice: i + 1 })));
      return;
    }
    if (n.kind === 'any') {
      rows.push({ path: `${parentPath}/*`, name: '*', depth, kind: 'any', type: 'any', occurs: occursLabel(n), required: n.min > 0, constraints: `namespace: ${n.namespace || '##any'}`, doc: null, ...extra });
      return;
    }
    const p = `${parentPath}/${n.name}`;
    rows.push({
      path: p, name: n.name, depth, kind: 'element', type: typeLabel(n), occurs: occursLabel(n), required: n.min > 0,
      constraints: constraintsLabel(n), doc: n.doc || n.type?.doc || null,
      recursive: !!n.recursive, ns: n.ns || '', ...extra,
    });
    for (const a of n.attributes || []) {
      rows.push({ path: `${p}/@${a.name}`, name: `@${a.name}`, depth: depth + 1, kind: 'attribute', type: typeLabel(a),
        occurs: a.required ? '1' : '0..1', required: !!a.required, constraints: constraintsLabel(a), doc: a.doc || null });
    }
    for (const c of n.children || []) walk(c, p, depth + 1);
  };
  if (includeRoot) walk(root, '', 0);
  else (root.children || []).forEach((c) => walk(c, '', 0));
  return rows;
}

module.exports = { TreeBuilder, flatten, typeLabel };
