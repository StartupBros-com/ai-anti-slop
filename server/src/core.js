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
  REPORTS_PER_DAY: 6000,
  NEW_INSTALLS_PER_NET_DAY: 10,
  REMOVALS_PER_NET_DAY: 5,
  REMOVALS_PER_DAY: 50,
});

const HOUR = 3600000;
const DAY = 86400000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const KEY_RE = /^[0-9a-f]{32}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_RE = /^\d{1,25}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------- small helpers ----------

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const msToMidnight = (now) => (Math.floor(now / DAY) + 1) * DAY - now;
const hourFloor = (now) => now - (now % HOUR);

// The start of a UTC day written YYYY-MM-DD, in ms, or null when it is not a real day.
function dayStart(s) {
  const m = DAY_RE.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayOf(t) === s ? t : null;
}

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

// Rate limits bump first and decide from the returned value, so parallel requests
// cannot all read the same old count. Whatever was bumped but not accepted is
// subtracted back with unbump; counters end exact, and while requests overlap
// they err toward deferring.
async function bump(db, kind, subject, day, by) {
  const row = await db
    .prepare('INSERT INTO counters (kind, subject, day, n) VALUES (?, ?, ?, ?) ON CONFLICT(kind, subject, day) DO UPDATE SET n = n + excluded.n RETURNING n')
    .bind(kind, subject, day, by)
    .first();
  return Number(row.n);
}

const unbump = (db, kind, subject, day, by) =>
  db.prepare('UPDATE counters SET n = n - ? WHERE kind = ? AND subject = ? AND day = ?').bind(by, kind, subject, day);

// ---------- build ----------

// SQL with its binds. Interpolated values become ? placeholders in order; a
// fragment made by sql`` or lit() is spliced in with its own binds, so shared
// conditions keep their placeholders in step wherever they are used.
function sql(strings, ...vals) {
  let text = strings[0];
  const binds = [];
  vals.forEach((v, i) => {
    if (v && typeof v === 'object' && typeof v.text === 'string') {
      text += v.text;
      binds.push(...v.binds);
    } else {
      text += '?';
      binds.push(v);
    }
    text += strings[i + 1];
  });
  return { text, binds };
}
const lit = (v) => ({ text: String(v), binds: [] });
const prep = (db, q) => db.prepare(q.text).bind(...q.binds);

const cuts = (now) => ({
  addCut: now - RULES.ADD_WAIT_HOURS * HOUR,
  expCut: now - RULES.EXPIRY_DAYS * DAY,
  ageCut: now - RULES.AGE_DAYS * DAY,
});

// A report row is one install's verdict on one account (see postReports). It
// counts toward the list when the day it was labelled is inside the window,
// its side has stood ADD_WAIT_HOURS since it last changed, and its install is
// AGE_DAYS old.
const inWindow = (c) => sql`r.labeled >= ${c.expCut}`;
const stood = (c) => sql`r.at <= ${c.addCut} AND r.reporter IN (SELECT id FROM reporters WHERE first_seen <= ${c.ageCut})`;
// While a removal request for the account stands, a Slop verdict counts only
// when it was labelled on a UTC day after the request's.
const slopSide = (c) =>
  sql`r.label = 'slop' AND r.labeled >= COALESCE((SELECT (q.at / ${lit(DAY)} + 1) * ${lit(DAY)} FROM removals q WHERE q.handle = r.handle AND q.at >= ${c.expCut}), 0)`;

