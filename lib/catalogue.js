'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SchemaSet, buildNamespaceIndex } = require('./schema');
const { parseWsdl } = require('./wsdl');
const { TreeBuilder, flatten } = require('./tree');
const { soapEnvelope, xmlDocument, jsonBody, jsonValue } = require('./samples');
const yaml = require('js-yaml');
const { buildOpenApi, fragment } = require('./openapi');

const toYaml = (o) => yaml.dump(o, { noRefs: true, lineWidth: -1, quotingType: '"' });

const EXTS = new Set(['.wsdl', '.xsd', '.xml']);

function walk(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.name.startsWith('.') || it.name === 'node_modules') continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(it.name).toLowerCase())) out.push(p);
  }
  return out;
}

function fingerprint(dir) {
  return walk(dir).map((f) => {
    try { const st = fs.statSync(f); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return f; }
  }).join('|');
}

/** Classify a file as wsdl / xsd by extension, sniffing the root element of .xml files. */
function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.wsdl') return 'wsdl';
  if (ext === '.xsd') return 'xsd';
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4096).replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '');
    const m = /<\s*(?:[\w.-]+:)?(definitions|description|schema)\b/.exec(head);
    if (!m) return null;
    return m[1] === 'schema' ? 'xsd' : 'wsdl';
  } catch { return null; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';

const RESPONSE_SUFFIXES = [['Request', 'Response'], ['Req', 'Resp'], ['Rq', 'Rs'], ['Input', 'Output'], ['', 'Response']];

class Catalogue extends EventEmitter {
  constructor(dir, opts = {}) {
    super();
    this.dir = path.resolve(dir);
    this.opts = opts;
    this.entries = [];
    this.byId = new Map();
    this.index = [];
    this.problems = [];
    this.version = 0;
    this.builtAt = null;
    this.timer = null;
  }

  rel(p) { return path.relative(this.dir, p).split(path.sep).join('/'); }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.rebuild('startup');
    this.watch();
    this.scan();
    return this;
  }

  /** Native file events: instant where the OS delivers them (local disks). */
  watch() {
    const { watch } = require('chokidar');
    const usePolling = /^(1|true|yes)$/i.test(process.env.CHOKIDAR_USEPOLLING || '');
    this.watcher = watch(this.dir, {
      ignoreInitial: true,
      usePolling,
      depth: 20,
      ignored: (p) => path.basename(p).startsWith('.') && p !== this.dir,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    this.watcher.on('all', (evt, p) => {
      if (evt === 'addDir' || evt === 'unlinkDir' || EXTS.has(path.extname(p).toLowerCase())) this.schedule(`${evt} ${this.rel(p)}`);
    });
    this.watcher.on('error', (e) => console.error('[watch] error:', e.message));
  }

  /**
   * Fingerprint scan: Docker bind mounts and network shares often drop file events and don't
   * refresh directory mtimes, which defeats both inotify and chokidar's polling. Listing the
   * tree and comparing path/size/mtime of every WSDL/XSD is cheap and always works.
   */
  scan() {
    const interval = Number(process.env.WATCH_INTERVAL) || 2000;
    this.scanTimer = setInterval(() => {
      if (this.timer) return; // a rebuild is already pending
      const fp = fingerprint(this.dir);
      if (fp !== this.fingerprint) this.schedule('folder scan detected changes');
    }, interval);
    this.scanTimer.unref();
    console.log(`[watch] watching ${this.dir} (file events + scan every ${interval}ms)`);
  }

  schedule(reason) {
    clearTimeout(this.timer);
    this.pendingReasons = [...(this.pendingReasons || []), reason];
    this.timer = setTimeout(() => {
      this.timer = null;
      const reasons = this.pendingReasons;
      this.pendingReasons = [];
      this.rebuild(reasons.join(', '));
    }, 350);
  }

  rebuild(reason) {
    const t0 = Date.now();
    const before = new Map(this.entries.map((e) => [e.id, e]));
    this.fingerprint = fingerprint(this.dir);
    const files = walk(this.dir);
    const kinds = new Map(files.map((f) => [f, classify(f)]));
    const wsdls = files.filter((f) => kinds.get(f) === 'wsdl');
    const xsds = files.filter((f) => kinds.get(f) === 'xsd');
    const { index: nsIndex, info } = buildNamespaceIndex(xsds);
    const problems = [];
    const entries = [];
    const referenced = new Set();
    for (const [f, i] of info) {
      i.refs.forEach((r) => referenced.add(r));
      if (!i.ok) problems.push({ file: this.rel(f), level: 'error', message: i.error });
    }

    const add = (entry, set, file) => {
      try {
        this.enrich(entry, set, file);
        entries.push(entry);
      } catch (e) {
        problems.push({ file: this.rel(file), level: 'error', message: `Failed to build ${entry.name}: ${e.message}` });
        console.error(e);
      }
    };

    for (const file of wsdls) {
      const set = new SchemaSet({ nsIndex });
      try {
        const res = parseWsdl(file, set);
        set.finalize();
        res.problems.forEach((p) => problems.push({ ...p, file: this.rel(p.file) }));
        if (!res.entries.length) problems.push({ file: this.rel(file), level: 'warning', message: 'WSDL defines no services or portTypes' });
        for (const entry of res.entries) add(entry, set, file);
      } catch (e) {
        problems.push({ file: this.rel(file), level: 'error', message: e.message.replace(file, this.rel(file)) });
      }
      set.files.forEach((f) => { if (f !== file) referenced.add(f); });
      set.problems.forEach((p) => problems.push({ ...p, file: this.rel(p.file) }));
    }

    // XSDs not pulled in by a WSDL or another schema are catalogued on their own
    for (const file of xsds) {
      if (referenced.has(file) || !info.get(file).ok) continue;
      const set = new SchemaSet({ nsIndex });
      set.loadFile(file);
      set.finalize();
      set.problems.forEach((p) => problems.push({ ...p, file: this.rel(p.file) }));
      add(this.xsdEntry(file, set), set, file);
    }

    // stable unique ids
    const seen = new Set();
    for (const e of entries) {
      let id = slug(`${e.folder === '.' ? '' : e.folder}-${e.name}`);
      for (let i = 2; seen.has(id); i++) id = `${slug(`${e.folder}-${e.name}`)}-${i}`;
      seen.add(id);
      e.id = id;
    }
    entries.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));

    const dedup = new Map(problems.map((p) => [`${p.file}|${p.message}`, p]));
    this.problems = [...dedup.values()];
    this.entries = entries;
    this.byId = new Map(entries.map((e) => [e.id, e]));
    this.index = this.buildIndex(entries);
    this.version++;
    this.builtAt = new Date().toISOString();

    const added = entries.filter((e) => !before.has(e.id)).map((e) => e.name);
    const removed = [...before.values()].filter((e) => !this.byId.has(e.id)).map((e) => e.name);
    const changed = entries.filter((e) => before.has(e.id) && before.get(e.id).hash !== e.hash).map((e) => e.name);
    const summary = { version: this.version, reason, added, removed, changed, services: entries.length,
      problems: this.problems.length, ms: Date.now() - t0 };
    console.log(`[catalogue] v${this.version} ${entries.length} entries, ${this.problems.length} problems in ${summary.ms}ms (${reason})`);
    this.emit('updated', summary);
    return summary;
  }

  xsdEntry(file, set) {
    const globals = [...set.elements.values()].filter((d) => d.ctx.file === file || set.files.has(d.ctx.file));
    const byName = new Map(globals.map((d) => [d.name, d]));
    const operations = [];
    const used = new Set();
    for (const d of globals) {
      for (const [reqS, resS] of RESPONSE_SUFFIXES) {
        if (reqS && !d.name.endsWith(reqS)) continue;
        const base = reqS ? d.name.slice(0, -reqS.length) : d.name;
        const res = byName.get(base + resS);
        if (!base || !res || res === d || used.has(d.name)) continue;
        const msg = (x) => ({ message: x.name, parts: [{ name: x.name, element: { ns: x.ns, local: x.name } }], headers: [] });
        const fault = byName.get(`${base}Fault`);
        operations.push({
          name: base, inferred: true, pattern: 'request-response', style: 'document', use: 'literal', soapAction: null,
          doc: `Inferred from the ${d.name} / ${res.name} element pair.`,
          input: msg(d), output: msg(res), faults: fault ? [{ name: fault.name, message: msg(fault) }] : [],
        });
        used.add(d.name); used.add(res.name);
        break;
      }
    }
    const root = globals.find((d) => d.ctx.file === file);
    return {
      kind: 'xsd', name: path.basename(file, path.extname(file)), doc: null,
      targetNamespace: root ? root.ns : '', soapVersions: ['1.1'], endpoints: [], operations,
      elements: globals.filter((d) => d.ctx.file === file).map((d) => ({ name: d.name, qname: { ns: d.ns, local: d.name } })),
      files: [file],
    };
  }

  /** Generate trees, samples, field tables and OpenAPI for an entry. */
  enrich(entry, set, file) {
    const tb = new TreeBuilder(set);
    const nodes = (desc) => {
      if (!desc) return [];
      const partNode = (p) => (p.element ? tb.element(p.element) : tb.typed(p.name, '', false, p.type));
      if (desc.rpc) {
        return [{ kind: 'element', name: desc.rpc.name, ns: desc.rpc.ns, qualified: true, min: 1, max: 1,
          children: desc.parts.map(partNode), attributes: [] }];
      }
      return desc.parts.map(partNode);
    };
    const rows = (ns) => ns.flatMap((n) => flatten(n));

    entry.folder = path.dirname(this.rel(file)) || '.';
    entry.source = this.rel(file);
    entry.files = [...new Set([file, ...(entry.files || []), ...set.files])].map((f) => this.rel(f));
    entry.updatedAt = Math.max(...entry.files.map((f) => { try { return fs.statSync(path.join(this.dir, f)).mtimeMs; } catch { return 0; } }));
    entry.hash = `${entry.updatedAt}:${entry.files.length}`;
    entry.namespaces = [...set.namespaces].filter(Boolean);
    entry.types = [
      ...[...set.complexTypes.values()].map((d) => ({ name: d.name, ns: d.ns, kind: 'complexType' })),
      ...[...set.simpleTypes.values()].map((d) => ({ name: d.name, ns: d.ns, kind: 'simpleType' })),
    ];

    for (const op of entry.operations) {
      const req = nodes(op.input);
      const res = nodes(op.output);
      const hdr = op.input ? (op.input.headers || []).map((p) => (p.element ? tb.element(p.element) : tb.typed(p.name, '', false, p.type))) : [];
      const faults = op.faults.map((f) => ({ name: f.name, nodes: nodes(f.message) }));
      op.samples = { soap: {}, json: {} };
      for (const v of entry.soapVersions) {
        op.samples.soap[v] = {
          request: op.input ? soapEnvelope(set, { version: v, headers: hdr, body: req }) : null,
          response: op.output ? soapEnvelope(set, { version: v, body: res }) : null,
          faults: faults.map((f) => ({ name: f.name, xml: soapEnvelope(set, { version: v, fault: { name: f.name, detail: f.nodes } }) })),
        };
      }
      op.samples.json = {
        request: op.input ? jsonBody(req) : null,
        response: op.output ? jsonBody(res) : null,
        faults: faults.map((f) => ({ name: f.name, body: jsonBody(f.nodes) })),
      };
      op.fields = { request: rows(req), response: rows(res), headers: rows(hdr), faults: faults.map((f) => ({ name: f.name, rows: rows(f.nodes) })) };
      const rootName = (m) => (!m ? null : m.rpc ? m.rpc.name : m.parts[0] ? (m.parts[0].element || {}).local || m.parts[0].name : null);
      op.inputElement = rootName(op.input);
      op.outputElement = rootName(op.output);
    }

    const { doc, opPaths, elementNames } = buildOpenApi(entry, set);
    entry.openapi = doc;
    entry.schemaCount = Object.keys(doc.components.schemas).length;
    for (const op of entry.operations) {
      op.path = opPaths[op.name];
      op.openapi = fragment(doc, { path: op.path });
      op.openapiYaml = toYaml(op.openapi);
    }
    for (const el of entry.elements || []) {
      const tree = tb.element(el.qname);
      el.ns = el.qname.ns;
      el.doc = tree.doc || null;
      el.samples = { xml: xmlDocument(set, tree), json: jsonValue(tree) };
      el.fields = flatten(tree);
      el.component = elementNames[el.name];
      el.openapi = fragment(doc, { schemaName: el.component });
      el.openapiYaml = toYaml(el.openapi);
    }
  }

  buildIndex(entries) {
    const idx = [];
    for (const e of entries) {
      idx.push({ k: 'service', id: e.id, name: e.name, folder: e.folder, ns: e.targetNamespace || '', doc: e.doc || '' });
      for (const op of e.operations) {
        idx.push({ k: 'operation', id: e.id, svc: e.name, op: op.name, name: op.name, doc: op.doc || '', action: op.soapAction || '',
          in: op.inputElement || '', out: op.outputElement || '' });
        const addRows = (rows, dir) => rows.forEach((r) => {
          if (r.kind === 'choice') return;
          idx.push({ k: 'field', id: e.id, svc: e.name, op: op.name, dir, name: r.name.replace(/^@/, ''), path: r.path, type: r.type, occurs: r.occurs, doc: r.doc || '' });
        });
        addRows(op.fields.headers, 'header');
        addRows(op.fields.request, 'request');
        addRows(op.fields.response, 'response');
        op.fields.faults.forEach((f) => addRows(f.rows, `fault:${f.name}`));
      }
      for (const el of e.elements || []) {
        idx.push({ k: 'element', id: e.id, svc: e.name, el: el.name, name: el.name, doc: el.doc || '' });
        el.fields.forEach((r) => {
          if (r.kind === 'choice' || r.depth === 0) return;
          idx.push({ k: 'field', id: e.id, svc: e.name, el: el.name, dir: 'element', name: r.name.replace(/^@/, ''), path: r.path, type: r.type, occurs: r.occurs, doc: r.doc || '' });
        });
      }
      for (const t of e.types) idx.push({ k: 'type', id: e.id, svc: e.name, name: t.name, ns: t.ns, tkind: t.kind });
    }
    return idx;
  }

  summary(e) {
    return {
      id: e.id, name: e.name, kind: e.kind, wsdlVersion: e.wsdlVersion || null, folder: e.folder, source: e.source,
      targetNamespace: e.targetNamespace, soapVersions: e.soapVersions, doc: e.doc, updatedAt: e.updatedAt,
      operations: e.operations.map((o) => o.name), elements: (e.elements || []).map((x) => x.name),
      endpoints: e.endpoints,
    };
  }

  resolveFile(rel) {
    const p = path.resolve(this.dir, rel);
    if (!p.startsWith(this.dir + path.sep)) return null;
    return fs.existsSync(p) ? p : null;
  }
}

module.exports = { Catalogue };
