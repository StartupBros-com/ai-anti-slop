import test from 'node:test';
import assert from 'node:assert/strict';
import { world, slopFrom, keyOf, RULES, T0, HOUR, DAY } from './helpers.mjs';

const item = (status) => ({ label: 'slop', handle: 'someone', status: String(status), thread: '1' });
const counter = (w, kind, subject) => {
  const r = w.db.raw.prepare('SELECT n FROM counters WHERE kind = ? AND subject = ?').get(kind, subject);
  return r ? Number(r.n) : null;
};
const toMidnight = DAY - (T0 % DAY);

test('limits: 30 parallel new installs on one network: 10 pass, 20 get 429, counters end exact', async () => {
  const w = world();
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => w.report(i + 1, [item(i + 1)], { ip: '203.0.113.7' })));
  assert.equal(rs.filter((r) => r.status === 200).length, RULES.NEW_INSTALLS_PER_NET_DAY);
  const limited = rs.filter((r) => r.status === 429);
  assert.equal(limited.length, 20);
  for (const r of limited) assert.equal(r.json.retryAfter, toMidnight);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reporters'), 10);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 10);
  assert.equal(counter(w, 'new_install', w.db.raw.prepare("SELECT subject FROM counters WHERE kind = 'new_install'").get().subject), 10);
  assert.equal(w.count("SELECT COUNT(*) AS c FROM counters WHERE kind = 'new_install'"), 1);
});

test('limits: parallel batches from one install accept exactly 100 and defer the rest with retryAfter', async () => {
  const w = world();
  assert.equal((await w.report(1, [item(1)])).status, 200); // registers the install
  const batch = (from) => Array.from({ length: 10 }, (_, i) => item(from + i));
  const rs = await Promise.all(Array.from({ length: 15 }, (_, k) => w.report(1, batch(1000 + k * 10))));
  const accepted = rs.reduce((n, r) => n + r.json.accepted.length, 0);
  const deferred = rs.reduce((n, r) => n + r.json.deferred.length, 0);
  assert.equal(accepted, RULES.REPORTS_PER_INSTALL_DAY - 1);
  assert.equal(deferred, 150 - accepted);
  for (const r of rs) if (r.json.deferred.length) assert.equal(r.json.retryAfter, toMidnight);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), RULES.REPORTS_PER_INSTALL_DAY);
  assert.equal(counter(w, 'report', w.db.raw.prepare("SELECT subject FROM counters WHERE kind = 'report'").get().subject), RULES.REPORTS_PER_INSTALL_DAY);
  // Install-capped reports never reached the global counter.
  assert.equal(counter(w, 'report_all', '*'), RULES.REPORTS_PER_INSTALL_DAY);
});

test('limits: the global daily cap defers the excess, and the counters give back what was not accepted', async () => {
  assert.equal(RULES.REPORTS_PER_DAY, 6000);
  const w = world();
  // RULES is frozen, so seed the global counter two short of the cap.
  const day = new Date(T0).toISOString().slice(0, 10);
  w.db.raw.prepare("INSERT INTO counters (kind, subject, day, n) VALUES ('report_all', '*', ?, ?)").run(day, RULES.REPORTS_PER_DAY - 2);
  const r = await w.report(1, [item(1), item(2), item(3), item(4), item(5)]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.accepted, ['1', '2']);
  assert.deepEqual(r.json.deferred, ['3', '4', '5']);
  assert.equal(r.json.retryAfter, toMidnight);
  assert.equal(counter(w, 'report_all', '*'), RULES.REPORTS_PER_DAY);
  const per = w.db.raw.prepare("SELECT n FROM counters WHERE kind = 'report'").get();
  assert.equal(Number(per.n), 2);
  // At the cap, a further request defers everything and changes nothing.
  const more = await w.report(1, [item(6)]);
  assert.deepEqual([more.json.accepted, more.json.deferred], [[], ['6']]);
  assert.equal(counter(w, 'report_all', '*'), RULES.REPORTS_PER_DAY);
  assert.equal(Number(w.db.raw.prepare("SELECT n FROM counters WHERE kind = 'report'").get().n), 2);
  // The next UTC day starts a fresh total.
  const next = await w.report(1, [item(6)], { now: T0 + DAY });
  assert.deepEqual(next.json.accepted, ['6']);
});

