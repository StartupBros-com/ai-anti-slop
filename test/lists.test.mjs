// The lists AI Anti-Slop hides from: the catalogue, storage keys, the settings
// shape, address checks, NDJSON parsing and fetching, and labels over several
// lists. Handles are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib as L, runContent, page, post, tick, src } from './helpers.mjs';

const AI = 'https://clankwall.vogel.dev/api/usernames.txt';
const ALL = 'https://clankwall.vogel.dev/api/accounts.ndjson';
const nd = (...names) => names.map((n) => JSON.stringify({ username: n, verdict: 'x' })).join('\n');
const ok = (body, type = 'application/x-ndjson') => ({ ok: true, status: 200, headers: { get: () => type }, text: async () => body });
const many = (n) => Array.from({ length: n }, (_, i) => `h${i}`);

// ------------------------------------------------------------ subscriptions

test('subscriptions: by default the AI list is on and All flags is off', () => {
  const subs = L.subscriptions({});
  assert.deepEqual(subs.map((l) => [l.id, l.on, l.builtin, l.mute, l.locked]), [
    ['clankwall-ai', true, true, true, false],
    ['clankwall-all', false, true, false, false],
  ]);
  assert.equal(subs[0].url, AI);
  assert.equal(subs[0].format, 'text');
  assert.equal(subs[1].url, ALL);
  assert.equal(subs[1].format, 'clankwall-ndjson');
  assert.equal(subs[0].about, 'https://clankwall.vogel.dev/?filter=ai');
  assert.deepEqual(L.enabledLists({}).map((l) => l.id), ['clankwall-ai']);
  assert.deepEqual(L.subscriptions(null).map((l) => l.id), ['clankwall-ai', 'clankwall-all']);
});

test('subscriptions: settings.lists overrides each built-in, and malformed lists is ignored', () => {
  const on = (s) => L.subscriptions(s).map((l) => l.on);
  assert.deepEqual(on({ lists: { 'clankwall-all': true } }), [true, true]);
  assert.deepEqual(on({ lists: { 'clankwall-ai': false } }), [false, false]);
  assert.deepEqual(on({ lists: { 'clankwall-all': 'yes' } }), [true, false], 'only true switches All flags on');
  assert.deepEqual(on({ lists: 'junk' }), [true, false]);
  assert.deepEqual(on({ lists: ['clankwall-all'] }), [true, false]);
  assert.deepEqual(L.enabledLists({ lists: { 'clankwall-ai': false, 'clankwall-all': true } }).map((l) => l.id), ['clankwall-all']);
});

test('subscriptions: the AI list is locked on while muting is on, whatever lists says', () => {
  const [ai] = L.subscriptions({ muteEnabled: true, lists: { 'clankwall-ai': false } });
  assert.deepEqual([ai.on, ai.locked], [true, true]);
  const [off] = L.subscriptions({ muteEnabled: false, lists: { 'clankwall-ai': false } });
  assert.deepEqual([off.on, off.locked], [false, false]);
  const [lockedDefault] = L.subscriptions({ muteEnabled: true });
  assert.deepEqual([lockedDefault.on, lockedDefault.locked], [true, true]);
});

test('subscriptions: feedUrl is the AI list address', () => {
  assert.equal(L.subscriptions({ feedUrl: 'https://mirror.example/ai.txt' })[0].url, 'https://mirror.example/ai.txt');
});

test('subscriptions: added lists follow the built-ins, named by host, path and query', () => {
  const s = { customLists: [{ id: 'uabc', url: 'https://raw.example.com/x/list.txt?token=1#frag', on: true }, { id: 'udef', url: 'https://b.example/l.txt', on: false }] };
  const subs = L.subscriptions(s);
  assert.deepEqual(subs.map((l) => l.id), ['clankwall-ai', 'clankwall-all', 'uabc', 'udef']);
  const [, , a, b] = subs;
  assert.deepEqual(
    { ...a },
    {
      id: 'uabc',
      name: 'raw.example.com/x/list.txt?token=1',
      url: 'https://raw.example.com/x/list.txt?token=1',
      format: 'text',
      on: true,
      builtin: false,
      mute: false,
      locked: false,
      about: 'https://raw.example.com/x/list.txt?token=1',
      note: null,
    },
  );
  assert.equal(b.on, false);
  assert.deepEqual(L.enabledLists(s).map((l) => l.id), ['clankwall-ai', 'uabc']);
  assert.deepEqual(L.enabledLists(s, { builtinOnly: true }).map((l) => l.id), ['clankwall-ai']);
});

