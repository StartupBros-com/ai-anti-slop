import test from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const many = (n, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('normalizeHandle lowercases, strips @ and rejects non-handles', () => {
  assert.equal(lib.normalizeHandle(' @Known_Slop '), 'known_slop');
  assert.equal(lib.normalizeHandle('user_7234'), 'user_7234');
  assert.equal(lib.normalizeHandle('a_b'), 'a_b');
  assert.equal(lib.normalizeHandle('sixteen_chars_xx'), null);
  assert.equal(lib.normalizeHandle('has space'), null);
  assert.equal(lib.normalizeHandle('<html>'), null);
  assert.equal(lib.normalizeHandle(''), null);
  assert.equal(lib.normalizeHandle(null), null);
});

test('parseList dedupes, sorts, skips comments and counts junk', () => {
  const r = lib.parseList('known_slop\r\nKnown_Slop\n\n# comment\n! filter header\n@grok\nnot a handle\nfake_slop\n');
  assert.deepEqual(r.handles, ['fake_slop', 'grok', 'known_slop']);
  assert.equal(r.rejected, 1);
  assert.equal(r.error, null);
});

test('parseList refuses a feed over maxHandles', () => {
  const r = lib.parseList(many(11).join('\n'), { maxHandles: 10 });
  assert.equal(r.error, 'too many handles');
  assert.deepEqual(r.handles, []);
});

test('acceptUpdate refuses an empty list', () => {
  assert.deepEqual(lib.acceptUpdate(['a'], []), { ok: false, reason: 'empty list' });
});

// Planted negative: a truncated feed must not replace a healthy stored list.
test('acceptUpdate refuses a feed that shrank from 369 to 10', () => {
  const v = lib.acceptUpdate(many(369), many(10));
  assert.equal(v.ok, false);
  assert.match(v.reason, /shrank from 369 to 10/);
});

test('acceptUpdate allows normal churn and first loads', () => {
  assert.equal(lib.acceptUpdate(many(369), many(300)).ok, true);
  assert.equal(lib.acceptUpdate(null, many(3)).ok, true);
  // Below the guard floor a ratio means nothing, so a small list may change freely.
  assert.equal(lib.acceptUpdate(many(10), many(2)).ok, true);
});

test('isDue honours the refresh interval', () => {
  const hour = 3600000;
  assert.equal(lib.isDue(0, 5, 360), true);
  assert.equal(lib.isDue(undefined, 5, 360), true);
  assert.equal(lib.isDue(10 * hour, 15 * hour, 360), false);
  assert.equal(lib.isDue(10 * hour, 16 * hour, 360), true);
});

function fakeFetch({ status = 200, body = '', ctype = 'text/plain; charset=utf-8', throws = null }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new Error(throws);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => ctype }, text: async () => body };
  };
  return { impl, calls };
}

test('fetchList accepts a good feed and requests it without credentials', async () => {
  const f = fakeFetch({ body: 'known_slop\nfake_slop\n' });
  const r = await lib.fetchList({ url: 'https://feed.example/u.txt', fetchImpl: f.impl });
  assert.deepEqual(r, { ok: true, handles: ['fake_slop', 'known_slop'], rejected: 0 });
  assert.equal(f.calls[0].url, 'https://feed.example/u.txt');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.cache, 'no-store');
});

test('fetchList defaults to the clankwall feed', async () => {
  const f = fakeFetch({ body: 'known_slop\n' });
  await lib.fetchList({ fetchImpl: f.impl });
  assert.equal(f.calls[0].url, 'https://clankwall.vogel.dev/api/usernames.txt');
});

test('fetchList fails closed on HTTP, HTML, junk, size, network and shrink', async () => {
  const cases = [
    [{ status: 503 }, /HTTP 503/],
    [{ ctype: 'text/html', body: 'known_slop' }, /content-type/],
    [{ body: 'ok\n<!doctype html>\n<p>error page</p>\n<div>\n' }, /mostly not handles/],
    [{ body: 'x'.repeat(20) }, /larger than 10 bytes/, { maxBytes: 10 }],
    [{ throws: 'offline' }, /network error: offline/],
    [{ body: many(5).join('\n') }, /shrank/, { prevHandles: many(369) }],
  ];
  for (const [resp, re, extra] of cases) {
    const r = await lib.fetchList({ fetchImpl: fakeFetch(resp).impl, ...(extra || {}) });
    assert.equal(r.ok, false, `expected failure for ${JSON.stringify(resp)}`);
    assert.match(r.reason, re);
  }
});

test('nextRecord keeps the previous list and fetchedAt on failure', () => {
  const prev = { handles: ['a', 'b'], fetchedAt: 100, source: 's', lastAttemptAt: 100, lastError: null };
  const failed = lib.nextRecord(prev, { ok: false, reason: 'HTTP 503' }, 's', 200);
  assert.deepEqual(failed, { handles: ['a', 'b'], fetchedAt: 100, source: 's', lastAttemptAt: 200, lastError: 'HTTP 503' });
  const ok = lib.nextRecord(prev, { ok: true, handles: ['c'] }, 's2', 300);
  assert.deepEqual(ok, { handles: ['c'], fetchedAt: 300, source: 's2', lastAttemptAt: 300, lastError: null });
  const first = lib.nextRecord(undefined, { ok: false, reason: 'offline' }, 's', 5);
  assert.deepEqual(first.handles, []);
  assert.equal(first.lastError, 'offline');
});

test('commitRecord drops a result that a newer success superseded', () => {
  const latest = { handles: ['a', 'b'], fetchedAt: 300, source: 's', lastAttemptAt: 300, lastError: null, seq: 2 };
  // Started at seq 1, but seq 2 committed meanwhile: write nothing.
  assert.equal(lib.commitRecord(latest, { ok: false, reason: 'HTTP 503' }, 's', 1, 400), null);
  assert.equal(lib.commitRecord(latest, { ok: true, handles: ['z'] }, 's', 1, 400), null);
  // Nothing newer: a failure keeps the stored list, a success replaces it and bumps seq.
  const failed = lib.commitRecord(latest, { ok: false, reason: 'HTTP 503' }, 's', 2, 400);
  assert.deepEqual(failed, { ...latest, lastAttemptAt: 400, lastError: 'HTTP 503' });
  const ok = lib.commitRecord(latest, { ok: true, handles: ['c'] }, 's', 2, 400);
  assert.deepEqual(ok, { handles: ['c'], fetchedAt: 400, source: 's', lastAttemptAt: 400, lastError: null, seq: 3 });
  // A record stored by 0.1.0 has no seq; it counts as 0.
  assert.equal(lib.commitRecord({ handles: ['a'], fetchedAt: 1, source: 's' }, { ok: true, handles: ['b'] }, 's', 0, 5).seq, 1);
  assert.equal(lib.commitRecord(null, { ok: false, reason: 'offline' }, 's', 0, 5).seq, 0);
});

