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

// What saveLabel queues for a label record: its report, with the hash of its words.
async function queued(st, rec) {
  const r = L.reportOf(rec);
  assert.ok(r, `a report for ${rec.url}`);
  return L.enqueueShare(st, { ...r, hash: await L.textHash(rec.text) });
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
async function send(w, st, { ip = '198.51.100.7', now = T0 } = {}) {
  const batch = L.shareBatch(st);
  assert.ok(batch, 'something to send');
  const r = await w.req('POST', batch.path, { raw: JSON.stringify(batch.body), headers: { 'content-type': 'text/plain;charset=UTF-8' }, ip, now });
  assert.equal(r.res.headers.get('access-control-allow-origin'), '*', `${batch.path} ${r.status} carries CORS`);
  return { batch, r, next: L.shareResult(st, batch, { status: r.status, body: r.json }, now) };
}

test('round trip: reports the extension builds are taken whole, then retracted, and the server keeps no words', async () => {
  const w = world();
  let st = L.shareState({ key: KEY });
  st = await queued(st, label('Reply_A', '2', '1'));
  st = await queued(st, label('reply_b', '3', null, ''));
  const { r, next } = await send(w, st);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.accepted, r.json.rejected, r.json.deferred], [['2', '3'], [], []]);
  assert.deepEqual([next.queue, next.sent, next.lastError, next.retryAt], [[], 2, null, null]);
  const rows = w.db.raw.prepare('SELECT handle, status, thread FROM reports ORDER BY status').all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { handle: 'reply_a', status: '2', thread: '1' },
    { handle: 'reply_b', status: '3', thread: null },
  ]);
  // The lib still sends a hash of the words; the server checks it and keeps neither.
  assert.ok(next.sent && (await L.textHash('great point, totally agree')));
  const kept = JSON.stringify(w.db.raw.prepare('SELECT * FROM reports').all());
  assert.equal(kept.includes('great point'), false);
  assert.equal(kept.includes(await L.textHash('great point, totally agree')), false);
  // Clearing the label sends a retraction, which the server applies and the lib drops.
  const back = await send(w, L.enqueueShare(next, { retract: '2' }));
  assert.deepEqual([back.r.status, back.r.json.ok, back.r.json.removed, back.next.queue], [200, true, 1, []]);
  assert.equal(w.count('SELECT COUNT(*) AS c FROM reports'), 1);
});

test('round trip: past the daily cap the server puts reports off, and the lib waits until the time it gives', async () => {
  const w = world();
  let st = L.shareState({ key: KEY });
  for (let i = 1; i <= 120; i++) st = await queued(st, label(`acct_${i}`, String(1000 + i), '1'));
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
    const st = await queued(L.shareState({ key: i.toString(16).padStart(32, 'a') }), label('x', String(10 + i), '1'));
    assert.equal((await send(w, st)).r.status, 200);
  }
  const st = await queued(L.shareState({ key: KEY }), label('x', '99', '1'));
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
  st = await queued(st, label('reply_a', '2', '1'));
  st = await queued(st, label('reply_b', '3', '4'));
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
    const st = await queued(L.shareState({ key: i.toString(16).padStart(32, 'b') }), label('Slop_Acct', status, thread));
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