test('subscriptions: two added addresses that differ only in the query get two names', () => {
  const s = { customLists: [{ id: 'ua', url: 'https://h.example/list?id=1', on: true }, { id: 'ub', url: 'https://h.example/list?id=2', on: true }] };
  const names = L.subscriptions(s).slice(2).map((l) => l.name);
  assert.deepEqual(names, ['h.example/list?id=1', 'h.example/list?id=2']);
});

test('subscriptions: malformed added lists are ignored, and at most 5 are read', () => {
  const good = (i) => ({ id: `u${i}`, url: `https://h${i}.example/l.txt`, on: true });
  const s = {
    customLists: [
      null,
      'text',
      { id: 'bad id', url: 'https://a.example/l' },
      { id: 'Uupper', url: 'https://a.example/l' },
      { id: 'u', url: 'https://a.example/l' },
      { id: 'u' + 'a'.repeat(17), url: 'https://a.example/l' },
      { id: 'uhttp', url: 'http://a.example/l' },
      { id: 'ucred', url: 'https://me:pw@a.example/l' },
      { id: 'unourl' },
      good(1),
      good(1),
      good(2),
      good(3),
      good(4),
      good(5),
      good(6),
      good(7),
    ],
  };
  assert.deepEqual(L.subscriptions(s).filter((l) => !l.builtin).map((l) => l.id), ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.deepEqual(L.subscriptions({ customLists: 'nope' }).map((l) => l.id), ['clankwall-ai', 'clankwall-all']);
});

// ------------------------------------------------------------------ keys

test('listKey and isListKey: the AI list keeps its old key; label keys are not list keys', () => {
  assert.equal(L.listKey('clankwall-ai'), 'xsh:list');
  assert.equal(L.listKey('clankwall-all'), 'xsh:list:clankwall-all');
  assert.equal(L.listKey('uabc'), 'xsh:list:uabc');
  assert.equal(L.STORAGE_KEYS.list, 'xsh:list');
  assert.equal(L.isListKey('xsh:list'), true);
  assert.equal(L.isListKey('xsh:list:clankwall-all'), true);
  assert.equal(L.isListKey('xsh:list:uabc'), true);
  for (const k of ['xsh:label:1', 'xsh:labelCount', 'xsh:settings', 'xsh:mutes', 'xsh:listing', 'list', '', undefined]) {
    assert.equal(L.isListKey(k), false, String(k));
  }
});

// ----------------------------------------------------------- address checks

test('checkListUrl: https only, no credentials, hash dropped, length capped', () => {
  assert.deepEqual({ ...L.checkListUrl('  https://a.example/l.txt  ') }, { ok: true, url: 'https://a.example/l.txt' });
  assert.deepEqual({ ...L.checkListUrl('https://a.example/l.txt?x=1#top') }, { ok: true, url: 'https://a.example/l.txt?x=1' });
  const http = L.checkListUrl('http://a.example/l.txt');
  assert.equal(http.ok, false);
  assert.match(http.reason, /starts with https:\/\//);
  assert.equal(L.checkListUrl('https://me:pw@a.example/l.txt').ok, false);
  assert.equal(L.checkListUrl('https://me@a.example/l.txt').ok, false);
  assert.equal(L.checkListUrl('ftp://a.example/l.txt').ok, false);
  assert.equal(L.checkListUrl('not a url').ok, false);
  assert.equal(L.checkListUrl('').ok, false);
  assert.equal(L.checkListUrl(null).ok, false);
  const long = `https://a.example/${'x'.repeat(L.DEFAULTS.listUrlMax)}`;
  assert.equal(L.checkListUrl(long).ok, false);
  const exact = `https://a.example/${'x'.repeat(L.DEFAULTS.listUrlMax - 'https://a.example/'.length)}`;
  assert.equal(exact.length, L.DEFAULTS.listUrlMax);
  assert.equal(L.checkListUrl(exact).ok, true);
});

test('defaults: the new limits', () => {
  assert.equal(L.DEFAULTS.ndjsonMaxBytes, 8000000);
  assert.equal(L.DEFAULTS.customListMax, 5);
  assert.equal(L.DEFAULTS.listUrlMax, 500);
  assert.equal(L.MUTE_LIST, 'clankwall-ai');
});

// --------------------------------------------------------------- patches

test('addListPatch: adds an entry with a fresh id, keeps the others, and refuses past 5', () => {
  const r = L.addListPatch({}, 'https://a.example/l.txt#x', 1700000000000);
  assert.equal(r.ok, true);
  assert.equal(r.id, `u${(1700000000000).toString(36)}`);
  assert.deepEqual(r.patch, { customLists: [{ id: r.id, url: 'https://a.example/l.txt', on: true }] });
  // The patch applied, a second add keeps the first.
  const s = { customLists: r.patch.customLists };
  const r2 = L.addListPatch(s, 'https://b.example/l.txt', 1700000000001);
  assert.deepEqual(r2.patch.customLists.map((c) => c.url), ['https://a.example/l.txt', 'https://b.example/l.txt']);
  // Cap.
  const five = { customLists: [1, 2, 3, 4, 5].map((i) => ({ id: `u${i}`, url: `https://h${i}.example/l`, on: true })) };
  const refused = L.addListPatch(five, 'https://h6.example/l', 1);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /at most 5/);
  assert.equal(refused.patch, undefined);
});

test('addListPatch: refuses an address a list already uses, clankwall own included, and a bad address', () => {
  const s = { customLists: [{ id: 'u1', url: 'https://a.example/l.txt', on: true }] };
  assert.equal(L.addListPatch(s, 'https://a.example/l.txt#again', 1).ok, false);
  assert.equal(L.addListPatch({}, ALL, 1).ok, false);
  assert.equal(L.addListPatch({}, `${AI}#x`, 1).ok, false);
  assert.equal(L.addListPatch({ feedUrl: 'https://m.example/ai.txt' }, 'https://m.example/ai.txt', 1).ok, false);
  assert.equal(L.addListPatch({}, 'http://a.example/l.txt', 1).ok, false);
  assert.match(L.addListPatch({}, 'http://a.example/l.txt', 1).reason, /https:\/\//);
});

test('addListPatch: the new id is unique even when the time repeats', () => {
  const t = 1700000000000;
  const id = `u${t.toString(36)}`;
  const s = { customLists: [{ id, url: 'https://a.example/l', on: true }] };
  const r = L.addListPatch(s, 'https://b.example/l', t);
  assert.equal(r.ok, true);
  assert.notEqual(r.id, id);
  assert.match(r.id, /^u[a-z0-9]{1,16}$/);
  assert.equal(new Set(r.patch.customLists.map((c) => c.id)).size, 2);
});

test('removeListPatch: drops one added list, null when it is not there', () => {
  const s = { customLists: [{ id: 'u1', url: 'https://a.example/l', on: true }, { id: 'u2', url: 'https://b.example/l', on: true }] };
  assert.deepEqual(L.removeListPatch(s, 'u1'), { customLists: [{ id: 'u2', url: 'https://b.example/l', on: true }] });
  assert.equal(L.removeListPatch(s, 'u9'), null);
  assert.equal(L.removeListPatch(s, 'clankwall-all'), null);
  assert.equal(L.removeListPatch({}, 'u1'), null);
});

test('listOnPatch: built-ins write settings.lists, added lists their own entry', () => {
  assert.deepEqual(L.listOnPatch({}, 'clankwall-all', true), { ok: true, patch: { lists: { 'clankwall-all': true } } });
  assert.deepEqual(L.listOnPatch({ lists: { 'clankwall-ai': false } }, 'clankwall-all', true).patch, { lists: { 'clankwall-ai': false, 'clankwall-all': true } });
  assert.deepEqual(L.listOnPatch({}, 'clankwall-ai', false).patch, { lists: { 'clankwall-ai': false } });
  const s = { customLists: [{ id: 'u1', url: 'https://a.example/l', on: true }, { id: 'u2', url: 'https://b.example/l', on: true }] };
  assert.deepEqual(L.listOnPatch(s, 'u2', false).patch, {
    customLists: [{ id: 'u1', url: 'https://a.example/l', on: true }, { id: 'u2', url: 'https://b.example/l', on: false }],
  });
  assert.equal(L.listOnPatch({}, 'nope', true).ok, false);
});

test('listOnPatch: the AI list cannot be switched off while muting is on', () => {
  const r = L.listOnPatch({ muteEnabled: true }, 'clankwall-ai', false);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Muting uses this list, so it stays on while muting is on.');
  assert.equal(r.patch, undefined);
  assert.equal(L.listOnPatch({ muteEnabled: true }, 'clankwall-ai', true).ok, true);
  assert.equal(L.listOnPatch({ muteEnabled: true }, 'clankwall-all', false).ok, true);
  assert.equal(L.listOnPatch({ muteEnabled: false }, 'clankwall-ai', false).ok, true);
});

test('listChanges: names the lists to fetch and the added lists that went', () => {
  const u1 = { id: 'u1', url: 'https://a.example/l', on: true };
  const u2 = { id: 'u2', url: 'https://b.example/l', on: true };
  assert.deepEqual(L.listChanges({}, {}), { on: [], gone: [] });
  assert.deepEqual(L.listChanges({}, { allowlist: 'x', extraList: 'y' }), { on: [], gone: [] });
  assert.deepEqual(L.listChanges({}, { lists: { 'clankwall-all': true } }), { on: ['clankwall-all'], gone: [] });
  assert.deepEqual(L.listChanges({ lists: { 'clankwall-all': true } }, { lists: { 'clankwall-all': false } }), { on: [], gone: [] });
  assert.deepEqual(L.listChanges({ lists: { 'clankwall-ai': false } }, {}), { on: ['clankwall-ai'], gone: [] });
  assert.deepEqual(L.listChanges({}, { feedUrl: 'https://m.example/ai.txt' }), { on: ['clankwall-ai'], gone: [] }, 'a new address');
  assert.deepEqual(L.listChanges({}, { customLists: [u1] }), { on: ['u1'], gone: [] });
  assert.deepEqual(L.listChanges({ customLists: [u1] }, { customLists: [{ ...u1, url: 'https://c.example/l' }] }), { on: ['u1'], gone: [] });
  assert.deepEqual(L.listChanges({ customLists: [u1, u2] }, { customLists: [u2] }), { on: [], gone: ['u1'] });
  assert.deepEqual(L.listChanges({ customLists: [u1] }, { customLists: [{ ...u1, on: false }] }), { on: [], gone: [] });
  assert.deepEqual(L.listChanges({ customLists: [{ ...u1, on: false }] }, { customLists: [u1] }), { on: ['u1'], gone: [] });
  // Muting turned on keeps the AI list on: nothing to fetch.
  assert.deepEqual(L.listChanges({}, { muteEnabled: true }), { on: [], gone: [] });
  assert.deepEqual(L.listChanges({ lists: { 'clankwall-ai': false } }, { muteEnabled: true }), { on: ['clankwall-ai'], gone: [] });
});

// --------------------------------------------------------------- NDJSON

test('parseNdjsonUsernames: reads each line username, counts the rest as rejected', () => {
  const text = [
    JSON.stringify({ username: 'Spam1', score: 3 }),
    '',
    '   ',
    JSON.stringify({ username: '@aionly' }),
    '{not json',
    JSON.stringify({ score: 1 }),
    JSON.stringify({ username: 'not a handle!' }),
    JSON.stringify({ username: 42 }),
    JSON.stringify(['spam1']),
    JSON.stringify(null),
    JSON.stringify({ username: 'spam1' }),
  ].join('\r\n');
  assert.deepEqual(L.parseNdjsonUsernames(text), { handles: ['aionly', 'spam1'], rejected: 6, error: null });
  assert.deepEqual(L.parseNdjsonUsernames(''), { handles: [], rejected: 0, error: null });
});

test('parseNdjsonUsernames: more than maxHandles is an error', () => {
  assert.deepEqual(L.parseNdjsonUsernames(nd(...many(4)), { maxHandles: 3 }), { handles: [], rejected: 0, error: 'too many handles' });
  assert.equal(L.parseNdjsonUsernames(nd(...many(3)), { maxHandles: 3 }).handles.length, 3);
});

test('fetchList: clankwall-ndjson parses lines, and text stays the default', async () => {
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    return ok(nd('spam1', 'Spam2', 'aionly'));
  };
  const r = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl });
  assert.deepEqual({ ...r }, { ok: true, handles: ['aionly', 'spam1', 'spam2'], rejected: 0 });
  assert.deepEqual(urls, [ALL]);
  // Without a format the same body is not a list of handles.
  const plain = await L.fetchList({ url: ALL, fetchImpl });
  assert.equal(plain.ok, false);
  assert.match(plain.reason, /mostly not handles/);
});