test('isRefreshDue waits out the retry gap after a failed attempt', () => {
  const min = 60 * 1000;
  const hour = 60 * min;
  assert.equal(lib.isRefreshDue(null, 5), true);
  assert.equal(lib.isRefreshDue({ fetchedAt: 10 * hour, lastAttemptAt: 10 * hour }, 15 * hour), false);
  assert.equal(lib.isRefreshDue({ fetchedAt: 10 * hour, lastAttemptAt: 10 * hour }, 16 * hour), true);
  // The list is stale and the last attempt failed: wait 30 minutes between tries.
  assert.equal(lib.isRefreshDue({ fetchedAt: 0, lastAttemptAt: 20 * hour }, 20 * hour + 29 * min), false);
  assert.equal(lib.isRefreshDue({ fetchedAt: 0, lastAttemptAt: 20 * hour }, 20 * hour + 30 * min), true);
});

test('parseAllowlist accepts newlines, commas, spaces and @', () => {
  assert.deepEqual([...lib.parseAllowlist('@Grok, known_slop\n  bad handle!! x_y')].sort(), ['bad', 'grok', 'known_slop', 'x_y']);
  assert.equal(lib.parseAllowlist(undefined).size, 0);
});

test('pageOwner reads the first path segment', () => {
  assert.equal(lib.pageOwner('/Known_Slop/with_replies'), 'known_slop');
  assert.equal(lib.pageOwner('/known_slop/status/123'), 'known_slop');
  assert.equal(lib.pageOwner('/'), null);
  assert.equal(lib.pageOwner('/i/lists/1'), 'i');
});

test('shouldHide needs a listed, non-allowlisted author off their own page', () => {
  const list = new Set(['known_slop', 'grok']);
  const base = { list, allow: new Set(), owner: null, paused: false };
  assert.equal(lib.shouldHide('known_slop', base), true);
  assert.equal(lib.shouldHide('someone', base), false);
  assert.equal(lib.shouldHide(null, base), false);
  assert.equal(lib.shouldHide('known_slop', { ...base, paused: true }), false);
  assert.equal(lib.shouldHide('grok', { ...base, allow: new Set(['grok']) }), false);
  assert.equal(lib.shouldHide('known_slop', { ...base, owner: 'known_slop' }), false);
  assert.equal(lib.shouldHide('grok', { ...base, owner: 'known_slop' }), true);
});

test('effectiveAllow adds @grok only when showGrok is on', () => {
  assert.deepEqual([...lib.effectiveAllow({ allowlist: 'friend' })].sort(), ['friend']);
  assert.deepEqual([...lib.effectiveAllow({ allowlist: 'friend', showGrok: true })].sort(), ['friend', 'grok']);
  assert.equal(lib.effectiveAllow(undefined).size, 0);
  assert.equal(lib.effectiveAllow({}).has('grok'), false);
  // Only a real true counts; a stray string from hand-edited storage does not.
  assert.equal(lib.effectiveAllow({ showGrok: 'false' }).has('grok'), false);
});

// Planted negative: the switch must not widen into a general allow.
test('showGrok unhides @grok and no other listed author', () => {
  const list = new Set(['known_slop', 'grok']);
  const allow = lib.effectiveAllow({ showGrok: true });
  assert.equal(lib.shouldHide('grok', { list, allow }), false);
  assert.equal(lib.shouldHide('known_slop', { list, allow }), true);
});

// ---------------------------------------------------------------- muting

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const DAY = '2026-11-06';

test('chooseMuteItem picks the one exact Mute item, matched without case or spacing', () => {
  assert.deepEqual(lib.chooseMuteItem(['Follow @Slop_A', ' Mute ', 'Block @slop_a'], 'slop_a'), { action: 'click', index: 1 });
  assert.deepEqual(lib.chooseMuteItem(['Mute @Slop_A'], 'slop_a'), { action: 'click', index: 0 });
  assert.deepEqual(lib.chooseMuteItem(['Unmute', 'Block @slop_a'], 'slop_a'), { action: 'done', status: 'already' });
  assert.deepEqual(lib.chooseMuteItem(['Unmute @slop_a'], 'slop_a'), { action: 'done', status: 'already' });
  const f = lib.chooseMuteItem(['Unfollow @slop_a', 'Mute'], 'slop_a');
  assert.equal(f.status, 'followed');
  assert.equal(f.stopDay, false);
});

// Planted negatives: never "Mute this conversation", never a guess between two.
test('chooseMuteItem refuses a menu without exactly one Mute item, and stops the day', () => {
  for (const items of [['Mute this conversation'], ['Mute @someone_else'], ['Mute', 'Mute @slop_a'], []]) {
    const r = lib.chooseMuteItem(items, 'slop_a');
    assert.equal(r.action, 'refuse');
    assert.equal(r.status, 'refused');
    assert.equal(r.stopDay, true);
  }
});

test('muteCandidates: front queue first, then the list, then retries; never @grok, the allowlist, unlisted or settled accounts', () => {
  const rec = {
    ...lib.emptyMutes(),
    front: ['slop_c', 'human'],
    handles: {
      done_a: { status: 'muted' },
      gone: { status: 'no-post', attempts: 2 },
      once: { status: 'no-post', attempts: 1 },
      flaky: { status: 'error', attempts: 1 },
    },
  };
  const list = ['done_a', 'flaky', 'friend', 'gone', 'grok', 'once', 'slop_b', 'slop_c'];
  // showGrok only governs hiding; @grok is never muted either way.
  for (const showGrok of [false, true]) {
    assert.deepEqual(lib.muteCandidates(list, { allowlist: '@Friend', showGrok }, rec), ['slop_c', 'slop_b', 'flaky', 'once']);
  }
  // A no-post recorded before attempts were counted is tried once more.
  assert.deepEqual(lib.muteCandidates(['old'], {}, { ...lib.emptyMutes(), handles: { old: { status: 'no-post' } } }), ['old']);
});

test('muteBudget counts down both caps for the UTC day', () => {
  const rec = { ...lib.emptyMutes(), days: { [DAY]: { mutes: 24, visits: 49, stopped: null } } };
  const at25 = { stopped: null, unmutes: 0, cap: 25, visitCap: 50 };
  assert.deepEqual(lib.muteBudget(rec, DAY), { mutesLeft: 1, visitsLeft: 1, mutes: 24, visits: 49, ...at25 });
  assert.deepEqual(lib.muteBudget(rec, '2026-11-07'), { mutesLeft: 25, visitsLeft: 50, mutes: 0, visits: 0, ...at25 });
  assert.equal(lib.utcDay(Date.UTC(2026, 10, 6, 23, 59, 59)), DAY);
});

test('muteBudget at 50 and 100 caps visits at twice the mutes; any other cap is 25', () => {
  const rec = { ...lib.emptyMutes(), days: { [DAY]: { mutes: 30, visits: 70, stopped: null } } };
  assert.deepEqual(lib.muteBudget(rec, DAY, 50), { mutesLeft: 20, visitsLeft: 30, stopped: null, mutes: 30, unmutes: 0, visits: 70, cap: 50, visitCap: 100 });
  assert.deepEqual(lib.muteBudget(rec, DAY, 100), { mutesLeft: 70, visitsLeft: 130, stopped: null, mutes: 30, unmutes: 0, visits: 70, cap: 100, visitCap: 200 });
  for (const cap of [undefined, 0, 26, 99, 101, 1000, '100', Infinity, NaN]) {
    const b = lib.muteBudget(rec, DAY, cap);
    assert.equal(b.cap, 25, String(cap));
    assert.equal(b.mutesLeft, 0, String(cap));
  }
});

