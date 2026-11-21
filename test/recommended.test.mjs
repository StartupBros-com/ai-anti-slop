// The Recommended list (#79): its rule over levelsio's NDJSON rows, its two
// sources each checked on their own, the record's parts, its default, and
// labels that name the source holding an account. Handles are invented; the
// rows have the fields levelsio's accounts.ndjson had on 2026-11-21.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib as L } from './helpers.mjs';

const AI = 'https://clankwall.vogel.dev/api/usernames.txt';
const LV = 'https://blockedforaireply.levels.io/api/accounts.ndjson';
const SOURCES = L.BUILTIN_LISTS.find((b) => b.id === 'recommended').sources;

// One levelsio row. Only "confirmed" rows carry evidence there.
const row = (username, tier, evidence = tier === 'confirmed' ? 1 : 0) =>
  JSON.stringify({
    id: '1',
    username,
    sources: tier ? ['levelsio'] : ['ryanvogel'],
    levelsio: tier,
    ryanvogel: null,
    reason: tier === 'confirmed' ? 'ai_reply' : null,
    account_created: '2024-01-01',
    blocked_reply_date: tier === 'confirmed' ? '2026-11-01' : null,
    evidence: Array.from({ length: evidence }, () => ({
      date: '2026-11-01',
      their_reply: 'reply text',
      their_reply_status: 'ok',
      text: 'AI bot',
      levelsio_reply: 'https://x.com/levelsio/status/1',
      their_post: 'https://x.com/i/status/2',
    })),
  });
const ok = (body, type = 'text/plain') => ({ ok: true, status: 200, headers: { get: () => type }, text: async () => body });
const fetchFrom = (bodies, seen = []) => async (url) => {
  seen.push(url);
  const b = bodies[url];
  if (b === undefined) return { ok: false, status: 404, headers: { get: () => 'text/plain' }, text: async () => '' };
  return typeof b === 'string' ? ok(b, url.endsWith('.ndjson') ? 'application/octet-stream' : 'text/plain') : b;
};
const many = (n, p = 'h') => Array.from({ length: n }, (_, i) => `${p}${i}`);

// ------------------------------------------------------------- the rule

test('levelsio rows: only confirmed rows with evidence are kept; the rest are left out, not rejected', () => {
  const body = [
    row('conf_a', 'confirmed'),
    row('conf_b', 'confirmed', 2),
    row('conf_none', 'confirmed', 0),
    row('likely_a', 'likely'),
    row('blocked_a', 'blocked'),
    row('copied_a', null),
    '',
    'not json',
    JSON.stringify({ username: 'bad handle!', levelsio: 'confirmed', evidence: [{}] }),
  ].join('\n');
  const parsed = L.parseNdjsonUsernames(body, { keep: L.levelsioConfirmed });
  assert.deepEqual(parsed, { handles: ['conf_a', 'conf_b'], rejected: 2, error: null });
  // Without a filter every row with a handle is kept, as for clankwall's file.
  assert.deepEqual(L.parseNdjsonUsernames(body).handles, ['blocked_a', 'conf_a', 'conf_b', 'conf_none', 'copied_a', 'likely_a']);
});

