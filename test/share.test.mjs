// Sharing labels (#81), the parts in lib: the switch, the install key, the
// report a label makes, the queue, the request it sends and what each answer
// does to it. The background's use of them is
// in wiring.test.mjs. Handles and post ids are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib as L } from './helpers.mjs';

const KEY = '0123456789abcdef0123456789abcdef';
const label = (o = {}) => ({ at: 1, label: 'slop', handle: 'reply_a', url: 'https://x.com/reply_a/status/2', text: 'hello', page: 'https://x.com/op/status/1', ...o });
const DAYMS = 86400000;
const NOW11 = Date.UTC(2026, 10, 22, 12, 0, 0);
const R0 = () => 0;
const at = (daysAgo, hour = 9) => Date.UTC(2026, 10, 22 - daysAgo, hour, 0, 0);
const post = (handle, id, o = {}) => ({ at: at(1), label: 'slop', handle, url: `https://x.com/${handle}/status/${id}`, text: 'some words', page: 'https://x.com/op/status/1', ...o });
const report = (status, o = {}) => ({ label: 'slop', handle: 'reply_a', status, thread: '1', day: null, ...o });

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

test('a label makes a report of its label, account, post id, the id of the post whose page it was on and the UTC day it was made', () => {
  assert.deepEqual(L.reportOf(label()), { label: 'slop', handle: 'reply_a', status: '2', thread: '1', day: '1970-01-01' });
  assert.deepEqual(L.reportOf(label({ label: 'not_slop', page: null, at: Date.UTC(2026, 10, 21, 23, 59, 59) })), { label: 'not_slop', handle: 'reply_a', status: '2', thread: null, day: '2026-11-21' });
  // A record with no usable time has no day.
  for (const at of [undefined, null, 0, -5, NaN, '2026', Infinity]) assert.equal(L.reportOf(label({ at })).day, null, String(at));
  // Never the words, the page's address or anything else the label keeps.
  assert.deepEqual(Object.keys(L.reportOf(label({ extra: true, allow: false, list: 'x', hidden: true }))).sort(), ['day', 'handle', 'label', 'status', 'thread']);
  // Not a label: no report.
  for (const bad of [null, {}, label({ label: 'maybe' }), label({ url: 'https://x.com/home' }), label({ handle: 'someone_else' }), label({ handle: '' })]) {
    assert.equal(L.reportOf(bad), null);
  }
});

test('the stored record is read defensively: a bad key, a bad item or a bad number is dropped', () => {
  assert.deepEqual(L.shareState(null), { on: false, key: null, queue: [], seq: 0, sent: 0, lastSentAt: null, lastError: null, retryAt: null, fails: 0, held: {}, legacy: false, asked: false });
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
    fails: -2,
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
    fails: 0,
    held: {},
    legacy: false,
    asked: false,
  });
  assert.equal(L.shareState({ fails: 3 }).fails, 3);
  assert.equal(L.shareState({ fails: 1.5 }).fails, 0);
  // asked is true only when it is exactly true.
  for (const v of ['true', 1, {}, null, undefined, false]) assert.equal(L.shareState({ asked: v }).asked, false, String(v));
  assert.equal(L.shareState({ asked: true }).asked, true);
  // A code means sharing was turned on once (0.10.0 kept no answer): answered.
  assert.equal(L.shareState({ key: KEY, sent: 3 }).asked, true);
  assert.equal(L.shareState({ key: 'not a key' }).asked, false);
  // Queueing keeps it.
  assert.equal(L.enqueueShare({ asked: true, key: KEY, on: true }, report('9')).asked, true);
});

test('a 0.10.0 queue item (a hash, no day) survives the update and is sent with neither; a bad day or hash is dropped', () => {
  const old = { op: 'report', label: 'slop', handle: 'a', status: '1', thread: '1', hash: 'b'.repeat(16), seq: 1 };
  const st = L.shareState({ key: KEY, queue: [old, { ...old, status: '2', hash: null, seq: 2 }, { ...old, status: '3', day: 'yesterday', seq: 3 }, { ...old, status: '4', day: '2026-02-30', seq: 4 }, { ...old, status: '5', day: '2026-11-20', seq: 5 }], seq: 5 });
  assert.deepEqual(st.queue.map((i) => i.status), ['1', '2', '5']);
  assert.deepEqual(st.queue[0], old, 'kept as it was stored');
  const b = L.shareBatch(st);
  // The dated one first, then the undated in the order queued; no hash anywhere.
  assert.deepEqual(b.body.reports, [
    { label: 'slop', handle: 'a', status: '5', thread: '1', day: '2026-11-20' },
    { label: 'slop', handle: 'a', status: '1', thread: '1' },
    { label: 'slop', handle: 'a', status: '2', thread: '1' },
  ]);
  assert.equal(JSON.stringify(b.body).includes('hash'), false);
  assert.equal(JSON.stringify(b.body).includes('bbbb'), false);
  // An answer for the legacy item takes it off the queue like any other.
  const next = L.shareResult(st, b, { status: 200, body: { ok: true, accepted: ['5', '1', '2'], rejected: [], deferred: [] } }, NOW11);
  assert.deepEqual([next.queue, next.sent, next.fails], [[], 3, 0]);
});