test('muteCap reads only 25, 50 or 100, so no stored value goes past 100', () => {
  assert.equal(lib.muteCap(undefined), 25);
  assert.equal(lib.muteCap({}), 25);
  assert.equal(lib.muteCap({ muteCap: 50 }), 50);
  assert.equal(lib.muteCap({ muteCap: 100 }), 100);
  for (const v of [200, 1000, 99, 26, 0, -1, '50', '100', null, true, Infinity, NaN, [100], { valueOf: () => 100 }]) {
    assert.equal(lib.muteCap({ muteCap: v }), 25, String(v));
  }
  assert.deepEqual([...lib.DEFAULTS.muteCaps], [25, 50, 100]);
  assert.throws(() => lib.DEFAULTS.muteCaps.push(500));
  assert.equal(lib.capNeedsXOpen(25), false);
  assert.equal(lib.capNeedsXOpen(50), true);
  assert.equal(lib.capNeedsXOpen(100), true);
});

test('visitNeedsXOpen: at 50 or 100 a visit needs an x.com tab only past what 25 a day allows today; at 25 never', () => {
  const day = '2026-11-19';
  const rec = (d) => ({ ...lib.emptyMutes(), days: { [day]: d } });
  for (const cap of [50, 100]) {
    assert.equal(lib.visitNeedsXOpen(undefined, day, cap), false, `${cap}: nothing done today`);
    assert.equal(lib.visitNeedsXOpen(rec({ mutes: 24, visits: 49 }), day, cap), false, `${cap}: below both`);
    assert.equal(lib.visitNeedsXOpen(rec({ mutes: 25, visits: 25 }), day, cap), true, `${cap}: 25 mutes`);
    assert.equal(lib.visitNeedsXOpen(rec({ mutes: 20, unmutes: 5, visits: 25 }), day, cap), true, `${cap}: unmutes count with mutes`);
    assert.equal(lib.visitNeedsXOpen(rec({ mutes: 10, visits: 50 }), day, cap), true, `${cap}: 50 visits`);
    const yesterday = { ...lib.emptyMutes(), days: { '2026-11-18': { mutes: 100, visits: 200 } } };
    assert.equal(lib.visitNeedsXOpen(yesterday, day, cap), false, `${cap}: yesterday's numbers do not count`);
  }
  assert.equal(lib.visitNeedsXOpen(rec({ mutes: 25, visits: 50 }), day, 25), false, 'at 25 the cap itself stops the day');
});

const LABEL_CTX = {
  handles: ['slop_a', 'grok'],
  source: 'https://clankwall.vogel.dev/api/usernames.txt',
  settings: { extraList: 'extra_a', allowlist: 'friend\nslop_a' },
};

test('statusOf reads an author and post id from a path or an x.com URL', () => {
  assert.deepEqual(lib.statusOf('/Slop_A/status/1234'), { handle: 'slop_a', id: '1234' });
  assert.deepEqual(lib.statusOf('/slop_a/status/1234/photo/1'), { handle: 'slop_a', id: '1234' });
  assert.deepEqual(lib.statusOf('https://x.com/slop_a/status/1234?s=20'), { handle: 'slop_a', id: '1234' });
  assert.deepEqual(lib.statusOf('https://mobile.twitter.com/slop_a/status/99#m'), { handle: 'slop_a', id: '99' });
  for (const bad of [null, '', '/slop_a', '/slop_a/status/', '/slop_a/status/12a', '/slop_a/statuses/1', 'https://evil.com/slop_a/status/1', 'https://x.com.evil.com/a/status/1', 'javascript:/a/status/1', '/sixteen_chars_xx/status/1', `/a/status/${'1'.repeat(26)}`]) {
    assert.equal(lib.statusOf(bad), null, String(bad));
  }
});

test("statusPageOf accepts only a post's own page", () => {
  assert.deepEqual(lib.statusPageOf('/Slop_A/status/1234'), { handle: 'slop_a', id: '1234' });
  assert.deepEqual(lib.statusPageOf('/slop_a/status/1234/'), { handle: 'slop_a', id: '1234' });
  for (const bad of [null, '', '/slop_a', '/slop_a/status/1234/quotes', '/slop_a/status/1234/likes', '/slop_a/status/1234/retweets', '/slop_a/status/1234/photo/1', '/slop_a/status/1234/analytics', 'https://x.com/slop_a/status/1234', '/slop_a/status/12a', '/sixteen_chars_xx/status/1', `/a/status/${'1'.repeat(26)}`]) {
    assert.equal(lib.statusPageOf(bad), null, String(bad));
  }
});

test('labelRecord checks the message and records what the list and boxes held', () => {
  const NOW_L = Date.UTC(2026, 10, 8, 12);
  const msg = { label: 'slop', handle: '@Slop_B', url: '/slop_b/status/111', page: '/OP/status/100', text: 'Great insight! 🚀' };
  const r = lib.labelRecord(msg, LABEL_CTX, NOW_L);
  assert.equal(r.ok, true);
  assert.equal(r.id, '111');
  assert.equal(r.handle, 'slop_b');
  assert.deepEqual(r.record, {
    at: NOW_L,
    label: 'slop',
    handle: 'slop_b',
    url: 'https://x.com/slop_b/status/111',
    text: 'Great insight! 🚀',
    page: 'https://x.com/op/status/100',
    list: null,
    extra: false,
    allow: false,
    hidden: false,
  });
  // A listed account in Always show: on the list, allowed, so not hidden.
  const listed = lib.labelRecord({ ...msg, label: 'not_slop', handle: 'slop_a', url: '/slop_a/status/5' }, LABEL_CTX, NOW_L).record;
  assert.equal(listed.list, 'clankwall.vogel.dev');
  assert.equal(listed.allow, true);
  assert.equal(listed.hidden, false);
  // An extra account is hidden, except on its own page.
  const extra = lib.labelRecord({ ...msg, handle: 'extra_a', url: '/extra_a/status/6' }, LABEL_CTX, NOW_L).record;
  assert.deepEqual([extra.list, extra.extra, extra.hidden], [null, true, true]);
  assert.equal(lib.labelRecord({ ...msg, handle: 'extra_a', url: '/extra_a/status/6', page: '/extra_a/status/1' }, LABEL_CTX, NOW_L).record.hidden, false);
  // A page that is not a post's own page is not recorded as one, and has no owner.
  const quotes = lib.labelRecord({ ...msg, handle: 'extra_a', url: '/extra_a/status/6', page: '/extra_a/status/1/quotes' }, LABEL_CTX, NOW_L).record;
  assert.deepEqual([quotes.page, quotes.hidden], [null, true]);
  // A listed account with nothing protecting it is hidden; pause is ignored.
  const s2 = { ...LABEL_CTX, settings: { paused: true } };
  assert.equal(lib.labelRecord({ ...msg, handle: 'slop_a', url: '/slop_a/status/7' }, s2, NOW_L).record.hidden, true);
  // Text is cut to labelTextMax characters, never through an emoji.
  const long = lib.labelRecord({ ...msg, text: '🚀'.repeat(1500) }, LABEL_CTX, NOW_L).record.text;
  assert.equal(Array.from(long).length, 1000);
  assert.equal(lib.labelRecord({ ...msg, text: { x: 1 } }, LABEL_CTX, NOW_L).record.text, '');
  assert.equal(lib.labelRecord({ ...msg, page: 'https://evil.com/a/status/1' }, LABEL_CTX, NOW_L).record.page, null);
  // A label from the home timeline, or any page that is not a post's own, keeps no page.
  for (const p of ['/home', '/search', '/op', '/i/lists/1']) assert.equal(lib.labelRecord({ ...msg, page: p }, LABEL_CTX, NOW_L).record.page, null, p);
  // Clearing needs only a valid post and handle.
  assert.deepEqual(lib.labelRecord({ label: null, handle: 'slop_b', url: '/slop_b/status/111' }, LABEL_CTX, NOW_L), { ok: true, id: '111', handle: 'slop_b', label: null });
  // Anything else is refused.
  for (const bad of [
    { ...msg, label: 'SLOP' },
    { ...msg, label: undefined },
    { ...msg, label: 'block' },
    { ...msg, url: '/slop_b' },
    { ...msg, url: 'https://evil.com/slop_b/status/1' },
    { ...msg, handle: 'not a handle' },
    { ...msg, handle: undefined },
    { ...msg, handle: 'slop_a' }, // the link names @slop_b
    { label: null, handle: 'slop_a', url: '/slop_b/status/111' },
    null,
  ]) {
    assert.equal(lib.labelRecord(bad, LABEL_CTX, NOW_L).ok, false, JSON.stringify(bad));
  }
  assert.equal(lib.labelRecord({ ...msg, handle: 'slop_a' }, LABEL_CTX, NOW_L).reason, "not the post's author");
});

