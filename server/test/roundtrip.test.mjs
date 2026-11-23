// The extension and this server against each other: the request bodies the
// extension's lib builds go to the server's real handler, its real answers go
// back through the lib, and the list the server builds is downloaded through
// the extension's own Recommended code. Neither side's fakes are used, so a
// field one side renames fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, T0, HOUR, DAY } from './helpers.mjs';

const L = createRequire(import.meta.url)('../../src/lib.js');
const CROWD_URL = `${L.DEFAULTS.crowdBase}/v1/list.ndjson`;
const KEY = 'c0ffee00c0ffee00c0ffee00c0ffee00';

// What saveLabel queues for a label record: its report alone (label, account,
// post, page and day; never the words). The send takes the account back first
// when the server may hold the other side.
function queued(st, rec) {
  const r = L.reportOf(rec);
  assert.ok(r, `a report for ${rec.url}`);
  return L.enqueueShare(st, r);
}
const label = (handle, status, thread, text = 'great point, totally agree') => ({
  at: T0,
  label: 'slop',
  handle,
  url: `https://x.com/${handle}/status/${status}`,
  text,
  page: thread ? `https://x.com/op/status/${thread}` : null,
});

// One request as the background sends it, and the answer as the background reads it.
// rand is the lib's jitter source; 0 gives the earliest time the lib may retry.
async function send(w, st, { ip = '198.51.100.7', now = T0, rand = () => 0 } = {}) {
  const batch = L.shareBatch(st);
  assert.ok(batch, 'something to send');
  const r = await w.req('POST', batch.path, { raw: JSON.stringify(batch.body), headers: { 'content-type': 'text/plain;charset=UTF-8' }, ip, now });
  assert.equal(r.res.headers.get('access-control-allow-origin'), '*', `${batch.path} ${r.status} carries CORS`);
  return { batch, r, next: L.shareResult(st, batch, { status: r.status, body: r.json }, now, rand) };
}

test('round trip: reports the extension builds are taken whole, then retracted, and the server keeps no words', async () => {
  const w = world();
  let st = L.shareState({ key: KEY });
  st = queued(st, label('Reply_A', '2', '1'));
  st = queued(st, label('reply_b', '3', null, ''));
  const { batch, r, next } = await send(w, st);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.accepted, r.json.rejected, r.json.deferred], [['2', '3'], [], []]);
  // What went over the wire holds the day of each label and no hash of the words.
  assert.deepEqual(batch.body.reports.map((x) => x.day), ['2026-06-01', '2026-06-01']);
  assert.equal(JSON.stringify(batch.body).includes('hash'), false);
  assert.deepEqual([next.queue, next.sent, next.lastError, next.retryAt], [[], 2, null, null]);
  const rows = w.db.raw.prepare('SELECT handle, status, thread FROM reports ORDER BY status').all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { handle: 'reply_a', status: '2', thread: '1' },
    { handle: 'reply_b', status: '3', thread: null },
  ]);
  // The server keeps no words.
  const kept = JSON.stringify(w.db.raw.prepare('SELECT * FROM reports').all());
  assert.equal(kept.includes('great point'), false);
  // Clearing the label sends a retraction, which the server applies and the lib drops.
  const back = await send(w, L.enqueueShare(next, { retract: '2' }));
  assert.deepEqual([back.r.status, back.r.json.ok, back.r.json.removed, back.next.queue], [200, true, 1, []]);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 1);
});

test('round trip: past the daily cap the server puts reports off, and the lib waits until the time it gives', async () => {
  const w = world();
  let st = L.shareState({ key: KEY });
  for (let i = 1; i <= 120; i++) st = queued(st, label(`acct_${i}`, String(1000 + i), '1'));
  const one = await send(w, st);
  const two = await send(w, one.next);
  assert.deepEqual([one.r.json.accepted.length, two.r.json.accepted.length, two.next.queue.length], [50, 50, 20]);
  const three = await send(w, two.next);
  assert.deepEqual([three.r.status, three.r.json.accepted.length, three.r.json.deferred.length], [200, 0, 20]);
  assert.equal(three.next.queue.length, 20, 'put off, not dropped');
  assert.equal(three.next.retryAt, Date.UTC(2026, 5, 2), 'until the next UTC day');
  assert.equal(three.next.sent, 100);
});

test('round trip: an 11th new install on one network is told to wait, and the lib keeps its reports', async () => {
  const w = world();
  for (let i = 0; i < 10; i++) {
    const st = queued(L.shareState({ key: i.toString(16).padStart(32, 'a') }), label('x', String(10 + i), '1'));
    assert.equal((await send(w, st)).r.status, 200);
  }
  const st = queued(L.shareState({ key: KEY }), label('x', '99', '1'));
  const { r, next } = await send(w, st);
  assert.equal(r.status, 429);
  assert.deepEqual([next.queue.length, next.retryAt], [1, T0 + L.msToUtcMidnight(T0)]);
  assert.match(next.lastError, /^the server asked to wait: /);
  // The same install from another network is let in.
  const other = await send(w, st, { ip: '203.0.113.9' });
  assert.deepEqual([other.r.status, other.next.queue], [200, []]);
});