test('fetchList: NDJSON size cap is 8 MB by default, text stays at 1 MB, an explicit maxBytes wins', async () => {
  const big = (n) => ({ ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => `${nd('spam1')}\n${' '.repeat(n)}` });
  const nd1 = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl: async () => big(1500000) });
  assert.equal(nd1.ok, true, 'over 1 MB but under 8 MB');
  const nd2 = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl: async () => big(8000000) });
  assert.equal(nd2.ok, false);
  assert.match(nd2.reason, /larger than 8000000 bytes/);
  const text = await L.fetchList({ url: AI, fetchImpl: async () => big(1500000) });
  assert.match(text.reason, /larger than 1000000 bytes/);
  const small = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', maxBytes: 50, fetchImpl: async () => ok(nd(...many(10))) });
  assert.match(small.reason, /larger than 50 bytes/);
});

test('fetchList: NDJSON keeps the shrink guard, the mostly-not-handles rule and the content type check', async () => {
  const prev = many(100);
  const shrunk = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', prevHandles: prev, fetchImpl: async () => ok(nd(...many(10))) });
  assert.equal(shrunk.ok, false);
  assert.match(shrunk.reason, /shrank from 100 to 10/);
  const kept = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', prevHandles: prev, fetchImpl: async () => ok(nd(...many(60))) });
  assert.equal(kept.ok, true);
  const junk = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl: async () => ok(`${nd('a1')}\nnot json\nalso not\n`) });
  assert.equal(junk.ok, false);
  assert.match(junk.reason, /mostly not handles \(2 invalid lines\)/);
  const html = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl: async () => ok(nd('a1'), 'text/html; charset=utf-8') });
  assert.match(html.reason, /unexpected content-type/);
  const empty = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl: async () => ok('') });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty list');
  const failed = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(failed.reason, 'HTTP 503');
  const boom = await L.fetchList({ url: ALL, format: 'clankwall-ndjson', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(boom.reason, 'network error: down');
});

