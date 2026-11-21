import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { world, slopFrom, keyOf, RULES, T0, HOUR, DAY, SECRET } from './helpers.mjs';

const OLD = T0 - 10 * DAY;
const listed = async (w, now = T0) => (await w.body(now)).split('\n').filter(Boolean).map((l) => JSON.parse(l).username);

test('1. fewer than 3 aged reporters never list; 3 across 2 threads and 2 nets list', async () => {
  const w = world();
  await slopFrom(w, 'spammer', [1, 2], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await listed(w), []);
  await slopFrom(w, 'spammer', [3], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await listed(w), ['spammer']);
  assert.equal(RULES.MIN_REPORTERS, 3);
});

test('2. three reporters in one thread do not list; three in one net do not list', async () => {
  const a = world();
  await slopFrom(a, 'onethread', [1, 2, 3], { when: OLD, nets: 3, threads: 1 });
  await a.buildAt();
  assert.deepEqual(await listed(a), []);
  const b = world();
  await slopFrom(b, 'onenet', [1, 2, 3], { when: OLD, nets: 1 });
  await b.buildAt();
  assert.deepEqual(await listed(b), []);
});

test('3. planted negative: 50 reporters from one net never list; the 11th new install in a day gets 429', async () => {
  const w = world();
  // 10 new installs per network per day: spread 50 installs over 5 days, one net.
  for (let d = 0; d < 5; d++) {
    for (let j = 0; j < 10; j++) {
      const i = d * 10 + j + 1;
      const r = await w.report(i, [{ label: 'slop', handle: 'farm', status: String(2000 + i), thread: String(700 + (i % 3)) }], { now: T0 - (20 - d) * DAY, ip: '203.0.113.7' });
      assert.equal(r.status, 200);
    }
  }
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reporters'), 50);
  await w.buildAt();
  assert.deepEqual(await listed(w), []);

  const day = T0 - 2 * DAY;
  for (let j = 0; j < 10; j++) {
    assert.equal((await w.report(100 + j, [{ label: 'slop', handle: 'x', status: '1', thread: '1' }], { now: day, ip: '198.51.100.9' })).status, 200);
  }
  const r = await w.report(110, [{ label: 'slop', handle: 'x', status: '1', thread: '1' }], { now: day, ip: '198.51.100.77' });
  assert.equal(r.status, 429);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.retryAfter, (Math.floor(day / DAY) + 1) * DAY - day);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reporters WHERE id = ?', 'x'), 0);
  // The same network may start again the next UTC day.
  assert.equal((await w.report(110, [{ label: 'slop', handle: 'x', status: '1', thread: '1' }], { now: day + DAY, ip: '198.51.100.9' })).status, 200);
});

test('4. planted negative: third slop report at 23 h does not list, at 24 h it does', async () => {
  const w = world();
  await slopFrom(w, 'late', [1, 2], { when: OLD, nets: 2 });
  await w.report(3, [{ label: 'slop', handle: 'late', status: '1003', thread: '503' }], { now: OLD, ip: '10.0.7.5' });
  // Re-report (upsert) puts the third report's time at T0 - 23h.
  await w.report(3, [{ label: 'slop', handle: 'late', status: '1003', thread: '503' }], { now: T0 - 23 * HOUR, ip: '10.0.7.5' });
  await w.buildAt();
  assert.deepEqual(await listed(w), []);
  await w.buildAt(T0 + HOUR); // now the report is 24 h old
  assert.deepEqual(await listed(w, T0 + HOUR), ['late']);
});

