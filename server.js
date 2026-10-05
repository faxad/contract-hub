'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const yaml = require('js-yaml');
const swaggerUiDist = require('swagger-ui-dist');
const { Catalogue } = require('./lib/catalogue');

const PORT = Number(process.env.PORT) || 8090;
const CATALOGUE_DIR = path.resolve(process.env.CATALOGUE_DIR || path.join(__dirname, 'catalogue'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 20;

const catalogue = new Catalogue(CATALOGUE_DIR).start();
const app = express();
app.disable('x-powered-by');
app.use(express.json());

const toYaml = (o) => yaml.dump(o, { noRefs: true, lineWidth: -1, quotingType: '"' });
const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });
const entryOr404 = (req, res) => catalogue.byId.get(req.params.id) || (notFound(res, 'Service'), null);

/* ------------------------------ API ------------------------------ */

app.get('/api/health', (req, res) => res.json({ ok: true, version: catalogue.version, builtAt: catalogue.builtAt }));

app.get('/api/catalogue', (req, res) => {
  res.json({
    version: catalogue.version,
    builtAt: catalogue.builtAt,
    directory: CATALOGUE_DIR,
    services: catalogue.entries.map((e) => catalogue.summary(e)),
    problems: catalogue.problems,
  });
});

app.get('/api/index', (req, res) => res.json({ version: catalogue.version, items: catalogue.index }));

/** Server-side search: ?q=text&kind=service|operation|field|type|element&service=id */
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  const kinds = req.query.kind ? String(req.query.kind).split(',') : null;
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  const items = catalogue.index.filter((i) => (!kinds || kinds.includes(i.k))
    && (!req.query.service || i.id === req.query.service)
    && (!q || [i.name, i.path, i.type, i.op, i.svc, i.doc, i.action].some((v) => v && String(v).toLowerCase().includes(q))));
  res.json({ total: items.length, items: items.slice(0, limit) });
});

app.get('/api/services/:id', (req, res) => {
  const e = entryOr404(req, res);
  if (!e) return;
  const { openapi, ...rest } = e;
  res.json(rest);
});

app.get('/api/services/:id/openapi.:fmt(json|yaml)', (req, res) => {
  const e = entryOr404(req, res);
  if (!e) return;
  if (req.query.download) res.attachment(`${e.id}.openapi.${req.params.fmt}`);
  if (req.params.fmt === 'yaml') res.type('application/yaml').send(toYaml(e.openapi));
  else res.json(e.openapi);
});

app.get('/api/services/:id/operations/:op/openapi.:fmt(json|yaml)', (req, res) => {
  const e = entryOr404(req, res);
  if (!e) return;
  const op = e.operations.find((o) => o.name === req.params.op);
  if (!op) return notFound(res, 'Operation');
  if (req.params.fmt === 'yaml') res.type('application/yaml').send(toYaml(op.openapi));
  else res.json(op.openapi);
});

/** Raw source files, restricted to the catalogue directory. */
app.get('/api/source', (req, res) => {
  const file = catalogue.resolveFile(String(req.query.path || ''));
  if (!file) return notFound(res, 'File');
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
});

/** Server-Sent Events: pushes a message whenever the catalogue is rebuilt. */
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ version: catalogue.version })}\n\n`);
  const onUpdate = (s) => res.write(`event: updated\ndata: ${JSON.stringify(s)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  catalogue.on('updated', onUpdate);
  req.on('close', () => { clearInterval(ping); catalogue.off('updated', onUpdate); });
});

/* Upload: drops files into the catalogue folder; the watcher does the rest. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 200 } });
const safeSegment = (s) => s.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_').trim();

app.post('/api/upload', upload.array('files'), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files received' });
  const relPaths = [].concat(req.body.paths || []);
  const firstSvc = files.find((f) => /\.wsdl$/i.test(f.originalname)) || files[0];
  const defaultFolder = safeSegment(String(req.body.folder || '').trim() || path.basename(firstSvc.originalname).replace(/\.[^.]+$/, ''));
  const written = [];
  const rejected = [];
  files.forEach((f, i) => {
    if (!/\.(wsdl|xsd|xml)$/i.test(f.originalname)) { rejected.push(f.originalname); return; }
    const rel = (relPaths[i] && relPaths[i].includes('/') ? relPaths[i] : `${defaultFolder}/${f.originalname}`)
      .split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..').map(safeSegment).filter(Boolean).join('/');
    const dest = path.resolve(CATALOGUE_DIR, rel);
    if (!dest.startsWith(CATALOGUE_DIR + path.sep)) { rejected.push(f.originalname); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.buffer);
    written.push(rel);
  });
  res.json({ written, rejected });
});

app.post('/api/rescan', (req, res) => res.json(catalogue.rebuild('manual rescan')));

/* ------------------------------ UI ------------------------------ */

app.use('/vendor/swagger-ui', express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false }));
app.get('/docs/:id', (req, res) => {
  const e = catalogue.byId.get(req.params.id);
  if (!e) return res.status(404).send('Service not found');
  const specUrl = `/api/services/${encodeURIComponent(e.id)}/openapi.json`;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e.name.replace(/</g, '&lt;')} · Swagger UI</title><link rel="stylesheet" href="/vendor/swagger-ui/swagger-ui.css">
<style>body{margin:0;background:#fff}.topbar{display:none}</style></head><body><div id="ui"></div>
<script>/* Swagger UI's built-in dark mode is incomplete; keep its light theme */
new MutationObserver(()=>document.documentElement.classList.remove('dark-mode')).observe(document.documentElement,{attributes:true,attributeFilter:['class']});</script>
<script src="/vendor/swagger-ui/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:${JSON.stringify(specUrl)},dom_id:'#ui',deepLinking:true,defaultModelsExpandDepth:1,tryItOutEnabled:false});</script>
</body></html>`);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Contract Hub running on http://localhost:${PORT}`);
  console.log(`Catalogue folder: ${CATALOGUE_DIR}`);
});