// ---------------------------------------------------------------- union

test('unionHandles: sorted and de-duplicated, tolerant of missing records', () => {
  assert.deepEqual(L.unionHandles([{ handles: ['b1', 'a1'] }, { handles: ['c1', 'a1'] }]), ['a1', 'b1', 'c1']);
  assert.deepEqual(L.unionHandles([null, undefined, {}, { handles: 'nope' }, { handles: ['z1'] }]), ['z1']);
  assert.deepEqual(L.unionHandles(undefined), []);
  assert.deepEqual(L.unionHandles([]), []);
});

// --------------------------------------------------------------- labels

const MSG = { label: 'slop', handle: 'spamonly', url: '/spamonly/status/2', page: '/op/status/1', text: 'hi' };

test('labelRecord with ctx.lists: list is the first holder host, lists names every holder, hidden uses the union', () => {
  const lists = [
    { id: 'clankwall-ai', url: AI, handles: ['aionly', 'both'] },
    { id: 'clankwall-all', url: ALL, handles: ['both', 'spamonly'] },
    { id: 'u1', url: 'https://raw.example.com/x.txt', handles: ['both'] },
  ];
  const only = L.labelRecord(MSG, { lists, settings: {} }, 5);
  assert.equal(only.ok, true);
  assert.deepEqual([only.record.list, only.record.lists, only.record.hidden], ['clankwall.vogel.dev', ['clankwall-all'], true]);
  const both = L.labelRecord({ ...MSG, handle: 'both', url: '/both/status/2' }, { lists, settings: {} }, 5).record;
  assert.deepEqual([both.list, both.lists, both.hidden], ['clankwall.vogel.dev', ['clankwall-ai', 'clankwall-all', 'u1'], true]);
  const third = L.labelRecord({ ...MSG, handle: 'both', url: '/both/status/2' }, { lists: [lists[2]], settings: {} }, 5).record;
  assert.deepEqual([third.list, third.lists], ['raw.example.com', ['u1']]);
  const none = L.labelRecord({ ...MSG, handle: 'nobody', url: '/nobody/status/2' }, { lists, settings: {} }, 5).record;
  assert.deepEqual([none.list, none.lists, none.hidden], [null, [], false]);
  // The union decides hidden, and Always show still wins.
  const shown = L.labelRecord(MSG, { lists, settings: { allowlist: 'spamonly' } }, 5).record;
  assert.deepEqual([shown.allow, shown.hidden], [true, false]);
  // On the account's own page its replies show.
  const own = L.labelRecord({ ...MSG, page: '/spamonly/status/9' }, { lists, settings: {} }, 5).record;
  assert.equal(own.hidden, false);
});