test('5. an install first seen 6 days ago does not count; at 7 days it does', async () => {
  const w = world();
  await slopFrom(w, 'aging', [1, 2], { when: T0 - 20 * DAY, nets: 2 });
  await slopFrom(w, 'aging', [3], { when: T0 - 6 * DAY, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await listed(w), []);
  await w.buildAt(T0 + DAY); // first seen exactly 7 days earlier
  assert.deepEqual(await listed(w, T0 + DAY), ['aging']);
});

test('6. not slop counts like slop: 3 slop and 1 not slop lists; a second not slop delists once it is past the 24 h wait', async () => {
  const w = world();
  await slopFrom(w, 'mixed', [1, 2, 3], { when: OLD, nets: 2 });
  await w.report(4, [{ label: 'not_slop', handle: 'mixed', status: '9004', thread: '9' }], { now: OLD, ip: '10.9.9.9' });
  await w.buildAt();
  assert.deepEqual(await listed(w), ['mixed']);
  // A fresh not_slop report from an aged install does not count until it is ADD_WAIT_HOURS old.
  await w.report(5, [{ label: 'not_slop', handle: 'mixed', status: '9005', thread: '9' }], { now: OLD, ip: '10.9.9.8' });
  const later = T0 + HOUR;
  await w.report(5, [{ label: 'not_slop', handle: 'mixed', status: '9005', thread: '9' }], { now: later, ip: '10.9.9.8' });
  await w.buildAt(later);
  assert.deepEqual(await listed(w, later), ['mixed']);
  const waited = later + RULES.ADD_WAIT_HOURS * HOUR;
  await w.buildAt(waited);
  assert.deepEqual(await listed(w, waited), []);
  assert.equal(RULES.NOT_SLOP_WEIGHT, 3);
});

test('7. retract and forget lower the count at the next build; forget removes the reporter row', async () => {
  const w = world();
  await slopFrom(w, 'gone', [1, 2, 3], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await listed(w), ['gone']);
  const r = await w.req('POST', '/v1/retract', { body: { v: 1, key: keyOf(3), statuses: ['1003', '4040'] } });
  assert.deepEqual(r.json, { ok: true, removed: 1 });
  await w.buildAt();
  assert.deepEqual(await listed(w), []);
  await slopFrom(w, 'gone', [3], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await listed(w), ['gone']);
  const f = await w.req('POST', '/v1/forget', { body: { v: 1, key: keyOf(3) } });
  assert.deepEqual(f.json, { ok: true, removed: 1 });
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reporters'), 2);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports WHERE status = ?', '1003'), 0);
  await w.buildAt();
  assert.deepEqual(await listed(w), []);
  const unknown = await w.req('POST', '/v1/retract', { body: { v: 1, key: keyOf(99), statuses: ['1'] } });
  assert.deepEqual(unknown.json, { ok: true, removed: 0 });
});

test('8. reports past 90 days are deleted at the build and stop counting', async () => {
  const w = world();
  const ancient = T0 - 91 * DAY;
  await slopFrom(w, 'stale', [1, 2, 3], { when: ancient, nets: 2 });
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 3);
  await w.buildAt(ancient + 8 * DAY);
  assert.deepEqual(await listed(w, ancient + 8 * DAY), ['stale']);
  await w.buildAt(T0);
  assert.deepEqual(await listed(w), []);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 0);
});

test('9. delist override removes at once via admin; list override adds; clear restores the rule', async () => {
  const w = world();
  await slopFrom(w, 'rule', [1, 2, 3], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await listed(w), ['rule']);
  assert.equal((await w.admin('POST', '/v1/admin/override', { handle: 'Rule', action: 'delist', note: 'checked' })).status, 200);
  assert.deepEqual(await listed(w), []);
  assert.equal((await w.admin('POST', '/v1/admin/override', { handle: 'manual', action: 'list' })).status, 200);
  assert.deepEqual(await listed(w), ['manual']);
  await w.buildAt(T0 + HOUR); // a normal cron build keeps both overrides
  assert.deepEqual(await listed(w, T0 + HOUR), ['manual']);
  await w.admin('POST', '/v1/admin/override', { handle: 'rule', action: 'clear' });
  await w.admin('POST', '/v1/admin/override', { handle: 'manual', action: 'clear' });
  assert.deepEqual(await listed(w), ['rule']);
});

test('10. empty build and no build both serve 200, empty, ndjson content type', async () => {
  const w = world();
  for (const step of ['before', 'after']) {
    if (step === 'after') await w.buildAt();
    const r = await w.req('GET', '/v1/list.ndjson');
    assert.equal(r.status, 200, step);
    assert.equal(r.text, '', step);
    assert.match(r.res.headers.get('content-type'), /^application\/x-ndjson/);
    assert.equal(r.res.headers.get('cache-control'), step === 'before' ? 'no-store' : 'public, max-age=600');
  }
});