test('levelsio rows: a feed where the filter keeps few of many rows is not "mostly not handles"', async () => {
  // 6 of every 7 rows are other tiers, about the share on 2026-11-21 (3,229 of 3,750).
  const lines = [];
  for (let i = 0; i < 30; i++) {
    lines.push(row(`c${i}`, 'confirmed'));
    for (const t of ['likely', 'blocked', 'blocked', 'likely', 'blocked', null]) lines.push(row(`${t || 'n'}${i}`, t));
  }
  const r = await L.fetchList({ url: LV, format: 'levelsio-confirmed', fetchImpl: fetchFrom({ [LV]: lines.join('\n') }) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.handles, many(30, 'c').sort());
  assert.equal(r.rejected, 0);
});

test('levelsio rows: the NDJSON size cap applies, so a file over 1 MB is read', async () => {
  // levelsio's file was 965,689 bytes on 2026-11-21 and growing.
  const lines = [];
  for (let i = 0, n = 0; n < 1200000; i++) {
    lines.push(row(`c${i}`, 'confirmed'));
    n += lines[i].length + 1;
  }
  const body = lines.join('\n');
  assert.ok(body.length > L.DEFAULTS.maxBytes && body.length < L.DEFAULTS.ndjsonMaxBytes);
  const r = await L.fetchList({ url: LV, format: 'levelsio-confirmed', fetchImpl: fetchFrom({ [LV]: body }) });
  assert.equal(r.ok, true);
  assert.equal(r.handles.length, lines.length);
  // The same size as a plain text list is refused.
  const t = await L.fetchList({ url: AI, format: 'text', fetchImpl: fetchFrom({ [AI]: 'x'.repeat(body.length) }) });
  assert.deepEqual(t, { ok: false, reason: `feed larger than ${L.DEFAULTS.maxBytes} bytes` });
});

// ---------------------------------------------------------- two sources

test('Recommended: both sources fetched, the union stored with each source\'s part', async () => {
  const seen = [];
  const r = await L.fetchList({
    url: LV,
    format: 'recommended',
    sources: SOURCES,
    fetchImpl: fetchFrom({ [AI]: 'ai_a\nboth\n', [LV]: [row('both', 'confirmed'), row('lv_a', 'confirmed'), row('lv_old', 'blocked')].join('\n') }, seen),
  });
  assert.deepEqual(seen.sort(), [AI, LV].sort());
  assert.deepEqual(r, {
    ok: true,
    handles: ['ai_a', 'both', 'lv_a'],
    parts: [
      { source: AI, handles: ['ai_a', 'both'] },
      { source: LV, handles: ['both', 'lv_a'] },
    ],
    rejected: 0,
  });
});

test('Recommended: a source that fails refuses the whole update and is named by its host', async () => {
  const lv = [row('lv_a', 'confirmed')].join('\n');
  const down = await L.fetchList({ url: LV, sources: SOURCES, fetchImpl: fetchFrom({ [LV]: lv }) });
  assert.deepEqual(down, { ok: false, reason: 'clankwall.vogel.dev: HTTP 404' });
  const html = await L.fetchList({ url: LV, sources: SOURCES, fetchImpl: fetchFrom({ [AI]: 'ai_a\n', [LV]: ok('<html></html>', 'text/html') }) });
  assert.deepEqual(html, { ok: false, reason: 'blockedforaireply.levels.io: unexpected content-type text/html' });
});

test('Recommended: levelsio\'s rows losing the tier field refuse the update, though clankwall\'s part alone is not empty', async () => {
  // Every row still parses, but none says "confirmed": the filter keeps nothing.
  const renamed = [1, 2, 3].map((i) => JSON.stringify({ username: `lv_${i}`, tier: 'confirmed', evidence: [{}] })).join('\n');
  const r = await L.fetchList({ url: LV, sources: SOURCES, fetchImpl: fetchFrom({ [AI]: many(40).join('\n'), [LV]: renamed }) });
  assert.deepEqual(r, { ok: false, reason: 'blockedforaireply.levels.io: empty list' });
});

test('Recommended: each source is held to the shrink guard against its own part, not the union', async () => {
  const prevParts = [
    { source: AI, handles: many(40, 'a') },
    { source: LV, handles: many(40, 'l') },
  ];
  // levelsio's part drops from 40 to 10; the union (50 of 80) would pass the half rule.
  const lv = many(10, 'l').map((h) => row(h, 'confirmed')).join('\n');
  const r = await L.fetchList({ url: LV, sources: SOURCES, prevHandles: [...many(40, 'a'), ...many(40, 'l')], prevParts, fetchImpl: fetchFrom({ [AI]: many(40, 'a').join('\n'), [LV]: lv }) });
  assert.deepEqual(r, { ok: false, reason: 'blockedforaireply.levels.io: list shrank from 40 to 10' });
  // The same drop with no part stored for that source is a first fetch, and passes.
  const first = await L.fetchList({ url: LV, sources: SOURCES, prevParts: [prevParts[0]], fetchImpl: fetchFrom({ [AI]: many(40, 'a').join('\n'), [LV]: lv }) });
  assert.equal(first.ok, true);
  assert.equal(first.handles.length, 50);
});

test('Recommended record: a success stores the parts, a failure keeps them and the handles', () => {
  const okResult = { ok: true, handles: ['a', 'b'], parts: [{ source: AI, handles: ['a'] }, { source: LV, handles: ['b'] }] };
  const rec = L.commitRecord(null, okResult, LV, 0, 100);
  assert.deepEqual(rec, { handles: ['a', 'b'], fetchedAt: 100, source: LV, lastAttemptAt: 100, lastError: null, parts: okResult.parts, seq: 1 });
  const failed = L.commitRecord(rec, { ok: false, reason: 'blockedforaireply.levels.io: HTTP 503' }, LV, 1, 200);
  assert.deepEqual(failed, { ...rec, lastAttemptAt: 200, lastError: 'blockedforaireply.levels.io: HTTP 503' });
  // A one-source list's record has no parts.
  assert.equal('parts' in L.nextRecord(null, { ok: true, handles: ['a'] }, AI, 1), false);
});

// ----------------------------------------------------------- the default

test('Recommended is first and on until switched off, the userscript never has it, and muting still reads the AI list', () => {
  const subs = L.subscriptions(null);
  const rec = subs[0];
  assert.deepEqual([rec.id, rec.name, rec.on, rec.mute, rec.locked, rec.url, rec.format], ['recommended', 'Recommended', true, false, false, LV, 'recommended']);
  assert.deepEqual(
    rec.sources.map((s) => [s.url, s.format, s.name, s.about]),
    [
      [AI, 'text', 'clankwall', 'https://clankwall.vogel.dev/?filter=ai'],
      [LV, 'levelsio-confirmed', 'levelsio', 'https://blockedforaireply.levels.io/'],
    ],
  );
  assert.deepEqual(L.enabledLists(null).map((l) => l.id), ['recommended', 'clankwall-ai']);
  assert.deepEqual(L.enabledLists({ lists: { recommended: false } }).map((l) => l.id), ['clankwall-ai']);
  assert.deepEqual(L.enabledLists({ lists: { recommended: true, 'clankwall-ai': false } }).map((l) => l.id), ['recommended']);
  assert.deepEqual(L.enabledLists(null, { userscript: true }).map((l) => l.id), ['clankwall-ai']);
  assert.equal(L.MUTE_LIST, 'clankwall-ai');
  // Switching it off is stored like any built-in's switch.
  assert.deepEqual(L.listOnPatch({}, 'recommended', false), { ok: true, patch: { lists: { recommended: false } } });
  // Its clankwall source is clankwall's published list, whatever feedUrl says.
  assert.equal(L.subscriptions({ feedUrl: 'https://example.com/x.txt' })[0].sources[0].url, AI);
});

// ------------------------------------------------------------- labels

test('labelRecord with Recommended as one entry per source: the host is the source holding the account, lists names it once', () => {
  const MSG = { label: 'slop', handle: 'ai_a', url: '/ai_a/status/2', page: '/op/status/1', text: 'hi' };
  const recommended = [
    { id: 'recommended', url: AI, handles: ['ai_a', 'both'] },
    { id: 'recommended', url: LV, handles: ['both', 'lv_a'] },
  ];
  const withAi = [...recommended, { id: 'clankwall-ai', url: AI, handles: ['ai_a', 'both'] }];
  const a = L.labelRecord(MSG, { lists: withAi, settings: {} }, 5).record;
  assert.deepEqual([a.list, a.lists, a.hidden], ['clankwall.vogel.dev', ['recommended', 'clankwall-ai'], true]);
  const lv = L.labelRecord({ ...MSG, handle: 'lv_a', url: '/lv_a/status/2' }, { lists: withAi, settings: {} }, 5).record;
  assert.deepEqual([lv.list, lv.lists, lv.hidden], ['blockedforaireply.levels.io', ['recommended'], true]);
  const both = L.labelRecord({ ...MSG, handle: 'both', url: '/both/status/2' }, { lists: withAi, settings: {} }, 5).record;
  assert.deepEqual([both.list, both.lists], ['clankwall.vogel.dev', ['recommended', 'clankwall-ai']]);
  // With the AI list switched off, an account from clankwall's file still names clankwall.
  const alone = L.labelRecord(MSG, { lists: recommended, settings: {} }, 5).record;
  assert.deepEqual([alone.list, alone.lists], ['clankwall.vogel.dev', ['recommended']]);
});
