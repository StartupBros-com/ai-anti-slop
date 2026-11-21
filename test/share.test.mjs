// Sharing labels (#81), the parts in lib: the switch, the install key, the
// hash of a post's words, the report a label makes, the queue, the request
// it sends and what each answer does to it. The background's use of them is
// in wiring.test.mjs. Handles and post ids are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lib as L } from './helpers.mjs';

const KEY = '0123456789abcdef0123456789abcdef';
const sha16 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const label = (o = {}) => ({ at: 1, label: 'slop', handle: 'reply_a', url: 'https://x.com/reply_a/status/2', text: 'hello', page: 'https://x.com/op/status/1', ...o });
const report = (status, o = {}) => ({ label: 'slop', handle: 'reply_a', status, thread: '1', hash: null, ...o });

test("sharing is on only when the sharing record's on is true; a sharing field in settings is not the switch", () => {
  for (const v of [undefined, null, false, 'true', 1, {}]) assert.equal(L.shareOn({ on: v }), false, String(v));
  assert.equal(L.shareOn(null), false);
  assert.equal(L.shareOn({}), false);
  assert.equal(L.shareOn('on'), false);
  assert.equal(L.shareOn({ on: true }), true);
  assert.equal(L.shareOn({ sharing: true }), false);
  // Read through shareState, only true itself is kept.
  for (const v of [undefined, null, false, 'true', 1, {}]) assert.equal(L.shareState({ key: KEY, on: v }).on, false, String(v));
  assert.equal(L.shareOn(L.shareState({ key: KEY, on: true })), true);
});

test('the install key is 16 random bytes as 32 lowercase hex characters, new each time', () => {
  const a = L.newShareKey();
  const b = L.newShareKey();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  // From the bytes it is given, in order.
  const fixed = { getRandomValues: (u) => u.fill(0xab) };
  assert.equal(L.newShareKey(fixed), 'ab'.repeat(16));
});

test('the hash is the first 16 hex characters of the SHA-256 of the words, with case, spacing, links and @handles taken out', async () => {
  assert.equal(L.shareText('  Great point @Foo!\n https://t.co/x  TOTALLY '), 'great point ! totally');
  const h = await L.textHash('Great point @Foo! https://t.co/x  Totally');
  assert.equal(h, sha16('great point ! totally'));
  // The same reply from another account, with its own link and mention, hashes the same.
  assert.equal(await L.textHash('great POINT @bar! http://example.com/y totally'), h);
  // Full-width letters fold to the usual ones (NFKC).
  assert.equal(await L.textHash('ｈｅｌｌｏ'), sha16('hello'));
  // No words, no hash.
  for (const t of ['', '   ', '@only https://t.co/z', null, undefined]) assert.equal(await L.textHash(t), null, String(t));
});

test('a label makes a report of its label, account, post id and the id of the post whose page it was on', () => {
  assert.deepEqual(L.reportOf(label()), { label: 'slop', handle: 'reply_a', status: '2', thread: '1' });
  assert.deepEqual(L.reportOf(label({ label: 'not_slop', page: null })), { label: 'not_slop', handle: 'reply_a', status: '2', thread: null });
  // Never the words, the page's address or anything else the label keeps.
  assert.deepEqual(Object.keys(L.reportOf(label({ extra: true, allow: false, list: 'x', hidden: true }))).sort(), ['handle', 'label', 'status', 'thread']);
  // Not a label: no report.
  for (const bad of [null, {}, label({ label: 'maybe' }), label({ url: 'https://x.com/home' }), label({ handle: 'someone_else' }), label({ handle: '' })]) {
    assert.equal(L.reportOf(bad), null);
  }
});

test('the stored record is read defensively: a bad key, a bad item or a bad number is dropped', () => {
  assert.deepEqual(L.shareState(null), { on: false, key: null, queue: [], seq: 0, sent: 0, lastSentAt: null, lastError: null, retryAt: null });
  const st = L.shareState({
    on: 'true',
    key: KEY.toUpperCase(),
    queue: [
      { op: 'report', label: 'slop', handle: 'a', status: '1', thread: null, hash: null, seq: 1 },
      { op: 'report', label: 'slop', handle: 'a', status: 'x1', thread: null, hash: null, seq: 2 },
      { op: 'report', label: 'meh', handle: 'a', status: '3', thread: null, hash: null, seq: 3 },
      { op: 'report', label: 'slop', handle: 'a', status: '4', thread: null, hash: 'zz', seq: 4 },
      { op: 'retract', status: '5', seq: 5 },
      { op: 'retract', status: '6' },
      'junk',
    ],
    seq: 6,
    sent: -3,
    lastSentAt: 'yesterday',
    retryAt: 1.5,
  });
  assert.deepEqual(st, {
    on: false,
    key: null,
    queue: [
      { op: 'report', label: 'slop', handle: 'a', status: '1', thread: null, hash: null, seq: 1 },
      { op: 'retract', status: '5', seq: 5 },
    ],
    seq: 6,
    sent: 0,
    lastSentAt: null,
    lastError: null,
    retryAt: null,
  });
});