test('labelPatch adds to Also hide or Always show and never removes anything', () => {
  assert.deepEqual(lib.labelPatch({}, 'Slop_B', 'slop'), { extraList: 'slop_b' });
  assert.deepEqual(lib.labelPatch({ extraList: 'a, b  \n' }, 'slop_b', 'slop'), { extraList: 'a, b\nslop_b' });
  assert.equal(lib.labelPatch({ extraList: 'a\n@Slop_B' }, 'slop_b', 'slop'), null);
  assert.deepEqual(lib.labelPatch({ allowlist: 'friend' }, 'pal', 'not_slop'), { allowlist: 'friend\npal' });
  // Mark slop on an Always-show account adds it to Also hide and leaves Always show alone.
  assert.deepEqual(lib.labelPatch({ allowlist: 'pal' }, 'pal', 'slop'), { extraList: 'pal' });
  assert.equal(lib.labelPatch({}, 'pal', null), null);
  assert.equal(lib.labelPatch({}, 'pal', 'block'), null);
  assert.equal(lib.labelPatch({}, 'not a handle', 'slop'), null);
});

test('labelsFrom keeps only label records, oldest first, and labelsJsonl writes one per line', () => {
  const all = {
    'xsh:list': { handles: ['x'] },
    'xsh:labelCount': 3,
    'xsh:label:2': { at: 20, label: 'not_slop', handle: 'b' },
    'xsh:label:1': { at: 10, label: 'slop', handle: 'a' },
    'xsh:label:3': { at: 30, label: 'weird', handle: 'c' },
    'xsh:label:4': 'junk',
  };
  const recs = lib.labelsFrom(all);
  assert.deepEqual(recs.map((r) => r.handle), ['a', 'b']);
  const out = lib.labelsJsonl(recs);
  assert.equal(out, '{"at":10,"label":"slop","handle":"a"}\n{"at":20,"label":"not_slop","handle":"b"}\n');
  assert.deepEqual(out.trim().split('\n').map((l) => JSON.parse(l).handle), ['a', 'b']);
  assert.equal(lib.labelsJsonl([]), '');
  assert.deepEqual(lib.labelsFrom(null), []);
});

test('recordOutcome: a mute counts, waits for a check and leaves the front queue', () => {
  const start = lib.countVisit({ ...lib.emptyMutes(), front: ['slop_a', 'slop_b'] }, NOW);
  const r = lib.recordOutcome(start, 'slop_a', { status: 'muted', toast: '@slop_a has been muted.Undo' }, NOW);
  assert.deepEqual(r.days[DAY], { mutes: 1, visits: 1, stopped: null });
  assert.deepEqual(r.handles.slop_a, { status: 'muted', at: NOW, toast: '@slop_a has been muted.Undo', confirmed: null });
  assert.deepEqual(r.sinceCheck, ['slop_a']);
  assert.deepEqual(r.front, ['slop_b']);
  assert.equal(start.handles.slop_a, undefined, 'the input record is not changed');
});

test('recordOutcome: already/followed settle without a mute; no-post settles the second time; refused stops the day but is retried later', () => {
  let r = lib.emptyMutes();
  for (const status of ['already', 'followed', 'no-post']) r = lib.recordOutcome(r, status.replace('-', '_'), { status }, NOW);
  assert.equal(r.days[DAY].mutes, 0);
  assert.equal(r.days[DAY].stopped, null);
  assert.equal(r.handles.no_post.attempts, 1);
  r = lib.recordOutcome(r, 'odd', { status: 'refused', reason: '0 exact Mute items' }, NOW);
  assert.equal(r.days[DAY].stopped, '@odd: refused (0 exact Mute items)');
  const list = ['already', 'followed', 'no_post', 'odd'];
  // Both are being tried again, so they keep list order.
  assert.deepEqual(lib.muteCandidates(list, {}, r), ['no_post', 'odd']);
  r = lib.recordOutcome(r, 'no_post', { status: 'no-post' }, NOW);
  assert.equal(r.handles.no_post.attempts, 2);
  assert.deepEqual(lib.muteCandidates(list, {}, r), ['odd']);
});

test('recordOutcome: errors are retried once, then the account is left alone', () => {
  let r = lib.recordOutcome(lib.emptyMutes(), 'slop_a', { status: 'error', reason: 'timeout' }, NOW);
  assert.equal(r.handles.slop_a.status, 'error');
  assert.deepEqual(lib.muteCandidates(['slop_a'], {}, r), ['slop_a']);
  r = lib.recordOutcome(r, 'slop_a', { status: 'error', reason: 'timeout' }, NOW);
  assert.equal(r.handles.slop_a.status, 'failed');
  assert.deepEqual(lib.muteCandidates(['slop_a'], {}, r), []);
});

test('recordOutcome: a wrong account or a login page stops the day and records nothing per account', () => {
  for (const status of ['wrong-account', 'login']) {
    const r = lib.recordOutcome(lib.emptyMutes(), 'slop_a', { status }, NOW);
    assert.match(r.days[DAY].stopped, new RegExp(`^@slop_a: ${status}`));
    assert.equal(r.handles.slop_a, undefined);
  }
});