test('11. changes records added and removed; a build that changes nothing records no row', async () => {
  const w = world();
  await slopFrom(w, 'alpha', [1, 2, 3], { when: OLD, nets: 2 });
  await w.buildAt(T0);
  await w.buildAt(T0 + HOUR);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM changes'), 1);
  await w.admin('POST', '/v1/admin/override', { handle: 'alpha', action: 'delist' }, T0 + 2 * HOUR);
  const c = await w.req('GET', '/v1/changes?limit=5');
  assert.deepEqual(c.json, [
    { at: T0 + 2 * HOUR, count: 0, added: [], removed: ['alpha'] },
    { at: T0, count: 1, added: ['alpha'], removed: [] },
  ]);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM changes'), 2);
  assert.equal((await w.req('GET', '/v1/changes?limit=1')).json.length, 1);
});

test('12. validation, size and the daily cap', async () => {
  const w = world();
  const good = { label: 'slop', handle: 'abc', status: '1', thread: '2', hash: null };
  assert.equal((await w.req('POST', '/v1/reports', { body: { v: 1, key: 'nope', reports: [good] } })).status, 400);
  assert.equal((await w.req('POST', '/v1/reports', { body: { v: 1, key: 'A'.repeat(32), reports: [good] } })).status, 400);
  assert.equal((await w.req('POST', '/v1/reports', { raw: 'not json' })).status, 400);
  assert.equal((await w.req('POST', '/v1/reports', { body: { v: 1, key: keyOf(1), reports: [] } })).status, 400);
  const many = Array.from({ length: 51 }, (_, i) => ({ ...good, status: String(i + 1) }));
  assert.equal((await w.req('POST', '/v1/reports', { body: { v: 1, key: keyOf(1), reports: many } })).status, 400);

  const mixed = await w.req('POST', '/v1/reports', {
    body: {
      v: 1, key: keyOf(1),
      reports: [
        good,
        { ...good, handle: 'has space', status: '2' },
        { ...good, handle: 'waytoolonghandle1', status: '3' },
        { ...good, status: 'abc' },
        { ...good, label: 'maybe', status: '5' },
        { ...good, hash: 'XYZ', status: '6' },
        { ...good, thread: '1x', status: '7' },
        { ...good, handle: 'MixedCase', status: '8', hash: '0123456789abcdef' },
      ],
    },
  });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.json, { ok: true, accepted: ['1', '8'], rejected: ['2', '3', '#3', '5', '6', '7'], deferred: [] });
  assert.equal(w.count("SELECT COUNT(*) AS c FROM reports WHERE handle = 'mixedcase'"), 1);

  const big = await w.req('POST', '/v1/reports', { raw: JSON.stringify({ v: 1, key: keyOf(1), pad: 'x'.repeat(RULES.BODY_MAX) }) });
  assert.equal(big.status, 413);

  // Daily cap: 2 accepted already; send 98 more to reach 100, then 5 are deferred.
  const batch = (from, n) => Array.from({ length: n }, (_, i) => ({ ...good, status: String(from + i) }));
  assert.equal((await w.report(1, batch(100, 50))).json.accepted.length, 50);
  assert.equal((await w.report(1, batch(200, 48))).json.accepted.length, 48);
  const over = await w.report(1, batch(300, 5));
  assert.equal(over.status, 200);
  assert.deepEqual(over.json.accepted, []);
  assert.equal(over.json.deferred.length, 5);
  assert.equal(over.json.retryAfter, DAY - (T0 % DAY));
  assert.equal(w.count('SELECT n AS c FROM counters WHERE kind = ?', 'report'), RULES.REPORTS_PER_INSTALL_DAY);
  const next = await w.report(1, batch(300, 5), { now: T0 + DAY });
  assert.equal(next.json.accepted.length, 5);
});