test('round trip: forget, in the body the background sends, removes what that install sent', async () => {
  const w = world();
  let st = L.shareState({ key: KEY });
  st = queued(st, label('reply_a', '2', '1'));
  st = queued(st, label('reply_b', '3', '4'));
  await send(w, st);
  const r = await w.req('POST', '/v1/forget', { raw: JSON.stringify({ v: 1, key: KEY }), headers: { 'content-type': 'text/plain;charset=UTF-8' } });
  assert.deepEqual([r.status, r.json.ok, r.json.removed], [200, true, 2]);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 0);
});

test("round trip: the list the server builds is what Recommended's third source reads", async () => {
  const w = world();
  const fetchFromServer = async (now) => {
    const served = async (url, init) => {
      assert.equal(url, CROWD_URL);
      assert.equal(init.credentials, 'omit');
      const r = await w.req('GET', '/v1/list.ndjson', { now });
      return new Response(r.text, { status: r.status, headers: r.res.headers });
    };
    const rec = L.BUILTIN_LISTS.find((b) => b.id === 'recommended');
    const src = rec.sources.find((s) => s.url === CROWD_URL);
    return L.fetchList({ ...src, fetchImpl: served });
  };
  // Before any build: an empty file, which this source may be.
  const empty = await fetchFromServer(T0);
  assert.deepEqual([empty.ok, empty.handles], [true, []]);
  // Three installs, each on its own network (/24), report one account in two
  // threads; a build once the installs and reports are old enough lists it.
  for (const [i, status, thread] of [[1, '21', '1'], [2, '22', '1'], [3, '23', '5']]) {
    const st = queued(L.shareState({ key: i.toString(16).padStart(32, 'b') }), label('Slop_Acct', status, thread));
    assert.equal((await send(w, st, { ip: `198.51.${i}.1` })).r.status, 200);
  }
  // Too soon: the reports are under a day old and the installs under a week.
  await w.buildAt(T0 + 2 * HOUR);
  assert.deepEqual((await fetchFromServer(T0 + 3 * HOUR)).handles, []);
  const later = T0 + 8 * DAY;
  await w.buildAt(later);
  const got = await fetchFromServer(later + HOUR);
  assert.deepEqual([got.ok, got.handles], [true, ['slop_acct']]);
});

// ---------------------------------------------------------------- 0.11.0 wire (planted negatives first)

const when = (d, h = 9) => Date.UTC(2026, 4, d, h, 0, 0);
const rec = (handle, status, o = {}) => ({ at: when(29), label: 'slop', handle, url: `https://x.com/${handle}/status/${status}`, text: 'words', page: 'https://x.com/op/status/1', ...o });
const verdicts = (w) => w.db.raw.prepare('SELECT handle, status, latest, label, labeled FROM reports ORDER BY handle').all().map((x) => ({ ...x }));
const sendAll = async (w, st, o) => {
  let cur = st;
  for (let i = 0; i < 6 && L.shareBatch(cur); i++) cur = (await send(w, cur, o)).next;
  return cur;
};

test('planted negative 3: clearing the first of two labels on an account leaves the server holding the other', async () => {
  const w = world();
  const a = rec('acct_z', '31', { at: when(29) });
  const b = rec('acct_z', '32', { at: when(31) });
  let st = L.shareState({ key: KEY });
  const stored = [];
  // Each label saved goes through what the background queues for a save.
  for (const rec of [a, b]) {
    st = queued(st, rec);
    stored.push(rec);
    st = await sendAll(w, st);
  }
  assert.deepEqual(verdicts(w), [{ handle: 'acct_z', status: '31', latest: '32', label: 'slop', labeled: Date.UTC(2026, 4, 31) }]);
  // The reader clears label A: the plan the background makes for a clear.
  for (const it of L.shareItemsOnClear(stored, a, T0)) st = L.enqueueShare(st, it);
  st = await sendAll(w, st);
  assert.deepEqual(verdicts(w), [{ handle: 'acct_z', status: '32', latest: '32', label: 'slop', labeled: Date.UTC(2026, 4, 31) }]);
});

test('planted negative 4: Not slop on one post, then Slop on another post of the account the same UTC day, ends Slop on the server', async () => {
  const w = world();
  const a = rec('acct_y', '41', { label: 'not_slop', at: when(31, 8) });
  const b = rec('acct_y', '42', { label: 'slop', at: when(31, 10) });
  let st = await sendAll(w, queued(L.shareState({ key: KEY }), a));
  assert.equal(verdicts(w)[0].label, 'not_slop');
  // The reader then labels post B Slop: what the background queues for a save.
  st = await sendAll(w, queued(st, b));
  assert.deepEqual(verdicts(w).map((v) => [v.handle, v.status, v.label]), [['acct_y', '42', 'slop']]);
});