test('the queue keeps one item per post, the last word on it: a retraction replaces a report and a report a retraction; and one report per account', () => {
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, report('2'));
  // A hash in the item is not kept: 0.11.0 sends none.
  st = L.enqueueShare(st, report('3', { handle: 'reply_b', label: 'not_slop', thread: null, day: '2026-11-20', hash: 'a'.repeat(16) }));
  st = L.enqueueShare(st, { retract: '2' });
  assert.deepEqual(st.queue, [
    { op: 'report', label: 'not_slop', handle: 'reply_b', status: '3', thread: null, day: '2026-11-20', seq: 2 },
    { op: 'retract', status: '2', seq: 3 },
  ]);
  st = L.enqueueShare(st, report('2', { label: 'not_slop' }));
  assert.deepEqual(st.queue.map((i) => [i.op, i.status, i.label, i.seq]), [['report', '3', 'not_slop', 2], ['report', '2', 'not_slop', 4]]);
  // The server keeps one verdict per account, so a report replaces the one
  // queued for the same account, whichever post it was about.
  st = L.enqueueShare(st, report('7', { handle: 'reply_b', label: 'slop' }));
  assert.deepEqual(st.queue.map((i) => [i.op, i.handle, i.status, i.label]), [['report', 'reply_a', '2', 'not_slop'], ['report', 'reply_b', '7', 'slop']]);
  // A retraction of a post leaves the account's report on another post.
  st = L.enqueueShare(st, { retract: '3' });
  assert.deepEqual(st.queue.map((i) => [i.op, i.status]), [['report', '2'], ['report', '7'], ['retract', '3']]);
  // Anything that is not a report the server takes is not queued.
  for (const bad of [report('x'), report('4', { label: 'meh' }), report('4', { handle: 'not a handle' }), report('4', { day: '2026-13-01' }), report('4', { day: 'today' }), report('4', { thread: 'p' }), { retract: 'p' }, { retractHandle: 'not a handle' }, { retractHandle: '' }, null]) {
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
  for (let i = 1; i <= 60; i++) st = L.enqueueShare(st, report(String(i), { handle: `acct_${i}` }));
  st = L.enqueueShare(st, { retract: '99' });
  const r = L.shareBatch(st);
  assert.deepEqual([r.path, r.key, r.body], ['/v1/retract', KEY, { v: 1, key: KEY, statuses: ['99'] }]);
  // Retractions of accounts ride in the same request, in `handles`.
  st = L.enqueueShare(st, { retractHandle: '@Acct_One' });
  assert.deepEqual(L.shareBatch(st).body, { v: 1, key: KEY, statuses: ['99'], handles: ['acct_one'] });
  st.queue = st.queue.filter((i) => i.op === 'report');
  const b = L.shareBatch(st);
  assert.equal(b.path, '/v1/reports');
  assert.equal(b.body.reports.length, 50);
  assert.deepEqual(b.body.reports[0], { label: 'slop', handle: 'acct_1', status: '1', thread: '1' }, 'an undated report sends no day');
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
  for (const s of ['1', '2', '3', '4']) st = L.enqueueShare(st, report(s, { handle: `acct_${s}` }));
  const batch = L.shareBatch(st);
  const next = L.shareResult(st, batch, { status: 200, body: { ok: true, accepted: ['1'], rejected: ['#1'], deferred: ['3'], retryAfter: 5000 } }, NOW, R0);
  // '4' was not named at all: it is not kept for ever.
  assert.deepEqual(next.queue.map((i) => i.status), ['3']);
  assert.deepEqual([next.sent, next.lastSentAt, next.lastError, next.retryAt], [1, NOW, 'the server refused 1 as malformed', NOW + 5000]);
  // With the most jitter it is an hour later still.
  assert.equal(L.shareResult(st, batch, { status: 200, body: { ok: true, accepted: ['1'], rejected: ['#1'], deferred: ['3'], retryAfter: 5000 } }, NOW, () => 1).retryAt, NOW + 5000 + 3600000);
  // Put off with no time given: until UTC midnight.
  const again = L.shareResult(next, L.shareBatch(next), { status: 200, body: { ok: true, accepted: [], rejected: [], deferred: ['3'] } }, NOW, R0);
  assert.equal(again.retryAt, Date.UTC(2026, 10, 22));
  assert.equal(L.shareResult(next, L.shareBatch(next), { status: 200, body: { ok: true, accepted: [], rejected: [], deferred: ['3'] } }, NOW, () => 1).retryAt, Date.UTC(2026, 10, 22) + 3600000);
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
  const busy = L.shareResult(st, b, { status: 429, body: { ok: false, reason: 'too many new installs from this network today', retryAfter: 60000 } }, NOW, R0);
  assert.deepEqual([busy.queue.length, busy.lastError, busy.retryAt], [1, 'the server asked to wait: too many new installs from this network today', NOW + 60000]);
  // A wait longer than a day and two hours is cut to that.
  assert.equal(L.shareResult(st, b, { status: 429, body: { retryAfter: 9e12 } }, NOW, R0).retryAt, NOW + 26 * 3600000);
  const down = L.shareResult(st, b, { status: 503, body: null }, NOW, R0);
  // 30 minutes, with 0.75 to 1.25 times that for the jitter.
  assert.deepEqual([down.queue.length, down.lastError, down.retryAt, down.fails], [1, 'the server answered 503', NOW + 22.5 * 60000, 1]);
  assert.equal(L.shareResult(st, b, { status: 503, body: null }, NOW, () => 1).retryAt, NOW + 37.5 * 60000);
  const odd = L.shareResult(st, b, { status: 200, body: { ok: false, reason: 'odd' } }, NOW);
  assert.deepEqual([odd.queue.length, odd.lastError], [1, 'the server answered 200: odd']);
  // Refused whole: sent again it would be refused again, so it goes.
  const bad = L.shareResult(st, b, { status: 400, body: { ok: false, reason: 'bad key' } }, NOW);
  assert.deepEqual([bad.queue, bad.lastError, bad.retryAt], [[], 'the server refused 1 (400: bad key)', null]);
  const big = L.shareResult(st, b, { status: 413, body: { ok: false, reason: 'body too large' } }, NOW);
  assert.deepEqual([big.queue, big.lastError, big.retryAt], [[], 'the server refused 1 (413: body too large)', null]);
  // Any other refusal may come from a proxy or a server mid-deploy: kept, and tried later.
  for (const status of [403, 404, 405, 408, 409, 410]) {
    const kept = L.shareResult(st, b, { status, body: null }, NOW, () => 0.5);
    assert.deepEqual([kept.queue.length, kept.lastError, kept.retryAt], [1, `the server answered ${status}`, NOW + 30 * 60000], String(status));
  }
  const off = L.shareResult(st, b, { status: 0, error: 'Failed to fetch' }, NOW, () => 0.5);
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

test('the labels already saved become one report each account, from their day; anything that is not a label is skipped', () => {
  const reps = L.backfillReports([label({ at: at(3) }), label({ label: 'meh', at: at(1) }), label({ url: 'https://x.com/b/status/5', handle: 'b', text: '', page: null, at: at(2) })], NOW11);
  assert.deepEqual(reps, [
    { label: 'slop', handle: 'b', status: '5', thread: null, day: '2026-11-20' },
    { label: 'slop', handle: 'reply_a', status: '2', thread: '1', day: '2026-11-19' },
  ]);
  assert.deepEqual(L.backfillReports(null, NOW11), []);
});

// ---------------------------------------------------------------- 0.11.0 wire (planted negatives first)

test('planted negative 1: a report in the request carries the label day and no hash', () => {
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, L.reportOf(post('acct_a', '21', { at: Date.UTC(2026, 10, 20, 23, 59, 0) })));
  const b = L.shareBatch(st);
  assert.deepEqual(b.body.reports, [{ label: 'slop', handle: 'acct_a', status: '21', thread: '1', day: '2026-11-20' }]);
  assert.equal(JSON.stringify(b.body).includes('hash'), false);
});

test('planted negative 2: backfill sends one report per account, the newest label, none older than the server takes', () => {
  const recs = [
    post('acct_a', '11', { at: at(10) }),
    post('acct_a', '12', { at: at(5) }),
    post('acct_a', '13', { at: at(2), label: 'not_slop' }),
    post('acct_b', '21', { at: at(100) }),
  ];
  const reps = L.backfillReports(recs, NOW11);
  assert.equal(reps.length, 1);
  assert.deepEqual(reps[0], { label: 'not_slop', handle: 'acct_a', status: '13', thread: '1', day: '2026-11-20' });
});

test('planted negative 5: a 429 waits at least the time the server gave, and the jitter spreads installs over an hour', () => {
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, report('2'));
  const b = L.shareBatch(st);
  const res = { status: 429, body: { ok: false, reason: 'busy', retryAfter: 3600000 } };
  const lo = L.shareResult(st, b, res, NOW11, () => 0);
  const hi = L.shareResult(st, b, res, NOW11, () => 1);
  assert.equal(hi.retryAt - lo.retryAt, 3600000);
  assert.equal(lo.retryAt, NOW11 + 3600000);
  assert.ok(hi.retryAt >= NOW11 + 3600000);
});

