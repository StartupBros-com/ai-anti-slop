// One install, one verdict per account (#90). The first four tests are the
// planted negatives: each fails against the per-report rule of 0.10.0's
// server and passes here. They use only the HTTP surface, so they run against
// either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, slopFrom, keyOf, T0, HOUR, DAY } from './helpers.mjs';

const OLD = T0 - 10 * DAY;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const entries = async (w, now = T0) =>
  (await w.body(now)).split('\n').filter(Boolean).map((l) => {
    const o = JSON.parse(l);
    return [o.username, o.reporters];
  });
const names = async (w, now = T0) => (await entries(w, now)).map((e) => e[0]);
const say = (w, i, label, handle, status, thread, now, extra = {}) =>
  w.report(i, [{ label, handle, status: String(status), thread: String(thread), ...extra }], { now, ip: `10.0.${i % 2}.5` });
// Make installs aged: each sends one report about an unrelated account at OLD.
const register = async (w, ids) => {
  for (const i of ids) assert.equal((await say(w, i, 'slop', 'filler' + i, 90000 + i, 9, OLD)).status, 200);
};

test('planted negative 1: a reader whose newer label says Not slop counts once, as Not slop', async () => {
  const w = world();
  await slopFrom(w, 'flip', [1, 2, 3], { when: OLD, nets: 2 });
  await say(w, 4, 'slop', 'flip', 4001, 600, OLD);
  await say(w, 4, 'not_slop', 'flip', 4002, 601, T0 - 2 * DAY);
  await w.buildAt();
  assert.deepEqual(await entries(w), [['flip', 3]]);

  // Five Slop readers and one Not slop reader list it (5 < 3 x 2 is false only
  // if the flipped reader is counted on both sides).
  const v = world();
  await slopFrom(v, 'flip', [1, 2, 3, 5, 6], { when: OLD, nets: 2 });
  await say(v, 7, 'not_slop', 'flip', 7001, 700, OLD);
  await say(v, 4, 'slop', 'flip', 4001, 600, OLD);
  await say(v, 4, 'not_slop', 'flip', 4002, 601, T0 - 2 * DAY);
  await v.buildAt();
  assert.deepEqual(await names(v), []);
});

test('planted negative 2: re-sending an unchanged report does not make it newer, so it expires 90 days after the label', async () => {
  const w = world();
  const first = T0 - 89 * DAY;
  await slopFrom(w, 'resent', [1, 2, 3], { when: first, nets: 2 });
  await slopFrom(w, 'resent', [1, 2, 3], { when: T0 - 2 * DAY, nets: 2 }); // the same three reports again
  await w.buildAt(T0);
  assert.deepEqual(await names(w, T0), ['resent']);
  const later = T0 + 2 * DAY; // 91 days after the labels
  await w.buildAt(later);
  assert.deepEqual(await names(w, later), []);
});

test('planted negative 3: a listed account at the 3-reader edge stays listed when one reader re-sends its report', async () => {
  const w = world();
  await slopFrom(w, 'edge', [1, 2, 3], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await names(w), ['edge']);
  // Reader 3's report exactly as slopFrom sent it, again.
  const again = await w.report(3, [{ label: 'slop', handle: 'edge', status: '1003', thread: '502' }], { now: T0 + HOUR, ip: '10.0.1.5' });
  assert.deepEqual(again.json.accepted, ['1003']);
  await w.buildAt(T0 + 2 * HOUR);
  assert.deepEqual(await names(w, T0 + 2 * HOUR), ['edge']);
});