// Rebuild the published list inside one batch. All counting happens in SQL.
export async function build(db, env, now) {
  const c = cuts(now);
  const { expCut } = c;
  const dayCut = dayOf(now - 3 * DAY);
  const slop = slopSide(c);

  const stmts = [
    db.prepare('DELETE FROM reports WHERE labeled < ?').bind(expCut),
    // Retention: installs with nothing left to show, and removal requests past their 90 days.
    db
      .prepare('DELETE FROM reporters WHERE first_seen < ? AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.reporter = reporters.id)')
      .bind(expCut),
    db.prepare('DELETE FROM removals WHERE at < ?').bind(expCut),
    db.prepare('DELETE FROM counters WHERE day < ?').bind(dayCut),
    db.prepare('DELETE FROM next_listed'),
    // The rule. Each install counts at most once per account, on one side.
    prep(
      db,
      sql`INSERT INTO next_listed (handle, reporters, since)
         SELECT g.handle, g.slop, COALESCE((SELECT l.since FROM listed l WHERE l.handle = g.handle), ${now})
         FROM (
           SELECT r.handle AS handle,
             COUNT(CASE WHEN ${slop} THEN 1 END) AS slop,
             COUNT(DISTINCT CASE WHEN ${slop} THEN COALESCE(r.thread, r.status) END) AS threads,
             COUNT(DISTINCT CASE WHEN ${slop} THEN r.net END) AS nets,
             COUNT(CASE WHEN r.label = 'not_slop' THEN 1 END) AS notslop
           -- reports_handle gives the rows in handle order, so GROUP BY needs no sort.
           FROM reports r INDEXED BY reports_handle
           WHERE ${inWindow(c)} AND ${stood(c)}
           GROUP BY r.handle
         ) g
         WHERE g.slop >= ${lit(RULES.MIN_REPORTERS)} AND g.threads >= ${lit(RULES.MIN_THREADS)} AND g.nets >= ${lit(RULES.MIN_NETS)}
           AND g.slop >= ${lit(RULES.NOT_SLOP_WEIGHT)} * g.notslop
           AND g.handle NOT IN (SELECT handle FROM overrides WHERE action = 'delist')`,
    ),
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
    // Diff-only: write just the rows that changed. An existing row keeps its since
    // (next_listed took it from listed), so only reporters can differ.
    db.prepare('DELETE FROM listed WHERE handle NOT IN (SELECT handle FROM next_listed)'),
    db.prepare(
      `UPDATE listed SET reporters = (SELECT n.reporters FROM next_listed n WHERE n.handle = listed.handle)
       WHERE reporters <> (SELECT n.reporters FROM next_listed n WHERE n.handle = listed.handle)`,
    ),
    db.prepare('INSERT INTO listed (handle, reporters, since) SELECT handle, reporters, since FROM next_listed WHERE handle NOT IN (SELECT handle FROM listed)'),
    db.prepare('DELETE FROM next_listed'),
    db.prepare(
      `INSERT OR REPLACE INTO meta (k, v)
       SELECT 'body', COALESCE(group_concat(line, char(10)) || char(10), '')
       FROM (SELECT json_object('username', handle, 'reporters', reporters, 'since', strftime('%Y-%m-%d', since / 1000, 'unixepoch')) AS line
             FROM listed ORDER BY handle)`,
    ),
    db.prepare(
      `INSERT OR REPLACE INTO meta (k, v)
       SELECT 'stats', json_object('listed', (SELECT COUNT(*) FROM listed), 'reporters', (SELECT COUNT(*) FROM reporters))`,
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
  if (!m.builtAt) {
    // Before the first build the empty list is a placeholder: never cache it.
    return finish(new Response('', { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } }));
  }
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
    const r = await db.prepare('SELECT COUNT(*) AS reporters FROM reporters').first();
    stats = { listed: 0, reporters: Number(r.reporters) };
  }
  return json(200, { ok: true, listed: stats.listed, reporters: stats.reporters, builtAt: m.builtAt ? Number(m.builtAt) : null }, { 'cache-control': 'public, max-age=60' });
}

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#555;--line:#ccc;--acc:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#aaa;--line:#444;--acc:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:2rem}
a{color:var(--acc)}code{background:rgba(127,127,127,.15);padding:0 .25em;border-radius:3px}
label{display:block;margin:.8rem 0 .2rem}input{width:100%;box-sizing:border-box;font:inherit;padding:.4rem;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px}
button{font:inherit;margin-top:1rem;padding:.4rem 1rem}
.mut{color:var(--mut)}`;

const page = (title, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${PAGE_STYLE}
</style></head>
<body><main>
${inner}
</main></body></html>`;

