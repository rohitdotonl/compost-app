// A small stand-in for the Worker's API, for trying the extension without a
// Cloudflare account. Keeps a rack in memory and answers like src/worker.js.
// By default it sends no CORS headers, so the extension must reach it through
// the host permission it asks for on the options page. CORS=1 adds them, the
// way the Worker will for the extension origin.
//
//   node extension/dev/mock-server.js          # http://localhost:8791, passcode "test"
//
// Dev-only controls: POST /dev/reset {rack: n, vault: [url], lookup: false, cors: true}
// and GET /page/:n serves a plain page to save.
const http = require('node:http');

const PORT = Number(process.env.PORT || 8791);
const PASSCODE = process.env.PASSCODE || 'test';
const LIMIT = 10;
const DAY = 24 * 60 * 60 * 1000;

const state = { rack: [], vault: [], intents: {}, notes: {}, lookup: true, cors: process.env.CORS === '1', nextId: 1 };

function reset({ rack = 0, vault = [], lookup = true, cors = state.cors } = {}) {
  state.rack = [];
  state.vault = vault.map((url) => ({ url, outcome: 'done' }));
  state.intents = {};
  state.notes = {};
  state.lookup = lookup;
  state.cors = cors;
  state.nextId = 1;
  for (let i = 1; i <= rack; i++) insert(`http://localhost:${PORT}/page/${i}`, `Page ${i}`);
}

function insert(url, title, note) {
  const now = Date.now();
  const item = {
    id: state.nextId++,
    url,
    title: title || url,
    site: new URL(url).hostname,
    minutes: 4,
    saved_at: now,
    expires_at: now + 7 * DAY,
    intent: null,
  };
  state.rack.push(item);
  if (note) state.notes[item.id] = note;
  return item;
}

function normalise(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(JSON.stringify(data));
}

function corsHeaders() {
  if (!state.cors) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passcode',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); } catch { resolve({}); }
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path.startsWith('/page/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><title>Page ${path.slice(6)}</title><h1>Page ${path.slice(6)}</h1><a href="/page/99">A link</a>`);
  }
  if (path === '/dev/reset' && req.method === 'POST') {
    reset(await readBody(req));
    return send(res, 200, { ok: true });
  }
  if (path === '/dev/state') return send(res, 200, state);
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>Compost (mock)</title><p>Mock Compost. The rack holds ' + state.rack.length + ' of ' + LIMIT + '.');
  }

  if (!path.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if ((req.headers['x-passcode'] || '') !== PASSCODE) return send(res, 401, { error: 'unauthorized' });

  if (path === '/api/items' && req.method === 'GET') {
    return send(res, 200, { now: Date.now(), rack: state.rack, vault: state.vault, heap: [] });
  }

  if (path === '/api/items' && req.method === 'POST') {
    const body = await readBody(req);
    const clean = normalise(body.url);
    if (!clean) return send(res, 400, { status: 'invalid_url' });
    if (state.vault.some((v) => v.url === clean)) return send(res, 200, { status: 'in_vault' });
    const existing = state.rack.find((i) => i.url === clean);
    if (existing) {
      if (body.note) state.notes[existing.id] = body.note;
      return send(res, 200, { status: 'in_rack' });
    }
    const dropId = body.dropId == null ? null : Number(body.dropId);
    if (state.rack.length >= LIMIT) {
      const idx = state.rack.findIndex((i) => i.id === dropId);
      if (idx < 0) return send(res, 409, { status: 'full', used: state.rack.length, limit: LIMIT, rack: state.rack });
      state.rack.splice(idx, 1);
    }
    const item = insert(clean, body.title, body.note);
    return send(res, 201, { status: 'saved', item, used: state.rack.length, limit: LIMIT });
  }

  const intent = path.match(/^\/api\/items\/(\d+)\/intent$/);
  if (intent && req.method === 'POST') {
    const body = await readBody(req);
    const item = state.rack.find((i) => i.id === Number(intent[1]));
    if (!item) return send(res, 404, { error: 'not_in_rack' });
    item.intent = body.intent ?? null;
    state.intents[item.id] = item.intent;
    return send(res, 200, { ok: true, intent: item.intent });
  }

  if (path === '/api/lookup' && req.method === 'GET') {
    if (!state.lookup) return send(res, 404, { error: 'not_found' });
    const clean = normalise(url.searchParams.get('url'));
    if (!clean) return send(res, 400, { status: 'invalid_url' });
    if (state.rack.some((i) => i.url === clean)) return send(res, 200, { status: 'in_rack' });
    if (state.vault.some((v) => v.url === clean)) return send(res, 200, { status: 'in_vault' });
    return send(res, 200, { status: 'new' });
  }

  return send(res, 404, { error: 'not_found' });
}

function start(port = PORT) {
  const server = http.createServer((req, res) => handle(req, res).catch((err) => send(res, 500, { error: String(err) })));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) {
  start().then(() => console.log(`Mock Compost at http://localhost:${PORT} (passcode "${PASSCODE}")`));
}

module.exports = { start, reset, state, PORT, PASSCODE };