test('planted negative 4: a removal request takes a listed account off at the next build; labels from later days put it back', async () => {
  const w = world();
  await slopFrom(w, 'asked', [1, 2, 3], { when: OLD, nets: 2 });
  await register(w, [4, 5, 6]);
  await w.buildAt();
  assert.deepEqual(await names(w), ['asked']);
  const r = await w.req('POST', '/v1/removal', { body: { handle: '@Asked' }, ip: '192.0.2.1', now: T0 + HOUR });
  assert.equal(r.status, 200);
  await w.buildAt(T0 + 2 * HOUR);
  assert.deepEqual(await names(w, T0 + 2 * HOUR), []);

  // Three more readers label it the same UTC day: that does not count.
  for (const i of [4, 5, 6]) await say(w, i, 'slop', 'asked', 6000 + i, 600 + i, T0 + 3 * HOUR, { day: dayOf(T0) });
  await w.buildAt(T0 + 2 * DAY);
  assert.deepEqual(await names(w, T0 + 2 * DAY), []);
  // They label more of its posts on a later day: now they count, and the
  // readers from before the request still do not.
  for (const i of [4, 5, 6]) await say(w, i, 'slop', 'asked', 7000 + i, 700 + i, T0 + DAY + HOUR, { day: dayOf(T0 + DAY) });
  await w.buildAt(T0 + 2 * DAY);
  assert.deepEqual(await entries(w, T0 + 2 * DAY), [['asked', 3]]);
});

test('another Slop label on a different post never lowers the count, the threads or the networks', async () => {
  const w = world();
  await slopFrom(w, 'more', [1, 2, 3], { when: OLD, nets: 2 }); // threads 500, 501, 502; networks 1, 0, 1
  await w.buildAt();
  assert.deepEqual(await entries(w), [['more', 3]]);
  // Readers 1 and 3 label posts in reader 2's thread, from reader 2's network.
  for (const i of [1, 3]) {
    await w.report(i, [{ label: 'slop', handle: 'more', status: String(5000 + i), thread: '501' }], { now: T0 + HOUR, ip: '10.0.0.5' });
  }
  await w.buildAt(T0 + 2 * HOUR);
  assert.deepEqual(await entries(w, T0 + 2 * HOUR), [['more', 3]]);
  // The verdict keeps the post that put each reader on the Slop side.
  assert.equal(w.count("SELECT COUNT(*) AS c FROM reports WHERE handle = 'more'"), 3);
  assert.equal(w.count("SELECT COUNT(DISTINCT thread) AS c FROM reports WHERE handle = 'more'"), 3);
});