test('a retraction of an account replaces what was queued for it: its reports and an earlier retraction; other accounts and post retractions stay', () => {
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, report('2'));
  st = L.enqueueShare(st, report('3', { handle: 'other_b' }));
  st = L.enqueueShare(st, { retract: '4' });
  st = L.enqueueShare(st, { retractHandle: 'Reply_A' });
  assert.deepEqual(st.queue.map((i) => [i.op, i.handle || i.status, i.seq]), [['report', 'other_b', 2], ['retract', '4', 3], ['retract-handle', 'reply_a', 4]]);
  // A second one for the same account is one item, with the newer number.
  st = L.enqueueShare(st, { retractHandle: '@reply_a' });
  assert.deepEqual(st.queue.map((i) => [i.op, i.handle || i.status, i.seq]), [['report', 'other_b', 2], ['retract', '4', 3], ['retract-handle', 'reply_a', 5]]);
  // A report made after it stays behind it, and a report for a post does not remove it.
  st = L.enqueueShare(st, report('6'));
  assert.deepEqual(st.queue.map((i) => [i.op, i.handle || i.status]), [['report', 'other_b'], ['retract', '4'], ['retract-handle', 'reply_a'], ['report', 'reply_a']]);
  // Read back from storage it is the same queue.
  assert.deepEqual(L.shareState(JSON.parse(JSON.stringify(st))).queue, st.queue);
});