test('the queue keeps one item per post, the last word on it: a retraction replaces a report and a report a retraction', () => {
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, report('2'));
  st = L.enqueueShare(st, report('3', { label: 'not_slop', thread: null, hash: 'a'.repeat(16) }));
  st = L.enqueueShare(st, { retract: '2' });
  assert.deepEqual(st.queue, [
    { op: 'report', label: 'not_slop', handle: 'reply_a', status: '3', thread: null, hash: 'a'.repeat(16), seq: 2 },
    { op: 'retract', status: '2', seq: 3 },
  ]);
  st = L.enqueueShare(st, report('2', { label: 'not_slop' }));
  assert.deepEqual(st.queue.map((i) => [i.op, i.status, i.label, i.seq]), [['report', '3', 'not_slop', 2], ['report', '2', 'not_slop', 4]]);
  // Anything that is not a report the server takes is not queued.
  for (const bad of [report('x'), report('4', { label: 'meh' }), report('4', { handle: 'not a handle' }), report('4', { hash: 'XYZ' }), report('4', { thread: 'p' }), { retract: 'p' }, null]) {
    assert.deepEqual(L.enqueueShare(st, bad), st);
  }
});

test('the queue keeps at most shareQueueMax items, dropping the oldest', () => {
  let st = L.shareState({ key: KEY });
  const max = L.DEFAULTS.shareQueueMax;
  for (let i = 1; i <= max + 3; i++) st = L.enqueueShare(st, { retract: String(i) });
  assert.equal(st.queue.length, max);
  assert.deepEqual([st.queue[0].status, st.queue.at(-1).status], ['4', String(max + 3)]);
});

test('a request holds up to 50 retractions while any are queued, else up to 50 reports, in the shape the server reads', () => {
  assert.equal(L.shareBatch(L.shareState({})), null, 'no key, nothing to send');
  let st = L.shareState({ key: KEY });
  assert.equal(L.shareBatch(st), null, 'nothing queued');
  for (let i = 1; i <= 60; i++) st = L.enqueueShare(st, report(String(i), { hash: i === 1 ? 'b'.repeat(16) : null }));
  st = L.enqueueShare(st, { retract: '99' });
  const r = L.shareBatch(st);
  assert.deepEqual([r.path, r.key, r.body], ['/v1/retract', KEY, { v: 1, key: KEY, statuses: ['99'] }]);
  st.queue = st.queue.filter((i) => i.op !== 'retract');
  const b = L.shareBatch(st);
  assert.equal(b.path, '/v1/reports');
  assert.equal(b.body.reports.length, 50);
  assert.deepEqual(b.body.reports[0], { label: 'slop', handle: 'reply_a', status: '1', thread: '1', hash: 'b'.repeat(16) });
  assert.deepEqual(Object.keys(b.body).sort(), ['key', 'reports', 'v']);
  assert.equal(L.DEFAULTS.shareBatch, 50);
});

test('the time to UTC midnight', () => {
  assert.equal(L.msToUtcMidnight(Date.UTC(2026, 10, 21, 23, 0, 0)), 3600000);
  assert.equal(L.msToUtcMidnight(Date.UTC(2026, 11, 31, 0, 0, 0)), 86400000);
});

test('an answer of 200: taken and malformed items leave, put-off items stay until the time given, "#n" names the nth item', () => {
  const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
  let st = L.shareState({ key: KEY });
  for (const s of ['1', '2', '3', '4']) st = L.enqueueShare(st, report(s));
  const batch = L.shareBatch(st);
  const next = L.shareResult(st, batch, { status: 200, body: { ok: true, accepted: ['1'], rejected: ['#1'], deferred: ['3'], retryAfter: 5000 } }, NOW);
  // '4' was not named at all: it is not kept for ever.
  assert.deepEqual(next.queue.map((i) => i.status), ['3']);
  assert.deepEqual([next.sent, next.lastSentAt, next.lastError, next.retryAt], [1, NOW, 'the server refused 1 as malformed', NOW + 5000]);
  // Put off with no time given: until UTC midnight.
  const again = L.shareResult(next, L.shareBatch(next), { status: 200, body: { ok: true, accepted: [], rejected: [], deferred: ['3'] } }, NOW);
  assert.equal(again.retryAt, Date.UTC(2026, 10, 22));
  // All taken: nothing left, no wait, no error.
  const done = L.shareResult(again, L.shareBatch(again), { status: 200, body: { ok: true, accepted: ['3'], rejected: [], deferred: [] } }, NOW + 1);
  assert.deepEqual([done.queue, done.sent, done.lastError, done.retryAt], [[], 2, null, null]);
});