test('13. neither the raw key nor the raw IP is stored in any table', async () => {
  const w = world();
  const key = 'deadbeefcafef00ddeadbeefcafef00d';
  const ip4 = '203.0.113.77';
  const ip6 = '2001:db8:1234:5678::9';
  await w.req('POST', '/v1/reports', { body: { v: 1, key, reports: [{ label: 'slop', handle: 'zed', status: '5', thread: '6' }] }, ip: ip4 });
  await w.req('POST', '/v1/reports', { body: { v: 1, key: keyOf(2), reports: [{ label: 'slop', handle: 'zed', status: '5', thread: '6' }] }, ip: ip6 });
  await w.req('POST', '/v1/removal', { body: { handle: 'zed', reason: 'x' }, ip: ip4 });
  await w.buildAt();
  const tables = w.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  let dump = '';
  for (const t of tables) dump += JSON.stringify(w.db.raw.prepare(`SELECT * FROM ${t}`).all());
  for (const secret of [key, ip4, '203.0.113', ip6, '2001:db8', SECRET]) assert.equal(dump.includes(secret), false, secret);
  const reporter = createHmac('sha256', SECRET).update('r:' + key).digest('hex').slice(0, 32);
  const net = createHmac('sha256', SECRET).update('n:203.0.113').digest('hex').slice(0, 16);
  const row = w.db.raw.prepare('SELECT reporter, net, at FROM reports WHERE status = ? AND reporter = ?').get('5', reporter);
  assert.equal(row.net, net);
  assert.equal(row.at % HOUR, 0);
  const net6 = createHmac('sha256', SECRET).update('n:2001:db8:1234').digest('hex').slice(0, 16);
  assert.equal(w.db.raw.prepare('SELECT net FROM reports WHERE reporter = ?').get(createHmac('sha256', SECRET).update('r:' + keyOf(2)).digest('hex').slice(0, 32)).net, net6);
  assert.equal(w.db.raw.prepare('SELECT first_seen FROM reporters WHERE id = ?').get(reporter).first_seen % HOUR, 0);
});

