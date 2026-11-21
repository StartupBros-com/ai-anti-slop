// All logic for the AI Anti-Slop crowd list server.
// Written against the D1 API surface only: prepare().bind().all()/first()/run()
// and batch(). Nothing here reads the clock; every function takes `now` in ms.

export const RULES = Object.freeze({
  MIN_REPORTERS: 3,
  MIN_THREADS: 2,
  MIN_NETS: 2,
  AGE_DAYS: 7,
  ADD_WAIT_HOURS: 24,
  EXPIRY_DAYS: 90,
  NOT_SLOP_WEIGHT: 3,
  BATCH_MAX: 50,
  BODY_MAX: 32768,
  REPORTS_PER_INSTALL_DAY: 100,
  NEW_INSTALLS_PER_NET_DAY: 10,
  REMOVALS_PER_NET_DAY: 5,
});

const HOUR = 3600000;
const DAY = 86400000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const KEY_RE = /^[0-9a-f]{32}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_RE = /^\d{1,25}$/;
const HASH_RE = /^[0-9a-f]{16}$/;

// ---------- small helpers ----------

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const msToMidnight = (now) => (Math.floor(now / DAY) + 1) * DAY - now;
const hourFloor = (now) => now - (now % HOUR);

function toHex(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// IPv4 /24 as "a.b.c", IPv6 /48 as the first three hextets after expanding "::".
export function ipPrefix(ip) {
  if (!ip) return 'local';
  const s = String(ip).trim().toLowerCase().split('%')[0];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const p = v4.slice(1).map(Number);
    return p.some((n) => n > 255) ? 'unknown' : `${p[0]}.${p[1]}.${p[2]}`;
  }
  if (!s.includes(':')) return 'unknown';
  let t = s;
  const emb = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  if (emb) {
    const p = emb.slice(2).map(Number);
    if (p.some((n) => n > 255)) return 'unknown';
    t = emb[1] + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = t.split('::');
  if (halves.length > 2) return 'unknown';
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return 'unknown';
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return 'unknown';
  const g = groups.map((x) => parseInt(x, 16));
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}`;
  }
  return g.slice(0, 3).map((x) => x.toString(16)).join(':');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
};

function finish(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const fail = (status, reason, extra = {}) => json(status, { ok: false, reason, ...extra });

const html = (status, body, cache = 'no-store') =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache } });

async function readBody(request) {
  const cl = request.headers.get('content-length');
  if (cl && Number(cl) > RULES.BODY_MAX) return { tooBig: true };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RULES.BODY_MAX) {
      await reader.cancel();
      return { tooBig: true };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { text: dec.decode(all) };
}

function parseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function counterValue(db, kind, subject, day) {
  const row = await db.prepare('SELECT n FROM counters WHERE kind = ? AND subject = ? AND day = ?').bind(kind, subject, day).first();
  return row ? Number(row.n) : 0;
}

const bumpSql = 'INSERT INTO counters (kind, subject, day, n) VALUES (?, ?, ?, ?) ON CONFLICT(kind, subject, day) DO UPDATE SET n = n + excluded.n';

// ---------- build ----------

// Rebuild the published list inside one batch. All counting happens in SQL.
export async function build(db, env, now) {
  const addCut = now - RULES.ADD_WAIT_HOURS * HOUR;
  const expCut = now - RULES.EXPIRY_DAYS * DAY;
  const ageCut = now - RULES.AGE_DAYS * DAY;
  const dayCut = dayOf(now - 3 * DAY);

  const stmts = [
    db.prepare('DELETE FROM reports WHERE at < ?').bind(expCut),
    db.prepare('DELETE FROM counters WHERE day < ?').bind(dayCut),
    db.prepare('DELETE FROM next_listed'),
    // The rule. Slop reports count once aged installs have waited out ADD_WAIT_HOURS;
    // Not slop reports from aged installs count at once.
    db
      .prepare(
        `INSERT INTO next_listed (handle, reporters, since)
         SELECT g.handle, g.slop, COALESCE((SELECT l.since FROM listed l WHERE l.handle = g.handle), ?)
         FROM (
           SELECT handle,
             COUNT(DISTINCT CASE WHEN label = 'slop' AND at <= ? THEN reporter END) AS slop,
             COUNT(DISTINCT CASE WHEN label = 'slop' AND at <= ? THEN COALESCE(thread, status) END) AS threads,
             COUNT(DISTINCT CASE WHEN label = 'slop' AND at <= ? THEN net END) AS nets,
             COUNT(DISTINCT CASE WHEN label = 'not_slop' THEN reporter END) AS notslop
           FROM reports
           WHERE at >= ? AND reporter IN (SELECT id FROM reporters WHERE first_seen <= ?)
           GROUP BY handle
         ) g
         WHERE g.slop >= ${RULES.MIN_REPORTERS} AND g.threads >= ${RULES.MIN_THREADS} AND g.nets >= ${RULES.MIN_NETS}
           AND g.slop >= ${RULES.NOT_SLOP_WEIGHT} * g.notslop
           AND g.handle NOT IN (SELECT handle FROM overrides WHERE action = 'delist')`,
      )
      .bind(now, addCut, addCut, addCut, expCut, ageCut),
    // Admin "list" overrides always add.
    db
      .prepare(
        `INSERT OR IGNORE INTO next_listed (handle, reporters, since)
         SELECT o.handle,
           (SELECT COUNT(DISTINCT r.reporter) FROM reports r WHERE r.handle = o.handle AND r.label = 'slop' AND r.at >= ?),
           COALESCE((SELECT l.since FROM listed l WHERE l.handle = o.handle), ?)
         FROM overrides o WHERE o.action = 'list'`,
      )
      .bind(expCut, now),
    db
      .prepare(
        `INSERT INTO changes (at, count, added, removed)
         SELECT ?,
           (SELECT COUNT(*) FROM next_listed),
           (SELECT json_group_array(handle) FROM (SELECT handle FROM next_listed WHERE handle NOT IN (SELECT handle FROM listed) ORDER BY handle)),
           (SELECT json_group_array(handle) FROM (SELECT handle FROM listed WHERE handle NOT IN (SELECT handle FROM next_listed) ORDER BY handle))
         WHERE EXISTS (SELECT 1 FROM next_listed WHERE handle NOT IN (SELECT handle FROM listed))
            OR EXISTS (SELECT 1 FROM listed WHERE handle NOT IN (SELECT handle FROM next_listed))`,
      )
      .bind(now),
    db.prepare('DELETE FROM listed'),
    db.prepare('INSERT INTO listed (handle, reporters, since) SELECT handle, reporters, since FROM next_listed'),
    db.prepare('DELETE FROM next_listed'),
    db.prepare(
      `INSERT OR REPLACE INTO meta (k, v)
       SELECT 'body', COALESCE(group_concat(line, char(10)) || char(10), '')
       FROM (SELECT json_object('username', handle, 'reporters', reporters, 'since', strftime('%Y-%m-%d', since / 1000, 'unixepoch')) AS line
             FROM listed ORDER BY handle)`,
    ),
    db.prepare(
      `INSERT OR REPLACE INTO meta (k, v)
       SELECT 'stats', json_object('listed', (SELECT COUNT(*) FROM listed), 'reports', (SELECT COUNT(*) FROM reports), 'reporters', (SELECT COUNT(*) FROM reporters))`,
    ),
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('builtAt', ?)").bind(String(now)),
  ];
  await db.batch(stmts);
  const row = await db.prepare("SELECT v FROM meta WHERE k = 'stats'").first();
  return row ? JSON.parse(row.v) : null;
}

// ---------- public endpoints ----------

async function getMeta(db, keys) {
  const marks = keys.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT k, v FROM meta WHERE k IN (${marks})`).bind(...keys).all();
  const out = {};
  for (const r of results) out[r.k] = r.v;
  return out;
}