// Planted negative: '__proto__' and 'constructor' are valid handles; on a plain
// object they read as Object's own keys, so they were retried for ever.
test("handles named like Object's keys are kept as ordinary accounts", () => {
  const s = { extraList: '__proto__\nconstructor\nprototype' };
  const eligible = lib.muteEligible([], s);
  assert.deepEqual(eligible, ['__proto__', 'constructor', 'prototype']);
  let rec = lib.emptyMutes();
  assert.deepEqual(lib.muteCandidates([], s, rec), eligible, 'untried, so not retries');
  rec = lib.recordOutcome(rec, '__proto__', { status: 'muted' }, NOW);
  rec = lib.recordOutcome(rec, 'constructor', { status: 'already' }, NOW);
  rec = JSON.parse(JSON.stringify(rec)); // as storage keeps it
  assert.equal(Object.getPrototypeOf(rec.handles), Object.prototype);
  assert.deepEqual(Object.keys(rec.handles).sort(), ['__proto__', 'constructor']);
  assert.deepEqual(lib.muteCandidates([], s, rec), ['prototype']);
  const sum = lib.muteSummary(rec);
  assert.deepEqual([sum.muted, sum.already], [1, 1]);
  const checked = lib.recordCheck(rec, ['__proto__'], NOW + 1).rec;
  assert.equal(Object.getOwnPropertyDescriptor(checked.handles, '__proto__').value.confirmed, true);
});

test('recordCheck confirms mutes seen in the rows and stops the day for any missing', () => {
  let r = lib.emptyMutes();
  for (const h of ['m1', 'm2']) r = lib.recordOutcome(r, h, { status: 'muted' }, NOW);
  const ok = lib.recordCheck(r, ['M2', 'm1', 'older'], NOW + 1);
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.rec.handles.m1.confirmed, true);
  assert.deepEqual(ok.rec.sinceCheck, []);
  assert.equal(ok.rec.days[DAY].stopped, null);
  const miss = lib.recordCheck(r, ['m1'], NOW + 1);
  assert.deepEqual(miss.missing, ['m2']);
  assert.equal(miss.rec.handles.m2.confirmed, false);
  assert.equal(miss.rec.days[DAY].stopped, 'not on settings/muted/all after muting: @m2');
  assert.deepEqual(lib.muteSummary(miss.rec), { muted: 2, confirmed: 1, notFound: 1, unmuted: 0, already: 0, followed: 0, skipped: 0, gone: 0 });
});

test('noteSighting moves an account to the front, once, capped at muteFrontMax', () => {
  let r = lib.emptyMutes();
  for (let i = 0; i < 60; i++) r = lib.noteSighting(r, `h${i}`);
  r = lib.noteSighting(r, 'h30');
  assert.equal(r.front.length, lib.DEFAULTS.muteFrontMax);
  assert.equal(r.front[0], 'h30');
  assert.equal(r.front.filter((h) => h === 'h30').length, 1);
});

// ------------------------------------------------------------------ bots

const ROSTER = ['grok', 'askperplexity', 'pangram', 'bot', 'threadreaderapp', 'unrollhelper'];
// Plain objects: botModes builds its result in the test's own realm, but keep the
// comparison independent of key order.
const modesOf = (settings, list) => Object.fromEntries(Object.entries(lib.botModes(settings, list)).sort());
const expectModes = (pairs) => Object.fromEntries(Object.entries(pairs).sort());

test('the bot roster is the six bots the issue names, with lowercase handles', () => {
  assert.deepEqual(
    lib.BOTS.map((b) => b.handle),
    ROSTER,
  );
  for (const b of lib.BOTS) assert.equal(lib.normalizeHandle(b.name), b.handle);
  assert.deepEqual([...lib.BOT_MODES], ['show', 'hide', 'mute']);
});

test('a bot with no saved choice follows the list: hidden if listed, shown if not', () => {
  const all = (mode) => Object.fromEntries(ROSTER.map((h) => [h, mode]));
  // clankwall listed @grok on 2026-11-06, and none of the others.
  assert.deepEqual(modesOf({}, ['known_slop', 'grok']), expectModes({ ...all('show'), grok: 'hide' }));
  assert.deepEqual(modesOf({}, ['known_slop']), expectModes(all('show')));
  assert.deepEqual(modesOf(undefined, undefined), expectModes(all('show')));
  // A bot later added to the list, or to the user's extra accounts, flips to Hide.
  assert.deepEqual(modesOf({}, ['grok', 'askperplexity']), expectModes({ ...all('show'), grok: 'hide', askperplexity: 'hide' }));
  assert.deepEqual(modesOf({ extraList: '@Pangram' }, []), expectModes({ ...all('show'), pangram: 'hide' }));
});

test('a saved choice wins over the list, an Always-show entry wins over both, and bad values are ignored', () => {
  const m = modesOf({ bots: { grok: 'show', askperplexity: 'mute', bot: 'hide', pangram: 'loud' } }, ['grok']);
  assert.equal(m.grok, 'show');
  assert.equal(m.askperplexity, 'mute');
  assert.equal(m.bot, 'hide');
  assert.equal(m.pangram, 'show', 'an unknown value falls back to the list');
  assert.equal(modesOf({ bots: { grok: 'mute' }, allowlist: 'grok' }, ['grok']).grok, 'show');
  assert.equal(lib.botChoice({ bots: 'grok' }, 'grok'), null);
  assert.equal(lib.botChoice({ bots: { grok: 'Show' } }, 'grok'), null, 'modes are exact');
});

test("0.3.0's showGrok means @grok is set to Show, until its row is changed", () => {
  assert.equal(lib.botChoice({ showGrok: true }, 'grok'), 'show');
  assert.equal(lib.botChoice({ showGrok: true }, 'askperplexity'), null, 'showGrok covers only @grok');
  assert.equal(lib.botChoice({ showGrok: 'true' }, 'grok'), null);
  assert.equal(lib.botChoice({ showGrok: false }, 'grok'), null);
  assert.equal(lib.botChoice({ showGrok: true, bots: { grok: 'hide' } }, 'grok'), 'hide');
  assert.equal(modesOf({ showGrok: true }, ['grok']).grok, 'show');
  // Reading never rewrites what is stored.
  const s = Object.freeze({ showGrok: true, bots: Object.freeze({}) });
  lib.botModes(s, ['grok']);
  lib.effectiveAllow(s);
  lib.effectiveList(['grok'], s);
  lib.muteEligible(['grok'], s);
});

test('effectiveAllow adds bots set to Show; effectiveList adds extra accounts and bots set to Hide or Mute', () => {
  const s = { allowlist: 'friend', extraList: 'Extra_A, extra_b', bots: { askperplexity: 'show', bot: 'hide', pangram: 'mute' } };
  assert.deepEqual([...lib.effectiveAllow(s)].sort(), ['askperplexity', 'friend']);
  assert.deepEqual([...lib.effectiveList(['slop_a'], s)].sort(), ['bot', 'extra_a', 'extra_b', 'pangram', 'slop_a']);
  // A bot at its default adds nothing: the list decides.
  assert.deepEqual([...lib.effectiveList(['grok'], {})], ['grok']);
  assert.deepEqual([...lib.effectiveAllow({})], []);
});

test('mentionTargets is empty until hideBotMentions is on, then holds the bots not shown', () => {
  assert.deepEqual([...lib.mentionTargets({}, ['grok'])], []);
  assert.deepEqual([...lib.mentionTargets({ hideBotMentions: 'true' }, ['grok'])], []);
  assert.deepEqual([...lib.mentionTargets({ hideBotMentions: true }, ['grok'])], ['grok']);
  const s = { hideBotMentions: true, bots: { grok: 'show', askperplexity: 'mute', bot: 'hide' } };
  assert.deepEqual([...lib.mentionTargets(s, ['grok'])].sort(), ['askperplexity', 'bot']);
});