test('labelRecord without ctx.lists: the record is what it was, with no lists field', () => {
  const r = L.labelRecord(MSG, { handles: ['spamonly'], source: AI, settings: { extraList: 'x1' } }, 7);
  assert.deepEqual(r.record, {
    at: 7,
    label: 'slop',
    handle: 'spamonly',
    url: 'https://x.com/spamonly/status/2',
    text: 'hi',
    page: 'https://x.com/op/status/1',
    list: 'clankwall.vogel.dev',
    extra: false,
    allow: false,
    hidden: true,
  });
  assert.equal('lists' in r.record, false);
  const unlisted = L.labelRecord(MSG, { handles: [], settings: {} }, 7).record;
  assert.deepEqual([unlisted.list, 'lists' in unlisted, unlisted.hidden], [null, false, false]);
});

// ---------------------------------------------------------------- content
//
// The real content.js with its own extension adapter, over a fake
// chrome.storage.

const ALL_KEY = 'xsh:list:clankwall-all';
const ALL_ON = { 'clankwall-all': true };
const record = (handles, source) => ({ handles, fetchedAt: Date.now(), source, lastAttemptAt: Date.now(), lastError: null });

// A fake chrome for content.js's own adapter, backed by `store`; `fire`
// delivers a storage change as the browser would.
function contentChrome(store) {
  const listeners = [];
  return {
    id: 'xshtest',
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
      },
      onChanged: { addListener: (f) => listeners.push(f) },
    },
    runtime: { id: 'xshtest', onMessage: { addListener() {} }, sendMessage: async () => null },
    fire: (changes) => listeners.forEach((f) => f(changes, 'local')),
  };
}