test('an answer to a retraction of an account takes it off the queue, unless it was replaced while the request was out', () => {
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, { retractHandle: 'reply_a' });
  st = L.enqueueShare(st, { retractHandle: 'acct_b' });
  const b = L.shareBatch(st);
  assert.deepEqual(b.body, { v: 1, key: KEY, statuses: [], handles: ['reply_a', 'acct_b'] });
  const changed = L.enqueueShare(st, { retractHandle: 'reply_a' });
  const after = L.shareResult(changed, b, { status: 200, body: { ok: true, removed: 2 } }, NOW11);
  assert.deepEqual(after.queue.map((i) => [i.op, i.handle]), [['retract-handle', 'reply_a']]);
  assert.deepEqual(L.shareResult(st, b, { status: 200, body: { ok: true, removed: 0 } }, NOW11).queue, []);
  assert.deepEqual(L.shareResult(st, b, { status: 400, body: { ok: false, reason: 'bad' } }, NOW11).queue, []);
});

test('a request holds at most 50 post retractions and 50 account retractions', () => {
  let st = L.shareState({ key: KEY });
  for (let i = 1; i <= 60; i++) {
    st = L.enqueueShare(st, { retract: String(i) });
    st = L.enqueueShare(st, { retractHandle: 'acct_' + i });
  }
  const b = L.shareBatch(st);
  assert.deepEqual([b.body.statuses.length, b.body.handles.length, b.items.length], [50, 50, 100]);
  assert.deepEqual([b.body.statuses[0], b.body.handles[0], b.body.handles[49]], ['1', 'acct_1', 'acct_50']);
});

test('reports go newest day first, the undated (0.10.0) after the dated, ties in the order queued', () => {
  let st = L.shareState({ key: KEY });
  for (const [id, day] of [['1', '2026-11-01'], ['2', null], ['3', '2026-11-20'], ['4', '2026-11-01'], ['5', '2026-11-10']]) {
    st = L.enqueueShare(st, report(id, { handle: `acct_${id}`, day }));
  }
  assert.deepEqual(L.shareBatch(st).items.map((i) => i.status), ['3', '5', '1', '4', '2']);
  assert.deepEqual(L.shareBatch(st).body.reports.map((r) => r.day), ['2026-11-20', '2026-11-10', '2026-11-01', '2026-11-01', undefined]);
});

test('past shareQueueMax the reports of the oldest days go first, undated ones before dated, and a retraction only when nothing else is left', () => {
  const max = L.DEFAULTS.shareQueueMax;
  const full = (mk) => {
    let st = L.shareState({ key: KEY });
    for (let i = 1; i <= max; i++) st = L.enqueueShare(st, mk(i));
    assert.equal(st.queue.length, max);
    return st;
  };
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Reports on days from 2026-01-02 on (a later number, a later day), the first one undated.
  const dayN = (i) => isoDay(Date.UTC(2026, 0, 1) + i * 86400000);
  let st = full((i) => report(String(i), { handle: `acct_${i}`, day: i === 1 ? null : dayN(i) }));
  st = L.enqueueShare(st, report('90000', { handle: 'acct_90000', day: '2030-12-31' }));
  assert.equal(st.queue.length, max);
  assert.equal(st.queue.some((i) => i.status === '1'), false, 'the undated one went first');
  assert.equal(st.queue.some((i) => i.status === '90000'), true, 'the newest stays');
  st = L.enqueueShare(st, report('90001', { handle: 'acct_90001', day: '2030-12-30' }));
  assert.equal(st.queue.some((i) => i.status === '2'), false, 'then the oldest day');
  assert.equal(st.queue.some((i) => i.status === '3'), true);
  // A backfill past the cap, newest first, keeps its first ones: the newest labels are never the ones dropped.
  let bf = L.shareState({ key: KEY });
  for (let i = 0; i < max + 5; i++) bf = L.enqueueShare(bf, report(String(1000 + i), { handle: `acct_${1000 + i}`, day: isoDay(Date.UTC(2026, 10, 22) - i * 86400000) }));
  assert.equal(bf.queue.length, max);
  assert.equal(bf.queue.some((i) => i.status === '1000'), true);
  assert.equal(bf.queue.some((i) => i.status === String(1000 + max + 4)), false);
  // Retractions stay while a report is there to drop.
  let mixed = full((i) => (i % 2 ? report(String(i), { handle: `acct_${i}`, day: '2026-11-01' }) : { retract: String(i) }));
  mixed = L.enqueueShare(mixed, { retractHandle: 'acct_x' });
  assert.equal(mixed.queue.filter((i) => i.op !== 'report').length, max / 2 + 1);
  // Retractions only: the one queued first goes.
  let only = full((i) => ({ retract: String(i) }));
  only = L.enqueueShare(only, { retractHandle: 'acct_x' });
  assert.deepEqual([only.queue[0].status, only.queue.at(-1).handle], ['2', 'acct_x']);
});