test('a flip to the other side counts only after its own 24 hours, and stops counting for the old side at once', async () => {
  const w = world();
  await slopFrom(w, 'turn', [1, 2, 3, 4], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.deepEqual(await entries(w), [['turn', 4]]);
  await say(w, 4, 'not_slop', 'turn', 4100, 650, T0 + HOUR);
  await w.buildAt(T0 + 2 * HOUR);
  assert.deepEqual(await entries(w, T0 + 2 * HOUR), [['turn', 3]], 'no longer Slop, not yet Not slop');
  assert.equal((await w.admin('GET', '/v1/admin/candidates', undefined, T0 + 2 * HOUR)).json.candidates[0].not_slop_reporters, 0);
  await w.buildAt(T0 + 26 * HOUR);
  assert.deepEqual(await entries(w, T0 + 26 * HOUR), [['turn', 3]]);
  assert.equal((await w.admin('GET', '/v1/admin/candidates', undefined, T0 + 26 * HOUR)).json.candidates[0].not_slop_reporters, 1);
});

test('the labelled day decides between sides: an older label changes nothing, and a tie goes to Not slop', async () => {
  const w = world();
  const row = (i) => w.db.raw.prepare('SELECT label, status FROM reports WHERE handle = ? AND reporter = (SELECT reporter FROM reports WHERE status = ?)').get('day', String(8000 + i));
  // Reader 1: Slop on day 5, then a Not slop label from day 3 arrives later.
  await say(w, 1, 'slop', 'day', 8001, 1, T0, { day: dayOf(T0 - 5 * DAY) });
  await say(w, 1, 'not_slop', 'day', 9001, 1, T0 + HOUR, { day: dayOf(T0 - 7 * DAY) });
  assert.deepEqual({ ...row(1) }, { label: 'slop', status: '8001' });
  // Reader 2: Slop and Not slop on the same day, in either order of arrival.
  await say(w, 2, 'slop', 'day', 8002, 1, T0, { day: dayOf(T0 - DAY) });
  await say(w, 2, 'not_slop', 'day', 9002, 1, T0 + HOUR, { day: dayOf(T0 - DAY) });
  assert.equal(w.count("SELECT COUNT(*) AS c FROM reports WHERE handle = 'day' AND status = '9002' AND label = 'not_slop'"), 1);
  await say(w, 3, 'not_slop', 'day', 9003, 1, T0, { day: dayOf(T0 - DAY) });
  await say(w, 3, 'slop', 'day', 8003, 1, T0 + HOUR, { day: dayOf(T0 - DAY) });
  assert.equal(w.count("SELECT COUNT(*) AS c FROM reports WHERE handle = 'day' AND status = '9003' AND label = 'not_slop'"), 1);
  // A newer Slop label takes reader 3 back.
  await say(w, 3, 'slop', 'day', 8004, 1, T0 + 2 * HOUR, { day: dayOf(T0) });
  assert.equal(w.count("SELECT COUNT(*) AS c FROM reports WHERE handle = 'day' AND status = '8004' AND label = 'slop'"), 1);
  assert.equal(w.count("SELECT COUNT(*) AS c FROM reports WHERE handle = 'day'"), 3);
});

test('day: kept as the start of that UTC day; a later day counts as arrival; a bad or too-old day is refused', async () => {
  const w = world();
  const at = T0 + 30 * 60000; // the arrival hour is T0
  const r = await w.report(1, [
    { label: 'slop', handle: 'a1', status: '1', day: dayOf(T0 - 3 * DAY) },
    { label: 'slop', handle: 'a2', status: '2', day: dayOf(T0 + 2 * DAY) },
    { label: 'slop', handle: 'a3', status: '3' },
    { label: 'slop', handle: 'a4', status: '4', day: '2026-02-30' },
    { label: 'slop', handle: 'a5', status: '5', day: '2026-6-1' },
    { label: 'slop', handle: 'a6', status: '6', day: 20260601 },
    { label: 'slop', handle: 'a7', status: '7', day: dayOf(T0 - 91 * DAY) },
    { label: 'slop', handle: 'a8', status: '8', day: dayOf(T0 - 89 * DAY) },
  ], { now: at });
  assert.deepEqual([r.json.accepted, r.json.rejected], [['1', '2', '3', '8'], ['4', '5', '6', '7']]);
  const labeled = Object.fromEntries(w.db.raw.prepare('SELECT status, labeled, at FROM reports').all().map((x) => [x.status, [x.labeled, x.at]]));
  const start = (t) => t - (t % DAY);
  assert.deepEqual(labeled, {
    1: [start(T0 - 3 * DAY), T0],
    2: [T0, T0],
    3: [T0, T0],
    8: [start(T0 - 89 * DAY), T0],
  });
});

test('the text hash 0.10.0 sends is accepted and never stored', async () => {
  const w = world();
  const r = await w.report(1, [{ label: 'slop', handle: 'h', status: '1', thread: '2', hash: '0123456789abcdef' }]);
  assert.deepEqual(r.json.accepted, ['1']);
  const cols = w.db.raw.prepare('PRAGMA table_info(reports)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['at', 'handle', 'label', 'labeled', 'net', 'reporter', 'status', 'thread']);
  assert.equal(JSON.stringify(w.db.raw.prepare('SELECT * FROM reports').all()).includes('0123456789abcdef'), false);
});

test('retract: a post withdraws the verdict it holds; another post of the account does not; a handle withdraws the verdict', async () => {
  const w = world();
  await say(w, 1, 'slop', 'r1', 1, 1, T0);
  await say(w, 1, 'slop', 'r1', 2, 1, T0 + DAY); // same side, later: the verdict keeps post 1
  await say(w, 1, 'slop', 'r2', 3, 1, T0);
  const retract = (body) => w.req('POST', '/v1/retract', { body: { v: 1, key: keyOf(1), ...body } });
  assert.deepEqual((await retract({ statuses: ['2'] })).json, { ok: true, removed: 0 });
  assert.deepEqual((await retract({ statuses: ['1'] })).json, { ok: true, removed: 1 });
  assert.deepEqual((await retract({ statuses: [], handles: ['R2', 'bad handle!'] })).json, { ok: true, removed: 1 });
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 0);
  assert.equal((await retract({ statuses: ['1'], handles: 'r1' })).status, 400);
});

test('removal: only a listed account, once per 90 days, keeps only the handle and the hour', async () => {
  const w = world();
  await slopFrom(w, 'listed1', [1, 2, 3], { when: OLD, nets: 2 });
  await w.buildAt();
  const send = (body, ip = '192.0.2.1', now = T0 + HOUR) => w.req('POST', '/v1/removal', { body, ip, now });

  const unlisted = await send({ handle: 'nobody' });
  assert.deepEqual(unlisted.json, { ok: true, handle: 'nobody', state: 'unlisted' });
  const taken = await send({ handle: '@Listed1', reason: 'not me', contact: 'me@example.com' });
  assert.deepEqual(taken.json, { ok: true, handle: 'listed1', state: 'taken' });
  const again = await send({ handle: 'listed1' }, '198.51.100.1', T0 + 5 * DAY);
  assert.deepEqual(again.json, { ok: true, handle: 'listed1', state: 'standing', since: dayOf(T0) });
  const cols = w.db.raw.prepare('PRAGMA table_info(removals)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['at', 'handle']);
  assert.deepEqual(w.db.raw.prepare('SELECT handle, at FROM removals').all().map((x) => ({ ...x })), [{ handle: 'listed1', at: T0 + HOUR }]);
  assert.equal(JSON.stringify(w.db.raw.prepare('SELECT * FROM removals').all()).includes('not me'), false);

  // Form posts get a page saying what happened.
  const form = (handle) => w.req('POST', '/v1/removal', { raw: 'handle=' + encodeURIComponent(handle), headers: { 'content-type': 'application/x-www-form-urlencoded' }, now: T0 + 2 * HOUR });
  const page = await form('listed1');
  assert.match(page.res.headers.get('content-type'), /text\/html/);
  assert.ok(page.text.includes('<h1>Already requested</h1>'));
  assert.ok((await form('nobody')).text.includes('<h1>Not listed</h1>'));
  assert.ok((await form('<b>')).status === 400);

  // 90 days on, the request has lapsed; once the account is listed again, a new one is taken.
  const late = T0 + 91 * DAY;
  await slopFrom(w, 'listed1', [4, 5, 6], { when: late - 9 * DAY, nets: 2 });
  await w.buildAt(late);
  assert.deepEqual(await names(w, late), ['listed1']);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM removals'), 0, 'the lapsed request was pruned');
  assert.equal((await send({ handle: 'listed1' }, '192.0.2.1', late + HOUR)).json.state, 'taken');
});

test('removal limits: 5 per network and 50 in all per UTC day; refused requests store nothing', async () => {
  const w = world();
  const R = w.db.raw;
  const put = R.prepare('INSERT INTO listed (handle, reporters, since) VALUES (?, 3, ?)');
  for (let i = 0; i < 60; i++) put.run('acct' + i, T0);
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => w.req('POST', '/v1/removal', { body: { handle: 'acct' + i }, ip: '198.51.100.4' })));
  assert.equal(rs.filter((r) => r.json.state === 'taken').length, 5);
  const limited = rs.filter((r) => r.status === 429);
  assert.equal(limited.length, 3);
  for (const r of limited) assert.equal(r.json.retryAfter, DAY - (T0 % DAY));
  assert.equal(w.count('SELECT COUNT(*) AS c FROM removals'), 5);
  assert.equal(w.count("SELECT n AS c FROM counters WHERE kind = 'removal'"), 5);
  // 45 more from other networks reach the day's 50; the 51st is refused.
  for (let i = 8; i < 53; i++) assert.equal((await w.req('POST', '/v1/removal', { body: { handle: 'acct' + i }, ip: `203.0.${i}.1` })).json.state, 'taken');
  const over = await w.req('POST', '/v1/removal', { body: { handle: 'acct59' }, ip: '192.0.2.250' });
  assert.deepEqual([over.status, over.json.reason], [429, 'too many removal requests today']);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM removals'), 50);
  assert.equal(w.count("SELECT n AS c FROM counters WHERE kind = 'removal_all'"), 50);
  assert.equal(w.count("SELECT COUNT(*) AS c FROM counters WHERE kind = 'removal' AND n > 5"), 0);
  const next = await w.req('POST', '/v1/removal', { body: { handle: 'acct59' }, ip: '192.0.2.250', now: T0 + DAY });
  assert.equal(next.json.state, 'taken');
});