function homePage() {
  const R = RULES;
  return page(
    'AI Anti-Slop crowd list',
    `<h1>AI Anti-Slop crowd list</h1>
<p>This is a list of X accounts that readers using the <a href="https://github.com/StartupBros-com/ai-anti-slop">AI Anti-Slop browser extension</a> have flagged as posting slop replies. Installs that opt in send a report for each post they label Slop or Not slop. The extension can use this list as one source for its Recommended list.</p>
<p class="mut">An entry means that several readers reported the account. It is not proof of anything about the account.</p>
<h2>When an account is listed</h2>
<p>Each install counts once per account, on one side: its newest label on any of the account's posts decides whether it says Slop or Not slop. A label counts from the day the reader made it. An account is listed when all of these hold:</p>
<ul>
<li>At least ${R.MIN_REPORTERS} different installs say Slop.</li>
<li>Their labels are about at least ${R.MIN_THREADS} different threads and came from at least ${R.MIN_NETS} different networks.</li>
<li>Each install is at least ${R.AGE_DAYS} days old, and each install's side, Slop or Not slop, has stood for at least ${R.ADD_WAIT_HOURS} hours.</li>
<li>The installs saying Slop are at least ${R.NOT_SLOP_WEIGHT} times as many as those saying Not slop.</li>
</ul>
<p>Labels made more than ${R.EXPIRY_DAYS} days ago are deleted, so an account drops off when readers stop reporting it. The list is rebuilt every six hours.</p>
<h2>Data</h2>
<ul>
<li><a href="/v1/list.ndjson">/v1/list.ndjson</a>: the current list, one JSON object per line.</li>
<li><a href="/v1/changes">/v1/changes</a>: recent builds that added or removed accounts.</li>
</ul>
<h2>Ask for a removal</h2>
<p>If your account is listed and you think that is wrong, send its handle. Nobody needs to read the request: the account comes off the list at the next rebuild, within six hours, and goes back on only if enough readers label its posts Slop on later days. One request per account counts in any ${R.EXPIRY_DAYS} days, and only for an account that is listed.</p>
<form method="post" action="/v1/removal">
<label for="handle">X handle</label>
<input id="handle" name="handle" required maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" autocomplete="off">
<button type="submit">Send request</button>
</form>
<p class="mut">AI Anti-Slop and this server are open source. Their code, and the place to report a problem with either, are on <a href="https://github.com/StartupBros-com/ai-anti-slop">GitHub</a>.</p>`,
  );
}