test('shouldHideMention spares your own posts, Always-show authors and pages opened on purpose', () => {
  const mentions = new Set(['grok']);
  const base = { allow: new Set(['friend']), owner: null, paused: false, me: 'startupbros', mentions };
  assert.equal(lib.shouldHideMention('rando', 'grok', base), true);
  assert.equal(lib.shouldHideMention('rando', null, base), false);
  assert.equal(lib.shouldHideMention(null, 'grok', base), false);
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, paused: true }), false);
  assert.equal(lib.shouldHideMention('friend', 'grok', base), false);
  assert.equal(lib.shouldHideMention('startupbros', 'grok', base), false);
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, owner: 'rando' }), false, "on the author's page");
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, owner: 'grok' }), false, "on the bot's page");
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, owner: 'someone_else' }), true);
});

// Planted negatives: @grok at its default (Hide) is never visited, and an
// extra account that is also on the allowlist is never muted.
test('muteEligible: the list, then sorted extra accounts, then bots set to Mute; never Always-show or other bots', () => {
  const list = ['grok', 'slop_a', 'slop_b'];
  assert.deepEqual(lib.muteEligible(list, {}), ['slop_a', 'slop_b']);
  assert.deepEqual(lib.muteEligible(list, { extraList: 'zed\nAlpha\nslop_a' }), ['slop_a', 'slop_b', 'alpha', 'zed']);
  assert.deepEqual(lib.muteEligible(list, { extraList: 'friend extra', allowlist: 'friend' }), ['slop_a', 'slop_b', 'extra']);
  for (const mode of ['show', 'hide']) {
    assert.deepEqual(lib.muteEligible(list, { bots: { grok: mode, askperplexity: mode } }), ['slop_a', 'slop_b']);
  }
  // A bot in the extra box is hidden but still muted only when its row says so.
  assert.deepEqual(lib.muteEligible([], { extraList: 'grok' }), []);
  assert.deepEqual(lib.muteEligible(list, { bots: { askperplexity: 'mute', grok: 'mute' } }), ['grok', 'slop_a', 'slop_b', 'askperplexity']);
  assert.deepEqual(lib.muteEligible(list, { bots: { grok: 'mute' }, allowlist: 'grok' }), ['slop_a', 'slop_b']);
  assert.deepEqual(lib.muteEligible(list, { showGrok: true, bots: {} }), ['slop_a', 'slop_b']);
});

test('muteCandidates follows muteEligible: a bot set to Mute and extra accounts enter the queue', () => {
  const rec = { ...lib.emptyMutes(), front: ['grok', 'extra_a'], handles: { slop_a: { status: 'muted' } } };
  const s = { extraList: 'extra_a', bots: { askperplexity: 'mute' } };
  assert.deepEqual(lib.muteCandidates(['grok', 'slop_a'], s, rec), ['extra_a', 'askperplexity']);
  assert.deepEqual(lib.muteCandidates(['grok', 'slop_a'], { ...s, bots: { askperplexity: 'hide' } }, rec), ['extra_a']);
});

// ---------------------------------------------------------------- unmuting

const ACCT = 'startupbros';
const mutedBy = (account, at = NOW) => ({ status: 'muted', at, account, toast: null, confirmed: true });
const onAcct = { muteEnabled: true, muteAccount: ACCT };

test('chooseUnmuteItem picks the one exact Unmute item; a Mute item means not muted', () => {
  assert.deepEqual(lib.chooseUnmuteItem(['Follow @a', '  UNMUTE  ', 'Unmute this conversation', 'Block @a'], 'a'), { action: 'click', index: 1 });
  assert.deepEqual(lib.chooseUnmuteItem(['Unmute @A'], 'a'), { action: 'click', index: 0 });
  assert.deepEqual(lib.chooseUnmuteItem(['Follow @a', 'Mute @a', 'Mute this conversation'], 'a'), { action: 'done', status: 'not-muted' });
});

test('chooseUnmuteItem refuses every other menu, and stops the day', () => {
  for (const items of [[], ['Unmute this conversation'], ['Unmute', 'Unmute @a'], ['Unmute', 'Mute'], ['Unmute @someone_else']]) {
    const r = lib.chooseUnmuteItem(items, 'a');
    assert.equal(r.action, 'refuse', JSON.stringify(items));
    assert.equal(r.status, 'refused');
    assert.equal(r.stopDay, true);
    assert.match(r.reason, /exact Unmute items/);
  }
});

test('unmuteCandidates: mutes it made as this account that muting no longer picks, oldest first', () => {
  const rec = {
    ...lib.emptyMutes(),
    handles: {
      gone_new: mutedBy(ACCT, NOW + 2),
      gone_old: mutedBy(ACCT, NOW),
      listed: mutedBy(ACCT),
      friend: mutedBy(ACCT), // listed, now in Always show
      extra: mutedBy(ACCT), // off the list, in Also hide
      askperplexity: mutedBy(ACCT), // its row moved off Mute on X
      other_acct: mutedBy('someone_else'),
      unstamped: { status: 'muted', at: NOW },
      mine: { status: 'already', at: NOW },
      fol: { status: 'followed', at: NOW },
      np: { status: 'no-post', at: NOW, attempts: 2 },
      done: { status: 'unmuted', at: NOW, account: ACCT },
    },
  };
  const s = { ...onAcct, allowlist: 'friend', extraList: 'extra', bots: { askperplexity: 'show' } };
  assert.deepEqual(lib.unmuteCandidates(['listed', 'friend'], s, rec), ['askperplexity', 'friend', 'gone_old', 'gone_new']);
});

test('unmuteCandidates: none while the list is empty or missing, without an account, or after muteMaxAttempts failures', () => {
  const rec = { ...lib.emptyMutes(), handles: { gone: mutedBy(ACCT) } };
  assert.deepEqual(lib.unmuteCandidates(['x'], onAcct, rec), ['gone']);
  assert.deepEqual(lib.unmuteCandidates([], onAcct, rec), []);
  assert.deepEqual(lib.unmuteCandidates(undefined, onAcct, rec), []);
  assert.deepEqual(lib.unmuteCandidates(['x'], { muteEnabled: true }, rec), []);
  const tried = { ...lib.emptyMutes(), handles: { gone: { ...mutedBy(ACCT), unmuteAttempts: 2 } } };
  assert.deepEqual(lib.unmuteCandidates(['x'], onAcct, tried), []);
});

test('stampAccount gives unstamped mutes the bound account, once, and touches nothing else', () => {
  const rec = { ...lib.emptyMutes(), handles: { a: { status: 'muted', at: NOW }, b: mutedBy('someone_else'), c: { status: 'already', at: NOW } } };
  const r = lib.stampAccount(rec, ACCT);
  assert.notEqual(r, rec);
  assert.equal(r.handles.a.account, ACCT);
  assert.equal(r.handles.b.account, 'someone_else');
  assert.equal(r.handles.c.account, undefined);
  assert.equal(rec.handles.a.account, undefined, 'the input is not changed');
  assert.equal(lib.stampAccount(r, ACCT), r, 'nothing left to stamp: the same object');
  assert.equal(lib.stampAccount(rec, null), rec);
});