test('admin: the list override and the removal review routes are gone; delist and clear remain', async () => {
  const w = world();
  await slopFrom(w, 'rule', [1, 2, 3], { when: OLD, nets: 2 });
  await w.buildAt();
  assert.equal((await w.admin('POST', '/v1/admin/override', { handle: 'manual', action: 'list' })).status, 400);
  assert.equal((await w.admin('GET', '/v1/admin/removals?status=open')).status, 404);
  assert.equal((await w.admin('POST', '/v1/admin/removal', { id: 1, status: 'done' })).status, 404);
  assert.equal((await w.admin('POST', '/v1/admin/override', { handle: 'Rule', action: 'delist' })).status, 200);
  assert.deepEqual(await names(w), []);
  assert.equal((await w.admin('POST', '/v1/admin/override', { handle: 'rule', action: 'clear' })).status, 200);
  assert.deepEqual(await names(w), ['rule']);
  await w.req('POST', '/v1/removal', { body: { handle: 'rule' }, now: T0 + HOUR });
  const c = (await w.admin('GET', '/v1/admin/candidates', undefined, T0 + HOUR)).json.candidates;
  assert.deepEqual([c[0].handle, c[0].slop_reporters, c[0].slop_reporters_all, c[0].removal_requested], ['rule', 0, 3, T0 + HOUR]);
});