test('a failure waits 30 minutes and doubles with each failure in a row up to 6 hours, times 0.75 to 1.25; a good answer or a refusal as malformed starts over', () => {
  const down = { status: 503, body: null };
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, report('2'));
  const b = L.shareBatch(st);
  const min = 60000;
  const want = [30, 60, 120, 240, 360, 360, 360];
  let cur = st;
  want.forEach((m, k) => {
    const lo = L.shareResult(cur, b, down, NOW11, R0);
    const hi = L.shareResult(cur, b, down, NOW11, () => 1);
    assert.equal(lo.fails, k + 1);
    assert.equal(lo.retryAt, NOW11 + m * 0.75 * min, 'failure ' + (k + 1) + ' at best');
    assert.equal(hi.retryAt, NOW11 + m * 1.25 * min, 'failure ' + (k + 1) + ' at worst');
    cur = lo;
  });
  // The count survives being stored and read back, and no answer at all counts the same.
  cur = L.shareState(JSON.parse(JSON.stringify(cur)));
  assert.equal(cur.fails, want.length);
  assert.equal(L.shareResult(cur, b, { status: 0, error: 'x' }, NOW11, R0).fails, want.length + 1);
  // A 429 or a put-off report leaves the count where it was.
  assert.equal(L.shareResult(cur, b, { status: 429, body: { retryAfter: 1000 } }, NOW11, R0).fails, want.length);
  assert.equal(L.shareResult(cur, b, { status: 200, body: { ok: true, accepted: [], rejected: [], deferred: ['2'], retryAfter: 1000 } }, NOW11, R0).fails, want.length);
  // Taken, or refused whole as malformed, or a retraction taken: start over.
  assert.equal(L.shareResult(cur, b, { status: 200, body: { ok: true, accepted: ['2'], rejected: [], deferred: [] } }, NOW11, R0).fails, 0);
  assert.equal(L.shareResult(cur, b, { status: 400, body: { ok: false } }, NOW11, R0).fails, 0);
  assert.equal(L.shareResult(cur, b, { status: 413, body: { ok: false } }, NOW11, R0).fails, 0);
  const withRetract = L.enqueueShare(cur, { retractHandle: 'reply_a' });
  assert.equal(L.shareResult(withRetract, L.shareBatch(withRetract), { status: 200, body: { ok: true, removed: 0 } }, NOW11, R0).fails, 0);
  // A retryAt is a whole number of milliseconds, so it survives being read back.
  const odd = L.shareResult(st, b, down, NOW11, () => 0.123456789);
  assert.equal(Number.isInteger(odd.retryAt), true);
  assert.equal(L.shareState(JSON.parse(JSON.stringify(odd))).retryAt, odd.retryAt);
});

test('a 429 or a put-off report never comes back before the time the server gave, and the jitter adds up to an hour', () => {
  let st = L.shareState({ key: KEY });
  st = L.enqueueShare(st, report('2'));
  const b = L.shareBatch(st);
  for (const rand of [() => 0, () => 0.25, () => 0.999, () => 1, () => 7, () => -3, () => NaN]) {
    const r = L.shareResult(st, b, { status: 429, body: { retryAfter: 120000 } }, NOW11, rand);
    assert.ok(r.retryAt >= NOW11 + 120000 && r.retryAt <= NOW11 + 120000 + 3600000, String(rand()));
    const d = L.shareResult(st, b, { status: 200, body: { ok: true, deferred: ['2'], retryAfter: 120000 } }, NOW11, rand);
    assert.ok(d.retryAt >= NOW11 + 120000 && d.retryAt <= NOW11 + 120000 + 3600000);
  }
  // No usable retryAfter: the next UTC midnight, then the jitter.
  const midnight = Date.UTC(2026, 10, 23);
  for (const body of [{}, { retryAfter: 0 }, { retryAfter: -5 }, { retryAfter: 'soon' }]) {
    assert.equal(L.shareResult(st, b, { status: 429, body }, NOW11, R0).retryAt, midnight);
    assert.equal(L.shareResult(st, b, { status: 429, body }, NOW11, () => 0.5).retryAt, midnight + 1800000);
  }
  // Never more than 26 hours from the server, even for a huge retryAfter.
  assert.equal(L.shareResult(st, b, { status: 429, body: { retryAfter: 1e15 } }, NOW11, () => 1).retryAt, NOW11 + 26 * 3600000 + 3600000);
});

test('backfill: one report per account, the one labelled last (Not slop only when made at the same moment); the newest come first', () => {
  const t = (d, h) => Date.UTC(2026, 10, d, h, 0, 0);
  const recs = [
    post('acct_a', '1', { at: t(10, 9) }),
    post('acct_a', '2', { at: t(10, 23), label: 'not_slop' }),
    post('acct_a', '3', { at: t(10, 20) }),
    post('acct_b', '4', { at: t(12, 8) }),
    post('acct_b', '5', { at: t(12, 9) }),
    post('acct_c', '6', { at: t(15, 1), label: 'not_slop' }),
    post('acct_c', '7', { at: t(15, 3), label: 'not_slop' }),
    post('acct_c', '8', { at: t(14, 23) }),
    // Not slop in the morning, Slop later the same day: Slop is the newer.
    post('acct_d', '9', { at: t(11, 8), label: 'not_slop' }),
    post('acct_d', '10', { at: t(11, 10) }),
    // Made at the same moment: Not slop.
    post('acct_e', '11', { at: t(9, 7) }),
    post('acct_e', '12', { at: t(9, 7), label: 'not_slop' }),
  ];
  const reps = L.backfillReports(recs, NOW11);
  assert.deepEqual(reps.map((r) => [r.handle, r.status, r.label, r.day]), [
    ['acct_c', '7', 'not_slop', '2026-11-15'],
    ['acct_b', '5', 'slop', '2026-11-12'],
    ['acct_d', '10', 'slop', '2026-11-11'],
    ['acct_a', '2', 'not_slop', '2026-11-10'],
    ['acct_e', '12', 'not_slop', '2026-11-09'],
  ]);
  // The same answer whatever the order the records come in.
  assert.deepEqual(L.backfillReports([...recs].reverse(), NOW11), reps);
});