test('limits: parallel removal requests from one network: 5 pass, the rest get 429, counter ends at 5', async () => {
  const w = world();
  const rs = await Promise.all(
    Array.from({ length: 12 }, () => w.req('POST', '/v1/removal', { body: { handle: 'victim' }, ip: '198.51.100.4' })),
  );
  assert.equal(rs.filter((r) => r.status === 200).length, RULES.REMOVALS_PER_NET_DAY);
  const limited = rs.filter((r) => r.status === 429);
  assert.equal(limited.length, 12 - RULES.REMOVALS_PER_NET_DAY);
  for (const r of limited) assert.equal(r.json.retryAfter, toMidnight);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM removals'), RULES.REMOVALS_PER_NET_DAY);
  assert.equal(w.count("SELECT n AS c FROM counters WHERE kind = 'removal'"), RULES.REMOVALS_PER_NET_DAY);
});

test('status: reports is no longer counted, before or after a build', async () => {
  const w = world();
  await w.report(1, [item(1)]);
  assert.deepEqual((await w.req('GET', '/v1/status')).json, { ok: true, listed: 0, reporters: 1, builtAt: null });
  const stats = await w.buildAt();
  assert.deepEqual(stats, { listed: 0, reporters: 1 });
});

test('list cache: nothing is cached before the first build; the built list is cached', async () => {
  const w = world();
  const puts = [];
  const real = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async (k, v) => { puts.push(v); }, delete: async () => true } };
  try {
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const { handle } = await import('../src/core.js');
    const get = () => handle(new Request('https://t.example/v1/list.ndjson'), w.env, T0, ctx);
    const before = await get();
    assert.equal(before.status, 200);
    assert.equal(await before.text(), '');
    assert.match(before.headers.get('content-type'), /^application\/x-ndjson/);
    assert.equal(before.headers.get('cache-control'), 'no-store');
    await Promise.all(waits);
    assert.equal(puts.length, 0);
    await w.buildAt();
    const after = await get();
    assert.equal(after.headers.get('cache-control'), 'public, max-age=600');
    await Promise.all(waits);
    assert.equal(puts.length, 1);
  } finally {
    if (real === undefined) delete globalThis.caches;
    else globalThis.caches = real;
  }
});

test('admin rebuild clears the list cache entry', async () => {
  const w = world();
  const deleted = [];
  const real = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async (k) => { deleted.push(k.url); return true; } } };
  try {
    assert.equal((await w.admin('POST', '/v1/admin/rebuild')).status, 200);
    assert.deepEqual(deleted, ['https://t.example/v1/list.ndjson']);
  } finally {
    if (real === undefined) delete globalThis.caches;
    else globalThis.caches = real;
  }
});

test('retention: build drops old reporters with no reports, and closed removals past 90 days; keeps the rest', async () => {
  const w = world();
  const old = T0 - (RULES.EXPIRY_DAYS + 5) * DAY;
  const fresh = T0 - 2 * DAY;
  const R = w.db.raw;
  const addReporter = R.prepare('INSERT INTO reporters (id, first_seen) VALUES (?, ?)');
  addReporter.run('old_empty', old);
  addReporter.run('old_with_report', old);
  addReporter.run('new_empty', fresh);
  R.prepare("INSERT INTO reports (reporter, status, handle, label, net, at) VALUES ('old_with_report', '1', 'h', 'slop', 'n', ?)").run(T0 - DAY);
  // An old report expires in this same build, so its reporter goes too.
  addReporter.run('old_expiring', old);
  R.prepare("INSERT INTO reports (reporter, status, handle, label, net, at) VALUES ('old_expiring', '2', 'h', 'slop', 'n', ?)").run(old);
  const addRemoval = R.prepare('INSERT INTO removals (handle, net, at, status) VALUES (?, ?, ?, ?)');
  addRemoval.run('open_old', 'n', old, 'open');
  addRemoval.run('done_old', 'n', old, 'done');
  addRemoval.run('rejected_old', 'n', old, 'rejected');
  addRemoval.run('done_new', 'n', fresh, 'done');
  await w.buildAt();
  assert.deepEqual(R.prepare('SELECT id FROM reporters ORDER BY id').all().map((r) => r.id), ['new_empty', 'old_with_report']);
  assert.deepEqual(R.prepare('SELECT handle FROM removals ORDER BY handle').all().map((r) => r.handle), ['done_new', 'open_old']);
});