test('recordOutcome: a mute records the account it was made as', () => {
  assert.equal(lib.recordOutcome(lib.emptyMutes(), 'a', { status: 'muted' }, NOW, ACCT).handles.a.account, ACCT);
  assert.equal(lib.recordOutcome(lib.emptyMutes(), 'a', { status: 'already' }, NOW, ACCT).handles.a.account, undefined);
});

test('recordUnmute: an unmute counts against the day and keeps when it was muted; Mute offered records not-muted', () => {
  const rec = { ...lib.emptyMutes(), handles: { a: mutedBy(ACCT, NOW - 1000), b: mutedBy(ACCT, NOW - 2000) } };
  let r = lib.recordUnmute(rec, 'a', { status: 'unmuted', toast: '@a has been unmuted.' }, NOW);
  assert.deepEqual(r.handles.a, { status: 'unmuted', at: NOW, mutedAt: NOW - 1000, account: ACCT, toast: '@a has been unmuted.' });
  assert.equal(r.days[DAY].unmutes, 1);
  assert.equal(r.days[DAY].mutes, 0);
  r = lib.recordUnmute(r, 'b', { status: 'not-muted' }, NOW);
  assert.deepEqual(r.handles.b, { status: 'not-muted', at: NOW, mutedAt: NOW - 2000, account: ACCT });
  assert.equal(r.days[DAY].unmutes, 1, 'nothing was clicked');
  assert.deepEqual(lib.unmuteCandidates(['x'], onAcct, r), []);
  assert.equal(lib.muteSummary(r).unmuted, 1);
});

test('recordUnmute: a failed visit keeps the mute recorded, is tried once more, then left muted', () => {
  let r = { ...lib.emptyMutes(), handles: { a: mutedBy(ACCT) } };
  r = lib.recordUnmute(r, 'a', { status: 'error', reason: 'the ⋯ menu did not open' }, NOW);
  assert.equal(r.handles.a.status, 'muted');
  assert.equal(r.handles.a.unmuteAttempts, 1);
  assert.deepEqual(lib.unmuteCandidates(['x'], onAcct, r), ['a']);
  r = lib.recordUnmute(r, 'a', { status: 'no-post' }, NOW + 1);
  assert.equal(r.handles.a.status, 'muted');
  assert.equal(r.handles.a.unmuteAttempts, 2);
  assert.deepEqual(lib.unmuteCandidates(['x'], onAcct, r), []);
  assert.equal(r.days[DAY].stopped, null);
});

test('recordUnmute: a refused menu, a wrong account or a login page stops the day and keeps the mute', () => {
  for (const status of ['refused', 'wrong-account', 'login']) {
    const r = lib.recordUnmute({ ...lib.emptyMutes(), handles: { a: mutedBy(ACCT) } }, 'a', { status, reason: 'x' }, NOW);
    assert.equal(r.days[DAY].stopped, `@a: ${status === 'refused' ? 'unmute refused' : status} (x)`);
    assert.equal(r.handles.a.status, 'muted');
    assert.equal(r.handles.a.unmuteAttempts, undefined, 'tried again on a later day');
  }
});

test('muteBudget: mutes and unmutes share the daily cap', () => {
  const rec = { ...lib.emptyMutes(), days: { [DAY]: { mutes: 20, unmutes: 4, visits: 30, stopped: null } } };
  const b = lib.muteBudget(rec, DAY);
  assert.equal(b.mutesLeft, 1);
  assert.equal(b.unmutes, 4);
  rec.days[DAY].unmutes = 5;
  assert.equal(lib.muteBudget(rec, DAY).mutesLeft, 0);
});

test('muteCandidates: an account it unmuted that is listed again goes with the new accounts, and a mute replaces the entry', () => {
  const rec = {
    ...lib.emptyMutes(),
    handles: {
      tried: { status: 'error', at: NOW, attempts: 1 },
      back: { status: 'unmuted', at: NOW, mutedAt: NOW - 1, account: ACCT, toast: 't' },
      back2: { status: 'not-muted', at: NOW, mutedAt: NOW - 1, account: ACCT },
    },
  };
  assert.deepEqual(lib.muteCandidates(['tried', 'back', 'new', 'back2'], onAcct, rec), ['back', 'new', 'back2', 'tried']);
  const r = lib.recordOutcome(rec, 'back', { status: 'muted', toast: '@back has been muted.' }, NOW + 5, ACCT);
  assert.deepEqual(r.handles.back, { status: 'muted', at: NOW + 5, account: ACCT, toast: '@back has been muted.', confirmed: null });
  assert.deepEqual(r.sinceCheck, ['back']);
});

test('recordUnmute: an account unmuted before its muted-list check leaves the check list; a failed visit does not', () => {
  const rec = { ...lib.emptyMutes(), handles: { a: mutedBy(ACCT), b: mutedBy(ACCT) }, sinceCheck: ['a', 'b'] };
  assert.deepEqual(lib.recordUnmute(rec, 'a', { status: 'unmuted' }, NOW).sinceCheck, ['b']);
  assert.deepEqual(lib.recordUnmute(rec, 'a', { status: 'not-muted' }, NOW).sinceCheck, ['b']);
  assert.deepEqual(lib.recordUnmute(rec, 'a', { status: 'error' }, NOW).sinceCheck, ['a', 'b']);
});

test('recordCheck: a handle on the check list that is no longer muted is not missing', () => {
  const rec = { ...lib.emptyMutes(), handles: { a: { status: 'unmuted', at: NOW }, b: mutedBy(ACCT) }, sinceCheck: ['a', 'b'] };
  const { rec: r, missing } = lib.recordCheck(rec, ['b'], NOW);
  assert.deepEqual(missing, []);
  assert.equal(r.days[DAY], undefined);
});

test('labelsOn: on unless turned off; anything but true or no value is off', () => {
  assert.equal(lib.labelsOn(undefined), true);
  assert.equal(lib.labelsOn({}), true);
  assert.equal(lib.labelsOn({ labeling: true }), true);
  for (const v of [false, 'true', null, 0, 1]) assert.equal(lib.labelsOn({ labeling: v }), false, String(v));
});

test('gone: kept for both job kinds, settles at the first visit, and is no Run now miss', () => {
  for (const kind of ['mute', 'unmute']) {
    assert.deepEqual(lib.jobResult(kind, { status: 'gone', reason: 'Account suspended' }), { status: 'gone', reason: 'Account suspended' });
  }
  assert.equal(lib.runMissed({ status: 'gone' }), false);
  const r = lib.recordOutcome(lib.emptyMutes(), 'dead_a', { status: 'gone', reason: 'This account doesn’t exist' }, NOW);
  assert.deepEqual(r.handles.dead_a, { status: 'gone', at: NOW, reason: 'This account doesn’t exist' });
  assert.deepEqual(r.days[DAY], { mutes: 0, visits: 0, stopped: null });
  assert.deepEqual(r.sinceCheck, [], 'nothing for the muted-list check to find');
  assert.deepEqual(lib.muteCandidates(['dead_a', 'live_b'], {}, r), ['live_b']);
  // A profile first seen with no post, found gone on its second try, settles too.
  const once = { ...lib.emptyMutes(), handles: { dead_a: { status: 'no-post', at: NOW - 1, attempts: 1 } } };
  assert.deepEqual(lib.muteCandidates(['dead_a'], {}, once), ['dead_a']);
  assert.deepEqual(lib.muteCandidates(['dead_a'], {}, lib.recordOutcome(once, 'dead_a', { status: 'gone' }, NOW)), []);
  const t = lib.muteSummary(r);
  assert.equal(t.gone, 1);
  assert.equal(t.skipped, 0);
});