// What a removal request did, as a page for the form and as fields for JSON.
function removalPage(handle, result) {
  const h = esc('@' + handle);
  const body = {
    taken: `<h1>Request received</h1>
<p>${h} comes off the list at the next rebuild, within six hours. From tomorrow (UTC) on, it goes back on only if enough readers label its posts Slop again.</p>`,
    standing: `<h1>Already requested</h1>
<p>A request for ${h} was made on ${esc(result.since)} and still stands, so this one changes nothing. Only labels made after that day count for the account.</p>`,
    unlisted: `<h1>Not listed</h1>
<p>${h} is not on the list, so there is nothing to remove. A request can be made once an account is listed.</p>`,
  }[result.state];
  return page('Removal request', `${body}\n<p><a href="/">Back</a></p>`);
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

// One row per install and account: its verdict. A label on the other side
// takes the row over only when it was made on the same day or later (a tie
// goes to Not slop); the row then holds the new label's post, thread, network
// and arrival hour, so the 24-hour wait starts again. A label on the same side
// about another post only moves the labelled day forward and records that post
// as `latest`: the post, thread and network that put the install on its side
// stay, so more labels never lower the thread or network count, and the side's
// wait does not restart. An older label, or either recorded post sent again,
// changes nothing.
const FLIP = "excluded.label <> reports.label AND (excluded.labeled > reports.labeled OR (excluded.labeled = reports.labeled AND excluded.label = 'not_slop'))";
const VERDICT_UPSERT = `INSERT INTO reports (reporter, handle, status, thread, latest, label, net, at, labeled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(reporter, handle) DO UPDATE SET
    latest = excluded.status,
    status = CASE WHEN ${FLIP} THEN excluded.status ELSE reports.status END,
    thread = CASE WHEN ${FLIP} THEN excluded.thread ELSE reports.thread END,
    net = CASE WHEN ${FLIP} THEN excluded.net ELSE reports.net END,
    at = CASE WHEN ${FLIP} THEN excluded.at ELSE reports.at END,
    labeled = CASE WHEN ${FLIP} THEN excluded.labeled ELSE MAX(reports.labeled, excluded.labeled) END,
    label = CASE WHEN ${FLIP} THEN excluded.label ELSE reports.label END
  WHERE ${FLIP} OR (excluded.label = reports.label AND excluded.status <> reports.status AND excluded.status <> reports.latest AND excluded.labeled > reports.labeled)`;

async function postReports(db, env, request, body, now) {
  if (body.v !== 1) return fail(400, 'unsupported version');
  if (!checkKey(body)) return fail(400, 'bad key');
  if (!Array.isArray(body.reports) || body.reports.length < 1 || body.reports.length > RULES.BATCH_MAX) {
    return fail(400, `reports must hold 1 to ${RULES.BATCH_MAX} items`);
  }
  const rejected = [];
  const valid = [];
  const at = hourFloor(now);
  const expCut = now - RULES.EXPIRY_DAYS * DAY;
  body.reports.forEach((it, i) => {
    // day: the UTC day the reader labelled the post (0.11.0 on). A label older
    // than the window is refused; a day later than arrival counts as the
    // arrival hour, so a wrong clock can only make a label older.
    const given = it && typeof it === 'object' ? it.day : undefined;
    const labeledDay = given == null ? undefined : typeof given === 'string' ? dayStart(given) : null;
    const ok =
      it && typeof it === 'object' &&
      (it.label === 'slop' || it.label === 'not_slop') &&
      typeof it.handle === 'string' && HANDLE_RE.test(it.handle) &&
      typeof it.status === 'string' && ID_RE.test(it.status) &&
      (it.thread == null || (typeof it.thread === 'string' && ID_RE.test(it.thread))) &&
      // 0.10.0 sends a hash of the post's words; it is checked and dropped, never stored.
      (it.hash == null || (typeof it.hash === 'string' && HASH_RE.test(it.hash))) &&
      labeledDay !== null &&
      (labeledDay === undefined || labeledDay >= expCut);
    if (ok) {
      const labeled = labeledDay === undefined ? at : Math.min(labeledDay, at);
      valid.push({ label: it.label, handle: it.handle.toLowerCase(), status: it.status, thread: it.thread ?? null, labeled });
    } else {
      rejected.push(it && typeof it.status === 'string' && ID_RE.test(it.status) ? it.status : `#${i}`);
    }
  });
  if (valid.length === 0) return json(200, { ok: true, accepted: [], rejected, deferred: [] });

  const { net, reporter } = await identity(env, request, body.key);
  const day = dayOf(now);
  const known = await db.prepare('SELECT 1 AS x FROM reporters WHERE id = ?').bind(reporter).first();
  if (!known) {
    if ((await bump(db, 'new_install', net, day, 1)) > RULES.NEW_INSTALLS_PER_NET_DAY) {
      await unbump(db, 'new_install', net, day, 1).run();
      return fail(429, 'too many new installs from this network today', { retryAfter: msToMidnight(now) });
    }
  }
  // The bumps below each commit on their own, before the batch that stores the
  // reports. `held` is what they took; if anything after them fails, it is
  // given back before the error goes on (a 500, which the extension retries),
  // so a failed request does not use up the install's or the day's quota.
  // This is compensation, not one transaction: if giving back fails too, what
  // was taken stays on that day's counters until they end at UTC midnight.
  const held = known ? [] : [['new_install', net, 1]];
  let accepted;
  let deferred;
  try {
    // The reporter row goes in the same batch as its reports, also for an
    // install seen above: a build running since that check can have removed
    // an old reporter whose reports had all expired, and a report whose
    // reporter is missing is never counted. A reporter removed that way comes
    // back as new (its age starts again) without counting as a new install.
    const stmts = [db.prepare('INSERT OR IGNORE INTO reporters (id, first_seen) VALUES (?, ?)').bind(reporter, hourFloor(now))];
    // Per install: bump by everything offered, then see how much of it fit.
    const offered = valid.length;
    const before = (await bump(db, 'report', reporter, day, offered)) - offered;
    held.push(['report', reporter, offered]);
    const underInstall = Math.min(offered, Math.max(0, RULES.REPORTS_PER_INSTALL_DAY - before));
    // Global: only what passed the install cap is offered to the daily total.
    let fit = 0;
    if (underInstall > 0) {
      const beforeAll = (await bump(db, 'report_all', '*', day, underInstall)) - underInstall;
      held.push(['report_all', '*', underInstall]);
      fit = Math.min(underInstall, Math.max(0, RULES.REPORTS_PER_DAY - beforeAll));
      if (underInstall > fit) stmts.push(unbump(db, 'report_all', '*', day, underInstall - fit));
    }
    if (offered > fit) stmts.push(unbump(db, 'report', reporter, day, offered - fit));
    accepted = valid.slice(0, fit);
    deferred = valid.slice(fit);
    for (const r of accepted) stmts.push(db.prepare(VERDICT_UPSERT).bind(reporter, r.handle, r.status, r.thread, r.status, r.label, net, at, r.labeled));
    await db.batch(stmts);
  } catch (err) {
    try {
      await db.batch(held.map(([kind, subject, by]) => unbump(db, kind, subject, day, by)));
    } catch (e) {
      console.error('could not give back a failed request\'s quota', e && e.name);
    }
    throw err;
  }
  const out = { ok: true, accepted: accepted.map((r) => r.status), rejected, deferred: deferred.map((r) => r.status) };
  if (deferred.length) out.retryAfter = msToMidnight(now);
  return json(200, out);
}

async function postRetract(db, env, request, body) {
  if (body.v !== 1) return fail(400, 'unsupported version');
  if (!checkKey(body)) return fail(400, 'bad key');
  const given = body.handles ?? [];
  if (!Array.isArray(body.statuses) || body.statuses.length > RULES.BATCH_MAX || !Array.isArray(given) || given.length > RULES.BATCH_MAX) {
    return fail(400, `statuses and handles must each hold at most ${RULES.BATCH_MAX} items`);
  }
  if (body.statuses.length + given.length < 1) return fail(400, 'nothing to retract');
  const statuses = body.statuses.filter((s) => typeof s === 'string' && ID_RE.test(s));
  const handles = given.filter((h) => typeof h === 'string' && HANDLE_RE.test(h)).map((h) => h.toLowerCase());
  if (!statuses.length && !handles.length) return json(200, { ok: true, removed: 0 });
  const { reporter } = await identity(env, request, body.key);
  const marks = (list) => list.map(() => '?').join(', ');
  // A status withdraws the verdict when it is the verdict's post or the post of
  // its newest label (so a cleared label's day never keeps counting); retracting
  // any other post of the same account leaves the verdict as it is. A handle
  // (0.11.0 on) withdraws the install's verdict on that account, whichever post
  // it holds; the extension then sends the newest label it still keeps on it.
  const stmts = [];
  // Two statements, not one with the list twice: D1 binds at most 100 values
  // per statement. The second sees only what the first left, so none is counted twice.
  if (statuses.length) {
    for (const col of ['status', 'latest']) {
      stmts.push(db.prepare(`DELETE FROM reports WHERE reporter = ? AND ${col} IN (${marks(statuses)})`).bind(reporter, ...statuses));
    }
  }
  if (handles.length) stmts.push(db.prepare(`DELETE FROM reports WHERE reporter = ? AND handle IN (${marks(handles)})`).bind(reporter, ...handles));
  const res = await db.batch(stmts);
  return json(200, { ok: true, removed: res.reduce((n, r) => n + Number(r.meta.changes), 0) });
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

// A removal request names a listed account. While it stands (EXPIRY_DAYS),
// only Slop labels made on later UTC days count for that account, so it
// leaves the list at the next build and returns only if readers label it
// again. One request per account counts in any EXPIRY_DAYS. Only the handle
// and the hour are kept.
async function postRemoval(db, env, request, raw, now) {
  const form = (request.headers.get('content-type') || '').toLowerCase().includes('application/x-www-form-urlencoded');
  let given;
  if (form) {
    given = new URLSearchParams(raw).get('handle');
  } else {
    const data = parseJson(raw);
    if (!data) return fail(400, 'bad body');
    given = data.handle;
  }
  const handle = typeof given === 'string' ? given.trim().replace(/^@/, '') : '';
  if (!HANDLE_RE.test(handle)) return fail(400, 'bad handle');
  const h = handle.toLowerCase();
  const answer = (result) => (form ? html(200, removalPage(h, result)) : json(200, { ok: true, handle: h, ...result }));

  const expCut = now - RULES.EXPIRY_DAYS * DAY;
  const standing = await db.prepare('SELECT at FROM removals WHERE handle = ? AND at >= ?').bind(h, expCut).first();
  if (standing) return answer({ state: 'standing', since: dayOf(Number(standing.at)) });
  if (!(await db.prepare('SELECT 1 AS x FROM listed WHERE handle = ?').bind(h).first())) return answer({ state: 'unlisted' });

  const { net } = await identity(env, request, null);
  const day = dayOf(now);
  if ((await bump(db, 'removal', net, day, 1)) > RULES.REMOVALS_PER_NET_DAY) {
    await unbump(db, 'removal', net, day, 1).run();
    return fail(429, 'too many removal requests from this network today', { retryAfter: msToMidnight(now) });
  }
  if ((await bump(db, 'removal_all', '*', day, 1)) > RULES.REMOVALS_PER_DAY) {
    await db.batch([unbump(db, 'removal', net, day, 1), unbump(db, 'removal_all', '*', day, 1)]);
    return fail(429, 'too many removal requests today', { retryAfter: msToMidnight(now) });
  }
  // A request past its days can still be stored until the next build prunes it.
  const put = await db
    .prepare('INSERT INTO removals (handle, at) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET at = excluded.at WHERE removals.at < ?')
    .bind(h, hourFloor(now), expCut)
    .run();
  if (Number(put.meta.changes) === 0) {
    // A request for the same account, made at the same moment, was stored first:
    // this one takes no place in the day's limits.
    await db.batch([unbump(db, 'removal', net, day, 1), unbump(db, 'removal_all', '*', day, 1)]);
    const first = await db.prepare('SELECT at FROM removals WHERE handle = ?').bind(h).first();
    return answer({ state: 'standing', since: dayOf(Number(first ? first.at : now)) });
  }
  return answer({ state: 'taken' });
}

// ---------- admin ----------

async function adminCandidates(db, url, now) {
  let limit = parseInt(url.searchParams.get('limit') ?? '', 10);
  if (!Number.isFinite(limit)) limit = 50;
  limit = Math.min(500, Math.max(1, limit));
  const c = cuts(now);
  const slop = slopSide(c);
  const st = stood(c);
  const { results } = await prep(
    db,
    sql`SELECT r.handle AS handle,
         COUNT(CASE WHEN ${slop} AND ${st} THEN 1 END) AS slop_reporters,
         COUNT(CASE WHEN r.label = 'slop' THEN 1 END) AS slop_reporters_all,
         COUNT(CASE WHEN r.label = 'not_slop' AND ${st} THEN 1 END) AS not_slop_reporters,
         COUNT(DISTINCT CASE WHEN ${slop} AND ${st} THEN COALESCE(r.thread, r.status) END) AS threads,
         COUNT(DISTINCT CASE WHEN ${slop} AND ${st} THEN r.net END) AS nets,
         MAX(CASE WHEN r.label = 'slop' THEN r.labeled END) AS newest,
         EXISTS (SELECT 1 FROM listed l WHERE l.handle = r.handle) AS listed,
         (SELECT o.action FROM overrides o WHERE o.handle = r.handle) AS override,
         (SELECT q.at FROM removals q WHERE q.handle = r.handle AND q.at >= ${c.expCut}) AS removal_requested
       FROM reports r
       WHERE ${inWindow(c)}
       GROUP BY r.handle
       HAVING slop_reporters_all > 0
       ORDER BY slop_reporters DESC, slop_reporters_all DESC, r.handle
       LIMIT ${limit}`,
  ).all();
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
      removal_requested: r.removal_requested == null ? null : Number(r.removal_requested),
    })),
  });
}