// Sharing turned off and on again as the background does it: off empties the
// queue and keeps the key (and what the server confirmed); on keeps them.
const off = (st) => L.shareState({ ...st, on: false, queue: [], retryAt: null });
const on = (st) => L.shareState({ ...st, on: true });

test('planted negative 5: Slop at 08:00, Not slop at 09:00 and Slop at 10:00 on one account the same UTC day; clearing the first leaves the server holding Slop', async () => {
  const w = world();
  const a = rec('acct_p', '71', { at: when(31, 8) });
  const b = rec('acct_p', '72', { at: when(31, 9), label: 'not_slop' });
  const c = rec('acct_p', '73', { at: when(31, 10) });
  // The server holds the account's newest label, C.
  let st = await sendAll(w, queued(L.shareState({ key: KEY }), c));
  assert.deepEqual(verdicts(w).map((v) => [v.status, v.label]), [['73', 'slop']]);
  // The reader clears A: the plan the background makes for a clear.
  for (const it of L.shareItemsOnClear([a, b, c], a, T0)) st = L.enqueueShare(st, it);
  st = await sendAll(w, st);
  assert.deepEqual(verdicts(w).map((v) => [v.handle, v.label]), [['acct_p', 'slop']]);
});

test('planted negative 6: Not slop shared, sharing off, the label changed to Slop the same day, on again with the saved labels: the server ends on Slop', async () => {
  const w = world();
  let st = await sendAll(w, queued(L.shareState({ key: KEY, on: true }), rec('acct_q', '81', { at: when(31, 9), label: 'not_slop' })));
  assert.deepEqual(verdicts(w).map((v) => v.label), ['not_slop']);
  st = off(st);
  // While sharing is off the reader changes the label to Slop: nothing is queued.
  const changed = rec('acct_q', '81', { at: when(31, 10) });
  // On again with "Also share" ticked: each account's newest label.
  st = on(st);
  for (const r of L.backfillReports([changed], T0)) st = L.enqueueShare(st, r);
  st = await sendAll(w, st);
  assert.deepEqual(verdicts(w).map((v) => [v.handle, v.status, v.label]), [['acct_q', '81', 'slop']]);
});

test('planted negative 7: Not slop shared, sharing off, changed to Slop the same day, on again without the saved labels, then Slop on another post: the server ends on Slop', async () => {
  const w = world();
  let st = await sendAll(w, queued(L.shareState({ key: KEY, on: true }), rec('acct_r', '91', { at: when(31, 9), label: 'not_slop' })));
  // Off; the label is changed to Slop; on again without "Also share".
  st = on(off(st));
  // Slop on another post of the account: the same side as its newest saved
  // label (the changed one), so the save queues its report alone.
  st = await sendAll(w, queued(st, rec('acct_r', '92', { at: when(31, 11) })));
  assert.deepEqual(verdicts(w).map((v) => [v.handle, v.label]), [['acct_r', 'slop']]);
});

test('round trip: a change of side queued, sharing turned off before it went, on again, then another label on that side: the server ends on that side', async () => {
  const w = world();
  let st = await sendAll(w, queued(L.shareState({ key: KEY, on: true }), rec('acct_s', '101', { at: when(31, 8), label: 'not_slop' })));
  // Slop on another post is queued, but sharing goes off before it is sent.
  st = off(queued(st, rec('acct_s', '102', { at: when(31, 9) })));
  st = await sendAll(w, queued(on(st), rec('acct_s', '103', { at: when(31, 10) })));
  assert.deepEqual(verdicts(w).map((v) => [v.status, v.label]), [['103', 'slop']]);
});

test('round trip: a report queued by 0.10.0 (dated by the hour it arrives), then the other side the same day, either way round, ends on the newer side', async () => {
  for (const [first, then] of [['slop', 'not_slop'], ['not_slop', 'slop']]) {
    const w = world();
    const legacy = { op: 'report', label: first, handle: 'acct_l', status: '111', thread: '1', hash: 'a'.repeat(16), seq: 1 };
    let st = await sendAll(w, L.shareState({ key: KEY, queue: [legacy], seq: 1 }));
    assert.deepEqual(verdicts(w).map((v) => [v.label, v.labeled]), [[first, T0]]);
    // Dated by its day, the next label is earlier than the hour the first was:
    // the server would keep the first, unless the account is taken back.
    st = await sendAll(w, queued(st, rec('acct_l', '112', { at: T0 + HOUR, label: then })));
    assert.deepEqual(verdicts(w).map((v) => v.label), [then], `${first} then ${then}`);
  }
});