test('recordUnmute: a deleted or suspended account is left muted and not tried again', () => {
  const r = lib.recordUnmute({ ...lib.emptyMutes(), handles: { a: mutedBy(ACCT) } }, 'a', { status: 'gone', reason: 'Account suspended' }, NOW);
  assert.equal(r.handles.a.status, 'muted');
  assert.equal(r.handles.a.unmuteAttempts, 2);
  assert.equal(r.handles.a.unmuteReason, 'Account suspended');
  assert.deepEqual(lib.unmuteCandidates(['x'], onAcct, r), []);
  assert.deepEqual(r.days[DAY], { mutes: 0, unmutes: 0, visits: 0, stopped: null });
});

const NO_ROWS = { status: 'error', reason: 'settings/muted/all showed no rows' };
const NO_ROWS_STOP = 'settings/muted/all check: error (settings/muted/all showed no rows)';
const pendingOne = () => ({ ...lib.emptyMutes(), handles: { m1: { status: 'muted', confirmed: null } }, sinceCheck: ['m1'] });

test('recordCheckFailed: a first failure waits 15 minutes with the mutes still waiting; a second in a row stops the day', () => {
  const r = lib.recordCheckFailed(pendingOne(), NO_ROWS, NOW, ACCT);
  assert.deepEqual(r.checkRetry, { at: NOW + 15 * 60000, account: ACCT, reason: NO_ROWS_STOP });
  assert.deepEqual(r.sinceCheck, ['m1']);
  assert.equal(r.handles.m1.confirmed, null);
  assert.equal(lib.muteBudget(r, DAY).stopped, null);
  assert.equal(lib.checkWaitMs(r, ACCT, NOW + 60000), 14 * 60000);
  assert.equal(lib.checkWaitMs(r, ACCT, NOW + 15 * 60000), 0);
  assert.equal(lib.checkWaitMs(r, 'someone_else', NOW), 0, 'the wait belongs to the account the check ran as');
  assert.equal(lib.checkWaitMs(lib.emptyMutes(), ACCT, NOW), 0);
  const again = lib.recordCheckFailed(r, NO_ROWS, NOW + 15 * 60000, ACCT);
  assert.equal(again.days[DAY].stopped, NO_ROWS_STOP, 'the same reason the troubleshooting table lists');
  assert.equal(again.checkRetry, undefined);
  assert.deepEqual(again.sinceCheck, ['m1'], 'still waiting for the next check');
  // As another account, a failure is a first one.
  const other = lib.recordCheckFailed(r, NO_ROWS, NOW + 1, 'someone_else');
  assert.equal(lib.muteBudget(other, DAY).stopped, null);
  assert.equal(other.checkRetry.account, 'someone_else');
});

test('recordCheckFailed: a good check in between starts the count again', () => {
  let r = lib.recordCheckFailed(pendingOne(), NO_ROWS, NOW, ACCT);
  r = lib.recordCheck(r, ['m1'], NOW + 15 * 60000).rec;
  assert.equal(r.checkRetry, undefined);
  assert.equal(r.handles.m1.confirmed, true);
  r = lib.recordCheckFailed({ ...r, sinceCheck: ['m1'] }, NO_ROWS, NOW + 20 * 60000, ACCT);
  assert.equal(lib.muteBudget(r, DAY).stopped, null, 'fail, good, fail: no stop');
  assert.equal(r.checkRetry.at, NOW + 35 * 60000);
});

test('recordCheckFailed: logged out, or logged in as another account, stops the day at once', () => {
  const login = lib.recordCheckFailed(pendingOne(), { status: 'login', reason: 'x.com shows a login button' }, NOW, ACCT);
  assert.equal(login.days[DAY].stopped, 'settings/muted/all check: login (x.com shows a login button)');
  assert.equal(login.checkRetry, undefined);
  assert.equal(lib.checkWaitMs(login, ACCT, NOW), 0, 'no wait, and no "did not load" line in the popup');
  assert.deepEqual(login.sinceCheck, ['m1']);
  const other = { status: 'wrong-account', reason: 'logged in as @someone_else, not @startupbros' };
  assert.equal(lib.recordCheckFailed(pendingOne(), other, NOW, ACCT).days[DAY].stopped, `settings/muted/all check: wrong-account (${other.reason})`);
});

test('recordCheckFailed: a failure long after the second try was due is a first failure again', () => {
  const r = lib.recordCheckFailed(pendingOne(), NO_ROWS, NOW, ACCT);
  const due = NOW + 15 * 60000;
  // The browser was closed or muting was off through the try: hours later, a
  // failure waits again instead of stopping the day.
  const late = lib.recordCheckFailed(r, NO_ROWS, due + 15 * 60000, ACCT);
  assert.equal(lib.muteBudget(late, DAY).stopped, null);
  assert.equal(late.checkRetry.at, due + 30 * 60000);
  // Within that time after it was due, it is the second try failing.
  assert.equal(lib.recordCheckFailed(r, NO_ROWS, due + 15 * 60000 - 1, ACCT).days[DAY].stopped, NO_ROWS_STOP);
});

test('daily mute writes add the same defaults on a new UTC day without mutating history', () => {
  const midnight = Date.parse('2026-10-10T00:00:00.000Z');
  const older = Object.freeze({ mutes: 7, visits: 8, stopped: 'yesterday', unmutes: 1 });
  const start = { ...lib.emptyMutes(), days: Object.freeze({ '2026-10-09': older }) };
  const edits = [
    [r => lib.recordOutcome(r, 'example', { status: 'muted' }, midnight), { mutes: 1, visits: 0, stopped: null }],
    [r => lib.countVisit(r, midnight), { mutes: 0, visits: 1, stopped: null }],
    [r => lib.stopDay(r, midnight, 'today'), { mutes: 0, visits: 0, stopped: 'today' }],
  ];
  for (const [edit, today] of edits) {
    const result = edit(start);
    assert.deepEqual(result.days, { '2026-10-09': older, '2026-10-10': today });
    assert.notStrictEqual(result.days['2026-10-09'], older);
    assert.deepEqual(start.days, { '2026-10-09': older });
  }
});

test('daily mute writes preserve previously recorded counts, stop reason and extension fields', () => {
  const now = Date.parse('2026-10-09T23:59:59.999Z');
  const day = { mutes: 2, visits: 3, stopped: 'earlier', unmutes: 1, extra: { retained: true } };
  const start = { ...lib.emptyMutes(), days: { '2026-10-09': day } };
  let state = lib.countVisit(start, now);
  state = lib.recordOutcome(state, 'example', { status: 'muted' }, now);
  assert.deepEqual(state.days['2026-10-09'], { ...day, mutes: 3, visits: 4 });
  assert.deepEqual(lib.stopDay(state, now, 'other').days, {
    '2026-10-09': { ...day, mutes: 3, visits: 4, stopped: 'other' },
  });
  assert.deepEqual(start.days, { '2026-10-09': { ...day, mutes: 2, visits: 3, stopped: 'earlier' } });
});