test('backfill leaves out a label more than shareBackfillDays (88) before today, the server taking none past 90', () => {
  assert.equal(L.DEFAULTS.shareBackfillDays, 88);
  const day = (n) => Date.UTC(2026, 10, 22 - n, 23, 59, 0);
  const reps = L.backfillReports([post('acct_a', '1', { at: day(88) }), post('acct_b', '2', { at: day(89) }), post('acct_c', '3', { at: day(87) })], NOW11);
  assert.deepEqual(reps.map((r) => r.handle), ['acct_c', 'acct_a']);
  // An account whose newest label is too old is not sent an older one either: there is none.
  assert.deepEqual(L.backfillReports([post('acct_d', '4', { at: day(89) }), post('acct_d', '5', { at: day(120) })], NOW11), []);
  // A record with no time cannot be placed, so it is not sent.
  assert.deepEqual(L.backfillReports([post('acct_e', '6', { at: undefined })], NOW11), []);
});

test('sending: an account is taken back first only when the server may hold the other side or what it holds is unknown', () => {
  const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
  const D21 = Date.UTC(2026, 10, 21);
  const held = { acct_s: { s: 'slop', l: Date.UTC(2026, 10, 19) }, acct_n: { s: 'not_slop', l: D21 }, acct_u: 'unknown', acct_g: 'none' };
  let st = L.shareState({ key: KEY, held });
  assert.deepEqual(st.held, held);
  for (const [h, label] of [['acct_s', 'slop'], ['acct_n', 'slop'], ['acct_u', 'slop'], ['acct_g', 'not_slop'], ['acct_new', 'not_slop']]) {
    st = L.enqueueShare(st, report(`1${st.seq}`, { handle: h, label, day: '2026-11-21' }));
  }
  // acct_n is held on the other side and acct_u is unknown; the rest go alone.
  const first = L.shareBatch(st);
  assert.deepEqual([first.path, first.items, first.handles, first.body], ['/v1/retract', [], ['acct_n', 'acct_u'], { v: 1, key: KEY, statuses: [], handles: ['acct_n', 'acct_u'] }]);
  st = L.shareResult(st, first, { status: 200, body: { ok: true, removed: 2 } }, NOW);
  assert.equal(st.queue.length, 5, 'taking back sends no report, so all stay queued');
  assert.deepEqual(Object.keys(st.held).sort(), ['acct_g', 'acct_s'], 'what was taken back holds nothing');
  const reports = L.shareBatch(st);
  assert.equal(reports.path, '/v1/reports');
  assert.deepEqual(reports.body.reports.map((r) => r.handle), ['acct_s', 'acct_n', 'acct_u', 'acct_g', 'acct_new']);
  st = L.shareResult(st, reports, { status: 200, body: { ok: true, accepted: reports.items.map((i) => i.status), rejected: [], deferred: [] } }, NOW);
  assert.deepEqual(st.held, {
    acct_s: { s: 'slop', l: D21 },
    acct_g: { s: 'not_slop', l: D21 },
    acct_n: { s: 'slop', l: D21 },
    acct_u: { s: 'slop', l: D21 },
    acct_new: { s: 'not_slop', l: D21 },
  });
  assert.equal(L.shareBatch(st), null);
  // Next time, a change of side on acct_s is taken back first; a same-side report on acct_n is not.
  st = L.enqueueShare(st, report('31', { handle: 'acct_s', label: 'not_slop', day: '2026-11-22' }));
  st = L.enqueueShare(st, report('32', { handle: 'acct_n', label: 'slop', day: '2026-11-22' }));
  assert.deepEqual(L.shareBatch(st).handles, ['acct_s']);
});