test('14. admin auth and unconfigured secrets', async () => {
  const w = world();
  assert.equal((await w.req('GET', '/v1/admin/candidates')).status, 401);
  assert.equal((await w.req('GET', '/v1/admin/candidates', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await w.req('POST', '/v1/admin/rebuild', { headers: { authorization: 'Basic ' + 'x' } })).status, 401);
  assert.equal((await w.admin('GET', '/v1/admin/candidates')).status, 200);
  assert.equal((await w.admin('GET', '/v1/admin/removals?status=open')).status, 200);
  assert.equal((await w.admin('POST', '/v1/admin/rebuild')).status, 200);

  const noAdmin = world({ ADMIN_TOKEN: undefined });
  assert.equal((await noAdmin.req('GET', '/v1/admin/candidates', { headers: { authorization: 'Bearer ' } })).status, 404);
  assert.equal((await noAdmin.req('POST', '/v1/admin/rebuild', { headers: { authorization: 'Bearer undefined' } })).status, 404);

  const noHmac = world({ HMAC_SECRET: undefined });
  const k = keyOf(1);
  for (const [path, body] of [
    ['/v1/reports', { v: 1, key: k, reports: [{ label: 'slop', handle: 'a', status: '1' }] }],
    ['/v1/retract', { v: 1, key: k, statuses: ['1'] }],
    ['/v1/forget', { v: 1, key: k }],
    ['/v1/removal', { handle: 'a' }],
  ]) {
    const r = await noHmac.req('POST', path, { body });
    assert.equal(r.status, 503, path);
    assert.deepEqual(r.json, { ok: false, reason: 'not configured' });
  }
});

test('15. CORS preflight and headers on responses', async () => {
  const w = world();
  const o = await w.req('OPTIONS', '/v1/reports');
  assert.equal(o.status, 204);
  assert.equal(o.res.headers.get('access-control-allow-origin'), '*');
  assert.equal(o.res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(o.res.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(o.res.headers.get('access-control-max-age'), '86400');
  assert.equal((await w.req('OPTIONS', '/anything/at/all')).status, 204);
  const p = await w.report(1, [{ label: 'slop', handle: 'a', status: '1' }]);
  assert.equal(p.res.headers.get('access-control-allow-origin'), '*');
  assert.equal(p.res.headers.get('x-content-type-options'), 'nosniff');
  const nf = await w.req('GET', '/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.ok, false);
  assert.equal(nf.res.headers.get('access-control-allow-origin'), '*');
});

test('16. list body is sorted, one JSON object per line, ends with a newline', async () => {
  const w = world();
  for (const [n, ids] of [['zulu', [1, 2, 3]], ['alpha', [4, 5, 6]], ['mike', [7, 8, 9]]]) {
    await slopFrom(w, n, ids, { when: OLD, nets: 2 });
  }
  await w.buildAt();
  const text = await w.body();
  assert.ok(text.endsWith('\n'));
  const lines = text.slice(0, -1).split('\n');
  assert.equal(lines.length, 3);
  const objs = lines.map((l) => JSON.parse(l));
  assert.deepEqual(objs.map((o) => o.username), ['alpha', 'mike', 'zulu']);
  assert.deepEqual(Object.keys(objs[0]), ['username', 'reporters', 'since']);
  assert.equal(objs[0].reporters, 3);
  assert.equal(objs[0].since, new Date(T0).toISOString().slice(0, 10));
  const etag = (await w.req('GET', '/v1/list.ndjson')).res.headers.get('etag');
  assert.equal(etag, `"${T0}"`);
  assert.equal((await w.req('GET', '/v1/list.ndjson', { headers: { 'if-none-match': etag } })).status, 304);
});

test('removal: JSON gets an id and is stored open; form gets HTML; sixth in a day is 429; limits enforced', async () => {
  const w = world();
  const j = await w.req('POST', '/v1/removal', { body: { handle: '@Someone', reason: 'wrong', contact: 'me' }, ip: '192.0.2.1' });
  assert.equal(j.status, 200);
  assert.equal(j.json.id, 1);
  const f = await w.req('POST', '/v1/removal', { raw: 'handle=other&reason=r&contact=', headers: { 'content-type': 'application/x-www-form-urlencoded' }, ip: '192.0.2.1' });
  assert.equal(f.status, 200);
  assert.match(f.res.headers.get('content-type'), /text\/html/);
  assert.equal((await w.req('POST', '/v1/removal', { body: { handle: 'x', reason: 'r'.repeat(1001) } })).status, 400);
  assert.equal((await w.req('POST', '/v1/removal', { body: { handle: 'bad handle' } })).status, 400);
  for (let i = 0; i < 3; i++) await w.req('POST', '/v1/removal', { body: { handle: 'n' + i }, ip: '192.0.2.200' });
  assert.equal((await w.req('POST', '/v1/removal', { body: { handle: 'n9' }, ip: '192.0.2.99' })).status, 429);
  const open = await w.admin('GET', '/v1/admin/removals?status=open');
  assert.equal(open.json.removals.length, 5);
  assert.equal(open.json.removals[0].handle, 'someone');
  assert.equal((await w.admin('POST', '/v1/admin/removal', { id: 1, status: 'done', note: 'ok' })).status, 200);
  assert.equal((await w.admin('GET', '/v1/admin/removals?status=done')).json.removals.length, 1);
  assert.equal((await w.admin('POST', '/v1/admin/removal', { id: 999, status: 'done' })).status, 404);
  assert.equal(w.count("SELECT COUNT(*) AS c FROM listed"), 0, 'a removal request never delists by itself');
});

test('pages, status and candidates', async () => {
  const w = world();
  const home = await w.req('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.res.headers.get('content-type'), /text\/html/);
  assert.match(home.text, /action="\/v1\/removal"/);
  assert.match(home.text, /rebuilt every six hours/);
  assert.ok(home.text.includes('<li>Each install is at least 7 days old, and each report, Slop or Not slop, is at least 24 hours old.</li>'));
  assert.equal(home.text.includes('http://') || /src=["']https?:/.test(home.text), false);
  assert.ok(home.text.includes('are open source. Their code, and the place to report a problem with either, are on <a href="https://github.com/StartupBros-com/ai-anti-slop">GitHub</a>.'), 'the page says where the code is');
  await slopFrom(w, 'cand', [1, 2], { when: OLD, nets: 2 });
  await w.buildAt();
  const s = await w.req('GET', '/v1/status');
  assert.deepEqual(s.json, { ok: true, listed: 0, reporters: 2, builtAt: T0 });
  const c = (await w.admin('GET', '/v1/admin/candidates?limit=5')).json.candidates;
  assert.equal(c.length, 1);
  assert.equal(c[0].handle, 'cand');
  assert.equal(c[0].slop_reporters, 2);
  assert.equal(c[0].listed, false);
});

test('ipPrefix expands IPv6 and handles mapped and missing addresses', async () => {
  const { ipPrefix } = await import('../src/core.js');
  assert.equal(ipPrefix('1.2.3.4'), '1.2.3');
  assert.equal(ipPrefix('2001:db8::1'), '2001:db8:0');
  assert.equal(ipPrefix('2001:0DB8:0000:5::'), '2001:db8:0');
  assert.equal(ipPrefix('::1'), '0:0:0');
  assert.equal(ipPrefix('::ffff:9.8.7.6'), '9.8.7');
  assert.equal(ipPrefix(null), 'local');
  assert.equal(ipPrefix('garbage'), 'unknown');
});