const twoStores = (settings) => ({
  'xsh:list': record(['aionly', 'both'], AI),
  [ALL_KEY]: record(['both', 'spamonly'], ALL),
  'xsh:settings': settings,
});

test('content: with All flags on, a reply by an account only on All flags is hidden; with it off it is shown', async () => {
  const cells = () => [post({ author: 'spamonly', status: '1' }), post({ author: 'aionly', status: '2' }), post({ author: 'human1', status: '3' })];
  const on = runContent(page(cells()), { chrome: contentChrome(twoStores({ lists: ALL_ON })) });
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(['1', '2', '3'].map(on.hidden), [true, true, false]);
  const off = runContent(page(cells()), { chrome: contentChrome(twoStores({})) });
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(['1', '2', '3'].map(off.hidden), [false, true, false]);
});

test('content: an Always-show entry beats every list', async () => {
  const t = runContent(page([post({ author: 'spamonly', status: '1' })]), {
    chrome: contentChrome(twoStores({ lists: ALL_ON, allowlist: 'spamonly' })),
  });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.hidden('1'), false);
});

test('content: a change to a list record, or to which lists are on, is read again', async () => {
  const store = twoStores({});
  const chrome = contentChrome(store);
  const t = runContent(page([post({ author: 'spamonly', status: '1' })]), { chrome });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.hidden('1'), false);
  store['xsh:settings'] = { lists: ALL_ON };
  chrome.fire({ 'xsh:settings': {} });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.hidden('1'), true, 'All flags switched on');
  store[ALL_KEY] = record(['other1'], ALL);
  chrome.fire({ [ALL_KEY]: {} });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.hidden('1'), false, 'its record changed');
  store[ALL_KEY] = record(['spamonly'], ALL);
  chrome.fire({ 'xsh:labelCount': {} });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.hidden('1'), false, 'a label key is not a list key');
});


test('settings page: its list switches are restated in forced-colors mode, as the popup does', () => {
  const css = src('src/settings.html').replace(/\/\*[\s\S]*?\*\//g, '');
  const open = '@media (forced-colors: active) {';
  const start = css.indexOf(open);
  assert.ok(start >= 0, 'the settings page has a forced-colors block');
  let depth = 0;
  let body = null;
  for (let i = start + open.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      body = css.slice(start + open.length, i);
      break;
    }
  }
  assert.ok(body, 'the block closes');
  const rule = (sel) => new RegExp(`${sel.replace(/[[\]():']/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`).exec(body);
  assert.match(rule("input[role='switch']")[1], /border:\s*2px solid ButtonText/);
  assert.match(rule("input[role='switch']::before")[1], /background:\s*ButtonText/);
  assert.match(rule("input[role='switch']:checked")[1], /background:\s*Highlight/);
  assert.match(rule("input[role='switch']:checked")[1], /border-color:\s*ButtonText/);
  assert.match(rule("input[role='switch']:checked::before")[1], /background:\s*HighlightText/);
});