test('sending: held is kept for each report the server may have taken, whatever the answer, and never for one it put off or refused', () => {
  const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
  const D20 = Date.UTC(2026, 10, 20);
  const queued = () => {
    let st = L.shareState({ key: KEY });
    for (const h of ['acct_a', 'acct_b', 'acct_c']) st = L.enqueueShare(st, report(`2${st.seq}`, { handle: h, day: '2026-11-20' }));
    return st;
  };
  const st = queued();
  const b = L.shareBatch(st);
  // No answer, a 5xx, a 429, a 200 that is not ok: the server may have taken them all.
  for (const res of [{ status: 0 }, { status: 503, body: null }, { status: 429, body: { retryAfter: 60000 } }, { status: 200, body: { ok: false } }]) {
    const next = L.shareResult(st, b, res, NOW, R0);
    assert.equal(next.queue.length, 3, JSON.stringify(res));
    assert.deepEqual(Object.keys(next.held), ['acct_a', 'acct_b', 'acct_c'], JSON.stringify(res));
    // So a change of side queued after it is taken back first.
    const turned = L.enqueueShare(next, report('29', { handle: 'acct_b', label: 'not_slop', day: '2026-11-22' }));
    assert.deepEqual(L.shareBatch(turned).handles, ['acct_b'], JSON.stringify(res));
  }
  // A 200: put off and refused ones (by status or "#n") are not on the server.
  const part = L.shareResult(st, b, { status: 200, body: { ok: true, accepted: ['20'], rejected: ['#1'], deferred: ['22'] } }, NOW, R0);
  assert.deepEqual(part.held, { acct_a: { s: 'slop', l: D20 } });
  // A taking-back the server refuses drops those accounts' reports, so it is not planned again and again.
  const turned = L.enqueueShare(L.shareState({ key: KEY, held: { acct_a: { s: 'not_slop', l: D20 } } }), report('40', { handle: 'acct_a' }));
  const plan = L.shareBatch(turned);
  assert.deepEqual(plan.handles, ['acct_a']);
  const refused = L.shareResult(turned, plan, { status: 400, body: { ok: false, reason: 'bad key' } }, NOW);
  assert.deepEqual([refused.queue, refused.lastError, L.shareBatch(refused)], [[], 'the server refused 1 (400: bad key)', null]);
  // A taking-back with no answer is tried again: held stays as it was.
  const lost = L.shareResult(turned, plan, { status: 0 }, NOW, R0);
  assert.deepEqual([lost.queue.length, lost.held, L.shareBatch({ ...lost, retryAt: null }).handles], [1, { acct_a: { s: 'not_slop', l: D20 } }, ['acct_a']]);
});

test('sending: a key 0.10.0 sent with takes each account back once, before its first report, and then never again', () => {
  const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
  // A 0.10.0 record: a key and a count sent, no held.
  let st = L.shareState({ key: KEY, sent: 4 });
  assert.equal(st.legacy, true);
  assert.equal(L.shareState({ key: KEY, sent: 0 }).legacy, false, 'a key that sent nothing holds nothing');
  assert.equal(L.shareState({ key: KEY, sent: 4, held: {} }).legacy, false, 'a 0.11.0 record');
  assert.equal(L.shareState({ sent: 4 }).legacy, false, 'no key');
  st = L.enqueueShare(st, report('51', { handle: 'acct_a', day: '2026-11-21' }));
  const b1 = L.shareBatch(st);
  assert.deepEqual(b1.handles, ['acct_a']);
  st = L.shareResult(st, b1, { status: 200, body: { ok: true, removed: 1 } }, NOW);
  assert.deepEqual(st.held, { acct_a: 'none' });
  // Stored and read back, it is still a 0.10.0 key, and acct_a holds nothing.
  st = L.shareState(JSON.parse(JSON.stringify(st)));
  assert.deepEqual([st.legacy, st.held], [true, { acct_a: 'none' }]);
  const b2 = L.shareBatch(st);
  assert.equal(b2.path, '/v1/reports');
  st = L.shareResult(st, b2, { status: 200, body: { ok: true, accepted: ['51'], rejected: [], deferred: [] } }, NOW);
  assert.deepEqual(st.held, { acct_a: { s: 'slop', l: Date.UTC(2026, 10, 21) } });
  // The same side again goes alone; another account is taken back once.
  st = L.enqueueShare(st, report('52', { handle: 'acct_a', day: '2026-11-22' }));
  st = L.enqueueShare(st, report('53', { handle: 'acct_b', day: '2026-11-22' }));
  assert.deepEqual(L.shareBatch(st).handles, ['acct_b']);
  // What the server can no longer hold (dated more than 92 days back) holds nothing: 'none' for a 0.10.0 key.
  const old = L.shareState({ key: KEY, sent: 4, held: {}, legacy: true, queue: [], seq: 9 });
  old.held.acct_z = { s: 'slop', l: NOW - 93 * 86400000 };
  old.held.acct_y = { s: 'slop', l: NOW - 91 * 86400000 };
  let q = L.enqueueShare(old, report('60', { handle: 'acct_x', day: '2026-11-22' }));
  q.held.acct_x = 'none';
  const sent = L.shareResult(q, L.shareBatch(q), { status: 200, body: { ok: true, accepted: ['60'], rejected: [], deferred: [] } }, NOW);
  assert.deepEqual([sent.held.acct_z, sent.held.acct_y.s], ['none', 'slop']);
  const fresh = L.shareState({ key: KEY, held: { acct_z: { s: 'slop', l: NOW - 93 * 86400000 } } });
  const f = L.enqueueShare(fresh, report('61', { handle: 'acct_x', day: '2026-11-22' }));
  assert.equal(Object.prototype.hasOwnProperty.call(L.shareResult(f, L.shareBatch(f), { status: 200, body: { ok: true, accepted: ['61'], rejected: [], deferred: [] } }, NOW).held, 'acct_z'), false);
});