test('migration 0002: each install keeps its newest report per account, a tie goes to Not slop, open removal requests carry over', async () => {
  const { makeDb, migrationText } = await import('./d1shim.mjs');
  const db = makeDb({ upTo: '0001_init.sql' });
  const R = db.raw;
  const rep = R.prepare('INSERT INTO reports (reporter, status, handle, thread, hash, label, net, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  rep.run('a', '1', 'h1', '10', '0123456789abcdef', 'slop', 'n1', T0 - 3 * DAY);
  rep.run('a', '2', 'h1', '11', null, 'not_slop', 'n2', T0 - DAY); // newer: kept
  rep.run('a', '3', 'h2', null, null, 'slop', 'n1', T0);
  rep.run('b', '4', 'h1', '12', null, 'slop', 'n3', T0); // same hour as the next: Not slop wins
  rep.run('b', '5', 'h1', '13', null, 'not_slop', 'n3', T0);
  R.prepare("INSERT INTO overrides (handle, action, note, at) VALUES ('manual', 'list', NULL, 1), ('kept', 'delist', 'x', 2)").run();
  const rem = R.prepare('INSERT INTO removals (handle, reason, contact, net, at, status) VALUES (?, ?, ?, ?, ?, ?)');
  rem.run('h1', 'why', 'me@example.com', 'n', T0 - 5 * DAY, 'open');
  rem.run('h1', null, null, 'n', T0 - 2 * DAY, 'open');
  rem.run('h2', null, null, 'n', T0, 'done');
  R.exec(migrationText('0002_verdicts.sql'));
  const rows = R.prepare('SELECT reporter, handle, status, thread, label, net, at, labeled FROM reports ORDER BY reporter, handle').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { reporter: 'a', handle: 'h1', status: '2', thread: '11', label: 'not_slop', net: 'n2', at: T0 - DAY, labeled: T0 - DAY },
    { reporter: 'a', handle: 'h2', status: '3', thread: null, label: 'slop', net: 'n1', at: T0, labeled: T0 },
    { reporter: 'b', handle: 'h1', status: '5', thread: '13', label: 'not_slop', net: 'n3', at: T0, labeled: T0 },
  ]);
  assert.deepEqual(R.prepare('SELECT handle, at FROM removals').all().map((r) => ({ ...r })), [{ handle: 'h1', at: T0 - 2 * DAY }]);
  assert.deepEqual(R.prepare('SELECT handle FROM overrides').all().map((r) => r.handle), ['kept']);
  const idx = R.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reports' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(idx, ['reports_handle', 'reports_labeled']);
  // The migrated database is the one every other test starts from.
  const fresh = makeDb().raw;
  const shape = (raw) => raw.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => [r.name, r.sql]);
  assert.deepEqual(shape(R), shape(fresh));
});