test('an answer to a retraction, a 429, a 5xx, a refusal and no answer at all', () => {
  const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, { retract: '7' });
  const b = L.shareBatch(st);
  assert.deepEqual(L.shareResult(st, b, { status: 200, body: { ok: true, removed: 0 } }, NOW).queue, []);
  const busy = L.shareResult(st, b, { status: 429, body: { ok: false, reason: 'too many new installs from this network today', retryAfter: 60000 } }, NOW);
  assert.deepEqual([busy.queue.length, busy.lastError, busy.retryAt], [1, 'the server asked to wait: too many new installs from this network today', NOW + 60000]);
  // A wait longer than a day and two hours is cut to that.
  assert.equal(L.shareResult(st, b, { status: 429, body: { retryAfter: 9e12 } }, NOW).retryAt, NOW + 26 * 3600000);
  const down = L.shareResult(st, b, { status: 503, body: null }, NOW);
  assert.deepEqual([down.queue.length, down.lastError, down.retryAt], [1, 'the server answered 503', NOW + 30 * 60000]);
  const odd = L.shareResult(st, b, { status: 200, body: { ok: false, reason: 'odd' } }, NOW);
  assert.deepEqual([odd.queue.length, odd.lastError], [1, 'the server answered 200: odd']);
  // Refused whole: sent again it would be refused again, so it goes.
  const bad = L.shareResult(st, b, { status: 400, body: { ok: false, reason: 'bad key' } }, NOW);
  assert.deepEqual([bad.queue, bad.lastError, bad.retryAt], [[], 'the server refused 1 (400: bad key)', null]);
  const big = L.shareResult(st, b, { status: 413, body: { ok: false, reason: 'body too large' } }, NOW);
  assert.deepEqual([big.queue, big.lastError, big.retryAt], [[], 'the server refused 1 (413: body too large)', null]);
  // Any other refusal may come from a proxy or a server mid-deploy: kept, and tried later.
  for (const status of [403, 404, 405, 408, 409, 410]) {
    const kept = L.shareResult(st, b, { status, body: null }, NOW);
    assert.deepEqual([kept.queue.length, kept.lastError, kept.retryAt], [1, `the server answered ${status}`, NOW + 30 * 60000], String(status));
  }
  const off =L.shareResult(st, b, { status: 0, error: 'Failed to fetch' }, NOW);
  assert.deepEqual([off.queue.length, off.lastError, off.retryAt], [1, 'could not reach the server (Failed to fetch)', NOW + 30 * 60000]);
});

test('an item replaced while its request was out stays queued; an answer for a deleted key changes nothing', () => {
  const NOW = 1000;
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, report('2'));
  const b = L.shareBatch(st);
  // The label is cleared while the report is out.
  const changed = L.enqueueShare(st, { retract: '2' });
  const after = L.shareResult(changed, b, { status: 200, body: { ok: true, accepted: ['2'], rejected: [], deferred: [] } }, NOW);
  assert.deepEqual(after.queue.map((i) => [i.op, i.status]), [['retract', '2']]);
  assert.equal(after.sent, 1);
  // Delete what I shared ran while the request was out: the record has no key.
  const gone = L.shareState(null);
  assert.deepEqual(L.shareResult(gone, b, { status: 200, body: { ok: true, accepted: ['2'] } }, NOW), gone);
});

test('the labels already saved become reports with their hashes; anything that is not a label is skipped', async () => {
  const reps = await L.backfillReports([label(), label({ label: 'meh' }), label({ url: 'https://x.com/b/status/5', handle: 'b', text: '', page: null })], (t) => L.textHash(t));
  assert.deepEqual(reps, [
    { label: 'slop', handle: 'reply_a', status: '2', thread: '1', hash: sha16('hello') },
    { label: 'slop', handle: 'b', status: '5', thread: null, hash: null },
  ]);
});