test('veto: not_slop counts only from aged installs and only once the report is past the wait', async () => {
  const notSlop = (w, ids, at) =>
    Promise.all(ids.map((i) => w.report(i, [{ label: 'not_slop', handle: 'target', status: String(9000 + i), thread: '900' }], { now: at, ip: `10.9.${i % 3}.5` })));
  const OLD = T0 - 10 * DAY;
  const listedNames = async (w) => (await w.body()).split('\n').filter(Boolean).map((l) => JSON.parse(l).username).filter((n) => n === 'target');

  // Fresh installs registered the same day veto nothing.
  const a = world();
  await slopFrom(a, 'target', [1, 2, 3], { when: OLD, nets: 2 });
  await notSlop(a, [11, 12, 13, 14, 15, 16], T0 - HOUR);
  await a.buildAt();
  assert.deepEqual(await listedNames(a), ['target']);

  // Aged installs whose not_slop report is still inside the wait do not veto either.
  const b = world();
  await slopFrom(b, 'target', [1, 2, 3], { when: OLD, nets: 2 });
  await slopFrom(b, 'filler', [11, 12, 13, 14, 15, 16], { when: OLD, nets: 2 }); // registers 11..16 as aged installs
  await notSlop(b, [11, 12, 13, 14, 15, 16], T0 - HOUR);
  await b.buildAt();
  assert.deepEqual(await listedNames(b), ['target']);

  // The same not_slop reports from aged installs, past the wait, keep it off.
  const c = world();
  await slopFrom(c, 'target', [1, 2, 3], { when: OLD, nets: 2 });
  await slopFrom(c, 'filler', [11, 12, 13, 14, 15, 16], { when: OLD, nets: 2 });
  await notSlop(c, [11, 12], T0 - 2 * DAY);
  await c.buildAt();
  assert.deepEqual(await listedNames(c), []);
});

test('listed is replaced by diff: an unchanged build writes no listed rows; changes write only their rows', async () => {
  const w = world();
  const OLD = T0 - 10 * DAY;
  let log = [];
  const orig = w.db.batch.bind(w.db);
  w.db.batch = async (stmts) => {
    const out = await orig(stmts);
    log = stmts.map((s, i) => ({ sql: s.sql, changes: out[i].meta.changes }));
    return out;
  };
  const listedWrites = () =>
    log
      .filter((e) => e.sql.trim().startsWith('DELETE FROM listed') || e.sql.trim().startsWith('UPDATE listed') || e.sql.trim().startsWith('INSERT INTO listed'))
      .reduce((n, e) => n + e.changes, 0);
  const rows = () => w.db.raw.prepare('SELECT handle, reporters, since FROM listed ORDER BY handle').all().map((r) => ({ ...r }));

  await slopFrom(w, 'alpha', [1, 2, 3], { when: OLD, nets: 2 });
  await w.buildAt(T0);
  assert.equal(listedWrites(), 1); // one new row
  const first = rows();
  assert.deepEqual(first.map((r) => [r.handle, r.reporters, r.since]), [['alpha', 3, T0]]);
  const body = await w.body();

  await w.buildAt(T0 + 6 * HOUR);
  assert.equal(listedWrites(), 0);
  assert.deepEqual(rows(), first);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM changes'), 1);
  assert.equal(await w.body(), body);

  // A fourth reporter changes one row's count and keeps its since.
  await slopFrom(w, 'alpha', [4], { when: OLD, nets: 2 });
  await w.buildAt(T0 + 12 * HOUR);
  assert.equal(listedWrites(), 1);
  assert.deepEqual(rows().map((r) => [r.handle, r.reporters, r.since]), [['alpha', 4, T0]]);

  // Losing every reporter deletes the row.
  w.db.raw.prepare('DELETE FROM reports').run();
  await w.buildAt(T0 + 18 * HOUR);
  assert.equal(listedWrites(), 1);
  assert.deepEqual(rows(), []);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM next_listed'), 0);
});

test('admin candidates: not_slop_reporters counts aged installs past the wait, as the build does', async () => {
  const w = world();
  const OLD = T0 - 10 * DAY;
  await slopFrom(w, 'target', [1, 2, 3], { when: OLD, nets: 2 });
  await slopFrom(w, 'filler', [11, 12, 13, 14], { when: OLD, nets: 2 }); // aged installs 11..14
  const ns = (i, at, ip) => w.report(i, [{ label: 'not_slop', handle: 'target', status: String(9000 + i), thread: '900' }], { now: at, ip });
  await ns(11, T0 - 2 * DAY, '10.9.1.5'); // aged install, past the wait: counts
  await ns(12, T0 - HOUR, '10.9.2.5'); // aged install, report too young: does not count
  await ns(21, T0 - 2 * DAY, '10.9.3.5'); // install registered inside the age window: does not count
  const get = async () => (await w.admin('GET', '/v1/admin/candidates')).json.candidates.find((c) => c.handle === 'target');
  assert.equal((await get()).not_slop_reporters, 1);
});