test('round trip: a key 0.10.0 sent with takes each account back once before its first 0.11.0 report, then sends reports alone', async () => {
  const w = world();
  // 0.10.0 sent Not slop (dated by the hour it arrived); its record kept no held.
  let st = await sendAll(w, L.shareState({ key: KEY, queue: [{ op: 'report', label: 'not_slop', handle: 'acct_m', status: '121', thread: '1', hash: 'b'.repeat(16), seq: 1 }], seq: 1 }));
  st = L.shareState({ key: st.key, on: true, sent: st.sent, seq: st.seq });
  assert.equal(st.legacy, true);
  const paths = [];
  const go = async (cur) => {
    for (let i = 0; i < 6 && L.shareBatch(cur); i++) {
      const r = await send(w, cur);
      paths.push(r.batch.path);
      cur = r.next;
    }
    return cur;
  };
  st = await go(queued(st, rec('acct_m', '122', { at: T0 + HOUR })));
  assert.deepEqual(paths, ['/v1/retract', '/v1/reports']);
  assert.deepEqual(verdicts(w).map((v) => [v.status, v.label]), [['122', 'slop']]);
  st = await go(queued(st, rec('acct_m', '123', { at: T0 + 2 * HOUR })));
  assert.deepEqual(paths, ['/v1/retract', '/v1/reports', '/v1/reports']);
});

test('round trip: sharing on again with the saved labels takes nothing back where the server holds the same side, and no verdict is lost on the way', async () => {
  const w = world();
  const recs = Array.from({ length: 150 }, (_, i) => rec(`acct_${i}`, String(1000 + i), { at: when(20), label: i % 3 ? 'slop' : 'not_slop' }));
  const want = recs.map((r) => [r.handle, r.label]).sort();
  const held = () => verdicts(w).map((v) => [v.handle, v.label]).sort();
  const paths = [];
  // Sent over days, as the server takes 100 reports from an install a day.
  const go = async (cur, day) => {
    for (let i = 0; i < 6 && L.shareBatch(cur); i++) {
      const r = await send(w, cur, { now: T0 + day * DAY });
      paths.push(r.batch.path);
      cur = r.next;
      if (cur.retryAt) break;
    }
    return cur;
  };
  let st = L.shareState({ key: KEY, on: true });
  for (const r of recs) st = queued(st, r);
  st = await go(st, 0);
  st = await go(st, 1);
  assert.deepEqual(held(), want);
  st = on(off(st));
  for (const r of L.backfillReports(recs, T0 + 2 * DAY)) st = L.enqueueShare(st, r);
  assert.equal(st.queue.length, 150);
  for (const day of [2, 3]) {
    st = await go(st, day);
    assert.deepEqual(held(), want, `day ${day}`);
  }
  assert.equal(st.queue.length, 0);
  assert.equal(paths.includes('/v1/retract'), false, paths.join(' '));
});

test('round trip: a backfill of old labels is taken whole by the server, the oldest day it sends being inside the days the server takes', async () => {
  const w = world();
  const at = (daysAgo) => T0 - daysAgo * DAY;
  const records = [rec('acct_a', '51', { at: at(88) }), rec('acct_b', '52', { at: at(60) }), rec('acct_c', '53', { at: at(89) }), rec('acct_d', '54', { at: at(3), label: 'not_slop' })];
  let st = L.shareState({ key: KEY });
  for (const r of L.backfillReports(records, T0)) st = L.enqueueShare(st, r);
  assert.deepEqual(st.queue.map((i) => i.handle), ['acct_d', 'acct_b', 'acct_a'], 'newest first, the 89-day-old label left out');
  const { batch, r } = await send(w, st);
  assert.deepEqual([r.status, r.json.accepted, r.json.rejected, r.json.deferred], [200, ['54', '52', '51'], [], []]);
  assert.deepEqual(batch.body.reports.map((x) => x.day), ['2026-05-29', '2026-04-02', '2026-03-05']);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 3);
});

test('round trip: a report queued by 0.10.0 (a hash, no day) goes without either and is taken, dated by the hour it arrived', async () => {
  const w = world();
  const legacy = { op: 'report', label: 'slop', handle: 'acct_l', status: '61', thread: '1', hash: 'a'.repeat(16), seq: 1 };
  const st = L.shareState({ key: KEY, queue: [legacy], seq: 1 });
  const { batch, r, next } = await send(w, st);
  assert.deepEqual(batch.body.reports, [{ label: 'slop', handle: 'acct_l', status: '61', thread: '1' }]);
  assert.deepEqual([r.status, r.json.accepted, next.queue], [200, ['61'], []]);
  assert.equal(w.db.raw.prepare('SELECT labeled FROM reports').get().labeled, T0);
});
