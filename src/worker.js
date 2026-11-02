// Compost: one Worker serving the app, a tiny API and a D1 database.
// Static files in ./public are served by Workers Static Assets before this
// code runs, so fetch() only sees requests that didn't match a file.
//
// The rules (slots, lifespan, extension, heap purge) are constants in
// src/rules.js. The routes live in one module per area, listed in ROUTES.
import { migrate, sweep } from './db.js';
import { json, safeEqual } from './http.js';
import { handleImg, withImgCookie } from './img.js';
import { routes as itemRoutes } from './items.js';
import { fetchPageInfo, fetchRawPage } from './page.js';
import { routes as readerRoutes } from './reader.js';
import { routes as reviewRoutes } from './review.js';
import { routes as highlightRoutes } from './highlights.js';
import { routes as pushRoutes, runScheduled } from './push.js';
import { routes as weeklyRoutes } from './weekly.js';

// The routing table. A route is [method, path, handler]; `:name` in the path
// becomes params.name. Every route needs the passcode and runs after the
// sweep. To add an area, export a `routes` list from its module and spread it
// here (Phase 4: ...readerRoutes).
const ROUTES = [
  ...itemRoutes,
  ...readerRoutes,
  ...reviewRoutes,
  ...highlightRoutes,
  ...pushRoutes,
  ...weeklyRoutes,
].map(([method, path, handler]) => ({ method, path, handler, match: compilePath(path) }));

export default {
  fetch(request, env) {
    return handle(request, env);
  },
  // Phase 8: the hourly Cron Trigger (wrangler.toml) for the daily reminder.
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, { now: event.scheduledTime }));
  },
};

// The whole request pipeline. `now`, `fetchPage` and `fetchRaw` can be injected, which
// is how the tests drive expiry without waiting a week.
export async function handle(request, env, { now = Date.now(), fetchPage = fetchPageInfo, fetchRaw = fetchRawPage, img = {} } = {}) {
  const url = new URL(request.url);
  // The image proxy isn't a file, so it reaches the Worker; it checks its
  // own cookie rather than the header (see src/img.js).
  if (url.pathname === '/img') return handleImg(request, env, img).catch(() => new Response('Not found', { status: 404 }));
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

  try {
    const res = await handleApi(request, env, url, now, fetchPage, fetchRaw);
    return res.status < 400 ? await withImgCookie(res, request, env.PASSCODE) : res;
  } catch (err) {
    console.error(err);
    return json({ error: 'server_error' }, 500);
  }
}

async function handleApi(request, env, url, now, fetchPage, fetchRaw) {
  if (!env.PASSCODE) return json({ error: 'passcode_not_set' }, 500);
  if (!safeEqual(request.headers.get('X-Passcode') || '', env.PASSCODE)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const matches = ROUTES.filter((r) => r.match(url.pathname));
  if (!matches.length) return json({ error: 'not_found' }, 404);
  const route = matches.find((r) => r.method === request.method);
  if (!route) return json({ error: 'method_not_allowed' }, 405);

  const db = env.DB;
  await migrate(db);
  await sweep(db, now);
  return route.handler({ request, env, url, db, now, fetchPage, fetchRaw }, route.match(url.pathname));
}

// '/api/items/:id/done' → a function returning { id } or null. `:id` only
// matches digits and arrives as a number.
function compilePath(path) {
  const names = [];
  const re = new RegExp(
    '^' + path.replace(/\/:(\w+)/g, (_, name) => { names.push(name); return name === 'id' ? '/(\\d+)' : '/([^/]+)'; }) + '$'
  );
  return (pathname) => {
    const m = pathname.match(re);
    if (!m) return null;
    const params = {};
    names.forEach((name, i) => { params[name] = name === 'id' ? Number(m[i + 1]) : decodeURIComponent(m[i + 1]); });
    return params;
  };
}