test('held is read defensively, and an account named __proto__ is an account like any other', () => {
  const st = L.shareState({ key: KEY, held: { acct_a: { s: 'slop', l: 5 }, acct_b: { s: 'meh', l: 5 }, acct_c: { s: 'slop' }, acct_d: 'maybe', 'not a handle': 'none', acct_e: 'unknown', Acct_F: 'none' } });
  assert.deepEqual(st.held, { acct_a: { s: 'slop', l: 5 }, acct_e: 'unknown' });
  for (const bad of [null, 'x', [], 3]) assert.deepEqual(L.shareState({ key: KEY, held: bad }).held, {});
  assert.deepEqual(L.shareState({ held: { acct_a: 'none' } }).held, {}, 'no key: nothing held');
  // JSON.parse makes "__proto__" an own key; it stays one through every step.
  let p = L.shareState(JSON.parse('{"key":"' + KEY + '","held":{"__proto__":{"s":"not_slop","l":5}}}'));
  assert.deepEqual(Object.keys(p.held), ['__proto__']);
  p = L.enqueueShare(p, report('70', { handle: '__proto__' }));
  const b = L.shareBatch(p);
  assert.deepEqual(b.handles, ['__proto__']);
  p = L.shareResult(p, b, { status: 200, body: { ok: true, removed: 1 } }, NOW11);
  assert.deepEqual(Object.keys(p.held), []);
  p = L.shareResult(p, L.shareBatch(p), { status: 200, body: { ok: true, accepted: ['70'], rejected: [], deferred: [] } }, NOW11);
  assert.equal(Object.getPrototypeOf(p.held), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(p.held)), JSON.parse('{"__proto__":{"s":"slop","l":' + Math.floor(NOW11 / 3600000) * 3600000 + '}}'));
});

test('clearing a label: the account is taken back and its newest remaining label, if any and not too old, is sent again', () => {
  const t = (d) => Date.UTC(2026, 10, d, 9, 0, 0);
  const a = post('acct_a', '1', { at: t(10) });
  const b = post('acct_a', '2', { at: t(12) });
  const c = post('acct_a', '3', { at: t(11), label: 'not_slop' });
  const rep = (rec) => L.reportOf(rec);
  assert.deepEqual(L.shareItemsOnClear([a, b], a, NOW11), [{ retractHandle: 'acct_a' }, rep(b)]);
  assert.deepEqual(L.shareItemsOnClear([a, b, c], b, NOW11), [{ retractHandle: 'acct_a' }, rep(c)], 'the newest of those left');
  // planted negative 1 (the same day): Slop at 08:00, Not slop at 09:00, Slop at 10:00; clearing the first sends the 10:00 Slop, the newest.
  const h = (hr, id, label = 'slop') => post('acct_a', id, { at: Date.UTC(2026, 10, 21, hr, 0, 0), label });
  assert.deepEqual(L.shareItemsOnClear([h(8, '1'), h(9, '2', 'not_slop'), h(10, '3')], h(8, '1'), NOW11), [{ retractHandle: 'acct_a' }, rep(h(10, '3'))]);
  assert.deepEqual(L.shareItemsOnClear([a], a, NOW11), [{ retractHandle: 'acct_a' }], 'the last label on the account: only the retraction');
  assert.deepEqual(L.shareItemsOnClear([a, post('other_b', '9', { at: t(13) })], a, NOW11), [{ retractHandle: 'acct_a' }], 'another account is not this one');
  const old = post('acct_a', '4', { at: Date.UTC(2026, 7, 1) });
  assert.deepEqual(L.shareItemsOnClear([a, old], a, NOW11), [{ retractHandle: 'acct_a' }], 'a label past the age limit is not sent');
  assert.deepEqual(L.shareItemsOnClear([a], { label: 'slop', url: 'nope' }, NOW11), []);
});

test('Delete all labels: one retraction for each account among the labels', () => {
  const recs = [post('acct_a', '1'), post('acct_a', '2'), post('acct_b', '3'), { label: 'meh' }];
  assert.deepEqual(L.shareItemsOnClearAll(recs), [{ retractHandle: 'acct_a' }, { retractHandle: 'acct_b' }]);
  assert.deepEqual(L.shareItemsOnClearAll([]), []);
});

test('mutingOn is true only with muting switched on and an account named', () => {
  assert.equal(L.mutingOn({ muteEnabled: true, muteAccount: 'reader' }), true);
  for (const s of [null, undefined, {}, { muteEnabled: true }, { muteEnabled: true, muteAccount: '' }, { muteEnabled: false, muteAccount: 'reader' }, { muteAccount: 'reader' }]) {
    assert.equal(L.mutingOn(s), false, JSON.stringify(s));
  }
});

test('the disclosure is data: headings and items, with the server host filled in, saying what the 0.11.0 report holds', () => {
  const d = L.shareDisclosure('example.test');
  assert.deepEqual(d.map((x) => x.heading), ['What is sent', 'What is never sent', 'Where it goes']);
  const items = d.flatMap((x) => x.items);
  assert.deepEqual(items, [
    "For each label: that it is slop or not slop, the account's handle, the post's id, the id of the post whose page it was on, and the day you labelled it. The post's words are not sent.",
    'A random code made for this browser, so that you count as one reader and can delete what you sent. It is not your X account.',
    "The post's words, your X account, other pages you visit, your lists and your settings.",
    'To example.test, run by AI Anti-Slop. It keeps one entry for each account you labelled: whether your newest label says slop or not slop and its day, with the post and page ids, the hour and a keyed hash of the first part of your IP address (never the address) from the report that set that side, so that one network cannot count as many readers. An entry is deleted 90 days after your newest label on that account.',
    'While sharing is on, clearing a label takes back what the server keeps for that account and sends your newest remaining label on it, if there is one. Delete what I shared removes everything from this browser. Turning sharing off stops sending and keeps what was sent.',
  ]);
  assert.equal(items.join(' ').includes('hash of the post'), false);
});