async function adminRoute(db, env, request, url, path, now) {
  const m = request.method;
  if (path === '/v1/admin/candidates' && m === 'GET') return adminCandidates(db, url, now);
  if (m !== 'POST') return null;
  if (path === '/v1/admin/rebuild') {
    const stats = await build(db, env, now);
    const cache = getCache();
    if (cache) await cache.delete(listCacheKey(request.url));
    return json(200, { ok: true, ...stats });
  }
  if (path === '/v1/admin/override') {
    const { text, tooBig } = await readBody(request);
    if (tooBig) return fail(413, 'body too large');
    const b = parseJson(text);
    if (!b) return fail(400, 'bad body');
    const note = typeof b.note === 'string' ? b.note.slice(0, 1000) : null;
    const handle = typeof b.handle === 'string' ? b.handle.trim().replace(/^@/, '').toLowerCase() : '';
    if (!HANDLE_RE.test(handle)) return fail(400, 'bad handle');
    if (b.action === 'clear') {
      await db.prepare('DELETE FROM overrides WHERE handle = ?').bind(handle).run();
    } else if (b.action === 'delist') {
      await db
        .prepare("INSERT INTO overrides (handle, action, note, at) VALUES (?, 'delist', ?, ?) ON CONFLICT(handle) DO UPDATE SET action = excluded.action, note = excluded.note, at = excluded.at")
        .bind(handle, note, now)
        .run();
    } else {
      // Every listed account is listed by readers, so there is no "list" override.
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