function listCacheKey(url) {
  return new Request(new URL('/v1/list.ndjson', url).toString(), { method: 'GET' });
}

function getCache() {
  return typeof caches !== 'undefined' && caches && caches.default ? caches.default : null;
}

async function getList(db, request, ctx) {
  const cache = getCache();
  const key = listCacheKey(request.url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const m = await getMeta(db, ['body', 'builtAt']);
  const headers = {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'public, max-age=600',
  };
  if (m.builtAt) headers.etag = `"${m.builtAt}"`;
  if (m.builtAt && request.headers.get('if-none-match') === headers.etag) {
    return new Response(null, { status: 304, headers });
  }
  const res = finish(new Response(m.body || '', { status: 200, headers }));
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function getChanges(db, url) {
  let limit = parseInt(url.searchParams.get('limit') ?? '', 10);
  if (!Number.isFinite(limit)) limit = 20;
  limit = Math.min(100, Math.max(1, limit));
  const { results } = await db.prepare('SELECT at, count, added, removed FROM changes ORDER BY id DESC LIMIT ?').bind(limit).all();
  const rows = results.map((r) => ({ at: Number(r.at), count: Number(r.count), added: JSON.parse(r.added), removed: JSON.parse(r.removed) }));
  return json(200, rows, { 'cache-control': 'public, max-age=300' });
}

async function getStatus(db) {
  const m = await getMeta(db, ['stats', 'builtAt']);
  let stats = m.stats ? JSON.parse(m.stats) : null;
  if (!stats) {
    // Before the first build the tables are tiny, so a live count is cheap.
    const r = await db.prepare('SELECT (SELECT COUNT(*) FROM reports) AS reports, (SELECT COUNT(*) FROM reporters) AS reporters').first();
    stats = { listed: 0, reports: Number(r.reports), reporters: Number(r.reporters) };
  }
  return json(200, { ok: true, listed: stats.listed, reports: stats.reports, reporters: stats.reporters, builtAt: m.builtAt ? Number(m.builtAt) : null }, { 'cache-control': 'public, max-age=60' });
}

function homePage() {
  const R = RULES;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Anti-Slop crowd list</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#555;--line:#ccc;--acc:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#aaa;--line:#444;--acc:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:2rem}
a{color:var(--acc)}code{background:rgba(127,127,127,.15);padding:0 .25em;border-radius:3px}
label{display:block;margin:.8rem 0 .2rem}input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:.4rem;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px}
button{font:inherit;margin-top:1rem;padding:.4rem 1rem}
.mut{color:var(--mut)}
</style></head>
<body><main id="home">
<h1>AI Anti-Slop crowd list</h1>
<p>This is a list of X accounts that readers using the AI Anti-Slop browser extension have flagged as posting slop replies. Installs that opt in send a report for each post they label Slop (labels saved as Not slop by versions before 0.9.0 are sent too). The extension can use this list as one source for its Recommended list.</p>
<p class="mut">An entry means that several readers reported the account. It is not proof of anything about the account.</p>
<h2>When an account is listed</h2>
<p>An account is listed when all of these hold:</p>
<ul>
<li>At least ${R.MIN_REPORTERS} different installs reported it as Slop.</li>
<li>Those reports are about at least ${R.MIN_THREADS} different threads and come from at least ${R.MIN_NETS} different networks.</li>
<li>Each install is at least ${R.AGE_DAYS} days old, and each Slop report is at least ${R.ADD_WAIT_HOURS} hours old.</li>
<li>The Slop reporters are at least ${R.NOT_SLOP_WEIGHT} times as many as the installs that reported the account as Not slop.</li>
</ul>
<p>Reports older than ${R.EXPIRY_DAYS} days are deleted, so an account drops off when readers stop reporting it. The list is rebuilt every three hours.</p>
<h2>Data</h2>
<ul>
<li><a href="/v1/list.ndjson">/v1/list.ndjson</a>: the current list, one JSON object per line.</li>
<li><a href="/v1/changes">/v1/changes</a>: recent builds that added or removed accounts.</li>
</ul>
<h2>Ask for a removal</h2>
<p>If your account is listed and you think that is wrong, send a request. Requests are reviewed by hand. Sending one does not remove the account by itself.</p>
<form method="post" action="/v1/removal">
<label for="handle">X handle</label>
<input id="handle" name="handle" required maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" autocomplete="off">
<label for="reason">Reason (optional, up to 1,000 characters)</label>
<textarea id="reason" name="reason" rows="4" maxlength="1000"></textarea>
<label for="contact">Contact (optional, up to 200 characters)</label>
<input id="contact" name="contact" maxlength="200" autocomplete="off">
<button type="submit">Send request</button>
</form>
</main></body></html>`;
}

function thanksPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Request received</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}</style></head>
<body><h1>Request received</h1>
<p>Removal requests are reviewed by hand. The account stays listed until a reviewer acts on the request.</p>
<p><a href="/">Back</a></p></body></html>`;
}

// ---------- write endpoints ----------

async function identity(env, request, key) {
  const prefix = ipPrefix(request.headers.get('CF-Connecting-IP'));
  const net = (await hmacHex(env.HMAC_SECRET, 'n:' + prefix)).slice(0, 16);
  const reporter = key ? (await hmacHex(env.HMAC_SECRET, 'r:' + key)).slice(0, 32) : null;
  return { net, reporter };
}

function checkKey(body) {
  return body && typeof body.key === 'string' && KEY_RE.test(body.key);
}

async function postReports(db, env, request, body, now) {
  if (body.v !== 1) return fail(400, 'unsupported version');
  if (!checkKey(body)) return fail(400, 'bad key');
  if (!Array.isArray(body.reports) || body.reports.length < 1 || body.reports.length > RULES.BATCH_MAX) {
    return fail(400, `reports must hold 1 to ${RULES.BATCH_MAX} items`);
  }
  const rejected = [];
  const valid = [];
  body.reports.forEach((it, i) => {
    const ok =
      it && typeof it === 'object' &&
      (it.label === 'slop' || it.label === 'not_slop') &&
      typeof it.handle === 'string' && HANDLE_RE.test(it.handle) &&
      typeof it.status === 'string' && ID_RE.test(it.status) &&
      (it.thread == null || (typeof it.thread === 'string' && ID_RE.test(it.thread))) &&
      (it.hash == null || (typeof it.hash === 'string' && HASH_RE.test(it.hash)));
    if (ok) {
      valid.push({ label: it.label, handle: it.handle.toLowerCase(), status: it.status, thread: it.thread ?? null, hash: it.hash ?? null });
    } else {
      rejected.push(it && typeof it.status === 'string' && ID_RE.test(it.status) ? it.status : `#${i}`);
    }
  });
  if (valid.length === 0) return json(200, { ok: true, accepted: [], rejected, deferred: [] });

  const { net, reporter } = await identity(env, request, body.key);
  const day = dayOf(now);
  const stmts = [];
  const known = await db.prepare('SELECT 1 AS x FROM reporters WHERE id = ?').bind(reporter).first();
  if (!known) {
    const n = await counterValue(db, 'new_install', net, day);
    if (n >= RULES.NEW_INSTALLS_PER_NET_DAY) {
      const retryAfter = msToMidnight(now);
      return fail(429, 'too many new installs from this network today', { retryAfter });
    }
    stmts.push(db.prepare('INSERT OR IGNORE INTO reporters (id, first_seen) VALUES (?, ?)').bind(reporter, hourFloor(now)));
    stmts.push(db.prepare(bumpSql).bind('new_install', net, day, 1));
  }
  const used = known ? await counterValue(db, 'report', reporter, day) : 0;
  const room = Math.max(0, RULES.REPORTS_PER_INSTALL_DAY - used);
  const accepted = valid.slice(0, room);
  const deferred = valid.slice(room);
  const at = hourFloor(now);
  for (const r of accepted) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reports (reporter, status, handle, thread, hash, label, net, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(reporter, status) DO UPDATE SET label = excluded.label, handle = excluded.handle, thread = excluded.thread,
             hash = excluded.hash, net = excluded.net, at = excluded.at`,
        )
        .bind(reporter, r.status, r.handle, r.thread, r.hash, r.label, net, at),
    );
  }
  if (accepted.length) stmts.push(db.prepare(bumpSql).bind('report', reporter, day, accepted.length));
  if (stmts.length) await db.batch(stmts);
  const out = { ok: true, accepted: accepted.map((r) => r.status), rejected, deferred: deferred.map((r) => r.status) };
  if (deferred.length) out.retryAfter = msToMidnight(now);
  return json(200, out);
}

async function postRetract(db, env, request, body) {
  if (body.v !== 1) return fail(400, 'unsupported version');
  if (!checkKey(body)) return fail(400, 'bad key');
  if (!Array.isArray(body.statuses) || body.statuses.length < 1 || body.statuses.length > RULES.BATCH_MAX) {
    return fail(400, `statuses must hold 1 to ${RULES.BATCH_MAX} items`);
  }
  const statuses = body.statuses.filter((s) => typeof s === 'string' && ID_RE.test(s));
  if (!statuses.length) return json(200, { ok: true, removed: 0 });
  const { reporter } = await identity(env, request, body.key);
  const marks = statuses.map(() => '?').join(', ');
  const r = await db.prepare(`DELETE FROM reports WHERE reporter = ? AND status IN (${marks})`).bind(reporter, ...statuses).run();
  return json(200, { ok: true, removed: Number(r.meta.changes) });
}

async function postForget(db, env, request, body) {
  if (body.v !== 1) return fail(400, 'unsupported version');
  if (!checkKey(body)) return fail(400, 'bad key');
  const { reporter } = await identity(env, request, body.key);
  const res = await db.batch([
    db.prepare('DELETE FROM reports WHERE reporter = ?').bind(reporter),
    db.prepare('DELETE FROM reporters WHERE id = ?').bind(reporter),
    db.prepare("DELETE FROM counters WHERE kind = 'report' AND subject = ?").bind(reporter),
  ]);
  return json(200, { ok: true, removed: Number(res[0].meta.changes) });
}

async function postRemoval(db, env, request, raw, now) {
  const form = (request.headers.get('content-type') || '').toLowerCase().includes('application/x-www-form-urlencoded');
  let data;
  if (form) {
    const p = new URLSearchParams(raw);
    data = { handle: p.get('handle'), reason: p.get('reason'), contact: p.get('contact') };
  } else {
    data = parseJson(raw);
    if (!data) return fail(400, 'bad body');
  }
  const handle = typeof data.handle === 'string' ? data.handle.trim().replace(/^@/, '') : '';
  if (!HANDLE_RE.test(handle)) return fail(400, 'bad handle');
  const opt = (v, max) => (v == null || v === '' ? null : typeof v === 'string' && v.length <= max ? v : false);
  const reason = opt(data.reason, 1000);
  const contact = opt(data.contact, 200);
  if (reason === false) return fail(400, 'reason too long');
  if (contact === false) return fail(400, 'contact too long');

  const { net } = await identity(env, request, null);
  const day = dayOf(now);
  if ((await counterValue(db, 'removal', net, day)) >= RULES.REMOVALS_PER_NET_DAY) {
    return fail(429, 'too many removal requests from this network today', { retryAfter: msToMidnight(now) });
  }
  const res = await db.batch([
    db.prepare('INSERT INTO removals (handle, reason, contact, net, at) VALUES (?, ?, ?, ?, ?)').bind(handle.toLowerCase(), reason, contact, net, hourFloor(now)),
    db.prepare(bumpSql).bind('removal', net, day, 1),
  ]);
  if (form) return html(200, thanksPage());
  return json(200, { ok: true, id: Number(res[0].meta.last_row_id) });
}

// ---------- admin ----------

async function adminCandidates(db, url, now) {
  let limit = parseInt(url.searchParams.get('limit') ?? '', 10);
  if (!Number.isFinite(limit)) limit = 50;
  limit = Math.min(500, Math.max(1, limit));
  const addCut = now - RULES.ADD_WAIT_HOURS * HOUR;
  const expCut = now - RULES.EXPIRY_DAYS * DAY;
  const ageCut = now - RULES.AGE_DAYS * DAY;
  const { results } = await db
    .prepare(
      `SELECT r.handle AS handle,
         COUNT(DISTINCT CASE WHEN r.label = 'slop' AND r.at <= ? AND r.reporter IN (SELECT id FROM reporters WHERE first_seen <= ?) THEN r.reporter END) AS slop_reporters,
         COUNT(DISTINCT CASE WHEN r.label = 'slop' THEN r.reporter END) AS slop_reporters_all,
         COUNT(DISTINCT CASE WHEN r.label = 'not_slop' AND r.reporter IN (SELECT id FROM reporters WHERE first_seen <= ?) THEN r.reporter END) AS not_slop_reporters,
         COUNT(DISTINCT CASE WHEN r.label = 'slop' THEN COALESCE(r.thread, r.status) END) AS threads,
         COUNT(DISTINCT CASE WHEN r.label = 'slop' THEN r.net END) AS nets,
         MAX(CASE WHEN r.label = 'slop' THEN r.at END) AS newest,
         EXISTS (SELECT 1 FROM listed l WHERE l.handle = r.handle) AS listed,
         (SELECT o.action FROM overrides o WHERE o.handle = r.handle) AS override
       FROM reports r
       WHERE r.at >= ?
       GROUP BY r.handle
       HAVING slop_reporters_all > 0
       ORDER BY slop_reporters DESC, slop_reporters_all DESC, r.handle
       LIMIT ?`,
    )
    .bind(addCut, ageCut, ageCut, expCut, limit)
    .all();
  return json(200, {
    ok: true,
    candidates: results.map((r) => ({
      handle: r.handle,
      slop_reporters: Number(r.slop_reporters),
      slop_reporters_all: Number(r.slop_reporters_all),
      not_slop_reporters: Number(r.not_slop_reporters),
      threads: Number(r.threads),
      nets: Number(r.nets),
      newest: r.newest == null ? null : Number(r.newest),
      listed: !!Number(r.listed),
      override: r.override ?? null,
    })),
  });
}

async function adminRoute(db, env, request, url, path, now) {
  const m = request.method;
  if (path === '/v1/admin/removals' && m === 'GET') {
    const status = url.searchParams.get('status') || 'open';
    if (!['open', 'done', 'rejected'].includes(status)) return fail(400, 'bad status');
    const { results } = await db.prepare('SELECT id, handle, reason, contact, at, status, note FROM removals WHERE status = ? ORDER BY id LIMIT 500').bind(status).all();
    return json(200, { ok: true, removals: results });
  }
  if (path === '/v1/admin/candidates' && m === 'GET') return adminCandidates(db, url, now);
  if (m !== 'POST') return null;
  if (path === '/v1/admin/rebuild') {
    const stats = await build(db, env, now);
    return json(200, { ok: true, ...stats });
  }
  if (path === '/v1/admin/removal' || path === '/v1/admin/override') {
    const { text, tooBig } = await readBody(request);
    if (tooBig) return fail(413, 'body too large');
    const b = parseJson(text);
    if (!b) return fail(400, 'bad body');
    const note = typeof b.note === 'string' ? b.note.slice(0, 1000) : null;
    if (path === '/v1/admin/removal') {
      if (!Number.isInteger(b.id) || !['done', 'rejected'].includes(b.status)) return fail(400, 'bad id or status');
      const r = await db.prepare('UPDATE removals SET status = ?, note = ? WHERE id = ?').bind(b.status, note, b.id).run();
      return Number(r.meta.changes) ? json(200, { ok: true }) : fail(404, 'no such removal');
    }
    const handle = typeof b.handle === 'string' ? b.handle.trim().replace(/^@/, '').toLowerCase() : '';
    if (!HANDLE_RE.test(handle)) return fail(400, 'bad handle');
    if (b.action === 'clear') {
      await db.prepare('DELETE FROM overrides WHERE handle = ?').bind(handle).run();
    } else if (b.action === 'delist' || b.action === 'list') {
      await db
        .prepare('INSERT INTO overrides (handle, action, note, at) VALUES (?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET action = excluded.action, note = excluded.note, at = excluded.at')
        .bind(handle, b.action, note, now)
        .run();
    } else {
      return fail(400, 'bad action');
    }
    const stats = await build(db, env, now);
    const cache = getCache();
    if (cache) await cache.delete(listCacheKey(request.url));
    return json(200, { ok: true, ...stats });
  }
  return null;
}

// ---------- router ----------

export async function handle(request, env, now, ctx) {
  try {
    return finish(await route(request, env, now, ctx));
  } catch (err) {
    // Never log bodies or parameters; the error name is enough to find the fault.
    console.error('request failed', err && err.name);
    return finish(fail(500, 'internal error'));
  }
}

async function route(request, env, now, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const m = request.method;
  const db = env.DB;

  if (m === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (path.startsWith('/v1/admin/')) {
    if (!env.ADMIN_TOKEN) return fail(404, 'not found');
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!(await safeEqual(token, env.ADMIN_TOKEN))) return fail(401, 'unauthorized');
    return (await adminRoute(db, env, request, url, path, now)) || fail(404, 'not found');
  }

  const writes = { '/v1/reports': postReports, '/v1/retract': postRetract, '/v1/forget': postForget, '/v1/removal': postRemoval };
  if (writes[path]) {
    if (m !== 'POST') return fail(405, 'method not allowed');
    if (!env.HMAC_SECRET) return fail(503, 'not configured');
    const { text, tooBig } = await readBody(request);
    if (tooBig) return fail(413, 'body too large');
    if (path === '/v1/removal') return postRemoval(db, env, request, text, now);
    const body = parseJson(text);
    if (!body) return fail(400, 'bad body');
    return writes[path](db, env, request, body, now);
  }

  if (m === 'GET') {
    if (path === '/v1/list.ndjson') return getList(db, request, ctx);
    if (path === '/v1/changes') return getChanges(db, url);
    if (path === '/v1/status') return getStatus(db);
    if (path === '/') return html(200, homePage(), 'public, max-age=600');
  }
  return fail(404, 'not found');
}
