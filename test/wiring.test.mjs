// Wiring tests: run the real background.js and the built userscript against
// in-memory fakes of chrome.* and GM_*. They check the glue, not the browser;
// the live check on x.com is described in the README.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildUserscript } from '../scripts/build-userscript.mjs';
import { src, root, post, page, tick, lib, meLink } from './helpers.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';

const many = (n) => Array.from({ length: n }, (_, i) => `h${i}`);

function event() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.map((f) => f(...a)) };
}

function area(store, onChanged, name) {
  return {
    get: async (keys) => {
      if (keys === null || keys === undefined) return structuredClone(store);
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
    },
    set: async (o) => {
      const changes = Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: structuredClone(o[k]) }]));
      Object.assign(store, structuredClone(o));
      if (onChanged) onChanged.fire(changes, name);
    },
    remove: async (keys) => {
      const ks = (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store);
      const changes = Object.fromEntries(ks.map((k) => [k, { oldValue: structuredClone(store[k]) }]));
      for (const k of ks) delete store[k];
      if (onChanged && ks.length) onChanged.fire(changes, name);
    },
  };
}

const EXT_ID = 'xshtestextensionid';

// `browser` is the browser's own table of open tabs, which outlives a worker:
// a second worker after an update shares the first one's. tabs.get answers
// from it as Chrome does without the "tabs" permission: id, window and whether
// the tab is in front, no address; a closed tab is an error, and a tab id that
// is not an integer throws before any promise exists.
const newBrowser = () => ({ live: new Map(), nextId: 100 });

function fakeChrome(store = {}, browser = newBrowser()) {
  const session = {};
  const alarmTable = {};
  const onChanged = event();
  // `list` holds the user's own tabs: tabs.query returns them and every tab
  // opened for a job that is still open, without URLs (there is no "tabs"
  // permission). `answer(id, msg)` is a tab's reply to tabs.sendMessage; by
  // default no content script is there. A tab in `failRemove` will not close.
  const tabs = { opened: [], removed: [], browser, onRemoved: event(), list: [], queries: 0, asked: [], failRemove: new Set() };
  tabs.answer = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
  tabs.create = async (info) => {
    const tab = { id: browser.nextId++, windowId: 1, ...info };
    tabs.opened.push(tab);
    browser.live.set(tab.id, { id: tab.id, windowId: tab.windowId, active: info.active !== false });
    return tab;
  };
  tabs.get = (id) => {
    if (!Number.isInteger(id)) throw new TypeError('Error in invocation of tabs.get(integer tabId, optional function callback)');
    const t = browser.live.get(id);
    return t ? Promise.resolve(structuredClone(t)) : Promise.reject(new Error(`No tab with id: ${id}.`));
  };
  tabs.remove = async (id) => {
    if (tabs.failRemove.has(id)) throw new Error(`No tab with id: ${id}.`);
    tabs.removed.push(id);
    browser.live.delete(id);
    tabs.onRemoved.fire(id, {});
  };
  tabs.query = async () => {
    tabs.queries += 1;
    const jobTabs = tabs.opened.filter((t) => !tabs.removed.includes(t.id)).map((t) => ({ id: t.id }));
    return structuredClone([...tabs.list, ...jobTabs]);
  };
  tabs.sendMessage = async (id, msg) => {
    tabs.asked.push(id);
    return tabs.answer(id, msg);
  };
  return {
    store,
    session,
    alarmTable,
    tabs,
    storage: { local: area(store, onChanged, 'local'), session: area(session, onChanged, 'session'), onChanged },
    alarms: {
      get: async (name) => alarmTable[name],
      // Chrome's Alarm carries scheduledTime; when and periodInMinutes are kept as given.
      create: (name, info) => {
        const scheduledTime = info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000;
        alarmTable[name] = { name, ...info, scheduledTime };
      },
      clear: async (name) => {
        delete alarmTable[name];
        return true;
      },
      onAlarm: event(),
    },
    runtime: {
      id: EXT_ID,
      getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
      getManifest: () => JSON.parse(src('manifest.json')),
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
    },
  };
}

// A second worker may share the first one's local storage (`store`) and open
// tabs (`browser`) with an empty session: what a reload or update looks like.
// `timers` (from fakeTimers) replaces setTimeout and clearTimeout.
function loadBackground(responder, store, browser, timers = null) {
  const chrome = fakeChrome(store, browser);
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return responder(url);
  };
  const clock = timers || { setTimeout, clearTimeout };
  // A service worker has crypto and TextEncoder; sharing hashes with them.
  const ctx = vm.createContext({ chrome, fetch, AbortSignal, console, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, URL, crypto: globalThis.crypto, TextEncoder });
  ctx.self = ctx;
  ctx.importScripts = (p) => {
    assert.equal(p, 'lib.js');
    vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  };
  vm.runInContext(src('src/background.js'), ctx, { filename: 'src/background.js' });
  return { chrome, requests };
}

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => body });
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

test('background: install fetches the feed, stores it and schedules a 6-hour alarm', async () => {
  const bg = loadBackground(() => ok('Known_Slop\nfake_slop\n'));
  bg.chrome.store['xsh:settings'] = { lists: { recommended: false } };
  bg.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.deepEqual(bg.requests.map((r) => r.url), ['https://clankwall.vogel.dev/api/usernames.txt']);
  const rec = bg.chrome.store['xsh:list'];
  assert.deepEqual(rec.handles, ['fake_slop', 'known_slop']);
  assert.equal(rec.lastError, null);
  assert.equal(bg.chrome.alarmTable['xsh-refresh'].periodInMinutes, 360);
});

test('background: a failed or shrunken refresh keeps the stored list', async () => {
  let body = many(369).join('\n');
  let status = 200;
  const bg = loadBackground(() => (status === 200 ? ok(body) : { ok: false, status, headers: { get: () => null }, text: async () => '' }));
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  const fetchedAt = bg.chrome.store['xsh:list'].fetchedAt;
  status = 503;
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(bg.chrome.store['xsh:list'].lastError, 'HTTP 503');
  assert.equal(bg.chrome.store['xsh:list'].fetchedAt, fetchedAt);
  status = 200;
  body = many(10).join('\n');
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.match(bg.chrome.store['xsh:list'].lastError, /shrank from 369 to 10/);
});

test('background: startup refreshes only when due; the popup message forces it', async () => {
  const bg = loadBackground(() => ok('known_slop\n'));
  bg.chrome.store['xsh:settings'] = { lists: { recommended: false } };
  bg.chrome.store['xsh:list'] = { handles: ['known_slop'], fetchedAt: Date.now(), source: 's' };
  bg.chrome.runtime.onStartup.fire();
  await settle();
  assert.equal(bg.requests.length, 0);
  let reply;
  const keepOpen = bg.chrome.runtime.onMessage.fire({ type: 'xsh:refresh' }, {}, (r) => {
    reply = r;
  });
  assert.deepEqual(keepOpen, [true]);
  await settle();
  assert.equal(bg.requests.length, 1);
  assert.deepEqual({ ...reply }, { ok: true, reason: null, count: 1 });
});

test('background: overlapping triggers share one fetch; a later failure keeps the list', async () => {
  const pending = [];
  const bg = loadBackground(() => new Promise((resolve) => pending.push(resolve)));
  bg.chrome.store['xsh:settings'] = { lists: { recommended: false } };
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  let reply;
  bg.chrome.runtime.onMessage.fire({ type: 'xsh:refresh' }, {}, (r) => {
    reply = r;
  });
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.requests.length, 1);
  pending[0](ok(many(369).join('\n')));
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(reply.count, 369);
  // Once settled, the next trigger fetches again; its failure keeps the list.
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.requests.length, 2);
  pending[1]({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(bg.chrome.store['xsh:list'].lastError, 'HTTP 503');
});

test('background: a refresh commits against the list stored now, not the one it started from', async () => {
  const pending = [];
  const bg = loadBackground(() => new Promise((resolve) => pending.push(resolve)));
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  // Another writer stores a newer list while this fetch is in flight.
  bg.chrome.store['xsh:list'] = { handles: many(369), fetchedAt: Date.now(), source: 's', lastAttemptAt: Date.now(), lastError: null, seq: 1 };
  pending[0]({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(bg.chrome.store['xsh:list'].lastError, null);
});

test('background: a custom feed URL in settings is used', async () => {
  const bg = loadBackground(() => ok('known_slop\n'));
  bg.chrome.store['xsh:settings'] = { feedUrl: 'https://mirror.example/list.txt', lists: { recommended: false } };
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  assert.equal(bg.requests[0].url, 'https://mirror.example/list.txt');
  assert.equal(bg.chrome.store['xsh:list'].source, 'https://mirror.example/list.txt');
});

// ------------------------------------------------------------ muting

const ME = 'startupbros';
const today = () => lib.utcDay(Date.now());

// A worker with a stored list and the given settings, already installed.
async function muteBackground({ handles = ['slop_a', 'slop_b'], settings = { muteEnabled: true, muteAccount: ME }, mutes = null, timers = null } = {}) {
  const bg = loadBackground(() => ok(handles.join('\n')), undefined, undefined, timers);
  bg.chrome.store['xsh:list'] = { handles, fetchedAt: Date.now(), source: 's' };
  bg.chrome.store['xsh:settings'] = settings;
  if (mutes) bg.chrome.store['xsh:mutes'] = mutes;
  bg.chrome.runtime.onStartup.fire();
  await settle();
  return bg;
}

const alarm = async (bg, name = 'xsh-mute') => {
  bg.chrome.alarms.onAlarm.fire({ name });
  await settle();
};

function send(bg, msg, tabId) {
  return new Promise((resolve) => {
    const keep = bg.chrome.runtime.onMessage.fire(msg, { tab: { id: tabId } }, resolve);
    if (!keep.includes(true)) resolve(undefined);
  });
}

// Let the next visit happen now instead of 1-3 minutes on.
const due = (bg) => {
  bg.chrome.store['xsh:mutes'].nextAt = 0;
};

const lastTab = (bg) => bg.chrome.tabs.opened.at(-1);

test('background: muting is off by default; no alarm, no tab', async () => {
  const bg = await muteBackground({ settings: {} });
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  assert.equal(bg.chrome.alarmTable['xsh-mute'], undefined);
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
});

test('background: turning muting on sets a 1-minute alarm; turning it off clears it', async () => {
  const bg = await muteBackground({ settings: {} });
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: true, muteAccount: ME } });
  await settle();
  assert.equal(bg.chrome.alarmTable['xsh-mute'].periodInMinutes, 1);
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: false, muteAccount: null } });
  await settle();
  assert.equal(bg.chrome.alarmTable['xsh-mute'], undefined);
});

test('background: one visit opens a background tab, gives it the job once, records the mute and closes the tab', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1);
  const tab = lastTab(bg);
  assert.equal(tab.url, 'https://x.com/slop_a');
  assert.equal(tab.active, false);
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 1);
  assert.ok(bg.chrome.alarmTable['xsh-job-timeout'], 'a timeout alarm backs the job');
  // Another alarm while the job runs opens nothing more.
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1);

  assert.equal(await send(bg, { type: 'xsh:job' }, 999), null, 'any other tab gets no job');
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.equal(job.kind, 'mute');
  assert.equal(job.handle, 'slop_a');
  assert.equal(job.account, ME);
  assert.equal(await send(bg, { type: 'xsh:job' }, tab.id), null, 'a reload of the job tab does not get it again');

  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'muted', toast: '@slop_a has been muted.Undo' } }, tab.id);
  const m = bg.chrome.store['xsh:mutes'];
  assert.equal(m.handles.slop_a.status, 'muted');
  assert.equal(m.handles.slop_a.toast, '@slop_a has been muted.Undo');
  assert.equal(m.handles.slop_a.confirmed, null);
  assert.equal(m.days[today()].mutes, 1);
  assert.deepEqual(m.sinceCheck, ['slop_a']);
  assert.deepEqual(bg.chrome.tabs.removed, [tab.id]);
  assert.deepEqual(bg.chrome.session, {});
  assert.equal(bg.chrome.alarmTable['xsh-job-timeout'], undefined);
  const gap = m.nextAt - Date.now();
  assert.ok(gap > 50000 && gap <= 180000, `next visit 1-3 min away, got ${gap} ms`);
  // The gap holds the next visit back.
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1);
  due(bg);
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_b');
});

test('background: a report from another tab or with a stale id changes nothing', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  const tab = lastTab(bg);
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'muted' } }, 999);
  await send(bg, { type: 'xsh:job-result', result: { id: 'stale', status: 'muted' } }, tab.id);
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a, undefined);
  assert.deepEqual(bg.chrome.tabs.removed, []);
});

test('background: never visits @grok, the allowlist or settled accounts; accounts seen while browsing go first', async () => {
  const bg = await muteBackground({
    handles: ['done_a', 'friend', 'grok', 'slop_b', 'slop_c'],
    settings: { muteEnabled: true, muteAccount: ME, allowlist: 'Friend', showGrok: false },
    mutes: { ...lib.emptyMutes(), handles: { done_a: { status: 'muted', confirmed: true } } },
  });
  await send(bg, { type: 'xsh:sighting', handle: 'human' }, 5); // not listed: ignored
  await send(bg, { type: 'xsh:sighting', handle: 'slop_c' }, 5);
  assert.deepEqual(bg.chrome.store['xsh:mutes'].front, ['slop_c']);
  const visited = [];
  for (let i = 0; i < 4; i++) {
    await alarm(bg);
    const tab = lastTab(bg);
    if (!tab || visited.includes(tab.url)) break;
    visited.push(tab.url);
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'no-post' } }, tab.id);
    due(bg);
  }
  assert.deepEqual(visited, ['https://x.com/slop_c', 'https://x.com/slop_b']);
});

// Planted negative: @grok at its default never enters the queue, by sighting or by list.
test('background: visits a bot only when its row says Mute on X, and extra accounts like listed ones', async () => {
  const bg = await muteBackground({
    handles: ['grok', 'slop_a'],
    settings: { muteEnabled: true, muteAccount: ME, extraList: 'extra_a\nfriend', allowlist: 'friend', bots: { askperplexity: 'mute', bot: 'hide' } },
  });
  for (const h of ['grok', 'bot', 'friend', 'extra_a']) await send(bg, { type: 'xsh:sighting', handle: h }, 5);
  assert.deepEqual(bg.chrome.store['xsh:mutes'].front, ['extra_a']);
  const visited = [];
  for (let i = 0; i < 6; i++) {
    await alarm(bg);
    const tab = lastTab(bg);
    if (!tab || visited.includes(tab.url)) break;
    visited.push(tab.url);
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'no-post' } }, tab.id);
    due(bg);
  }
  assert.deepEqual(visited, ['https://x.com/extra_a', 'https://x.com/slop_a', 'https://x.com/askperplexity']);
});

test('background: after 5 mutes it checks settings/muted/all; a mute missing there stops the day', async () => {
  const five = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const handles = Object.fromEntries(five.map((h) => [h, { status: 'muted', confirmed: null }]));
  const bg = await muteBackground({
    handles: [...five, 'slop_z'],
    mutes: { ...lib.emptyMutes(), handles, sinceCheck: five, days: { [today()]: { mutes: 5, visits: 5, stopped: null } } },
  });
  await alarm(bg);
  const tab = lastTab(bg);
  assert.equal(tab.url, 'https://x.com/settings/muted/all');
  assert.equal(tab.active, false);
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 5, 'a check is not a profile visit');
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.equal(job.kind, 'check');
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'checked', rows: ['m5', 'm4', 'm2', 'm1', 'older'] } }, tab.id);
  const m = bg.chrome.store['xsh:mutes'];
  assert.deepEqual(five.map((h) => m.handles[h].confirmed), [true, true, false, true, true]);
  assert.deepEqual(m.sinceCheck, []);
  assert.match(m.days[today()].stopped, /@m3/);
  due(bg);
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1, 'stopped for the day: slop_z waits');
});

test('background: at the daily caps it only finishes a pending check', async () => {
  let bg = await muteBackground({ mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 25, visits: 25, stopped: null } } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
  bg = await muteBackground({ mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 3, visits: 50, stopped: null } } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
  bg = await muteBackground({
    mutes: {
      ...lib.emptyMutes(),
      handles: { m1: { status: 'muted', confirmed: null } },
      sinceCheck: ['m1'],
      days: { [today()]: { mutes: 25, visits: 30, stopped: null } },
    },
  });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened.map((t) => t.url), ['https://x.com/settings/muted/all']);
});

test('background: a tab that never answers is closed after 90 s, retried after the untried accounts, and left alone after a second failure', async () => {
  const bg = await muteBackground();
  const timeOut = async (attempt) => {
    await alarm(bg);
    const tab = lastTab(bg);
    assert.equal(tab.url, 'https://x.com/slop_a');
    bg.chrome.session['xsh:job'].startedAt -= 91000;
    await alarm(bg, 'xsh-job-timeout');
    assert.ok(bg.chrome.tabs.removed.includes(tab.id));
    const e = bg.chrome.store['xsh:mutes'].handles.slop_a;
    assert.equal(e.attempts, attempt);
    assert.equal(e.status, attempt === 1 ? 'error' : 'failed');
    due(bg);
  };
  await timeOut(1);
  // slop_b has not been tried yet, so it goes before slop_a's retry.
  await alarm(bg);
  const b = lastTab(bg);
  assert.equal(b.url, 'https://x.com/slop_b');
  const job = await send(bg, { type: 'xsh:job' }, b.id);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'already' } }, b.id);
  due(bg);
  await timeOut(2);
  await alarm(bg);
  // No fourth tab: slop_a failed twice and slop_b answered, so nothing is left to visit.
  assert.equal(bg.chrome.tabs.opened.length, 3, 'no new tab: nothing is left to visit');
  assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].mutes, 0);
});

test('background: closing the job tab counts as an error; turning muting off mid-job drops the job', async () => {
  let bg = await muteBackground();
  await alarm(bg);
  await bg.chrome.tabs.remove(lastTab(bg).id);
  await settle();
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a.status, 'error');
  assert.match(bg.chrome.store['xsh:mutes'].handles.slop_a.reason, /closed/);

  bg = await muteBackground();
  await alarm(bg);
  const tab = lastTab(bg);
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: false, muteAccount: null } });
  await alarm(bg, 'xsh-job-timeout');
  assert.ok(bg.chrome.tabs.removed.includes(tab.id));
  assert.deepEqual(bg.chrome.session, {});
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a, undefined);
});

// Planted negatives: a settings change while the job's tab loads (before it
// claims the job) or waits for a post (after) stops the click.
test('background: a job whose account stops being eligible is dropped at the claim or just before the click', async () => {
  const base = { muteEnabled: true, muteAccount: ME, bots: { askperplexity: 'mute' } };
  const changes = [
    { ...base, bots: { askperplexity: 'show' } },
    { ...base, bots: { askperplexity: 'hide' } },
    { ...base, allowlist: 'AskPerplexity' },
    { ...base, muteAccount: 'someone_else' },
  ];
  for (const when of ['claim', 'click']) {
    for (const next of changes) {
      const bg = await muteBackground({ handles: [], settings: base });
      await alarm(bg);
      const tab = lastTab(bg);
      assert.equal(tab.url, 'https://x.com/askperplexity');
      let job = null;
      if (when === 'click') {
        job = await send(bg, { type: 'xsh:job' }, tab.id);
        assert.equal(job.handle, 'askperplexity');
        assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, 999), false, 'another tab is told no');
        assert.equal(await send(bg, { type: 'xsh:job-go', id: 'stale' }, tab.id), false, 'a stale id is told no');
        assert.deepEqual(bg.chrome.tabs.removed, [], 'neither drops the job');
      }
      await bg.chrome.storage.local.set({ 'xsh:settings': next });
      await settle();
      if (when === 'claim') assert.equal(await send(bg, { type: 'xsh:job' }, tab.id), null, JSON.stringify(next));
      else assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), false, JSON.stringify(next));
      assert.deepEqual(bg.chrome.tabs.removed, [tab.id]);
      assert.deepEqual(bg.chrome.session, {});
      assert.equal(bg.chrome.alarmTable['xsh-job-timeout'], undefined);
      const m = bg.chrome.store['xsh:mutes'];
      assert.equal(m.handles.askperplexity, undefined, 'dropped unrecorded');
      assert.equal(m.days[today()].visits, 1, 'the visit stays counted');
    }
  }
});

test('background: the click is confirmed while nothing has changed, once the job is claimed', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  const tab = lastTab(bg);
  assert.equal(await send(bg, { type: 'xsh:job-go', id: 'any' }, tab.id), false, 'not before the claim');
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), true);
  assert.deepEqual(bg.chrome.tabs.removed, []);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'muted' } }, tab.id);
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a.status, 'muted');
});

test('background: a wrong-account or login report stops muting for the day', async () => {
  for (const status of ['wrong-account', 'login']) {
    const bg = await muteBackground();
    await alarm(bg);
    const tab = lastTab(bg);
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status, reason: 'x' } }, tab.id);
    const m = bg.chrome.store['xsh:mutes'];
    assert.match(m.days[today()].stopped, new RegExp(status));
    assert.equal(m.handles.slop_a, undefined, 'the account is tried again another day');
    due(bg);
    await alarm(bg);
    assert.equal(bg.chrome.tabs.opened.length, 1);
  }
});

test('userscript build: header grants and connects only what it uses', () => {
  const us = buildUserscript();
  assert.match(us, /^\/\/ ==UserScript==/);
  assert.match(us, /@connect {6}clankwall\.vogel\.dev/);
  assert.doesNotMatch(us, /@grant\s+none/);
  assert.doesNotMatch(us, /unsafeWindow/);
});

// Managers install an update only when @version rises, and fetch it from @updateURL.
test('userscript build: carries the manifest version, MIT licence and update URLs', () => {
  const us = buildUserscript();
  const version = JSON.parse(src('manifest.json')).version;
  const raw = 'https://raw.githubusercontent.com/StartupBros-com/ai-anti-slop/main/dist/x-slop-hide.user.js';
  assert.match(us, new RegExp(`^// @version {6}${version.replace(/\./g, '\\.')}$`, 'm'));
  assert.equal(JSON.parse(src('package.json')).version, version);
  assert.match(us, /^\/\/ @license {6}MIT$/m);
  assert.ok(us.includes(`// @downloadURL  ${raw}\n`));
  assert.ok(us.includes(`// @updateURL    ${raw}\n`));
});

// Run the built userscript in a VM with in-memory GM_* storage. Tabs that
// share `values` share storage, as they do under a userscript manager.
function loadUserscript({
  values = {},
  respond,
  cells = [post({ author: 'known_slop', status: '1' }), post({ author: 'realhuman', status: '2' })],
  pathname = '/home',
}) {
  const { window, document, MutationObserver } = parseHTML(page(cells));
  const requests = [];
  const menu = {};
  const intervals = [];
  let answer = () => null;
  const ctx = vm.createContext({
    window,
    document,
    MutationObserver,
    location: { pathname },
    console,
    prompt: (q, d) => answer(q, d),
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    GM_getValue: (k, d) => (k in values ? structuredClone(values[k]) : d),
    GM_setValue: (k, v) => {
      values[k] = structuredClone(v);
    },
    GM_registerMenuCommand: (name, fn) => {
      menu[name] = fn;
    },
    GM_addValueChangeListener: () => {},
    GM_xmlhttpRequest: (req) => {
      requests.push(req);
      respond(req);
    },
  });
  vm.runInContext(buildUserscript(), ctx, { filename: 'dist/x-slop-hide.user.js' });
  // `prompt(fn)` sets how the page's prompt() answers.
  return { window, document, values, requests, menu, intervals, prompt: (fn) => (answer = fn) };
}

const gmOk = (body) => (req) =>
  setTimeout(() => req.onload({ status: 200, responseHeaders: 'content-type: text/plain\r\n', responseText: body }), 0);

test('userscript: fetches via GM_xmlhttpRequest, caches, and hides listed authors', async () => {
  const us = loadUserscript({ respond: gmOk('known_slop\n') });
  await settle();
  assert.equal(us.requests.length, 1);
  assert.equal(us.requests[0].url, 'https://clankwall.vogel.dev/api/usernames.txt');
  assert.equal(us.requests[0].anonymous, true);
  assert.deepEqual(us.values['xsh:list'].handles, ['known_slop']);
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual([hidden('1'), hidden('2')], [true, false]);
  assert.deepEqual(Object.keys(us.menu), [
    'Pause / resume hiding',
    'Show / hide @grok',
    'Refresh list now',
    'Hide every account clankwall flagged / AI flags only',
    'Edit always-show list',
    'Edit extra accounts to hide',
    'Show or hide a bot',
    'Hide / show posts that tag a hidden bot',
  ]);
});

test("userscript: the @grok menu item flips @grok's row and the page follows", async () => {
  const us = loadUserscript({
    respond: gmOk('known_slop\ngrok\n'),
    cells: [post({ author: 'grok', status: '1' }), post({ author: 'known_slop', status: '2' })],
  });
  await settle();
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual([hidden('1'), hidden('2')], [true, true]);
  us.menu['Show / hide @grok']();
  assert.equal(us.values['xsh:settings'].bots.grok, 'show');
  assert.deepEqual([hidden('1'), hidden('2')], [false, true]);
  us.menu['Show / hide @grok']();
  assert.equal(us.values['xsh:settings'].bots.grok, 'hide');
  assert.deepEqual([hidden('1'), hidden('2')], [true, true]);
});

test("userscript: a 0.3.0 user's showGrok is read as Show, and the menu flips it to Hide without deleting it", async () => {
  const us = loadUserscript({
    values: { 'xsh:settings': { showGrok: true } },
    respond: gmOk('known_slop\ngrok\n'),
    cells: [post({ author: 'grok', status: '1' })],
  });
  await settle();
  const hidden = () => us.document.querySelector('[data-fixture="1"]').hasAttribute('data-xsh-hidden');
  assert.equal(hidden(), false);
  us.menu['Show / hide @grok']();
  assert.deepEqual(us.values['xsh:settings'], { showGrok: true, bots: { grok: 'hide' } });
  assert.equal(hidden(), true);
});

test('userscript: the bot, extra-accounts and tag menus save what the popup saves', async () => {
  const answers = [];
  const us = loadUserscript({
    respond: gmOk('known_slop\n'),
    cells: [
      post({ author: 'askperplexity', status: '1' }),
      post({ author: 'extra_a', status: '2' }),
      post({ author: 'rando', mention: 'askperplexity', status: '3' }),
      meLink('StartupBros'), // tag hiding waits for the logged-in account
    ],
  });
  await settle();
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual(['1', '2', '3'].map(hidden), [false, false, false]);
  us.prompt((q) => {
    answers.push(q);
    return 'AskPerplexity hide';
  });
  us.menu['Show or hide a bot']();
  assert.match(answers[0], /Now: @grok show, @AskPerplexity show, /);
  assert.deepEqual(us.values['xsh:settings'].bots, { askperplexity: 'hide' });
  us.prompt(() => 'askperplexity mute'); // the userscript cannot mute: ignored
  us.menu['Show or hide a bot']();
  us.prompt(() => 'someone hide'); // not a roster bot: ignored
  us.menu['Show or hide a bot']();
  assert.deepEqual(us.values['xsh:settings'].bots, { askperplexity: 'hide' });
  us.prompt(() => '@Extra_A, bad handle!!');
  us.menu['Edit extra accounts to hide']();
  assert.equal(us.values['xsh:settings'].extraList, 'bad\nextra_a');
  assert.deepEqual(['1', '2', '3'].map(hidden), [true, true, false]);
  us.menu['Hide / show posts that tag a hidden bot']();
  assert.equal(us.values['xsh:settings'].hideBotMentions, true);
  assert.deepEqual(['1', '2', '3'].map(hidden), [true, true, true]);
});

// Run the real popup.js against popup.html with an in-memory chrome.storage.
// `globals` adds to or replaces what the page sees (URL, Blob).
function loadPopup(store, globals = {}, tabs = null) {
  const { window, document } = parseHTML(src('src/popup.html'));
  const chrome = fakeChrome();
  Object.assign(chrome.store, structuredClone(store));
  chrome.tabs = tabs || { query: async () => [], sendMessage: async () => null };
  chrome.runtime.sendMessage = async () => ({ ok: true });
  const ctx = vm.createContext({ window, document, chrome, console, URL, ...globals });
  vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  vm.runInContext(src('src/popup.js'), ctx, { filename: 'src/popup.js' });
  return { window, document, chrome };
}

// The option a bot's row shows, read the way popup.js sets it.
const rowMode = (p, h) => [...p.document.getElementById(`bot-${h}`).querySelectorAll('option')].find((o) => o.selected)?.value;
function pick(p, h, mode) {
  const sel = p.document.getElementById(`bot-${h}`);
  const opts = [...sel.querySelectorAll('option')];
  for (const o of opts) o.selected = false; // clear first: see setChoice in popup.js
  opts.find((o) => o.value === mode).selected = true;
  sel.dispatchEvent(new p.window.Event('change'));
}

test('popup: one row per bot, showing what applies now, without writing anything', async () => {
  const settings = { allowlist: 'friend\nbot', showGrok: true };
  const p = loadPopup({
    'xsh:list': { handles: ['grok', 'askperplexity'], fetchedAt: Date.now(), source: 'https://clankwall.vogel.dev/api/usernames.txt' },
    'xsh:settings': settings,
  });
  await settle();
  const rows = [...p.document.querySelectorAll('#bots .bot')];
  assert.deepEqual(
    rows.map((r) => r.querySelector('a').getAttribute('href')),
    ['grok', 'AskPerplexity', 'pangram', 'bot', 'threadreaderapp', 'UnrollHelper'].map((n) => `https://x.com/${n}`),
  );
  assert.deepEqual(
    lib.BOTS.map((b) => rowMode(p, b.handle)),
    ['show', 'hide', 'show', 'show', 'show', 'show'],
    'showGrok reads as Show; a listed bot hides; the rest follow the list',
  );
  assert.equal(p.document.getElementById('bot-bot').disabled, true, 'Always-show locks the row to Show');
  assert.equal(p.document.getElementById('bot-bot-why').hidden, false, 'a locked row says why in text, not only in a tooltip');
  assert.equal(p.document.getElementById('bot-bot-why').textContent, 'Locked to Show: it is in Always show.');
  assert.equal(p.document.getElementById('bot-bot').getAttribute('aria-describedby'), 'bot-bot-why');
  assert.equal(p.document.getElementById('bot-grok-why').hidden, true);
  assert.equal(p.document.getElementById('bot-grok').hasAttribute('aria-describedby'), false);
  assert.equal(p.document.getElementById('bot-grok').disabled, false);
  assert.equal(p.document.getElementById('mentions').checked, false);
  assert.equal(p.document.getElementById('botsSum').textContent, 'Show 5 · Hide 1 · Mute 0', 'the folded section counts its rows');
  assert.equal(p.document.getElementById('listsSum').textContent, 'Always show 2 · Also hide 0');
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'rendering saves nothing');
});

test("popup: changing a bot's row saves only that bot, keeping other settings and bots", async () => {
  const p = loadPopup({
    'xsh:list': { handles: ['grok'], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { allowlist: 'friend', muteEnabled: true, muteAccount: 'startupbros', showGrok: true, bots: { bot: 'hide' } },
  });
  await settle();
  pick(p, 'askperplexity', 'mute');
  await settle();
  pick(p, 'grok', 'hide');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], {
    allowlist: 'friend',
    muteEnabled: true,
    muteAccount: 'startupbros',
    showGrok: true,
    bots: { bot: 'hide', askperplexity: 'mute', grok: 'hide' },
  });
  assert.equal(rowMode(p, 'grok'), 'hide', 'a saved row wins over showGrok');
  assert.equal(rowMode(p, 'askperplexity'), 'mute');
  assert.equal(p.document.getElementById('botsSum').textContent, 'Show 3 · Hide 2 · Mute 1');
});

test('popup: Save writes both boxes in one write; the tag box saves hideBotMentions', async () => {
  const p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': { paused: false } });
  await settle();
  const writes = [];
  const set = p.chrome.storage.local.set;
  p.chrome.storage.local.set = (o) => {
    writes.push(structuredClone(o));
    return set(o);
  };
  p.document.getElementById('allow').value = 'Friend, @pal';
  p.document.getElementById('extra').value = '@Extra_B extra_a not!valid';
  p.document.getElementById('save').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(p.chrome.store['xsh:settings'], { paused: false, allowlist: 'friend\npal', extraList: 'extra_a\nextra_b' });
  assert.equal(p.document.getElementById('extra').value, 'extra_a\nextra_b');
  assert.equal(p.document.getElementById('listsSum').textContent, 'Always show 2 · Also hide 2');
  const box = p.document.getElementById('mentions');
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.equal(p.chrome.store['xsh:settings'].hideBotMentions, true);
  assert.equal(box.checked, true);
});

test('popup: muting binds to the account logged in on this tab, and refuses without one', async () => {
  const p = loadPopup({ 'xsh:list': { handles: ['slop_a'], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': { allowlist: 'friend' } });
  await settle();
  const box = p.document.getElementById('mute');
  assert.equal(box.checked, false);
  assert.equal(p.document.getElementById('muteHint').hidden, false, 'off: the Always-show hint');
  // The hint is one click away, in How muting works, not in a fold inside it.
  const hintFold = p.document.getElementById('muteHint').closest('details');
  assert.equal(Boolean(hintFold && hintFold.matches('details.more')), true, 'the hint is in How muting works');
  assert.equal(Boolean(hintFold.parentElement.closest('details')), false, 'that fold is not inside another');
  assert.equal(p.document.getElementById('muteOn').hidden, true);
  // No x.com tab: stays off and says why.
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.equal(box.checked, false);
  assert.equal(p.document.getElementById('muteErr').hidden, false);
  assert.equal(p.chrome.store['xsh:settings'].muteEnabled, undefined);
  // An x.com tab logged in as @startupbros.
  p.chrome.tabs.query = async () => [{ id: 7 }];
  p.chrome.tabs.sendMessage = async () => ({ me: 'startupbros', paused: false, hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 0 });
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { allowlist: 'friend', muteEnabled: true, muteAccount: 'startupbros' });
  assert.equal(p.document.getElementById('muteHint').hidden, true);
  assert.equal(p.document.getElementById('muteOn').hidden, false);
  assert.equal(p.document.getElementById('muteWho').textContent, 'Muting as @startupbros');
  assert.equal(p.document.getElementById('muteToday').textContent, 'Today (UTC): 0 of 25 mutes, 0 of 50 visits');
  box.checked = false;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { allowlist: 'friend', muteEnabled: false, muteAccount: null });
  assert.equal(p.document.getElementById('muteHint').hidden, false);
  assert.equal(p.document.getElementById('muteOn').hidden, true);
});

test("popup: shows today's counts, the totals and why muting stopped", async () => {
  const p = loadPopup({
    'xsh:list': { handles: ['a'], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' },
    'xsh:mutes': {
      ...lib.emptyMutes(),
      handles: {
        a: { status: 'muted', confirmed: true },
        b: { status: 'muted', confirmed: false },
        c: { status: 'already' },
        d: { status: 'followed' },
        e: { status: 'no-post' },
      },
      days: { [lib.utcDay(Date.now())]: { mutes: 2, visits: 5, stopped: 'not on settings/muted/all after muting: @b' } },
    },
  });
  await settle();
  assert.equal(p.document.getElementById('mute').checked, true);
  assert.equal(p.document.getElementById('muteWho').textContent, 'Muting as @startupbros');
  assert.equal(p.document.getElementById('muteToday').textContent, 'Today (UTC): 2 of 25 mutes, 5 of 50 visits');
  assert.equal(p.document.getElementById('muteBar').getAttribute('value'), '2');
  assert.equal(p.document.getElementById('muteBar').getAttribute('max'), '25');
  assert.equal(
    p.document.getElementById('muteTotals').textContent,
    'So far: 2 muted (1 seen on your muted list, 1 not found there), 1 already muted, 1 you follow, 1 skipped.',
  );
  assert.equal(p.document.getElementById('muteStop').hidden, false);
  assert.equal(p.document.getElementById('muteStop').textContent, 'Stopped for today: not on settings/muted/all after muting: @b');
  assert.equal(p.document.getElementById('muteNext').hidden, false, 'a stopped day says when muting starts again');
  assert.match(p.document.getElementById('muteNext').textContent, /^Muting starts again on the next UTC day\. What each reason means$/);
  assert.equal(p.document.querySelector('#muteNext a').getAttribute('href'), 'https://github.com/StartupBros-com/ai-anti-slop#muting-stopped-for-today');
});

test('popup: the bar stops at the cap, and a stop line from today hides while muting is off', async () => {
  const day = lib.utcDay(Date.now());
  const over = loadPopup({
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' },
    'xsh:mutes': { ...lib.emptyMutes(), days: { [day]: { mutes: 26, visits: 30 } } },
  });
  await settle();
  assert.equal(over.document.getElementById('muteBar').getAttribute('value'), '25');
  assert.equal(over.document.getElementById('muteToday').textContent, 'Today (UTC): 26 mutes (over 25 a day), 30 of 50 visits');
  const off = loadPopup({
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: false },
    'xsh:mutes': { ...lib.emptyMutes(), days: { [day]: { mutes: 25, visits: 31, stopped: 'daily mute cap reached' } } },
  });
  await settle();
  assert.equal(off.document.getElementById('muteStop').hidden, true);
  assert.equal(off.document.getElementById('muteNext').hidden, true);
  assert.equal(off.document.getElementById('muteOn').hidden, true);
  assert.equal(off.document.getElementById('muteHint').hidden, false);
  // The totals sit in How muting works, outside muteOn: they hide on their own.
  assert.equal(off.document.getElementById('muteTotals').hidden, true);
  assert.equal(over.document.getElementById('muteTotals').hidden, false);
});

test('popup and manifest: every icon file they name exists', () => {
  const m = JSON.parse(src('manifest.json'));
  const paths = [...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  assert.ok(paths.length >= 4);
  for (const p of paths) assert.ok(existsSync(join(root, p)), p);
  const { document } = parseHTML(src('src/popup.html'));
  const img = document.querySelector('header img').getAttribute('src');
  assert.ok(existsSync(join(root, 'src', img)), img);
});

// The muting warning as the popup must show it whenever it shows the muting switch.
const WARNING =
  `X's rules forbid "scripting the X website" and say: "The use of these techniques may result in the permanent suspension of your account." Muting scripts x.com. A lower daily number lowers the risk; no number makes it allowed.`;
// Nothing between the element and the page hides it: no hidden ancestor, no closed fold.
const shownInDom = (el) => {
  for (let e = el; e; e = e.parentElement) if (e.hidden || (e.tagName === 'DETAILS' && !e.hasAttribute('open'))) return false;
  return true;
};

test('popup: the X rules warning is shown in full, outside every fold, beside the muting switch, on or off', async () => {
  const day = lib.utcDay(Date.now());
  const states = {
    off: { 'xsh:settings': {} },
    on: { 'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' } },
    stopped: {
      'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' },
      'xsh:mutes': { ...lib.emptyMutes(), days: { [day]: { mutes: 1, visits: 2, stopped: '@a: login (x.com shows a login button)' } } },
    },
  };
  for (const [name, seed] of Object.entries(states)) {
    const p = loadPopup({ 'xsh:list': { handles: ['a'], fetchedAt: Date.now(), source: 's' }, ...seed });
    await settle();
    const w = p.document.getElementById('muteWarn');
    assert.ok(w, `${name}: the warning is there`);
    assert.equal(w.textContent.replace(/\s+/g, ' ').trim(), WARNING, `${name}: every word of it`);
    // A boolean, not the element: a failed assert carrying a DOM node hangs the runner.
    assert.equal(Boolean(w.closest('details')), false, `${name}: not inside a fold`);
    assert.ok(shownInDom(w), `${name}: nothing hides it`);
    assert.ok(shownInDom(p.document.getElementById('mute')), `${name}: the switch shows`);
    assert.equal(p.document.getElementById('mute').getAttribute('aria-describedby'), 'muteWarn', `${name}: read out with the switch`);
  }
});

test('popup: every control has a name a screen reader reads, and the page has one h1', async () => {
  const p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': {} });
  await settle();
  const d = p.document;
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const wrap = el.closest('label');
    if (wrap) return wrap.textContent;
    const lab = el.id && d.querySelector(`label[for="${el.id}"]`);
    if (lab) return lab.textContent;
    return ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? '' : el.textContent;
  };
  const controls = [...d.querySelectorAll('a[href], button, input, select, textarea, summary')];
  assert.ok(controls.length >= 30, `found ${controls.length} controls`);
  for (const el of controls) assert.ok(nameOf(el).replace(/\s+/g, ' ').trim(), `${el.tagName.toLowerCase()}#${el.id} has no name`);
  assert.equal(d.querySelectorAll('h1').length, 1);
});

test('popup: each message it writes later sits in a live region', () => {
  const { document } = parseHTML(src('src/popup.html'));
  const region = (id) => document.getElementById(id).parentElement.closest('[role]')?.getAttribute('role');
  assert.deepEqual(
    ['err', 'muteErr', 'muteStop', 'muteNext', 'labelsMsg'].map(region),
    ['status', 'alert', 'status', 'status', 'status'],
  );
});

test('popup: the tab line leads with the count, says when hiding is paused, and points at x.com elsewhere', async () => {
  const list = { handles: ['a', 'b'], fetchedAt: Date.now(), source: 'https://clankwall.vogel.dev/api/usernames.txt' };
  const tab = (o) => ({
    query: async () => [{ id: 3 }],
    sendMessage: async () => ({ me: 'm', paused: false, hiddenPosts: 14, hiddenAuthors: [...'abcdefghi'], hiddenNow: 3, hiddenMentions: 2, ...o }),
  });
  const read = (p) => ({
    tab: p.document.getElementById('tab').textContent,
    more: p.document.getElementById('tabMore').hidden ? null : p.document.getElementById('tabMore').textContent,
  });
  let p = loadPopup({ 'xsh:list': list, 'xsh:settings': { lists: { recommended: false } } }, {}, tab({}));
  await settle();
  assert.deepEqual(read(p), { tab: '14 posts hidden on this tab', more: 'From 9 accounts. Plus 2 posts that tag a bot. 3 on screen now.' });
  assert.equal(p.document.querySelector('#tab .num').textContent, '14', 'the count is its own element, drawn large');
  assert.equal(p.document.getElementById('list').textContent, '2 accounts on the list');
  assert.equal(p.document.getElementById('listAge').textContent, 'From clankwall.vogel.dev, updated just now');
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { lists: { recommended: false } } }, {}, tab({ hiddenPosts: 1, hiddenAuthors: ['a'], hiddenNow: 1, hiddenMentions: 1 }));
  await settle();
  assert.deepEqual(read(p), { tab: '1 post hidden on this tab', more: 'From 1 account. Plus 1 post that tags a bot. 1 on screen now.' });
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { lists: { recommended: false } } }, {}, tab({ hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 0, hiddenMentions: 0 }));
  await settle();
  assert.deepEqual(read(p), { tab: '0 posts hidden on this tab', more: null });
  // Only tag hiding hid anything: its count leads, not a 0.
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { lists: { recommended: false } } }, {}, tab({ hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 2, hiddenMentions: 2 }));
  await settle();
  assert.deepEqual(read(p), { tab: '2 posts hidden on this tab', more: 'Each one tags a bot. 2 on screen now.' });
  assert.equal(p.document.querySelector('#tab .num').textContent, '2');
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { lists: { recommended: false } } }, {}, tab({ hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 1, hiddenMentions: 1 }));
  await settle();
  assert.deepEqual(read(p), { tab: '1 post hidden on this tab', more: 'It tags a bot. 1 on screen now.' });
  // An x.com tab reports pause; another tab still points at x.com, as in 0.6.1.
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { paused: true, lists: { recommended: false } } }, {}, tab({ paused: true }));
  await settle();
  assert.deepEqual(read(p), { tab: 'Hiding is paused', more: 'Turn off Pause hiding to hide posts again.' });
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { paused: true, lists: { recommended: false } } });
  await settle();
  assert.deepEqual(read(p), { tab: 'Open x.com in this tab to see what was hidden.', more: 'If it is already open, reload the tab.' });
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { lists: { recommended: false } } });
  await settle();
  // No answer from the tab: another site, or an x.com tab opened before install.
  assert.deepEqual(read(p), { tab: 'Open x.com in this tab to see what was hidden.', more: 'If it is already open, reload the tab.' });
  p = loadPopup({ 'xsh:list': { handles: [] }, 'xsh:settings': { lists: { recommended: false } } });
  await settle();
  assert.equal(p.document.getElementById('listAge').textContent, 'From clankwall.vogel.dev, not fetched yet');
});

test('popup: a failed refresh says the previous list is still in use only when there is one', async () => {
  const at = Date.now();
  let p = loadPopup({ 'xsh:list': { handles: ['a'], fetchedAt: at - 3600e3, lastAttemptAt: at, lastError: 'HTTP 503', source: 's' }, 'xsh:settings': { lists: { recommended: false } } });
  await settle();
  assert.equal(p.document.getElementById('err').hidden, false);
  assert.equal(p.document.getElementById('err').textContent, 'Last refresh failed (just now): HTTP 503. Still using the previous list.');
  // The first fetch failed: there is no previous list to fall back on.
  p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: 0, lastAttemptAt: at, lastError: 'HTTP 503', source: 's' }, 'xsh:settings': { lists: { recommended: false } } });
  await settle();
  assert.equal(p.document.getElementById('err').textContent, 'Last refresh failed (just now): HTTP 503.');
  assert.equal(p.document.getElementById('list').textContent, '0 accounts on the list');
});

test('popup: Refresh list now stays enabled (aria-disabled, not disabled) while it works, and two clicks send one refresh', async () => {
  const p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': {} });
  await settle();
  const sent = [];
  let release = null;
  p.chrome.runtime.sendMessage = (m) => {
    sent.push(m.type);
    return new Promise((r) => {
      release = () => r({ ok: true });
    });
  };
  const btn = p.document.getElementById('refresh');
  // An icon button: named by aria-label and title, its drawing kept through a refresh.
  const name = () => [btn.getAttribute('aria-label'), btn.getAttribute('title')];
  assert.deepEqual(name(), ['Refresh list now', 'Refresh list now']);
  assert.equal(btn.querySelectorAll('svg').length, 1);
  btn.dispatchEvent(new p.window.Event('click'));
  btn.dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, ['xsh:refresh']);
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.equal(btn.disabled, false, 'a disabled button would drop keyboard focus');
  assert.deepEqual(name(), ['Refreshing…', 'Refreshing…']);
  release();
  await settle();
  assert.equal(btn.hasAttribute('aria-disabled'), false);
  assert.deepEqual(name(), ['Refresh list now', 'Refresh list now']);
  assert.equal(btn.querySelectorAll('svg').length, 1, 'the icon is still drawn after a refresh');
  btn.dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, ['xsh:refresh', 'xsh:refresh'], 'it can refresh again once the first is done');
  release();
  await settle();
});

test('userscript: has no job channel, so it only hides', async () => {
  const built = buildUserscript();
  assert.match(built, /@description {2}Hides x\.com posts .* Hides only; muting is in the browser extension\./);
  assert.doesNotMatch(src('src/userscript-adapter.js'), /getJob|reportJob/);
});

test('userscript: an older refresh in another tab cannot overwrite a newer list', async () => {
  const values = {};
  const pendingA = [];
  const tabA = loadUserscript({ values, respond: (req) => pendingA.push(req) });
  await settle();
  assert.equal(tabA.requests.length, 1);
  // Tab B opens while A's request is still out, fetches and commits 369 handles.
  loadUserscript({ values, respond: gmOk(many(369).join('\n')) });
  await settle();
  assert.equal(values['xsh:list'].handles.length, 369);
  // A's older request then fails: the newer list stays, with no stale error.
  pendingA[0].onerror();
  await settle();
  assert.equal(values['xsh:list'].handles.length, 369);
  assert.equal(values['xsh:list'].lastError, null);
  // An older success is dropped as well.
  const pendingD = [];
  const shared = { 'xsh:list': { handles: ['a'], fetchedAt: 0, source: 's', seq: 3 } };
  loadUserscript({ values: shared, respond: (req) => pendingD.push(req) });
  await settle();
  shared['xsh:list'] = { handles: many(369), fetchedAt: Date.now(), source: 's', lastAttemptAt: Date.now(), lastError: null, seq: 4 };
  pendingD[0].onload({ status: 200, responseHeaders: 'content-type: text/plain\r\n', responseText: 'onlyone\n' });
  await settle();
  assert.equal(shared['xsh:list'].handles.length, 369);
});

test('userscript: an open tab re-checks on a timer and when it becomes visible', async () => {
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  const values = { 'xsh:list': { handles: ['known_slop'], fetchedAt: now, lastAttemptAt: now, source: 's', lastError: null, seq: 1 } };
  let body = 'known_slop\nnewbot\n';
  const us = loadUserscript({ values, respond: (req) => gmOk(body)(req) });
  await settle();
  assert.equal(us.requests.length, 0);
  assert.equal(us.intervals.length, 1);
  assert.equal(us.intervals[0].ms, 15 * 60 * 1000);
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 0);
  // Seven hours pass with the tab open.
  values['xsh:list'].fetchedAt -= 7 * hour;
  values['xsh:list'].lastAttemptAt -= 7 * hour;
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 1);
  assert.deepEqual(values['xsh:list'].handles, ['known_slop', 'newbot']);
  // Timers were suspended in the background; the tab comes back into view.
  values['xsh:list'].fetchedAt -= 7 * hour;
  values['xsh:list'].lastAttemptAt -= 7 * hour;
  body = 'known_slop\nnewbot\nthird\n';
  Object.defineProperty(us.document, 'visibilityState', { value: 'visible', configurable: true });
  us.document.dispatchEvent(new us.window.Event('visibilitychange'));
  await settle();
  assert.equal(us.requests.length, 2);
  assert.equal(values['xsh:list'].handles.length, 3);
});

test('userscript: a failed refresh is retried after the retry gap, not on every check', async () => {
  const values = {};
  let fail = true;
  const us = loadUserscript({
    values,
    respond: (req) => (fail ? setTimeout(() => req.onerror(), 0) : gmOk('known_slop\n')(req)),
  });
  await settle();
  assert.equal(us.requests.length, 1);
  assert.match(values['xsh:list'].lastError, /network error/);
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 1);
  values['xsh:list'].lastAttemptAt -= 30 * 60 * 1000;
  fail = false;
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 2);
  assert.deepEqual(values['xsh:list'].handles, ['known_slop']);
});

test('userscript: committed dist file matches the sources', () => {
  assert.equal(src('dist/x-slop-hide.user.js'), buildUserscript());
});

// ------------------------------------------------------------ daily number

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const muteAt = (muteCap, over = {}) => muteBackground({ settings: { muteEnabled: true, muteAccount: ME, muteCap }, ...over });
// A mute record whose day is past what 25 a day allows, so at 50 or 100 the
// next visit needs an x.com tab of the user's own.
const past25 = (over = {}) => ({ ...lib.emptyMutes(), ...over, days: { [today()]: { mutes: 25, unmutes: 0, visits: 25, stopped: null } } });

test('background: at 25 a day muting never looks for an x.com tab, and a stored number other than 25, 50 or 100 reads as 25', async () => {
  for (const muteCap of [25, undefined, 1000, '100', 0, -1]) {
    const bg = await muteAt(muteCap);
    await alarm(bg);
    assert.equal(bg.chrome.tabs.opened.length, 1, `${muteCap}: visits with no x.com tab open`);
    assert.equal(bg.chrome.tabs.queries, 0, `${muteCap}: never asks the tabs`);
  }
  // 25 mutes done today: a stored 1000 stops there, as 25 does.
  const bg = await muteAt(1000, { mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 25, visits: 25 } } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
});

test("background: at 50 or 100 a day, a mute visit waits for an x.com tab of the user's own, and only a true answer counts", async () => {
  for (const cap of [50, 100]) {
    const bg = await muteAt(cap, { mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 30, visits: 40 } } } });
    const t = bg.chrome.tabs;
    await alarm(bg);
    assert.deepEqual(t.opened, [], `${cap}: no tab of the user's own, no visit`);
    assert.equal(t.queries, 1);
    t.list = [{ id: 7 }, { id: 8 }];
    for (const reply of ['true', 1, { present: true }, null, false]) {
      t.answer = (id) => (id === 7 ? reply : Promise.reject(new Error('no content script')));
      await alarm(bg);
      assert.deepEqual(t.opened, [], `${cap}: a reply of ${JSON.stringify(reply)} is not a yes`);
    }
    t.answer = (id) => (id === 8 ? true : Promise.reject(new Error('no content script')));
    t.asked.length = 0;
    await alarm(bg);
    assert.equal(t.opened.length, 1, `${cap}: one tab says yes, so the visit goes ahead past 25 today`);
    assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
    assert.deepEqual([...t.asked].sort(), [7, 8], 'both tabs were asked');
    assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 41);
  }
  // At today's cap there is nothing to ask about.
  const full = await muteAt(50, { mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 50, visits: 60 } } } });
  full.chrome.tabs.list = [{ id: 7 }];
  full.chrome.tabs.answer = () => true;
  await alarm(full);
  assert.equal(full.chrome.tabs.queries, 0);
  assert.deepEqual(full.chrome.tabs.opened, []);
});

test("background: at 50 or 100 a day the day's first 25 mutes need no x.com tab, so a tab cut off by an update holds back only the rest", async () => {
  const day = (d) => ({ mutes: { ...lib.emptyMutes(), days: { [today()]: d } } });
  for (const cap of [50, 100]) {
    // Below 25 with no tab of the user's (none open, or one left open across
    // an update, which cannot answer): the visit starts and no tab is asked.
    let bg = await muteAt(cap, day({ mutes: 24, visits: 30 }));
    await alarm(bg);
    assert.equal(bg.chrome.tabs.opened.length, 1, `${cap}: visits below 25 with no x.com tab`);
    assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
    assert.equal(bg.chrome.tabs.queries, 0, `${cap}: never asks the tabs below 25`);
    assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 31);
    // Mutes and unmutes reach 25 together: from there the tab is needed.
    bg = await muteAt(cap, day({ mutes: 20, unmutes: 5, visits: 30 }));
    await alarm(bg);
    assert.deepEqual(bg.chrome.tabs.opened, [], `${cap}: 25 done today and no tab, so no visit`);
    assert.equal(bg.chrome.tabs.queries, 1);
    // So do 50 visits, with fewer mutes.
    bg = await muteAt(cap, day({ mutes: 10, visits: 50 }));
    await alarm(bg);
    assert.deepEqual(bg.chrome.tabs.opened, [], `${cap}: 50 visits today and no tab, so no visit`);
    assert.equal(bg.chrome.tabs.queries, 1);
  }
});

test('background: the x.com check never counts a job tab, even one that failed to close, skips discarded tabs, and waits 1.5 s for an answer', async () => {
  const bg = await muteAt(50, { mutes: past25() });
  const t = bg.chrome.tabs;
  // Every tab says yes, as a job tab whose page reloaded after its job would.
  t.list = [{ id: 7 }];
  t.answer = () => true;
  t.failRemove.add(100);
  await alarm(bg);
  assert.equal(lastTab(bg).id, 100);
  assert.deepEqual(bg.chrome.session['xsh:jobTabs'], [100]);
  const job = await send(bg, { type: 'xsh:job' }, 100);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'already' } }, 100);
  assert.deepEqual(t.removed, [], 'the close failed');
  assert.deepEqual(bg.chrome.session['xsh:jobTabs'], [100], 'so the tab stays on the job-tab list');
  // The user's tab is gone; a discarded one is left, and job tab 100 is still open.
  t.list = [{ id: 8, discarded: true }];
  t.asked.length = 0;
  due(bg);
  await alarm(bg);
  assert.equal(t.opened.length, 1, 'no visit');
  assert.deepEqual(t.asked, [], 'neither the job tab nor the discarded tab is asked');
  // A tab that answers after 2 s is past the wait: checked after its late yes.
  t.list = [{ id: 9 }];
  t.answer = (id) => (id === 9 ? sleep(2000).then(() => true) : true);
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
  await sleep(2300);
  await settle();
  assert.equal(t.opened.length, 1, 'no answer within 1.5 s counts as no, and a later yes is ignored');
  // One that answers after 0.8 s is in time.
  t.answer = (id) => (id === 9 ? sleep(800).then(() => true) : true);
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
  await sleep(1000);
  await settle();
  assert.equal(t.opened.length, 2);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_b');
  assert.deepEqual(t.asked, [9, 9], 'only tab 9 was ever asked');
  assert.deepEqual(bg.chrome.session['xsh:jobTabs'], [100, 101]);
});

test("background: the x.com check is asked outside the worker's queue, so a tab that just loaded can ask for its job first", async () => {
  // As content.js does: a tab answers xsh:present only after the worker has
  // answered its xsh:job question, which goes through the worker's queue.
  const bg = await muteAt(100, { mutes: past25() });
  const t = bg.chrome.tabs;
  t.list = [{ id: 7 }];
  t.answer = (id, msg) => (id === 7 && msg.type === 'xsh:present' ? send(bg, { type: 'xsh:job' }, 7).then((job) => !job) : Promise.reject(new Error('no content script')));
  const started = Date.now();
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
  while (!t.opened.length && Date.now() - started < 1400) await sleep(20);
  assert.equal(t.opened.length, 1, 'the visit starts without waiting out the 1.5 s');
  assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
  assert.equal(t.queries, 1);
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 26);
});

test('background: at 50 a day with no x.com tab open, a pending check of the muted list still runs', async () => {
  const bg = await muteAt(50, { mutes: past25({ handles: { slop_a: { status: 'muted', confirmed: null } }, sinceCheck: ['slop_a'] }) });
  await alarm(bg);
  assert.equal(bg.chrome.tabs.queries, 1);
  assert.equal(bg.chrome.tabs.opened.length, 1);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all');
});

// ------------------------------------------------------------ labels

const LABEL_MSG = { type: 'xsh:label', label: 'slop', handle: '@Reply_A', url: '/reply_a/status/2', page: '/op/status/1', text: 'hello' };
const labelKeys = (bg) => Object.keys(bg.chrome.store).filter((k) => k.startsWith('xsh:label:')).sort();
const reply = async (p) => ({ ...(await p) });

function labelBackground({ settings = { labeling: true }, handles = [], source = 's', store = {} } = {}) {
  const bg = loadBackground(() => ok(handles.join('\n')));
  bg.chrome.store['xsh:list'] = { handles, fetchedAt: Date.now(), source };
  bg.chrome.store['xsh:settings'] = settings;
  Object.assign(bg.chrome.store, store);
  return bg;
}

// A message from the popup. Chrome gives it the popup's own address and,
// unless the popup was opened in a tab, no sender.tab.
const POPUP_URL = `chrome-extension://${EXT_ID}/src/popup.html`;
function fromPopup(bg, msg, sender = { id: EXT_ID, url: POPUP_URL }) {
  return new Promise((resolve) => {
    const keep = bg.chrome.runtime.onMessage.fire(msg, sender, resolve);
    if (!keep.includes(true)) resolve(undefined);
  });
}

test('background: a label is refused while labelling is off, and nothing is written', async () => {
  for (const settings of [{ labeling: false }, { labeling: 'true' }, { labeling: null }]) {
    const bg = labelBackground({ settings });
    const before = structuredClone(bg.chrome.store);
    assert.deepEqual(await reply(send(bg, LABEL_MSG, 7)), { ok: false, reason: 'labels are off' });
    assert.deepEqual(bg.chrome.store, before);
  }
});

test('background: labels are on by default, so settings that never had the switch save one', async () => {
  const bg = labelBackground({ settings: {} });
  assert.deepEqual(await reply(send(bg, LABEL_MSG, 7)), { ok: true, label: 'slop', added: 'extraList' });
  assert.equal(bg.chrome.store['xsh:label:2'].label, 'slop');
});

test('background: Slop saves the record and adds the account to Also hide once; Not slop adds it to Always show; clearing changes neither box', async () => {
  const bg = labelBackground({ settings: { labeling: true, allowlist: 'friend' } });
  const before = Date.now();
  assert.deepEqual(await reply(send(bg, LABEL_MSG, 7)), { ok: true, label: 'slop', added: 'extraList' });
  const rec = bg.chrome.store['xsh:label:2'];
  assert.ok(rec.at >= before && rec.at <= Date.now());
  assert.deepEqual(
    { ...rec, at: 0 },
    {
      at: 0,
      label: 'slop',
      handle: 'reply_a',
      url: 'https://x.com/reply_a/status/2',
      text: 'hello',
      page: 'https://x.com/op/status/1',
      list: null,
      lists: [],
      extra: false,
      allow: false,
      hidden: false,
    },
  );
  assert.equal(bg.chrome.store['xsh:labelCount'], 1);
  assert.deepEqual(bg.chrome.store['xsh:settings'], { labeling: true, allowlist: 'friend', extraList: 'reply_a' });
  // The same label from another tab adds and counts nothing more.
  assert.deepEqual(await reply(send(bg, LABEL_MSG, 8)), { ok: true, label: 'slop', added: null });
  assert.equal(bg.chrome.store['xsh:labelCount'], 1);
  assert.equal(bg.chrome.store['xsh:settings'].extraList, 'reply_a');
  // Not slop: into Always show, and still in Also hide.
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, label: 'not_slop' }, 7)), { ok: true, label: 'not_slop', added: 'allowlist' });
  assert.deepEqual(bg.chrome.store['xsh:settings'], { labeling: true, allowlist: 'friend\nreply_a', extraList: 'reply_a' });
  const changed = bg.chrome.store['xsh:label:2'];
  assert.deepEqual([changed.label, changed.extra, changed.allow, changed.hidden], ['not_slop', true, false, true], 'what the boxes held before this label');
  assert.equal(bg.chrome.store['xsh:labelCount'], 1);
  // Clearing deletes the record and leaves both boxes.
  const settings = structuredClone(bg.chrome.store['xsh:settings']);
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, label: null }, 7)), { ok: true, label: null });
  assert.deepEqual(labelKeys(bg), []);
  assert.equal(bg.chrome.store['xsh:labelCount'], 0);
  assert.deepEqual(bg.chrome.store['xsh:settings'], settings);
  // Clearing a label that was never saved changes nothing.
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, label: null, url: '/reply_a/status/3' }, 7)), { ok: true, label: null });
  assert.equal(bg.chrome.store['xsh:labelCount'], 0);
});

test('background: a label records which list had the account and whether its replies hide on that page, and keeps 1,000 characters of text', async () => {
  const bg = labelBackground({ handles: ['slop_x'], source: 'https://clankwall.vogel.dev/api/usernames.txt' });
  await send(bg, { ...LABEL_MSG, handle: 'slop_x', url: '/slop_x/status/5', text: '🚀'.repeat(1200) }, 7);
  const r = bg.chrome.store['xsh:label:5'];
  assert.deepEqual([r.list, r.extra, r.allow, r.hidden], ['clankwall.vogel.dev', false, false, true]);
  assert.equal(Array.from(r.text).length, 1000);
  // On the account's own post page its replies show.
  await send(bg, { ...LABEL_MSG, handle: 'slop_x', url: '/slop_x/status/6', page: '/slop_x/status/4' }, 7);
  assert.equal(bg.chrome.store['xsh:label:6'].hidden, false);
  // A page that is not a post is recorded as none.
  await send(bg, { ...LABEL_MSG, url: '/reply_a/status/7', page: '/home' }, 7);
  assert.equal(bg.chrome.store['xsh:label:7'].page, null);
});

test("background: a label with a bad link, another account's handle or an unknown label is refused and writes nothing", async () => {
  const bg = labelBackground();
  const before = structuredClone(bg.chrome.store);
  const cases = [
    [{ url: '/reply_a' }, 'not a post URL'],
    [{ url: 'https://evil.example/reply_a/status/2' }, 'not a post URL'],
    [{ url: 42 }, 'not a post URL'],
    [{ handle: 'reply_b' }, "not the post's author"],
    [{ handle: 'not a handle!' }, 'not a handle'],
    [{ label: 'maybe' }, 'unknown label'],
    [{ label: undefined }, 'unknown label'],
  ];
  for (const [over, reason] of cases) {
    assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, ...over }, 7)), { ok: false, reason }, JSON.stringify(over));
  }
  assert.deepEqual(bg.chrome.store, before);
});

test('background: at 2,000 labels a new one is refused and a saved one can still change; a count that drifted is recounted', async () => {
  const store = { 'xsh:labelCount': 2000 };
  for (let i = 1; i <= 2000; i++) store[`xsh:label:${i}`] = { at: i, label: 'slop', handle: 'reply_a', url: `https://x.com/reply_a/status/${i}` };
  const bg = labelBackground({ store });
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, url: '/reply_a/status/2001' }, 7)), {
    ok: false,
    reason: '2000 labels saved: export and delete them to add more',
  });
  assert.equal(bg.chrome.store['xsh:label:2001'], undefined);
  assert.equal(bg.chrome.store['xsh:settings'].extraList, undefined, 'a refused label adds no one to a box');
  assert.equal((await send(bg, { ...LABEL_MSG, label: 'not_slop', url: '/reply_a/status/5' }, 7)).ok, true);
  assert.equal(bg.chrome.store['xsh:label:5'].label, 'not_slop');
  assert.equal(bg.chrome.store['xsh:labelCount'], 2000);
  // The count says 2,000 but only 3 are stored: the recount lets a new one in.
  for (let i = 4; i <= 2000; i++) delete bg.chrome.store[`xsh:label:${i}`];
  assert.equal((await send(bg, { ...LABEL_MSG, url: '/reply_a/status/2001' }, 7)).ok, true);
  assert.equal(bg.chrome.store['xsh:labelCount'], 4);
  assert.equal(labelKeys(bg).length, 4);
});

test('background: deleting every label works only from the popup and leaves Also hide and Always show as they are', async () => {
  const settings = { labeling: true, extraList: 'slop_x', allowlist: 'friend' };
  const store = { 'xsh:labelCount': 3, 'xsh:mutes': lib.emptyMutes() };
  for (const i of [1, 2, 3]) store[`xsh:label:${i}`] = { at: i, label: 'slop', handle: 'slop_x', url: `https://x.com/slop_x/status/${i}` };
  const bg = labelBackground({ settings, store });
  assert.equal(await send(bg, { type: 'xsh:labels-clear' }, 7), undefined, 'a tab gets no answer');
  const refused = [
    { id: EXT_ID, tab: { id: 7 }, url: 'https://x.com/e2e_op/status/100' },
    { id: EXT_ID, url: 'https://x.com/home' },
    { id: EXT_ID, url: 'chrome-extension://another_extension/src/popup.html' },
    { id: EXT_ID, url: `chrome-extension://${EXT_ID}.evil.example/` },
    { id: EXT_ID },
  ];
  for (const sender of refused) {
    assert.equal(await fromPopup(bg, { type: 'xsh:labels-clear' }, sender), undefined, `refused: ${JSON.stringify(sender)}`);
  }
  assert.equal(labelKeys(bg).length, 3);
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:labels-clear' })), { ok: true, removed: 3 });
  assert.deepEqual(labelKeys(bg), []);
  assert.equal('xsh:labelCount' in bg.chrome.store, false);
  assert.deepEqual(bg.chrome.store['xsh:settings'], settings);
  assert.ok(bg.chrome.store['xsh:mutes'] && bg.chrome.store['xsh:list'], 'nothing else is deleted');
});

test('background: the popup opened in a tab of its own can still delete every label', async () => {
  const store = { 'xsh:labelCount': 2 };
  for (const i of [1, 2]) store[`xsh:label:${i}`] = { at: i, label: 'slop', handle: 'slop_x', url: `https://x.com/slop_x/status/${i}` };
  const bg = labelBackground({ store });
  const sender = { id: EXT_ID, tab: { id: 9 }, url: POPUP_URL };
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:labels-clear' }, sender)), { ok: true, removed: 2 });
  assert.deepEqual(labelKeys(bg), []);
});

// ------------------------------------------------------------ popup: number and labels

const choice = (p, id) => [...p.document.getElementById(id).querySelectorAll('option')].find((o) => o.selected)?.value;
function choose(p, id, value) {
  const sel = p.document.getElementById(id);
  const opts = [...sel.querySelectorAll('option')];
  for (const o of opts) o.selected = false;
  opts.find((o) => o.value === value).selected = true;
  sel.dispatchEvent(new p.window.Event('change'));
}

test('popup: the daily number offers 25, 50 and 100, saves the one picked, and says why none goes higher', async () => {
  const day = lib.utcDay(Date.now());
  const p = loadPopup({
    'xsh:list': { handles: many(250), fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros', muteCap: 100 },
    'xsh:mutes': { ...lib.emptyMutes(), handles: { h0: { status: 'muted', confirmed: true } }, days: { [day]: { mutes: 2, visits: 5 } } },
  });
  await settle();
  const $ = (id) => p.document.getElementById(id);
  assert.deepEqual([...p.document.querySelectorAll('#muteCap option')].map((o) => o.value), ['25', '50', '100']);
  assert.equal(choice(p, 'muteCap'), '100');
  assert.equal($('muteToday').textContent, 'Today (UTC): 2 of 100 mutes, 5 of 200 visits');
  assert.equal($('muteBar').getAttribute('max'), '100');
  assert.equal(
    $('capWhy').textContent,
    'No setting goes above 100: hiding already covers this browser, and muting only adds the X apps. At 100 a day, muting the 249 accounts left takes 3 days; Run now visits them all at once.',
  );
  // Why none goes higher is one click away, in How muting works, a fold of
  // its own in the muting section. A boolean, not the element: a failed
  // assert carrying a DOM node hangs the runner.
  const fold = $('capWhy').closest('details');
  assert.equal(Boolean(fold && fold.matches('details.more')), true, 'the cap note is in How muting works');
  assert.equal(fold.querySelector(':scope > summary').textContent, 'How muting works');
  assert.equal(Boolean(fold.parentElement.closest('details')), false, 'that fold is not inside another');
  assert.equal(Boolean(fold.closest('section.muting')), true);
  // What a number above 25 changes is said beside the choice, in view, and
  // the select is described by it.
  assert.equal($('capNote').hidden, false);
  assert.equal($('capNote').textContent, 'Mutes past 25 need an x.com tab open.');
  assert.equal(Boolean($('capNote').closest('details')), false, 'the x.com note is not folded');
  assert.equal(Boolean($('capNote').closest('.caprow .caplabel')), true, 'the note is under Mutes a day, beside the select');
  assert.equal($('muteCap').getAttribute('aria-describedby'), 'capNote');
  choose(p, 'muteCap', '50');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { muteEnabled: true, muteAccount: 'startupbros', muteCap: 50 });
  assert.equal(choice(p, 'muteCap'), '50');
  assert.equal($('muteToday').textContent, 'Today (UTC): 2 of 50 mutes, 5 of 100 visits');
  assert.equal($('capNote').hidden, false);
  assert.equal($('capNote').textContent, 'Mutes past 25 need an x.com tab open.');
  choose(p, 'muteCap', '25');
  await settle();
  assert.equal($('capNote').hidden, true, '25 runs whenever the browser is open: no note');
  assert.equal($('capNote').textContent, '');
  // A stored number that is not offered reads as 25; with nothing left to mute, one sentence.
  const odd = loadPopup({
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros', muteCap: 1000 },
  });
  await settle();
  assert.equal(choice(odd, 'muteCap'), '25');
  assert.equal(odd.document.getElementById('muteToday').textContent, 'Today (UTC): 0 of 25 mutes, 0 of 50 visits');
  assert.equal(odd.document.getElementById('capWhy').textContent, 'No setting goes above 100: hiding already covers this browser, and muting only adds the X apps.');
  assert.equal(odd.chrome.store['xsh:settings'].muteCap, 1000, 'rendering does not rewrite it');
});

test('popup: the labels switch shows on when it was never set', async () => {
  const p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': {}, 'xsh:mutes': lib.emptyMutes() });
  await settle();
  assert.equal(p.document.getElementById('labeling').checked, true);
  assert.equal(p.document.getElementById('labelsSum').textContent, 'On · 0 saved');
});

test('popup: labels switch on and off, export as JSON lines oldest first, and delete only on a second click', async () => {
  const recs = [3, 1, 2].map((at) => ({
    at,
    label: at === 2 ? 'not_slop' : 'slop',
    handle: `h${at}`,
    url: `https://x.com/h${at}/status/${at}`,
    text: `reply ${at} 🚀`,
  }));
  const store = {
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { extraList: 'h1', labeling: false },
    'xsh:labelCount': 3,
    'xsh:mutes': lib.emptyMutes(),
  };
  for (const r of recs) store[`xsh:label:${r.at}`] = r;
  const made = [];
  const revoked = [];
  class TestURL extends URL {
    static createObjectURL(blob) {
      made.push(blob);
      return `blob:test/${made.length}`;
    }
    static revokeObjectURL(u) {
      revoked.push(u);
    }
  }
  const p = loadPopup(store, { URL: TestURL, Blob });
  const $ = (id) => p.document.getElementById(id);
  const downloads = [];
  p.document.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && e.target.hasAttribute('download')) downloads.push({ href: e.target.getAttribute('href'), name: e.target.getAttribute('download') });
  });
  const sent = [];
  p.chrome.runtime.sendMessage = async (m) => {
    sent.push(structuredClone(m));
    // What the worker does: delete the labels and the count.
    for (const k of Object.keys(p.chrome.store)) if (k.startsWith('xsh:label:') || k === 'xsh:labelCount') delete p.chrome.store[k];
    return { ok: true, removed: 3 };
  };
  await settle();
  assert.equal($('labelsSum').textContent, 'Off · 3 saved');
  assert.equal($('labeling').checked, false);
  assert.equal($('export').textContent, 'Export labels (3)');
  assert.equal($('export').disabled, false);
  assert.equal($('deleteLabels').textContent, 'Delete all labels');
  assert.equal($('labelsMsg').hidden, true);
  $('labeling').checked = true;
  $('labeling').dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { extraList: 'h1', labeling: true });
  assert.equal($('labelsSum').textContent, 'On · 3 saved');
  // Export.
  $('export').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(made.length, 1);
  assert.equal(made[0].type, 'application/x-ndjson');
  const oldestFirst = [...recs].sort((a, b) => a.at - b.at);
  assert.equal(await made[0].text(), `${oldestFirst.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.deepEqual(downloads, [{ href: 'blob:test/1', name: `ai-anti-slop-labels-${lib.utcDay(Date.now())}.jsonl` }]);
  assert.equal(p.document.querySelectorAll('a[download]').length, 0, 'the link is removed after the click');
  assert.equal($('labelsMsg').hidden, false);
  assert.equal($('labelsMsg').textContent, 'Exported 3 labels.');
  $('export').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(revoked, ['blob:test/1'], "a second export frees the first file's URL");
  // Delete: the first click only arms the button.
  $('deleteLabels').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, []);
  assert.equal($('deleteLabels').textContent, 'Click again to delete 3 labels');
  assert.equal($('deleteLabels').className, 'armed');
  $('deleteLabels').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, [{ type: 'xsh:labels-clear' }]);
  assert.equal($('labelsMsg').textContent, 'Deleted 3 labels.');
  assert.equal($('labelsSum').textContent, 'On · 0 saved');
  assert.equal($('export').disabled, true);
  assert.equal($('deleteLabels').disabled, true);
  assert.equal($('deleteLabels').textContent, 'Delete all labels');
  assert.equal($('deleteLabels').className, '');
  assert.deepEqual(p.chrome.store['xsh:settings'], { extraList: 'h1', labeling: true }, 'the boxes stay');
  // A count with no labels behind it exports nothing; a refused delete says why.
  const q = loadPopup({ 'xsh:list': store['xsh:list'], 'xsh:settings': { labeling: true }, 'xsh:labelCount': 1 }, { URL: TestURL, Blob });
  q.chrome.runtime.sendMessage = async () => ({ ok: false, reason: 'busy' });
  await settle();
  q.document.getElementById('export').dispatchEvent(new q.window.Event('click'));
  await settle();
  assert.equal(q.document.getElementById('labelsMsg').textContent, 'No labels saved yet.');
  assert.equal(made.length, 2, 'no new file');
  q.document.getElementById('deleteLabels').dispatchEvent(new q.window.Event('click'));
  await settle();
  assert.equal(q.document.getElementById('deleteLabels').textContent, 'Click again to delete 1 label');
  q.document.getElementById('deleteLabels').dispatchEvent(new q.window.Event('click'));
  await settle();
  assert.equal(q.document.getElementById('labelsMsg').textContent, 'Not deleted: busy');
  assert.equal(q.document.getElementById('deleteLabels').textContent, 'Delete all labels');
});

test('userscript: never shows label buttons, even with labelling saved as on', async () => {
  const now = Date.now();
  const values = {
    'xsh:list': { handles: ['known_slop'], fetchedAt: now, lastAttemptAt: now, source: 's', lastError: null, seq: 1 },
    'xsh:settings': { labeling: true },
  };
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2' }), post({ author: 'known_slop', status: '3' })];
  const us = loadUserscript({ values, respond: gmOk('known_slop\n'), cells, pathname: '/op/status/1' });
  await settle();
  assert.ok(us.document.querySelector('[data-fixture="3"]').hasAttribute('data-xsh-hidden'), 'the userscript is running');
  assert.equal(us.document.querySelectorAll('[data-xsh-bar]').length, 0);
  assert.equal(us.document.getElementById('xsh-bar-style') === null, true, 'compared as a boolean: printing a node hangs the run');
  assert.doesNotMatch(src('src/userscript-adapter.js'), /saveLabel|getLabels|subscribeLabels|answerPresent/);
});

// ------------------------------------------------------------------ export and import page

// Run the real settings.js against settings.html. Downloads are recorded
// from the <a download> click, and a picked file is set on the input.
// `timers` (fakeTimers) holds the Undo timer; `focused` lists the id of each
// element focused, in order. linkedom keeps no activeElement, so the page
// gets one as a browser keeps it: the element focused last, or the body once
// that element has left the page. A click on a control focuses it first, as
// in Chrome.
function loadSettings(store, globals = {}) {
  const { window, document } = parseHTML(src('src/settings.html'));
  const chrome = fakeChrome();
  Object.assign(chrome.store, structuredClone(store));
  const timers = fakeTimers();
  const focused = [];
  let active = null;
  window.HTMLElement.prototype.focus = function () {
    focused.push(this.id);
    active = this;
  };
  window.HTMLElement.prototype.blur = function () {
    if (active === this) active = null;
  };
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => (active && active.isConnected ? active : document.body) });
  const made = [];
  class TestURL extends URL {
    static createObjectURL(blob) {
      made.push(blob);
      return `blob:test/${made.length}`;
    }
    static revokeObjectURL() {}
  }
  const downloads = [];
  document.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && e.target.hasAttribute('download')) downloads.push(e.target.getAttribute('download'));
  });
  const ctx = vm.createContext({ window, document, chrome, console, URL: TestURL, Blob, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...globals });
  vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  vm.runInContext(src('src/settings.js'), ctx, { filename: 'src/settings.js' });
  const $ = (id) => document.getElementById(id);
  const click = (id) => {
    if ($(id).matches('button, input, summary, a[href], [tabindex]')) $(id).focus();
    $(id).dispatchEvent(new window.Event('click'));
  };
  const submit = (id) => $(id).dispatchEvent(new window.Event('submit'));
  // A `text` of null fails the test if the page reads the file at all.
  const pickFile = (name, text, size) => {
    const f = {
      name,
      size: size === undefined ? Buffer.byteLength(text) : size,
      text: async () => (text === null ? assert.fail('file was read') : text),
    };
    Object.defineProperty($('file'), 'files', { configurable: true, value: [f] });
    $('file').dispatchEvent(new window.Event('change'));
  };
  const changes = () => [...document.querySelectorAll('#changes li')].map((li) => li.textContent);
  return { chrome, document, $, click, submit, pickFile, changes, made, downloads, timers, focused };
}

// What the Settings file row says it holds, for a page with these counts.
const holds = (show, hide, bots) =>
  `Always show ${show}, Also hide ${hide}, ${bots} bot choice${bots === 1 ? '' : 's'} and the tag setting. ` +
  'It leaves out muting, pause, list choices and labels.';
// The next step every refused import names.
const PICK = ' Pick a settings file or a text file with one handle per line.';

const LIST = { handles: ['listed', 'grok'], fetchedAt: 1, source: 's' };
const settingsFile = (o) => JSON.stringify({ format: 'x-slop-hide-settings', version: 1, ...o });

test('settings page: export saves only the account boxes, bot choices and tag setting', async () => {
  const settings = {
    allowlist: 'pal',
    extraList: 'spam_b\nspam_a',
    bots: { grok: 'mute' },
    hideBotMentions: true,
    muteEnabled: true,
    muteAccount: 'me_here',
    muteCap: 100,
    feedUrl: 'https://example.com/list.txt',
    paused: true,
    labeling: true,
  };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': settings });
  await settle();
  assert.equal(p.$('have').textContent, holds(1, 2, 1));
  p.click('exportSettings');
  await settle();
  assert.deepEqual(p.downloads, [`ai-anti-slop-settings-${lib.utcDay(Date.now())}.json`]);
  assert.equal(p.made[0].type, 'application/json');
  const out = JSON.parse(await p.made[0].text());
  assert.deepEqual(Object.keys(out).sort(), ['alsoHide', 'alwaysShow', 'bots', 'exported', 'format', 'hideBotMentions', 'version']);
  assert.deepEqual([out.alwaysShow, out.alsoHide, out.bots, out.hideBotMentions], [['pal'], ['spam_a', 'spam_b'], { grok: 'mute' }, true]);
  assert.equal(p.$('msg').textContent, `Exported ai-anti-slop-settings-${lib.utcDay(Date.now())}.json: Always show 1, Also hide 2, 1 bot choice.`);
  p.click('exportList');
  await settle();
  assert.equal(p.downloads[1], `ai-anti-slop-also-hide-${lib.utcDay(Date.now())}.txt`);
  assert.equal(await p.made[1].text(), 'spam_a\nspam_b\n');
  assert.equal(p.$('msg').textContent, `Exported ai-anti-slop-also-hide-${lib.utcDay(Date.now())}.txt, a list of 2 accounts.`);
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'export writes nothing');
});

// The button stays enabled, so a click can say why there is nothing to save.
test('settings page: Export list with Also hide empty saves no file and says why', async () => {
  const settings = { allowlist: 'pal' };
  const p = loadSettings({ 'xsh:settings': settings });
  await settle();
  assert.equal(p.$('have').textContent, holds(1, 0, 0));
  p.click('exportList');
  await settle();
  assert.deepEqual(p.downloads, []);
  assert.equal(p.made.length, 0);
  assert.equal(p.$('msg').textContent, 'Also hide is empty, so there is no list to export. Add accounts to it in the popup first.');
  assert.equal(p.$('msg').classList.contains('bad'), false);
  assert.deepEqual(p.chrome.store['xsh:settings'], settings);
});

test('settings page: importing a list previews, writes nothing until Confirm, then adds to Also hide', async () => {
  const settings = { allowlist: 'pal', extraList: 'spam_a', paused: false };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': settings });
  await settle();
  p.pickFile('shared.txt', '# from a friend\n@spam_a\nspam_b\nPal\n');
  await settle();
  assert.equal(p.$('preview').hidden, false);
  assert.equal(p.$('fileKind').textContent, 'shared.txt: a list of 3 handles, for Also hide');
  assert.deepEqual(p.changes(), ['Also hide gains 2 accounts: @pal, @spam_b.', '@pal will stay shown, because Always show has it.']);
  assert.equal(p.$('muteNote').textContent, 'Muting is off. If you turn it on, it can also mute 1 account from this file: @spam_b.');
  assert.equal(p.$('muteNote').className, 'callout note');
  assert.deepEqual(p.focused, ['preview'], 'the preview takes focus when it opens');
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'the preview writes nothing');
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { allowlist: 'pal', extraList: 'spam_a\npal\nspam_b', paused: false });
  assert.equal(p.$('preview').hidden, true);
  assert.equal(p.$('msg').textContent, 'Imported: Also hide gained 2.');
  assert.equal(p.$('have').textContent, holds(1, 3, 0));
  assert.equal(p.focused.at(-1), 'file', 'focus goes back to the file input');
});

// Planted negative (issue #27), through the page.
test('settings page: a file naming muting, its cap, its account or the list URL changes none of them', async () => {
  const settings = { muteEnabled: false, muteCap: 25, muteAccount: null, feedUrl: '', paused: false, labeling: false };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': settings });
  await settle();
  p.pickFile(
    'evil.json',
    settingsFile({
      alsoHide: ['spam'],
      muteEnabled: true,
      muteCap: 100,
      muteAccount: 'someone',
      feedUrl: 'https://evil.example/list.txt',
      paused: true,
      labeling: true,
    }),
  );
  await settle();
  assert.deepEqual(p.changes(), ['Also hide gains 1 account: @spam.']);
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { ...settings, extraList: 'spam' });
});

test('settings page: Cancel writes nothing', async () => {
  const settings = { extraList: 'spam_a' };
  const p = loadSettings({ 'xsh:settings': settings });
  await settle();
  p.pickFile('s.json', settingsFile({ alwaysShow: ['pal'], bots: { grok: 'show' }, hideBotMentions: true }));
  await settle();
  assert.deepEqual(p.changes(), [
    'Always show gains 1 account: @pal.',
    '@grok: follows the list → Show.',
    'Turns on hiding posts that tag a bot set to Hide here or Mute on X.',
  ]);
  p.click('cancel');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], settings);
  assert.equal(p.$('preview').hidden, true);
  assert.equal(p.$('msg').textContent, 'Nothing imported.');
  assert.equal(p.focused.at(-1), 'file', 'focus goes back to the file input');
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'Confirm after Cancel does nothing');
});

test('settings page: a bad file is refused whole, and an oversize one is not read', async () => {
  const settings = { extraList: 'spam_a' };
  const p = loadSettings({ 'xsh:settings': settings });
  await settle();
  p.pickFile('list.txt', 'spam_b\nnot a handle\n');
  await settle();
  assert.equal(p.$('msg').textContent, `Not imported: line 2 is not an X handle.${PICK}`);
  assert.ok(p.$('msg').classList.contains('bad'));
  assert.equal(p.$('preview').hidden, true);
  p.pickFile('big.txt', null, lib.DEFAULTS.maxBytes + 1);
  await settle();
  assert.equal(p.$('msg').textContent, `Not imported: the file is larger than 1 MB.${PICK}`);
  p.pickFile('s.json', settingsFile({ bots: { grok: 'block' } }));
  await settle();
  assert.equal(p.$('msg').textContent, `Not imported: "bots" has a choice other than show, hide or mute.${PICK}`);
  assert.deepEqual(p.chrome.store['xsh:settings'], settings);
});

test('settings page: settings that change after the preview are shown again, not written', async () => {
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { extraList: '' } });
  await settle();
  p.pickFile('shared.txt', 'spam_a\nspam_b\n');
  await settle();
  assert.equal(p.$('stale').hidden, true);
  assert.deepEqual(p.changes(), ['Also hide gains 2 accounts: @spam_a, @spam_b.']);
  // Meanwhile, in the popup: muting turned on, and spam_a saved to Also hide.
  const changed = { extraList: 'spam_a', muteEnabled: true, muteAccount: 'me_here', muteCap: 50 };
  p.chrome.store['xsh:settings'] = structuredClone(changed);
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], changed, 'nothing written');
  assert.equal(p.$('stale').hidden, false);
  assert.equal(p.document.activeElement.id, 'stale', 'the warning takes focus, so it is read out before Confirm');
  assert.deepEqual(p.changes(), ['Also hide gains 1 account: @spam_b.']);
  assert.equal(p.$('muteNote').className, 'callout warn');
  assert.equal(
    p.$('muteNote').textContent,
    'Muting is on as @me_here. After this import it can also mute 1 more account: @spam_b. It mutes up to 50 a day and skips accounts you follow.',
  );
  p.click('confirm');
  await settle();
  assert.equal(p.chrome.store['xsh:settings'].extraList, 'spam_a\nspam_b');
  assert.equal(p.$('msg').textContent, 'Imported: Also hide gained 1.');
});

test('settings page: a bot set to Mute on X is named in the muting note', async () => {
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { muteEnabled: true, muteAccount: 'me_here' } });
  await settle();
  p.pickFile('s.json', settingsFile({ bots: { askperplexity: 'mute' } }));
  await settle();
  assert.deepEqual(p.changes(), ['@AskPerplexity: follows the list → Mute on X.']);
  assert.equal(
    p.$('muteNote').textContent,
    'Muting is on as @me_here. After this import it can also mute 1 more account: @askperplexity. Bots among them: @AskPerplexity. ' +
      'It mutes up to 25 a day and skips accounts you follow.',
  );
});

// A shared list can hold hundreds of handles. Each preview line names the
// first 12, and every one of them is under Show all, muting note included.
test('settings page: a line with more than 12 accounts lists all of them under Show all', async () => {
  const hs = Array.from({ length: 14 }, (_, i) => `spam_${String(i).padStart(2, '0')}`);
  const at = (xs) => xs.map((h) => `@${h}`).join(', ');
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { muteEnabled: true, muteAccount: 'me_here' } });
  await settle();
  p.pickFile('shared.txt', `${hs.join('\n')}\n`);
  await settle();
  const li = p.document.querySelectorAll('#changes li');
  assert.equal(li.length, 1);
  assert.equal(li[0].firstChild.textContent, `Also hide gains 14 accounts: ${at(hs.slice(0, 12))} and 2 more.`);
  assert.equal(li[0].querySelector('details summary').textContent, 'Show all 14 accounts');
  assert.equal(li[0].querySelector('details p').textContent, at(hs));
  const mute = p.$('muteNote');
  assert.equal(
    mute.firstChild.textContent,
    `Muting is on as @me_here. After this import it can also mute 14 more accounts: ${at(hs.slice(0, 12))} and 2 more. ` +
      'It mutes up to 25 a day and skips accounts you follow.',
  );
  assert.equal(mute.querySelector('details summary').textContent, 'Show all 14 accounts');
  assert.equal(mute.querySelector('details p').textContent, at(hs));

  const twelve = loadSettings({ 'xsh:settings': { muteEnabled: true, muteAccount: 'me_here' } });
  await settle();
  twelve.pickFile('shared.txt', `${hs.slice(0, 12).join('\n')}\n`);
  await settle();
  assert.deepEqual(twelve.changes(), [`Also hide gains 12 accounts: ${at(hs.slice(0, 12))}.`]);
  assert.equal(twelve.document.querySelectorAll('#preview details').length, 0, 'no Show all at 12');
});

test('settings page: a second click on Confirm writes once', async () => {
  const p = loadSettings({ 'xsh:settings': { extraList: 'spam_a' } });
  let writes = 0;
  const set = p.chrome.storage.local.set;
  p.chrome.storage.local.set = async (o) => {
    writes += 1;
    return set(o);
  };
  await settle();
  p.pickFile('shared.txt', 'spam_b\n');
  await settle();
  p.click('confirm');
  p.click('confirm');
  await settle();
  assert.equal(writes, 1);
  assert.equal(p.chrome.store['xsh:settings'].extraList, 'spam_a\nspam_b');
  assert.equal(p.$('msg').textContent, 'Imported: Also hide gained 1.');
});

test('settings page: Cancel while Confirm reads settings stops the write', async () => {
  const settings = { extraList: 'spam_a' };
  const p = loadSettings({ 'xsh:settings': settings });
  await settle();
  p.pickFile('shared.txt', 'spam_b\n');
  await settle();
  p.click('confirm');
  p.click('cancel');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], settings);
  assert.equal(p.$('msg').textContent, 'Nothing imported.');
});

test('settings page: a bot set to Show stays shown for that reason, not because of Always show', async () => {
  const bots = { grok: 'show', pangram: 'show', askperplexity: 'show' };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { allowlist: 'pal', bots } });
  await settle();
  p.pickFile('shared.txt', 'grok\npangram\npal\nspam_b\n');
  await settle();
  assert.deepEqual(p.changes(), [
    'Also hide gains 4 accounts: @grok, @pal, @pangram, @spam_b.',
    '@pal will stay shown, because Always show has it.',
    '@grok, @pangram will stay shown, because they are set to Show.',
  ]);
  p.pickFile('one.txt', 'AskPerplexity\n');
  await settle();
  assert.deepEqual(p.changes(), ['Also hide gains 1 account: @askperplexity.', '@AskPerplexity will stay shown, because it is set to Show.']);
});

test('settings page: a file with nothing new says so and offers no Confirm', async () => {
  const p = loadSettings({ 'xsh:settings': { extraList: 'spam_a' } });
  await settle();
  p.pickFile('shared.txt', 'spam_a\n');
  await settle();
  assert.equal(p.$('preview').hidden, true);
  assert.equal(p.$('msg').textContent, 'Nothing to import: your settings already have everything in this file.');
});

test('popup: Export or import opens the options page', async () => {
  const p = loadPopup({ 'xsh:settings': {} });
  let opened = 0;
  p.chrome.runtime.openOptionsPage = async () => {
    opened += 1;
  };
  await settle();
  p.document.getElementById('files').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(opened, 1);
});

// ------------------------------------------------------------ unmuting

const mutedAs = (account, at = Date.now() - 86400000) => ({ status: 'muted', at, account, toast: null, confirmed: true });

test('background: an account it muted that left the list is unmuted before any new mute, against the same cap', async () => {
  const bg = await muteBackground({ handles: ['slop_b'], mutes: { ...lib.emptyMutes(), handles: { gone: mutedAs(ME) } } });
  await alarm(bg);
  const tab = lastTab(bg);
  assert.equal(tab.url, 'https://x.com/gone');
  assert.equal(tab.active, false);
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.deepEqual([job.kind, job.handle, job.account], ['unmute', 'gone', ME]);
  assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), true);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'unmuted', toast: '@gone has been unmuted.' } }, tab.id);
  const m = bg.chrome.store['xsh:mutes'];
  assert.equal(m.handles.gone.status, 'unmuted');
  assert.deepEqual([m.days[today()].unmutes, m.days[today()].mutes, m.days[today()].visits], [1, 0, 1]);
  assert.deepEqual(m.sinceCheck, [], 'an unmute waits for no check of the muted list');
  assert.deepEqual(bg.chrome.tabs.removed, [tab.id]);
  due(bg);
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_b', 'then the mutes');
});

test('background: unmutes stop at the daily cap, shared with mutes', async () => {
  const day = { mutes: 20, unmutes: 5, visits: 25, stopped: null };
  const bg = await muteBackground({ handles: ['slop_b'], mutes: { ...lib.emptyMutes(), handles: { gone: mutedAs(ME) }, days: { [today()]: day } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
});

test('background: moving a muted account to Always show unmutes it', async () => {
  const bg = await muteBackground({
    handles: ['friend', 'slop_b'],
    settings: { muteEnabled: true, muteAccount: ME, allowlist: 'friend' },
    mutes: { ...lib.emptyMutes(), handles: { friend: mutedAs(ME) } },
  });
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/friend');
  assert.equal((await send(bg, { type: 'xsh:job' }, lastTab(bg).id)).kind, 'unmute');
});

// Planted negative: only mutes it made as this account are undone. An account
// the user muted (recorded `already`) that left the list is never visited, so
// nothing can click its Unmute; neither are followed or skipped accounts, a
// mute made as another account, or anything while the stored list is empty.
test('background: never unmutes what the user muted, what another account muted, or while the list is empty', async () => {
  const handles = {
    mine: { status: 'already', at: 1 },
    fol: { status: 'followed', at: 1 },
    np: { status: 'no-post', at: 1, attempts: 2 },
    other: mutedAs('someone_else'),
  };
  let bg = await muteBackground({ handles: ['slop_b'], mutes: { ...lib.emptyMutes(), handles } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened.map((t) => t.url), ['https://x.com/slop_b']);
  bg = await muteBackground({ handles: [], mutes: { ...lib.emptyMutes(), handles: { gone: mutedAs(ME) } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
});

test('background: a mute recorded before 0.8.0 is stamped with the account muting is on for, then unmuted once it leaves the list', async () => {
  const bg = await muteBackground({ handles: ['slop_b'], mutes: { ...lib.emptyMutes(), handles: { gone: { status: 'muted', at: 1, confirmed: true } } } });
  await alarm(bg);
  assert.equal(bg.chrome.store['xsh:mutes'].handles.gone.account, ME);
  assert.equal(lastTab(bg).url, 'https://x.com/gone');
});

// Planted negatives: back on the list, or added to Also hide, between the visit
// starting and the click: the job is dropped and the mute stays recorded.
test('background: an unmute job is dropped at the claim or just before the click when the account is wanted muted again', async () => {
  for (const when of ['claim', 'click']) {
    for (const change of ['list', 'extra']) {
      const bg = await muteBackground({ handles: ['slop_b'], mutes: { ...lib.emptyMutes(), handles: { gone: mutedAs(ME) } } });
      await alarm(bg);
      const tab = lastTab(bg);
      assert.equal(tab.url, 'https://x.com/gone');
      const job = when === 'click' ? await send(bg, { type: 'xsh:job' }, tab.id) : null;
      if (change === 'list') bg.chrome.store['xsh:list'] = { ...bg.chrome.store['xsh:list'], handles: ['gone', 'slop_b'] };
      else await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: true, muteAccount: ME, extraList: 'gone' } });
      await settle();
      if (when === 'claim') assert.equal(await send(bg, { type: 'xsh:job' }, tab.id), null, `${when} ${change}`);
      else assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), false, `${when} ${change}`);
      assert.deepEqual(bg.chrome.tabs.removed, [tab.id]);
      assert.equal(bg.chrome.store['xsh:mutes'].handles.gone.status, 'muted', 'dropped unrecorded');
    }
  }
});

test('background: a failed unmute keeps the mute recorded, is tried once more, then left muted', async () => {
  const bg = await muteBackground({ handles: ['slop_b'], mutes: { ...lib.emptyMutes(), handles: { gone: mutedAs(ME) } } });
  for (const attempt of [1, 2]) {
    await alarm(bg);
    const tab = lastTab(bg);
    assert.equal(tab.url, 'https://x.com/gone');
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'error', reason: 'the ⋯ menu did not open' } }, tab.id);
    const e = bg.chrome.store['xsh:mutes'].handles.gone;
    assert.deepEqual([e.status, e.unmuteAttempts], ['muted', attempt]);
    due(bg);
  }
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_b', 'given up on: the mutes go on');
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].unmutes, 0);
});

test("popup: today's line and the totals count unmutes once there are some", async () => {
  const p = loadPopup({
    'xsh:list': { handles: ['a'], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' },
    'xsh:mutes': {
      ...lib.emptyMutes(),
      handles: { a: { status: 'muted', confirmed: true }, g: { status: 'unmuted' } },
      days: { [lib.utcDay(Date.now())]: { mutes: 2, unmutes: 1, visits: 4, stopped: null } },
    },
  });
  await settle();
  assert.equal(p.document.getElementById('muteToday').textContent, 'Today (UTC): 3 of 25 (2 mutes, 1 unmute), 4 of 50 visits');
  assert.equal(p.document.getElementById('muteBar').getAttribute('value'), '3');
  assert.equal(
    p.document.getElementById('muteTotals').textContent,
    'So far: 1 muted (1 seen on your muted list, 0 not found there), 1 unmuted, 0 already muted, 0 you follow, 0 skipped.',
  );
});

test('background: muted, moved to Always show, unmuted, moved back: muted again ahead of an account never visited', async () => {
  const bg = await muteBackground({ handles: ['slop_a', 'slop_b'] });
  const visit = async (url, kind, status, verb) => {
    if (bg.chrome.store['xsh:mutes']) due(bg);
    await alarm(bg);
    const tab = lastTab(bg);
    assert.equal(tab.url, url);
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    assert.equal(job.kind, kind);
    assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), true);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status, toast: `@slop_a has been ${verb}.` } }, tab.id);
    return bg.chrome.store['xsh:mutes'];
  };
  let m = await visit('https://x.com/slop_a', 'mute', 'muted', 'muted');
  assert.deepEqual(m.sinceCheck, ['slop_a']);
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: true, muteAccount: ME, allowlist: 'slop_a' } });
  await settle();
  m = await visit('https://x.com/slop_a', 'unmute', 'unmuted', 'unmuted');
  assert.equal(m.handles.slop_a.status, 'unmuted');
  assert.deepEqual(m.sinceCheck, [], 'nothing left for the muted-list check to find');
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: true, muteAccount: ME } });
  await settle();
  m = await visit('https://x.com/slop_a', 'mute', 'muted', 'muted');
  assert.deepEqual([m.handles.slop_a.status, m.handles.slop_a.account], ['muted', ME]);
  assert.deepEqual([m.days[today()].mutes, m.days[today()].unmutes, m.days[today()].visits, m.days[today()].stopped], [2, 1, 3, null]);
});

// ------------------------------------------------------------ stranded visit after an update

// A visit in progress in a first worker, then an update: a second worker with
// the same local storage and open tabs, and empty session storage.
async function updatedWorker() {
  const first = await muteBackground();
  await alarm(first);
  const tabId = lastTab(first).id;
  assert.deepEqual(first.chrome.store['xsh:visit'], { tabId, windowId: 1, startedAt: first.chrome.store['xsh:visit'].startedAt }, 'the visit is kept in local storage');
  const second = loadBackground(() => ok('slop_a\nslop_b'), first.chrome.store, first.chrome.tabs.browser);
  return { first, second, tabId };
}

// Fire the update in the second worker; what it closed, and whether the key is left.
async function sweepAfterUpdate(second) {
  second.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  return { removed: second.chrome.tabs.removed, key: 'xsh:visit' in second.chrome.store };
}

test('update: a worker with empty session storage closes exactly the stranded visit tab and removes the key', async () => {
  const { second, tabId } = await updatedWorker();
  assert.deepEqual(second.chrome.session, {});
  assert.deepEqual(await sweepAfterUpdate(second), { removed: [tabId], key: false });
});

test('update: a tab the browser no longer has, one in another window, or the one in front of the user is not closed', async () => {
  const cases = {
    gone: (t) => t.browser.live.delete(t.id),
    'another window': (t) => (t.browser.live.get(t.id).windowId = 2),
    'in front': (t) => (t.browser.live.get(t.id).active = true),
  };
  for (const [name, change] of Object.entries(cases)) {
    const { second, tabId } = await updatedWorker();
    change({ browser: second.chrome.tabs.browser, id: tabId });
    assert.deepEqual(await sweepAfterUpdate(second), { removed: [], key: false }, name);
  }
});

test('update: a visit stamped in the future (the clock went back) or a key without a usable tab id closes no tab', async () => {
  const cases = {
    future: (v) => (v.startedAt = Date.now() + 60000),
    'no time': (v) => delete v.startedAt,
    'tab id as text': (v) => (v.tabId = String(v.tabId)),
    'no tab id': (v) => delete v.tabId,
    'no window id': (v) => delete v.windowId,
  };
  for (const [name, change] of Object.entries(cases)) {
    const { second } = await updatedWorker();
    change(second.chrome.store['xsh:visit']);
    assert.deepEqual(await sweepAfterUpdate(second), { removed: [], key: false }, name);
    // The serial chain is not stuck: the next visit still opens.
    second.chrome.store['xsh:mutes'].nextAt = 0;
    const before = second.chrome.tabs.opened.length;
    second.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
    await settle();
    assert.equal(second.chrome.tabs.opened.length, before + 1, `${name}: the next visit opened`);
  }
});

test('update: install and chrome_update close no tab', async () => {
  for (const reason of ['install', 'chrome_update']) {
    const { second } = await updatedWorker();
    second.chrome.runtime.onInstalled.fire({ reason });
    await settle();
    assert.deepEqual(second.chrome.tabs.removed, [], reason);
  }
});

test('update: a key older than the tab timeout closes no tab, and is removed', async () => {
  const { second } = await updatedWorker();
  second.chrome.store['xsh:visit'].startedAt = Date.now() - lib.DEFAULTS.muteTabTimeoutMs - 1;
  second.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  assert.deepEqual(second.chrome.tabs.removed, []);
  assert.equal('xsh:visit' in second.chrome.store, false);
});

test('update: browser startup removes the key and closes no tab', async () => {
  const { second } = await updatedWorker();
  second.chrome.runtime.onStartup.fire();
  await settle();
  assert.deepEqual(second.chrome.tabs.removed, []);
  assert.equal('xsh:visit' in second.chrome.store, false);
});

test('update: no key, no tab closed', async () => {
  const second = loadBackground(() => ok(''), {});
  second.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  assert.deepEqual(second.chrome.tabs.removed, []);
});

test('update: never closes the tab of a job the new worker started itself', async () => {
  const { second } = await updatedWorker();
  // The new worker's alarm tick runs first and starts its own visit, which
  // takes over the key; onInstalled then runs the sweep.
  second.chrome.store['xsh:mutes'].nextAt = 0;
  second.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
  second.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  const mine = second.chrome.tabs.opened.at(-1);
  assert.ok(mine, 'the new worker opened a tab');
  assert.deepEqual(second.chrome.tabs.removed, [], 'nothing was closed');
  assert.equal(second.chrome.session['xsh:job'].tabId, mine.id);
  assert.equal(second.chrome.store['xsh:visit'].tabId, mine.id);
});

test('update: the sweep skips a key that names the current session job', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  const tab = lastTab(bg);
  bg.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  assert.deepEqual(bg.chrome.tabs.removed, []);
  assert.equal(bg.chrome.store['xsh:visit'].tabId, tab.id);
});

test('visit key: a finished job leaves no key', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  assert.ok(bg.chrome.store['xsh:visit']);
  const tab = lastTab(bg);
  await send(bg, { type: 'xsh:job' }, tab.id);
  await send(bg, { type: 'xsh:job-result', result: { id: bg.chrome.session['xsh:job'].id, status: 'already' } }, tab.id);
  await settle();
  assert.equal('xsh:job' in bg.chrome.session, false);
  assert.equal('xsh:visit' in bg.chrome.store, false);
});

test('visit key: a tab the user closed leaves no key', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  assert.ok(bg.chrome.store['xsh:visit']);
  bg.chrome.tabs.onRemoved.fire(lastTab(bg).id, {});
  await settle();
  assert.equal('xsh:visit' in bg.chrome.store, false);
});

test('visit key: a job dropped because muting was turned off leaves no key', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  assert.ok(bg.chrome.store['xsh:visit']);
  const tab = lastTab(bg);
  const claimed = await send(bg, { type: 'xsh:job' }, tab.id);
  bg.chrome.store['xsh:settings'] = { muteEnabled: false, muteAccount: null };
  assert.equal(await send(bg, { type: 'xsh:job-go', id: claimed.id }, tab.id), false);
  await settle();
  assert.equal('xsh:job' in bg.chrome.session, false, 'the job is gone');
  assert.equal('xsh:visit' in bg.chrome.store, false);
});

// ------------------------------------------------------------ Run now

// Timers the test fires by hand, so a run's next step needs no real wait. A
// cleared timer stays in `due`, marked `cleared`, so a test can tell it from
// a live one.
function fakeTimers() {
  const due = [];
  return {
    due,
    setTimeout: (fn, ms) => {
      due.push({ fn, ms });
      return due.length;
    },
    clearTimeout: (handle) => {
      if (due[handle - 1]) due[handle - 1].cleared = true;
    },
  };
}

// The day's number used up: 25 mutes, the next daily visit two minutes away.
const capUsed = (handles = {}) => ({
  ...lib.emptyMutes(),
  handles,
  days: { [today()]: { mutes: 25, unmutes: 0, visits: 30, stopped: null } },
  nextAt: Date.now() + 120000,
});

// Hand the open job tab its job, then report what it found.
async function answer(bg, result) {
  const tab = lastTab(bg);
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, ...result } }, tab.id);
  return job;
}

// The run's next step: its pause of a few seconds passes, then its timer fires.
async function nextStep(bg, t) {
  const timer = t.due.shift();
  assert.ok(timer, 'the run set a timer for its next step');
  assert.ok(timer.ms >= 2000 && timer.ms <= 5100, `a pause of a few seconds, got ${timer.ms} ms`);
  due(bg);
  timer.fn();
  await settle();
}

const runOn = (bg) => reply(fromPopup(bg, { type: 'xsh:run', on: true }));

test('background: Run now visits everything waiting past the daily number, unmutes first, a few seconds apart, with the checks, then ends', async () => {
  const t = fakeTimers();
  const handles = ['slop_a', 'slop_b', 'slop_c', 'slop_d', 'slop_e', 'slop_f', 'slop_g'];
  const bg = await muteBackground({ handles, mutes: capUsed({ gone: mutedAs(ME) }), timers: t });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, [], 'the day is used up, so the daily pace visits nothing');

  assert.deepEqual(await runOn(bg), { ok: true, waiting: 8 });
  await settle();
  assert.equal(bg.chrome.session['xsh:run'].account, ME);
  assert.equal(lastTab(bg).url, 'https://x.com/gone');
  assert.equal((await answer(bg, { status: 'unmuted' })).kind, 'unmute');
  const gap = bg.chrome.store['xsh:mutes'].nextAt - Date.now();
  assert.ok(gap > 1900 && gap <= 5000, `next visit a few seconds away, got ${gap} ms`);

  const visited = [];
  for (const h of handles.slice(0, 5)) {
    await nextStep(bg, t);
    visited.push(lastTab(bg).url);
    await answer(bg, { status: 'muted' });
  }
  assert.deepEqual(visited, handles.slice(0, 5).map((h) => `https://x.com/${h}`));
  // Five mutes since the last check: the muted list is read before any more.
  await nextStep(bg, t);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all');
  await answer(bg, { status: 'checked', rows: ['slop_e', 'slop_d', 'slop_c', 'slop_b', 'slop_a'] });
  for (const h of ['slop_f', 'slop_g']) {
    await nextStep(bg, t);
    assert.equal(lastTab(bg).url, `https://x.com/${h}`);
    await answer(bg, { status: 'muted' });
  }
  // Nothing left to mute, two mutes not yet checked: one last check.
  await nextStep(bg, t);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all');
  await answer(bg, { status: 'checked', rows: ['slop_g', 'slop_f', 'slop_e'] });
  const tabs = bg.chrome.tabs.opened.length;
  await nextStep(bg, t);
  assert.equal(bg.chrome.tabs.opened.length, tabs, 'nothing left: no tab');
  assert.equal('xsh:run' in bg.chrome.session, false, 'the run ended');
  assert.equal(t.due.length, 0, 'and set no more timers');

  const m = bg.chrome.store['xsh:mutes'];
  assert.deepEqual(m.days[today()], { mutes: 32, unmutes: 1, visits: 38, stopped: null });
  assert.equal(m.handles.gone.status, 'unmuted');
  for (const h of handles) assert.equal(m.handles[h].confirmed, true, h);
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, tabs, 'after the run, the daily number holds again');
});

test('background: Run now is refused, and opens nothing, while muting is off, after the day has stopped, or with nothing waiting', async () => {
  const stopped = { ...capUsed(), days: { [today()]: { mutes: 3, visits: 4, stopped: '@slop_x: refused' } } };
  const cases = [
    [{ settings: { muteEnabled: false } }, 'muting is off'],
    [{ mutes: stopped }, 'stopped for today: @slop_x: refused'],
    [{ handles: ['slop_a'], mutes: capUsed({ slop_a: mutedAs(ME) }) }, 'nothing is waiting'],
  ];
  for (const [opts, reason] of cases) {
    const bg = await muteBackground(opts);
    assert.deepEqual(await runOn(bg), { ok: false, reason });
    await settle();
    assert.deepEqual(bg.chrome.tabs.opened, [], reason);
    assert.equal('xsh:run' in bg.chrome.session, false, reason);
  }
});

test('background: only the popup can start or stop a run; a tab or another page gets no answer', async () => {
  const bg = await muteBackground({ mutes: capUsed() });
  assert.equal(await send(bg, { type: 'xsh:run', on: true }, 7), undefined);
  for (const sender of [
    { id: EXT_ID, tab: { id: 7 }, url: 'https://x.com/slop_a' },
    { id: EXT_ID, url: 'chrome-extension://another_extension/src/popup.html' },
    { id: EXT_ID },
  ]) {
    assert.equal(await fromPopup(bg, { type: 'xsh:run', on: true }, sender), undefined, JSON.stringify(sender));
  }
  await settle();
  assert.deepEqual(bg.chrome.tabs.opened, []);
  assert.equal('xsh:run' in bg.chrome.session, false);
});

test('background: Stop ends the run and puts the daily pace back', async () => {
  const t = fakeTimers();
  const bg = await muteBackground({ mutes: capUsed(), timers: t });
  await runOn(bg);
  await settle();
  // Found muted already: no check of the muted list is owed after it.
  await answer(bg, { status: 'already' });
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:run', on: false })), { ok: true });
  assert.equal('xsh:run' in bg.chrome.session, false);
  const gap = bg.chrome.store['xsh:mutes'].nextAt - Date.now();
  assert.ok(gap > 50000, `next visit back to minutes away, got ${gap} ms`);
  await nextStep(bg, t);
  assert.equal(bg.chrome.tabs.opened.length, 1, 'the timer left behind opens nothing: the day is used up');
});

test('background: anything that stops the day ends the run', async () => {
  const t = fakeTimers();
  const bg = await muteBackground({ mutes: capUsed(), timers: t });
  await runOn(bg);
  await settle();
  await answer(bg, { status: 'refused', reason: 'X showed a warning' });
  assert.match(bg.chrome.store['xsh:mutes'].days[today()].stopped, /^@slop_a: refused/);
  await nextStep(bg, t);
  assert.equal(bg.chrome.tabs.opened.length, 1);
  assert.equal('xsh:run' in bg.chrome.session, false);
});

test('background: in a run, an account that fails twice is left alone and the run still ends', async () => {
  const t = fakeTimers();
  const bg = await muteBackground({ handles: ['slop_a'], mutes: capUsed({ gone: mutedAs(ME) }), timers: t });
  await runOn(bg);
  await settle();
  await answer(bg, { status: 'error', reason: 'no menu' });
  await nextStep(bg, t);
  assert.equal(lastTab(bg).url, 'https://x.com/gone', 'one more try at the unmute');
  await answer(bg, { status: 'error', reason: 'no menu' });
  await nextStep(bg, t);
  await answer(bg, { status: 'error', reason: 'no menu' });
  await nextStep(bg, t);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_a', 'one more try at the mute');
  await answer(bg, { status: 'error', reason: 'no menu' });
  await nextStep(bg, t);
  assert.deepEqual(
    bg.chrome.tabs.opened.map((tab) => tab.url),
    ['gone', 'gone', 'slop_a', 'slop_a'].map((h) => `https://x.com/${h}`),
  );
  assert.equal('xsh:run' in bg.chrome.session, false);
  const m = bg.chrome.store['xsh:mutes'];
  assert.equal(m.handles.slop_a.status, 'failed');
  assert.equal(m.handles.gone.status, 'muted', 'an unmute that failed twice leaves the account muted');
  assert.equal(m.handles.gone.unmuteAttempts, 2);
});

test('background: turning muting off or muting as another account ends the run', async () => {
  for (const next of [{ muteEnabled: false, muteAccount: null }, { muteEnabled: true, muteAccount: 'someone_else' }]) {
    const bg = await muteBackground({ mutes: capUsed() });
    await runOn(bg);
    await settle();
    assert.ok(bg.chrome.session['xsh:run']);
    await bg.chrome.storage.local.set({ 'xsh:settings': next });
    await settle();
    assert.equal('xsh:run' in bg.chrome.session, false, JSON.stringify(next));
  }
});

test('background: at 50 a day a run does not wait for an x.com tab, and never asks the open tabs', async () => {
  const mutes = { ...capUsed(), days: { [today()]: { mutes: 50, unmutes: 0, visits: 60, stopped: null } } };
  const bg = await muteBackground({ settings: { muteEnabled: true, muteAccount: ME, muteCap: 50 }, mutes });
  const asked = bg.chrome.tabs.queries;
  await runOn(bg);
  await settle();
  assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
  assert.equal(bg.chrome.tabs.queries, asked);
});

test('background: a worker after an update or a browser restart has no run, so the daily number holds', async () => {
  const t = fakeTimers();
  const bg = await muteBackground({ mutes: capUsed(), timers: t });
  await runOn(bg);
  await settle();
  await answer(bg, { status: 'already' });
  const next = loadBackground(() => ok('slop_a\nslop_b'), bg.chrome.store, bg.chrome.tabs.browser);
  next.chrome.runtime.onStartup.fire();
  await settle();
  due(next);
  await alarm(next);
  assert.deepEqual(next.chrome.tabs.opened, []);
});

// A popup whose Run now button records what it sends and answers `answerWith`.
function runPopup(store, answerWith = { ok: true }) {
  const p = loadPopup(store);
  p.sent = [];
  p.chrome.runtime.sendMessage = async (m) => {
    p.sent.push({ ...m }); // a copy made here: the page's objects are another realm's
    return answerWith;
  };
  return p;
}

const popupStore = (mutes, settings = { muteEnabled: true, muteAccount: ME }) => ({
  'xsh:list': { handles: ['slop_a', 'slop_b', 'slop_c'], fetchedAt: Date.now(), source: 's' },
  'xsh:settings': settings,
  'xsh:mutes': mutes,
});

test('popup: Run now names what is waiting and sends the start; during a run it reads Stop', async () => {
  const p = runPopup(popupStore(capUsed({ gone: mutedAs(ME) })));
  await settle();
  const $ = (id) => p.document.getElementById(id);
  assert.equal($('runRow').hidden, false);
  assert.equal($('runWhat').hidden, false, 'the caution shows with the button');
  assert.equal(Boolean($('runWhat').closest('details')), false, 'and is not folded');
  assert.equal($('runNow').textContent, 'Run now');
  assert.equal(
    $('runWhat').textContent,
    'Mutes and unmutes the 4 accounts waiting now, past your number a day. That is more scripted clicking at once than any daily number.',
  );
  assert.match($('muteToday').textContent, / · next visit in 2 min$/);
  $('runNow').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(p.sent, [{ type: 'xsh:run', on: true }]);
  assert.equal($('runMsg').hidden, true);

  // The worker stores the run; the open popup draws it without being reopened.
  await p.chrome.storage.session.set({ 'xsh:run': { startedAt: Date.now(), account: ME } });
  await settle();
  assert.equal($('runNow').textContent, 'Stop');
  assert.match($('runWhat').textContent, /^Running: 4 accounts left, a few seconds apart\./);
  assert.doesNotMatch($('muteToday').textContent, /next visit/);
  $('runNow').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(p.sent.at(-1), { type: 'xsh:run', on: false });
});

test('popup: Run now is not offered while muting is off, after the day has stopped, or with nothing waiting', async () => {
  const stopped = { ...capUsed(), days: { [today()]: { mutes: 3, visits: 4, stopped: '@slop_x: refused' } } };
  const settled = capUsed({ slop_a: mutedAs(ME), slop_b: mutedAs(ME), slop_c: mutedAs(ME) });
  for (const store of [popupStore(capUsed(), { muteEnabled: false }), popupStore(stopped), popupStore(settled)]) {
    const p = runPopup(store);
    await settle();
    assert.equal(p.document.getElementById('runRow').hidden, true, JSON.stringify(store['xsh:mutes'].days));
    assert.equal(p.document.getElementById('runWhat').hidden, true, 'the caution hides with the button');
  }
});

test('popup: a refused Run now says why', async () => {
  const p = runPopup(popupStore(capUsed()), { ok: false, reason: 'nothing is waiting' });
  await settle();
  p.document.getElementById('runNow').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(p.document.getElementById('runMsg').hidden, false);
  assert.equal(p.document.getElementById('runMsg').textContent, 'Not started: nothing is waiting');
});

test('popup: past the daily number the today line gives counts, not "of", and redraws as visits land', async () => {
  const day = today();
  const p = runPopup(popupStore({ ...lib.emptyMutes(), days: { [day]: { mutes: 60, unmutes: 2, visits: 70 } } }));
  await settle();
  const $ = (id) => p.document.getElementById(id);
  assert.equal($('muteToday').textContent, 'Today (UTC): 62 (60 mutes, 2 unmutes; over 25 a day), 70 visits');
  assert.equal($('muteBar').getAttribute('value'), '25');
  await p.chrome.storage.local.set({ 'xsh:mutes': { ...lib.emptyMutes(), days: { [day]: { mutes: 61, unmutes: 2, visits: 71 } } } });
  await settle();
  assert.equal($('muteToday').textContent, 'Today (UTC): 63 (61 mutes, 2 unmutes; over 25 a day), 71 visits');
});

test('background: a visit reporting a status it does not know counts as a failed try, so a run still ends', async () => {
  assert.deepEqual({ ...lib.jobResult('mute', { status: 'unmuted' }) }, { status: 'error', reason: 'unknown result: unmuted' });
  assert.deepEqual({ ...lib.jobResult('unmute', {}) }, { status: 'error', reason: 'unknown result: undefined' });
  assert.deepEqual({ ...lib.jobResult('mute', { status: 'already' }) }, { status: 'already' });
  const t = fakeTimers();
  const bg = await muteBackground({ handles: ['slop_a'], mutes: capUsed({ gone: mutedAs(ME) }), timers: t });
  await runOn(bg);
  await settle();
  for (const status of ['already', 'muted', 'weird', undefined]) {
    await answer(bg, { status });
    await nextStep(bg, t);
  }
  assert.deepEqual(
    bg.chrome.tabs.opened.map((tab) => tab.url),
    ['gone', 'gone', 'slop_a', 'slop_a'].map((h) => 'https://x.com/' + h),
  );
  assert.equal('xsh:run' in bg.chrome.session, false);
  const m = bg.chrome.store['xsh:mutes'];
  assert.equal(m.handles.gone.unmuteAttempts, 2);
  assert.equal(m.handles.slop_a.status, 'failed');
});

test('popup: a visit landing, or pressing Run now, leaves what the user typed but has not saved', async () => {
  const p = runPopup(popupStore(capUsed()));
  await settle();
  const $ = (id) => p.document.getElementById(id);
  $('allow').value = 'typed_not_saved';
  $('extra').value = 'also_typed';
  await p.chrome.storage.local.set({ 'xsh:mutes': { ...capUsed(), days: { [today()]: { mutes: 26, unmutes: 0, visits: 31 } } } });
  await settle();
  assert.equal($('muteToday').textContent.startsWith('Today (UTC): 26 mutes (over 25 a day)'), true);
  $('runNow').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal($('allow').value, 'typed_not_saved');
  assert.equal($('extra').value, 'also_typed');
});

test('background: in a run, five visits in a row that do nothing stop muting for the day before any account is given up on', async () => {
  const t = fakeTimers();
  const handles = ['slop_a', 'slop_b', 'slop_c', 'slop_d', 'slop_e', 'slop_f'];
  const bg = await muteBackground({ handles, mutes: capUsed(), timers: t });
  await runOn(bg);
  await settle();
  const answers = [
    { status: 'error', reason: 'no answer from the tab in 90 s' },
    { status: 'no-post', reason: 'no post by the account on its profile' },
    { status: 'error', reason: 'the ⋯ menu did not open' },
    { status: 'no-post', reason: 'no post by the account on its profile' },
    { status: 'error', reason: 'no answer from the tab in 90 s' },
  ];
  for (const [i, result] of answers.entries()) {
    await answer(bg, result);
    if (i < answers.length - 1) {
      assert.equal(bg.chrome.session['xsh:run'].misses, i + 1);
      await nextStep(bg, t);
    }
  }
  await settle();
  assert.equal('xsh:run' in bg.chrome.session, false, 'the run ended');
  assert.equal(t.due.length, 0, 'and set no timer for a next step');
  assert.deepEqual(
    bg.chrome.tabs.opened.map((tab) => tab.url),
    handles.slice(0, 5).map((h) => `https://x.com/${h}`),
  );
  const m = bg.chrome.store['xsh:mutes'];
  assert.equal(m.days[today()].stopped, 'Run now: 5 visits in a row did nothing, the last @slop_e: error (no answer from the tab in 90 s)');
  for (const h of handles.slice(0, 5)) {
    assert.notEqual(m.handles[h].status, 'failed', `@${h} keeps its second try`);
    assert.equal(lib.muteCandidates(handles, { muteEnabled: true, muteAccount: ME }, m).includes(h), true);
  }
  due(bg);
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 5, 'the daily pace visits nothing either, today');
});

test('background: in a run, a visit that does something starts the count of visits that did nothing again', async () => {
  const t = fakeTimers();
  const handles = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];
  const bg = await muteBackground({ handles, mutes: capUsed(), timers: t });
  await runOn(bg);
  await settle();
  const err = { status: 'error', reason: 'no menu' };
  for (const result of [err, err, err, err, { status: 'muted' }, err, err, err, err]) {
    await answer(bg, result);
    await nextStep(bg, t);
  }
  assert.equal(bg.chrome.session['xsh:run'].misses, 4, 'four since the mute');
  assert.equal(bg.chrome.tabs.opened.length, 10);
  assert.equal(lastTab(bg).url, 'https://x.com/m1', 'a second try once every account had one');
  await answer(bg, err);
  await settle();
  assert.equal('xsh:run' in bg.chrome.session, false);
  const m = bg.chrome.store['xsh:mutes'];
  assert.match(m.days[today()].stopped, /^Run now: 5 visits in a row did nothing, the last @m1: error/);
  assert.equal(m.handles.m1.status, 'failed');
  assert.equal(m.handles.m5.status, 'muted');
});

test('background: a check that cannot read the muted list is tried again 15 minutes on; a second failure stops the day', async () => {
  const five = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const handles = Object.fromEntries(five.map((h) => [h, { status: 'muted', confirmed: null, account: ME, at: 1 }]));
  const bg = await muteBackground({
    handles: [...five, 'slop_z'],
    mutes: { ...lib.emptyMutes(), handles, sinceCheck: five, days: { [today()]: { mutes: 5, visits: 5, stopped: null } } },
  });
  const rec = () => bg.chrome.store['xsh:mutes'];
  const noRows = { status: 'error', reason: 'settings/muted/all showed no rows' };
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all');
  const before = Date.now();
  await answer(bg, noRows);
  assert.equal(rec().days[today()].stopped, null, 'one failure does not stop the day');
  assert.deepEqual(rec().sinceCheck, five);
  const wait = rec().checkRetry.at - before;
  assert.ok(wait >= 15 * 60000 - 2000 && wait <= 15 * 60000 + 2000, `about 15 minutes, got ${wait} ms`);
  due(bg);
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1, 'during the wait nothing opens, slop_z included');
  rec().checkRetry.at = Date.now() - 1;
  due(bg);
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 2);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all');
  await answer(bg, noRows);
  assert.equal(rec().days[today()].stopped, 'settings/muted/all check: error (settings/muted/all showed no rows)');
  due(bg);
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 2, 'stopped for the day: slop_z waits');
});

test('background: pressing Run now while a failed check waits does not skip the wait', async () => {
  const t = fakeTimers();
  const five = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const handles = Object.fromEntries(five.map((h) => [h, { status: 'muted', confirmed: null, account: ME, at: 1 }]));
  const checkRetry = { at: Date.now() + 10 * 60000, account: ME, reason: 'settings/muted/all check: error (x)' };
  const bg = await muteBackground({ handles: [...five, 'slop_z'], mutes: { ...capUsed(handles), sinceCheck: five, checkRetry }, timers: t });
  assert.deepEqual(await runOn(bg), { ok: true, waiting: 1 });
  await settle();
  assert.deepEqual(bg.chrome.tabs.opened, [], 'neither the check nor slop_z before the wait is over');
  assert.ok(bg.chrome.session['xsh:run'], 'the run waits with it');
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
  bg.chrome.store['xsh:mutes'].checkRetry.at = Date.now() - 1;
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all');
  await answer(bg, { status: 'checked', rows: [...five].reverse() });
  assert.equal(bg.chrome.store['xsh:mutes'].checkRetry, undefined);
  await nextStep(bg, t);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_z');
});

test('background: in a run, deleted or suspended accounts settle and are not visits that did nothing', async () => {
  const t = fakeTimers();
  const handles = ['dead_1', 'dead_2', 'dead_3', 'dead_4', 'dead_5', 'dead_6', 'live_a'];
  const bg = await muteBackground({ handles, mutes: capUsed(), timers: t });
  await runOn(bg);
  await settle();
  for (const h of handles.slice(0, 6)) {
    assert.equal(lastTab(bg).url, `https://x.com/${h}`);
    await answer(bg, { status: 'gone', reason: 'Account suspended' });
    assert.equal(bg.chrome.session['xsh:run'].misses || 0, 0, `@${h} is not a miss`);
    await nextStep(bg, t);
  }
  assert.equal(lastTab(bg).url, 'https://x.com/live_a', 'six in a row did not stop the run');
  const m = bg.chrome.store['xsh:mutes'];
  assert.equal(m.days[today()].stopped, null);
  for (const h of handles.slice(0, 6)) assert.deepEqual(m.handles[h].status, 'gone');
  assert.deepEqual(lib.muteCandidates(handles, { muteEnabled: true, muteAccount: ME }, m), ['live_a'], 'none is visited again');
});

test('popup: a failed check waiting for its second try says so, during a run too; deleted or suspended accounts are counted', async () => {
  const handles = { m1: { status: 'muted', confirmed: null, account: ME, at: 1 }, dead_1: { status: 'gone', at: 1 }, dead_2: { status: 'gone', at: 1 } };
  const checkRetry = { at: Date.now() + 14.5 * 60000, account: ME, reason: 'settings/muted/all check: error (x)' };
  const p = runPopup(popupStore({ ...capUsed(handles), sinceCheck: ['m1'], checkRetry }));
  await settle();
  const $ = (id) => p.document.getElementById(id);
  assert.match($('muteToday').textContent, / · your muted list did not load, next try in 15 min$/);
  assert.doesNotMatch($('muteToday').textContent, /next visit/);
  assert.match($('muteTotals').textContent, /, 0 skipped, 2 deleted or suspended\.$/);
  await p.chrome.storage.session.set({ 'xsh:run': { startedAt: Date.now(), account: ME } });
  await settle();
  assert.match($('muteToday').textContent, / · your muted list did not load, next try in 15 min$/);
});

test('background: while a failed check waits nothing is visited, with fewer than 5 mutes waiting too; the retry comes first after it', async () => {
  const t = fakeTimers();
  const three = ['m1', 'm2', 'm3'];
  const handles = Object.fromEntries(three.map((h) => [h, { status: 'muted', confirmed: null, account: ME, at: 1 }]));
  const checkRetry = { at: Date.now() + 10 * 60000, account: ME, reason: 'settings/muted/all check: error (x)' };
  const bg = await muteBackground({ handles: [...three, 'slop_z'], mutes: { ...capUsed(handles), sinceCheck: three, checkRetry }, timers: t });
  assert.deepEqual(await runOn(bg), { ok: true, waiting: 1 });
  await settle();
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, [], 'Run now skips the caps, not the wait');
  bg.chrome.store['xsh:mutes'].checkRetry.at = Date.now() - 1;
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all', 'the second try, before slop_z');
  await answer(bg, { status: 'checked', rows: [...three].reverse() });
  await nextStep(bg, t);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_z');
});

test('popup: a stopped day does not also say a check is waiting', async () => {
  const handles = { m1: { status: 'muted', confirmed: null, account: ME, at: 1 } };
  const checkRetry = { at: Date.now() + 10 * 60000, account: ME, reason: 'x' };
  const stoppedDay = { [today()]: { mutes: 3, visits: 4, stopped: '@slop_x: refused' } };
  const p = runPopup(popupStore({ ...capUsed(handles), sinceCheck: ['m1'], checkRetry, days: stoppedDay }));
  await settle();
  assert.doesNotMatch(p.document.getElementById('muteToday').textContent, /muted list did not load/);
});

// ------------------------------------------------------------------ lists
//
// Choosing which lists hide replies. Muting reads the AI list's record alone;
// every other list only hides. Handles are invented.

const AI_URL = 'https://clankwall.vogel.dev/api/usernames.txt';
const ALL_URL = 'https://clankwall.vogel.dev/api/accounts.ndjson';
const ALL_KEY = 'xsh:list:clankwall-all';
const ndjson = (...names) => names.map((n) => JSON.stringify({ username: n, verdict: 'x' })).join('\n');
const record = (handles, source, extra = {}) => ({ handles, fetchedAt: Date.now(), source, lastAttemptAt: Date.now(), lastError: null, ...extra });
const ALL_ON = { 'clankwall-all': true };
const ALL_ONLY = { ...ALL_ON, recommended: false };
const LEVELS_URL = 'https://blockedforaireply.levels.io/api/usernames.txt';
const LEVELS_KEY = 'xsh:list:levelsio';

// storage.onChanged in a real browser carries oldValue; this fake's set does
// not, so the lists tests give it one.
function withOldValues(bg) {
  const { store } = bg.chrome;
  bg.chrome.storage.local.set = async (o) => {
    const changes = Object.fromEntries(
      Object.keys(o).map((k) => [k, { oldValue: k in store ? structuredClone(store[k]) : undefined, newValue: structuredClone(o[k]) }]),
    );
    Object.assign(store, structuredClone(o));
    bg.chrome.storage.onChanged.fire(changes, 'local');
  };
  return bg;
}

// A worker whose lists answer by address: the AI list `aiBody`, the NDJSON
// `allBody`, any other address `otherBody`.
function listsBackground({ store = {}, aiBody = 'aionly\nboth\n', allBody = ndjson('both', 'spamonly'), otherBody = 'custom1\ncustom2\n', timers = null } = {}) {
  const bg = loadBackground(
    (url) => ok(url === ALL_URL ? allBody : url === AI_URL ? aiBody : otherBody),
    store,
    undefined,
    timers,
  );
  return withOldValues(bg);
}

const startup = async (bg) => {
  bg.chrome.runtime.onStartup.fire();
  await settle();
};

// Muting on, an account set, the AI list ['aionly', 'both'] at xsh:list, the
// All flags list ['both', 'spamonly'] at its own key, and All flags on.
async function twoListBackground({ lists = ALL_ON, extra = {}, timers = null } = {}) {
  const bg = listsBackground({ timers });
  Object.assign(bg.chrome.store, {
    'xsh:list': record(['aionly', 'both'], AI_URL),
    [ALL_KEY]: record(['both', 'spamonly'], ALL_URL),
    'xsh:settings': { muteEnabled: true, muteAccount: ME, lists },
    ...extra,
  });
  await startup(bg);
  assert.deepEqual(bg.requests, [], 'both records are fresh, so startup fetches nothing');
  return bg;
}

test('lists, muting: a sighting of an account only on All flags is not noted; one on the AI list is', async () => {
  const bg = await twoListBackground({ lists: ALL_ONLY });
  await send(bg, { type: 'xsh:sighting', handle: 'spamonly' }, 7);
  assert.equal(bg.chrome.store['xsh:mutes'], undefined, 'nothing written to the mute record');
  await send(bg, { type: 'xsh:sighting', handle: 'both' }, 7);
  assert.deepEqual(bg.chrome.store['xsh:mutes'].front, ['both']);
});

test('lists, muting: ticks visit the AI list accounts and never an account only on All flags', async () => {
  const bg = await twoListBackground({ lists: ALL_ONLY });
  const urls = [];
  for (let i = 0; i < 3; i++) {
    await alarm(bg);
    const tab = lastTab(bg);
    urls.push(tab.url);
    if (tab.url.endsWith('/muted/all')) break;
    await answer(bg, { status: 'muted' });
    due(bg);
  }
  assert.deepEqual(urls, ['https://x.com/aionly', 'https://x.com/both', 'https://x.com/settings/muted/all']);
  assert.equal(bg.chrome.store['xsh:mutes'].handles.spamonly, undefined);
});

test('lists, muting: Run now waits on the same number with All flags on as with it off', async () => {
  const on = await twoListBackground({ lists: ALL_ONLY, timers: fakeTimers() });
  const off = await twoListBackground({ lists: { recommended: false }, timers: fakeTimers() });
  assert.deepEqual(await runOn(on), { ok: true, waiting: 2 });
  assert.deepEqual(await runOn(off), { ok: true, waiting: 2 });
  await settle();
  assert.equal(lastTab(on).url, 'https://x.com/aionly');
});

test('lists, muting: an account it muted that is on All flags only is still unmuted, because muting reads the AI list', async () => {
  const bg = await twoListBackground({ lists: ALL_ONLY, extra: { 'xsh:mutes': { ...lib.emptyMutes(), handles: { spamonly: mutedAs(ME) } } } });
  await alarm(bg);
  const tab = lastTab(bg);
  assert.equal(tab.url, 'https://x.com/spamonly');
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.deepEqual([job.kind, job.handle], ['unmute', 'spamonly']);
  assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), true);
});

test('lists, fetching: switching All flags on fetches the NDJSON once and stores it under its own key', async () => {
  const bg = listsBackground({ store: { 'xsh:list': record(['aionly', 'both'], AI_URL), 'xsh:settings': { lists: { recommended: false } } } });
  await startup(bg);
  assert.deepEqual(bg.requests, []);
  await bg.chrome.storage.local.set({ 'xsh:settings': { lists: ALL_ONLY } });
  await settle();
  assert.deepEqual(bg.requests.map((r) => r.url), [ALL_URL]);
  const rec = bg.chrome.store[ALL_KEY];
  assert.deepEqual(rec.handles, ['both', 'spamonly']);
  assert.equal(rec.source, ALL_URL);
  assert.equal(rec.seq, 1);
  assert.deepEqual(bg.chrome.store['xsh:list'].handles, ['aionly', 'both'], 'the AI record is untouched');
  // Off, then on again while the record is fresh: no second fetch.
  await bg.chrome.storage.local.set({ 'xsh:settings': { lists: { 'clankwall-all': false, recommended: false } } });
  await bg.chrome.storage.local.set({ 'xsh:settings': { lists: ALL_ONLY } });
  await settle();
  assert.equal(bg.requests.length, 1);
});

test('lists, fetching: switching levelsio\'s list on fetches its text file once and stores it under its own key', async () => {
  const bg = listsBackground({ store: { 'xsh:list': record(['aionly', 'both'], AI_URL), 'xsh:settings': { lists: { recommended: false } } }, otherBody: 'levelsonly\nboth\n' });
  await startup(bg);
  assert.deepEqual(bg.requests, [], 'off by default, so nothing fetched');
  await bg.chrome.storage.local.set({ 'xsh:settings': { lists: { levelsio: true, recommended: false } } });
  await settle();
  assert.deepEqual(bg.requests.map((r) => r.url), [LEVELS_URL]);
  const rec = bg.chrome.store[LEVELS_KEY];
  assert.deepEqual(rec.handles, ['both', 'levelsonly']);
  assert.equal(rec.source, LEVELS_URL);
  assert.deepEqual(bg.chrome.store['xsh:list'].handles, ['aionly', 'both'], 'the AI record is untouched');
});

test('lists, muting: a sighting of an account only on levelsio\'s list is not noted', async () => {
  const bg = await twoListBackground({ lists: { levelsio: true, recommended: false }, extra: { [LEVELS_KEY]: record(['levelsonly'], LEVELS_URL) } });
  await send(bg, { type: 'xsh:sighting', handle: 'levelsonly' }, 7);
  assert.equal(bg.chrome.store['xsh:mutes'], undefined, 'nothing written to the mute record');
});

test('lists, fetching: a record that came from another address, or is due, is fetched when its list is switched on', async () => {
  const bg = listsBackground({
    store: {
      'xsh:list': record(['aionly'], AI_URL),
      [ALL_KEY]: record(['old1'], 'https://elsewhere.example/a.ndjson'),
      'xsh:settings': { lists: { recommended: false } },
    },
  });
  await startup(bg);
  await bg.chrome.storage.local.set({ 'xsh:settings': { lists: ALL_ONLY } });
  await settle();
  assert.equal(bg.requests.length, 1);
  assert.deepEqual(bg.chrome.store[ALL_KEY].handles, ['both', 'spamonly']);
  // Seven hours old: due.
  const stale = Date.now() - 7 * 3600e3;
  bg.chrome.store[ALL_KEY] = record(['old2'], ALL_URL, { fetchedAt: stale, lastAttemptAt: stale });
  await bg.chrome.storage.local.set({ 'xsh:settings': { lists: { 'clankwall-all': false, recommended: false } } });
  await bg.chrome.storage.local.set({ 'xsh:settings': { lists: ALL_ONLY } });
  await settle();
  assert.equal(bg.requests.length, 2);
});

test('lists, fetching: a label, an Also hide edit, a bot row or muting on start no fetch', async () => {
  const bg = listsBackground({
    store: {
      'xsh:list': record(['aionly'], AI_URL),
      [ALL_KEY]: record(['spamonly'], ALL_URL),
      'xsh:settings': { labeling: true, lists: ALL_ONLY },
    },
  });
  await startup(bg);
  assert.deepEqual(await reply(send(bg, LABEL_MSG, 7)), { ok: true, label: 'slop', added: 'extraList' });
  await bg.chrome.storage.local.set({ 'xsh:settings': { ...bg.chrome.store['xsh:settings'], extraList: 'x1\nx2' } });
  await bg.chrome.storage.local.set({ 'xsh:settings': { ...bg.chrome.store['xsh:settings'], bots: { grok: 'show' } } });
  await bg.chrome.storage.local.set({ 'xsh:settings': { ...bg.chrome.store['xsh:settings'], muteEnabled: true, muteAccount: ME } });
  await settle();
  assert.deepEqual(bg.requests, []);
});

test('lists, fetching: adding a list fetches its address, and removing it deletes its record', async () => {
  const bg = listsBackground({ store: { 'xsh:list': record(['aionly'], AI_URL), 'xsh:settings': { lists: { recommended: false } } } });
  await startup(bg);
  const mine = { id: 'uabc', url: 'https://raw.example.com/x/list.txt', on: true };
  await bg.chrome.storage.local.set({ 'xsh:settings': { customLists: [mine], lists: { recommended: false } } });
  await settle();
  assert.deepEqual(bg.requests.map((r) => r.url), [mine.url]);
  assert.deepEqual(bg.chrome.store['xsh:list:uabc'].handles, ['custom1', 'custom2']);
  assert.equal(bg.requests[0].init.credentials, 'omit');
  await bg.chrome.storage.local.set({ 'xsh:settings': { customLists: [], lists: { recommended: false } } });
  await settle();
  assert.equal('xsh:list:uabc' in bg.chrome.store, false);
  assert.equal(bg.requests.length, 1);
  assert.deepEqual(bg.chrome.store['xsh:list'].handles, ['aionly']);
});

test('lists, fetching: a list removed while its fetch is out leaves no record', async () => {
  const pending = [];
  const bg = withOldValues(loadBackground(() => new Promise((resolve) => pending.push(resolve))));
  Object.assign(bg.chrome.store, { 'xsh:list': record(['aionly'], AI_URL), 'xsh:settings': {} });
  const mine = { id: 'uabc', url: 'https://raw.example.com/x/list.txt', on: true };
  await bg.chrome.storage.local.set({ 'xsh:settings': { customLists: [mine] } });
  await settle();
  assert.equal(pending.length, 1);
  await bg.chrome.storage.local.set({ 'xsh:settings': {} });
  await settle();
  pending[0](ok('custom1\ncustom2\n'));
  await settle();
  assert.equal('xsh:list:uabc' in bg.chrome.store, false);
});

test('lists, fetching: xsh:refresh and the alarm fetch only the lists that are on', async () => {
  const bg = listsBackground({
    store: {
      'xsh:list': record(['aionly', 'both'], AI_URL),
      [ALL_KEY]: record(['spamonly'], ALL_URL),
      'xsh:settings': { lists: { 'clankwall-all': false, recommended: false }, customLists: [{ id: 'uoff', url: 'https://off.example/l.txt', on: false }] },
    },
  });
  const r = await reply(send(bg, { type: 'xsh:refresh' }, undefined));
  assert.deepEqual(bg.requests.map((q) => q.url), [AI_URL]);
  assert.deepEqual(r, { ok: true, reason: null, count: 2 });
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.deepEqual(bg.requests.map((q) => q.url), [AI_URL, AI_URL]);
  assert.equal('xsh:list:uoff' in bg.chrome.store, false);
});

test('lists, fetching: with several lists on, refresh fetches each, counts the union and names the first failure', async () => {
  const bg = listsBackground({
    store: { 'xsh:list': record(['aionly', 'both'], AI_URL), 'xsh:settings': { lists: ALL_ONLY } },
  });
  assert.deepEqual(await reply(send(bg, { type: 'xsh:refresh' }, undefined)), { ok: true, reason: null, count: 3 });
  assert.deepEqual(bg.requests.map((q) => q.url).sort(), [ALL_URL, AI_URL].sort());
  // The NDJSON list fails; the AI list's own record still updates.
  const failing = loadBackground((url) => (url === ALL_URL ? { ok: false, status: 503, headers: { get: () => null }, text: async () => '' } : ok('aionly\nboth\n')));
  Object.assign(failing.chrome.store, { 'xsh:list': record(['aionly', 'both'], AI_URL), [ALL_KEY]: record(['both', 'spamonly'], ALL_URL), 'xsh:settings': { lists: ALL_ONLY } });
  assert.deepEqual(await reply(send(failing, { type: 'xsh:refresh' }, undefined)), {
    ok: false,
    reason: 'clankwall: All flags: HTTP 503',
    count: 3,
  });
  assert.equal(failing.chrome.store[ALL_KEY].lastError, 'HTTP 503');
  assert.deepEqual(failing.chrome.store[ALL_KEY].handles, ['both', 'spamonly']);
  assert.equal(failing.chrome.store['xsh:list'].lastError, null);
});

test('lists, fetching: with only the AI list on, the refresh reply is the one it always was', async () => {
  const bg = loadBackground(() => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' }));
  bg.chrome.store['xsh:settings'] = { lists: { recommended: false } };
  bg.chrome.store['xsh:list'] = record(['known_slop'], AI_URL);
  assert.deepEqual(await reply(send(bg, { type: 'xsh:refresh' }, undefined)), { ok: false, reason: 'HTTP 503', count: 1 });
});

test('lists, fetching: startup refreshes each list that is on and due, and no other', async () => {
  const stale = Date.now() - 7 * 3600e3;
  const bg = listsBackground({
    store: {
      'xsh:list': record(['aionly'], AI_URL),
      [ALL_KEY]: record(['spamonly'], ALL_URL, { fetchedAt: stale, lastAttemptAt: stale }),
      'xsh:settings': { lists: ALL_ONLY, customLists: [{ id: 'uoff', url: 'https://off.example/l.txt', on: false }] },
    },
  });
  await startup(bg);
  assert.deepEqual(bg.requests.map((q) => q.url), [ALL_URL]);
  assert.deepEqual(bg.chrome.store[ALL_KEY].handles, ['both', 'spamonly']);
});

test('lists, labels: a label says which lists hold the account, from the lists that are on', async () => {
  const bg = listsBackground({
    store: {
      'xsh:list': record(['aionly'], AI_URL),
      [ALL_KEY]: record(['reply_a'], ALL_URL),
      'xsh:list:uoff': record(['reply_a'], 'https://off.example/l.txt'),
      'xsh:settings': { labeling: true, lists: ALL_ON, customLists: [{ id: 'uoff', url: 'https://off.example/l.txt', on: false }] },
    },
  });
  assert.equal((await reply(send(bg, LABEL_MSG, 7))).ok, true);
  const r = bg.chrome.store['xsh:label:2'];
  assert.deepEqual([r.list, r.lists, r.hidden], ['clankwall.vogel.dev', ['clankwall-all'], true]);
});

// ---------------------------------------------------------- userscript

test('userscript: the menu switches All flags on, fetches the NDJSON and hides an account only on it', async () => {
  const respond = (req) => {
    const body = req.url === ALL_URL ? ndjson('both', 'spamonly') : 'aionly\nboth\n';
    const type = req.url === ALL_URL ? 'application/x-ndjson' : 'text/plain';
    setTimeout(() => req.onload({ status: 200, responseHeaders: `content-type: ${type}\r\n`, responseText: body }), 0);
  };
  const us = loadUserscript({
    respond,
    cells: [post({ author: 'spamonly', status: '1' }), post({ author: 'aionly', status: '2' }), post({ author: 'human1', status: '3' })],
  });
  await settle();
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual(us.requests.map((r) => r.url), [AI_URL]);
  assert.deepEqual(['1', '2', '3'].map(hidden), [false, true, false]);
  const item = 'Hide every account clankwall flagged / AI flags only';
  assert.ok(us.menu[item], 'the menu has the toggle');
  us.menu[item]();
  await settle();
  assert.deepEqual(us.values['xsh:settings'].lists, ALL_ON);
  assert.deepEqual(us.requests.map((r) => r.url), [AI_URL, ALL_URL]);
  assert.deepEqual(us.values[ALL_KEY].handles, ['both', 'spamonly']);
  assert.deepEqual(['1', '2', '3'].map(hidden), [true, true, false]);
  // Back to AI flags only: nothing fetched, the account shows again.
  us.menu[item]();
  await settle();
  assert.deepEqual(us.values['xsh:settings'].lists, { 'clankwall-all': false });
  assert.equal(us.requests.length, 2);
  assert.deepEqual(['1', '2', '3'].map(hidden), [false, true, false]);
});

test('userscript: levelsio\'s list is not read or fetched, even when settings switch it on', async () => {
  const us = loadUserscript({
    values: { 'xsh:settings': { lists: { levelsio: true } }, [LEVELS_KEY]: record(['human1'], LEVELS_URL) },
    respond: gmOk('aionly\n'),
    cells: [post({ author: 'human1', status: '1' })],
  });
  await settle();
  us.menu['Refresh list now']();
  await settle();
  assert.deepEqual(us.requests.map((r) => r.url), [AI_URL, AI_URL]);
  assert.equal(us.document.querySelector('[data-fixture="1"]').hasAttribute('data-xsh-hidden'), false);
});

test('userscript: added lists are not read or fetched', async () => {
  const us = loadUserscript({
    values: { 'xsh:settings': { customLists: [{ id: 'uabc', url: 'https://other.example/l.txt', on: true }] }, 'xsh:list:uabc': record(['human1'], 'https://other.example/l.txt') },
    respond: gmOk('aionly\n'),
    cells: [post({ author: 'human1', status: '1' })],
  });
  await settle();
  assert.deepEqual(us.requests.map((r) => r.url), [AI_URL]);
  assert.equal(us.document.querySelector('[data-fixture="1"]').hasAttribute('data-xsh-hidden'), false);
});

// ------------------------------------------------------- popup, settings

test('popup: with two lists on it says how many accounts on how many lists and how old the oldest is', async () => {
  const p = loadPopup({
    'xsh:list': record(['aionly', 'both'], AI_URL, { fetchedAt: Date.now() - 2 * 3600e3 }),
    [ALL_KEY]: record(['both', 'spamonly'], ALL_URL),
    'xsh:settings': { lists: ALL_ONLY },
  });
  await settle();
  const text = (id) => p.document.getElementById(id).textContent;
  assert.equal(text('list'), '3 accounts on 2 lists');
  assert.equal(text('listAge'), 'From 2 lists, oldest updated 2 h ago');
  assert.equal(p.document.getElementById('err').hidden, true);
  assert.equal(p.document.getElementById('chooseLists').textContent, 'Choose lists');
});

test('popup: with only the AI list on the list lines are what they always were', async () => {
  const p = loadPopup({
    'xsh:list': record(['aionly', 'both'], AI_URL, { fetchedAt: Date.now() - 3600e3 }),
    [ALL_KEY]: record(['spamonly'], ALL_URL),
    'xsh:settings': { lists: { recommended: false } },
  });
  await settle();
  const text = (id) => p.document.getElementById(id).textContent;
  assert.equal(text('list'), '2 accounts on the list');
  assert.equal(text('listAge'), 'From clankwall.vogel.dev, updated 1 h ago');
});

test('popup: a list never fetched, a failing list and no list at all', async () => {
  const at = Date.now();
  let p = loadPopup({
    'xsh:list': record(['aionly'], AI_URL),
    'xsh:settings': { lists: ALL_ONLY },
  });
  await settle();
  assert.equal(p.document.getElementById('list').textContent, '1 account on 2 lists');
  assert.equal(p.document.getElementById('listAge').textContent, 'From 2 lists, not all fetched yet');
  p = loadPopup({
    'xsh:list': record(['aionly'], AI_URL),
    [ALL_KEY]: record(['spamonly'], ALL_URL, { fetchedAt: at - 3600e3, lastAttemptAt: at, lastError: 'HTTP 503' }),
    'xsh:settings': { lists: ALL_ONLY },
  });
  await settle();
  assert.equal(p.document.getElementById('err').hidden, false);
  assert.equal(p.document.getElementById('err').textContent, 'clankwall: All flags: last refresh failed (just now): HTTP 503. Still using the previous list.');
  p = loadPopup({
    'xsh:list': record(['aionly'], AI_URL),
    [ALL_KEY]: record(['spamonly'], ALL_URL, { fetchedAt: 0, lastAttemptAt: at, lastError: 'HTTP 503' }),
    'xsh:settings': { lists: ALL_ONLY },
  });
  await settle();
  assert.equal(p.document.getElementById('err').textContent, 'clankwall: All flags: last refresh failed (just now): HTTP 503.');
  p = loadPopup({ 'xsh:list': record(['aionly'], AI_URL), 'xsh:settings': { lists: { 'clankwall-ai': false, recommended: false } } });
  await settle();
  assert.equal(p.document.getElementById('list').textContent, 'No list is on');
  assert.equal(p.document.getElementById('listAge').textContent, '');
  assert.equal(p.document.getElementById('err').hidden, true);
});

test('popup: while it is open, a list fetched or turned on elsewhere redraws the list lines, and what the user typed stays', async () => {
  const p = loadPopup({
    'xsh:list': record(['aionly', 'both'], AI_URL, { fetchedAt: Date.now() - 3600e3 }),
    'xsh:settings': { lists: { recommended: false } },
  });
  await settle();
  const $ = (id) => p.document.getElementById(id);
  assert.equal($('list').textContent, '2 accounts on the list');
  $('extra').value = 'typed_not_saved';
  // The 6-hour refresh lands while the popup is open.
  await p.chrome.storage.local.set({ 'xsh:list': record(['aionly', 'both', 'newone'], AI_URL) });
  await settle();
  assert.equal($('list').textContent, '3 accounts on the list');
  assert.equal($('listAge').textContent, 'From clankwall.vogel.dev, updated just now');
  // All flags is turned on in the settings page; then its first fetch lands.
  await p.chrome.storage.local.set({ 'xsh:settings': { lists: ALL_ONLY } });
  await settle();
  assert.equal($('list').textContent, '3 accounts on 2 lists');
  assert.equal($('listAge').textContent, 'From 2 lists, not all fetched yet');
  await p.chrome.storage.local.set({ [ALL_KEY]: record(['both', 'spamonly'], ALL_URL) });
  await settle();
  assert.equal($('list').textContent, '4 accounts on 2 lists');
  assert.equal($('extra').value, 'typed_not_saved', 'a redraw never writes the boxes');
});

test('popup: the bot rows follow every list that is on, and muting counts the AI list alone', async () => {
  const p = loadPopup({
    'xsh:list': record(['aionly'], AI_URL),
    [ALL_KEY]: record(['askperplexity'], ALL_URL),
    'xsh:settings': { lists: ALL_ON, muteEnabled: true, muteAccount: ME },
  });
  await settle();
  assert.equal(rowMode(p, 'askperplexity'), 'hide');
  const off = loadPopup({ 'xsh:list': record(['aionly'], AI_URL), [ALL_KEY]: record(['askperplexity'], ALL_URL), 'xsh:settings': {} });
  await settle();
  assert.equal(rowMode(off, 'askperplexity'), 'show');
  // Run now's count comes from the AI list only.
  assert.equal(p.document.getElementById('runWhat').textContent.includes('1 account '), true);
});

test('popup: Choose lists opens the options page', async () => {
  const p = loadPopup({ 'xsh:settings': {} });
  let opened = 0;
  p.chrome.runtime.openOptionsPage = async () => {
    opened += 1;
  };
  await settle();
  p.document.getElementById('chooseLists').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(opened, 1);
});

const rows = (s) => [...s.document.querySelectorAll('#listRows [data-list]')];
const rowOf = (s, id) => rows(s).find((r) => r.getAttribute('data-list') === id);
function flip(s, id, checked) {
  const box = s.document.getElementById(`list-${id}`);
  box.checked = checked;
  box.dispatchEvent(new s.document.defaultView.Event('change'));
}

const stat = (s, id) => s.$(`stat-${id}`).textContent;

test('settings page: the Lists section is first, retitled, and shows the four built-in lists', async () => {
  const s = loadSettings({ 'xsh:list': record(['aionly', 'both'], AI_URL, { fetchedAt: Date.now() - 5 * 60e3 }), 'xsh:settings': {} });
  await settle();
  assert.equal(s.document.title, 'AI Anti-Slop settings');
  assert.equal(s.document.querySelector('h1').textContent, 'Settings');
  assert.equal(s.document.querySelector('.brand').textContent, 'AI Anti-Slop');
  assert.equal(s.document.querySelector('main section').id, 'listsCard');
  assert.equal(s.document.querySelector('#listsCard h2').textContent, 'Lists');
  assert.equal(s.document.querySelector('#listsCard > p').textContent, 'Replies by any account on a list that is on are hidden. Always show, in the popup, beats every list.');
  assert.equal(s.$('summary').textContent, 'Hiding replies from 2 accounts on 2 lists.');
  assert.deepEqual([...s.document.querySelectorAll('#listRows h3')].map((h) => h.textContent), ['Built in', 'Added by you · 0 of 5']);
  assert.equal(s.$('ownRows').hidden, true, 'no empty list of added lists');
  assert.deepEqual(rows(s).map((r) => r.getAttribute('data-list')), ['recommended', 'clankwall-ai', 'clankwall-all', 'levelsio']);
  const ai = rowOf(s, 'clankwall-ai');
  const all = rowOf(s, 'clankwall-all');
  const lev = rowOf(s, 'levelsio');
  assert.equal(lev.querySelector('label').textContent, 'levelsio: Blocked for AI reply');
  assert.equal(lev.querySelector('input').checked, false);
  assert.equal(stat(s, 'levelsio'), 'Off');
  assert.match(lev.textContent, /The list's page calls its flags judgment calls, not proof\. Recommended includes the ones blocked with a public reply\. Hides replies only\./);
  assert.equal(lev.querySelector('a').getAttribute('href'), 'https://blockedforaireply.levels.io/');
  assert.equal(lev.querySelector('button'), null, 'a built-in list has no Remove');
  assert.equal(ai.querySelector('label').textContent, 'clankwall: AI flags');
  assert.equal(ai.querySelector('input').getAttribute('role'), 'switch');
  assert.equal(ai.querySelector('input').getAttribute('aria-describedby'), 'stat-clankwall-ai');
  assert.equal(ai.querySelector('input').checked, true);
  assert.equal(all.querySelector('input').checked, false);
  assert.equal(stat(s, 'clankwall-ai'), '2 accounts · updated 5 min ago');
  assert.equal(stat(s, 'clankwall-all'), 'Off');
  assert.match(ai.textContent, /Accounts whose replies clankwall scored as AI\. Muting uses this list\./);
  assert.match(all.textContent, /About half of those not on the AI list rest on a single flag/);
  // Each list's note and link wait behind its own About, named for the list.
  assert.equal(ai.querySelector('details summary').textContent, 'About clankwall: AI flags');
  assert.equal(ai.querySelector('details').hasAttribute('open'), false);
  assert.equal(ai.querySelector('a').getAttribute('href'), 'https://clankwall.vogel.dev/?filter=ai');
  assert.equal(ai.querySelector('a').textContent, 'Its page, where you can ask for a removal (clankwall: AI flags)');
  assert.equal(all.querySelector('a').getAttribute('href'), 'https://clankwall.vogel.dev/');
  assert.equal(ai.querySelector('button'), null, 'a built-in list has no Remove');
  // Export and Import are still there.
  assert.ok(s.$('exportSettings') && s.$('file'));
});

test('settings page: switching All flags on writes settings.lists and keeps the rest', async () => {
  const s = loadSettings({ 'xsh:settings': { allowlist: 'friend', lists: { 'clankwall-ai': true } } });
  await settle();
  flip(s, 'clankwall-all', true);
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'], { allowlist: 'friend', lists: { 'clankwall-ai': true, 'clankwall-all': true } });
  assert.equal(s.document.getElementById('list-clankwall-all').checked, true);
  assert.equal(stat(s, 'clankwall-all'), 'Not downloaded yet');
  flip(s, 'clankwall-all', false);
  await settle();
  assert.equal(s.chrome.store['xsh:settings'].lists['clankwall-all'], false);
});

test('settings page: the AI switch is checked and disabled while muting is on, and says why', async () => {
  const s = loadSettings({ 'xsh:settings': { muteEnabled: true, muteAccount: ME, lists: { 'clankwall-ai': false } } });
  await settle();
  const box = s.document.getElementById('list-clankwall-ai');
  assert.equal(box.checked, true);
  assert.equal(box.disabled, true);
  assert.equal(s.$('lock-clankwall-ai').textContent, 'Stays on while muting is on');
  assert.equal(box.getAttribute('aria-describedby'), 'stat-clankwall-ai lock-clankwall-ai');
  assert.match(rowOf(s, 'clankwall-ai').textContent, /Muting uses this list\./);
  assert.equal(s.$('lock-clankwall-all'), null);
  assert.equal(s.document.getElementById('list-clankwall-all').disabled, false);
  // Even a change event writes nothing.
  box.checked = false;
  box.dispatchEvent(new s.document.defaultView.Event('change'));
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'].lists, { 'clankwall-ai': false });
  assert.equal(s.document.getElementById('list-clankwall-ai').checked, true);
  assert.equal(s.document.getElementById('listMsg').textContent, 'Muting uses this list, so it stays on while muting is on.');
});

test('settings page: Add refuses http://, and a good address adds an entry that the background then fetches', async () => {
  const s = loadSettings({ 'xsh:settings': { allowlist: 'friend' } });
  await settle();
  // The form waits behind its button.
  assert.equal(s.$('addForm').hidden, true);
  assert.equal(s.$('addOpen').getAttribute('aria-expanded'), 'false');
  s.click('addOpen');
  assert.equal(s.$('addForm').hidden, false);
  assert.equal(s.$('addOpen').getAttribute('aria-expanded'), 'true');
  assert.equal(s.focused.at(-1), 'listUrl');
  const add = async (value) => {
    s.$('listUrl').value = value;
    s.submit('addForm');
    await settle();
  };
  await add('http://raw.example.com/list.txt');
  assert.equal(s.chrome.store['xsh:settings'].customLists, undefined);
  assert.match(s.$('listMsg').textContent, /starts with https:\/\//);
  assert.equal(s.$('listMsg').classList.contains('bad'), true);
  await add('https://raw.example.com/x/list.txt#top');
  const [mine, ...more] = s.chrome.store['xsh:settings'].customLists;
  assert.equal(more.length, 0);
  assert.deepEqual([mine.url, mine.on, /^u[a-z0-9]{1,16}$/.test(mine.id)], ['https://raw.example.com/x/list.txt', true, true]);
  assert.equal(s.chrome.store['xsh:settings'].allowlist, 'friend');
  assert.equal(s.$('listMsg').textContent, 'Added. Downloading it now.');
  assert.equal(s.$('listUrl').value, '');
  const row = rowOf(s, mine.id);
  // Titled by its file name, with the address under it.
  assert.equal(row.querySelector('label').textContent, 'list.txt');
  assert.equal(row.querySelector('.where').textContent, 'raw.example.com/x/list.txt');
  assert.equal(s.$(`rm-${mine.id}`).getAttribute('aria-label'), 'Remove list.txt');
  assert.equal(s.$('ownH').textContent, 'Added by you · 1 of 5');
  assert.equal(s.$('ownRows').hidden, false);
  // The same address again, and clankwall's own, are refused.
  await add('https://raw.example.com/x/list.txt');
  assert.match(s.$('listMsg').textContent, /already here/);
  await add('https://clankwall.vogel.dev/api/accounts.ndjson');
  assert.match(s.$('listMsg').textContent, /already here/);
  assert.equal(s.chrome.store['xsh:settings'].customLists.length, 1);
});

// A failed download's note: what went wrong, what to do, and the reason as reported.
const failNote = (s, id) => {
  const f = rowOf(s, id).querySelector('.fail');
  return f && { what: f.querySelector('strong').textContent, text: f.querySelector('p').textContent, reported: f.querySelector('.reported').textContent };
};

test('settings page: an added list shows its error, what to do, and Remove; Remove drops the entry', async () => {
  const mine = { id: 'uabc', url: 'https://raw.example.com/x/list.txt', on: true };
  const s = loadSettings({
    'xsh:settings': { customLists: [mine, { id: 'udef', url: 'https://b.example/l.txt', on: true }] },
    'xsh:list:uabc': record([], mine.url, { fetchedAt: 0, lastError: 'network error: Failed to fetch' }),
    'xsh:list:udef': record(['h1'], 'https://b.example/l.txt', { lastError: 'HTTP 404' }),
  });
  await settle();
  const a = rowOf(s, 'uabc');
  assert.equal(stat(s, 'uabc'), 'Download failed');
  assert.equal(s.$('stat-uabc').classList.contains('bad'), true);
  assert.deepEqual(failNote(s, 'uabc'), {
    what: 'The extension could not read the file at this address.',
    text:
      'The extension could not read the file at this address. Its host may not let other sites read it, or you may be offline. ' +
      'A raw GitHub or Gist link to the same file works.',
    reported: 'Reported: network error: Failed to fetch',
  });
  assert.ok(s.$('retry-uabc'), 'a failed list has Try again');
  // udef still has the copy from its last good download.
  assert.equal(stat(s, 'udef'), '1 account · last download failed');
  assert.deepEqual(failNote(s, 'udef'), {
    what: 'Nothing is at that address any more.',
    text:
      'Nothing is at that address any more. Check the address. To change it, remove this list and add the right one. ' +
      'Until then it hides the 1 account from the last good download.',
    reported: 'Reported: HTTP 404',
  });
  assert.equal(s.$('summary').textContent, 'Hiding replies from 1 account on 4 lists. 2 lists need a look.');
  assert.equal(a.querySelector('a'), null, 'an added list has no About link');
  s.click('rm-uabc');
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'].customLists.map((c) => c.id), ['udef']);
  assert.deepEqual(rows(s).map((r) => r.getAttribute('data-list')), ['recommended', 'clankwall-ai', 'clankwall-all', 'levelsio', 'udef']);
  // Undo takes the removed row's place, and focus.
  const first = s.document.querySelector('#ownRows li');
  assert.equal(first.hasAttribute('data-undo'), true);
  assert.equal(first.textContent, 'Removed list.txt.Undo');
  assert.equal(s.$('listMsg').textContent, 'Removed list.txt. Undo is in its place for 10 seconds.');
  assert.equal(s.focused.at(-1), 'undo');
  assert.deepEqual(s.timers.due.map((t) => t.ms), [10000]);
});

test('settings page: the card draws again when a list record changes, and builds names as text', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = loadSettings({ 'xsh:settings': { customLists: [{ id: 'uabc', url: `https://a.example/${encodeURI(evil)}`, on: true }] } });
  await settle();
  assert.equal(s.document.querySelector('#listRows img'), null);
  assert.equal(rowOf(s, 'uabc').querySelector('label').textContent, evil, 'the file name, decoded, as text');
  assert.equal(rowOf(s, 'uabc').querySelector('.where').textContent, 'a.example/%3Cimg%20src=x%20onerror=alert(1)%3E');
  assert.equal(stat(s, 'uabc'), 'Not downloaded yet');
  await s.chrome.storage.local.set({ 'xsh:list:uabc': record(['h1', 'h2'], 'https://a.example/x') });
  await settle();
  assert.equal(stat(s, 'uabc'), '2 accounts · updated just now');
});

const LISTS3 = [
  { id: 'uone', url: 'https://a.example/one.txt', on: true },
  { id: 'utwo', url: 'https://a.example/two.txt', on: false },
  { id: 'uthree', url: 'https://a.example/three.txt', on: true },
];

test('settings page: Undo puts a removed list back with its id, address, switch and place', async () => {
  const s = loadSettings({ 'xsh:settings': { allowlist: 'friend', customLists: LISTS3 } });
  await settle();
  s.click('rm-utwo');
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'].customLists, [LISTS3[0], LISTS3[2]]);
  assert.deepEqual([...s.document.querySelectorAll('#ownRows li')].map((li) => li.getAttribute('data-list') || 'undo'), ['uone', 'undo', 'uthree']);
  s.click('undo');
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'], { allowlist: 'friend', customLists: LISTS3 });
  assert.equal(s.$('listMsg').textContent, 'two.txt is back.');
  assert.equal(s.document.querySelector('#ownRows [data-undo]'), null);
  assert.equal(s.focused.at(-1), 'list-utwo');
  // A list that was on says it downloads again; the background fetches it as for any list switched on.
  s.click('rm-uone');
  await settle();
  s.click('undo');
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'].customLists, LISTS3);
  assert.equal(s.$('listMsg').textContent, 'one.txt is back. Downloading it again.');
});

test('settings page: Undo leaves after 10 seconds and the removal stands', async () => {
  const s = loadSettings({ 'xsh:settings': { customLists: LISTS3 } });
  await settle();
  s.click('rm-uthree');
  await settle();
  assert.ok(s.$('undo'));
  const [timer] = s.timers.due;
  assert.equal(timer.ms, 10000);
  timer.fn();
  await settle();
  assert.equal(s.$('undo'), null);
  assert.deepEqual(s.chrome.store['xsh:settings'].customLists, [LISTS3[0], LISTS3[1]]);
  assert.equal(s.focused.at(-1), 'addOpen', 'focus was on Undo, so it moves to Add when Undo goes');
  assert.equal(s.$('listMsg').textContent, 'Removed three.txt.', 'the message no longer offers Undo');
});

test('settings page: when Undo goes, focus anywhere else stays where it is', async () => {
  const s = loadSettings({ 'xsh:settings': { customLists: LISTS3 } });
  await settle();
  s.click('rm-uthree');
  await settle();
  // A click on plain text: focus leaves Undo for the page itself.
  s.document.activeElement.blur();
  assert.equal(s.document.activeElement === s.document.body, true, 'focus is on the page itself');
  const moves = s.focused.length;
  s.timers.due[0].fn();
  await settle();
  assert.equal(s.$('undo'), null);
  assert.equal(s.focused.length, moves, 'no focus moved');
  assert.equal(s.document.activeElement === s.document.body, true, 'focus is still on the page itself');
});

test('settings page: Undo, or a second removal, stops the earlier 10-second timer', async () => {
  const s = loadSettings({ 'xsh:settings': { customLists: LISTS3 } });
  await settle();
  s.click('rm-uone');
  await settle();
  s.click('undo');
  await settle();
  assert.deepEqual(s.timers.due.map((t) => !!t.cleared), [true], 'Undo stops its timer');
  s.click('rm-uone');
  await settle();
  s.click('rm-utwo');
  await settle();
  assert.deepEqual(s.timers.due.map((t) => !!t.cleared), [true, true, false], "the second removal stops the first one's timer");
  assert.deepEqual(
    [...s.document.querySelectorAll('#ownRows li')].map((li) => li.getAttribute('data-list') || li.textContent),
    ['Removed two.txt.Undo', 'uthree'],
    "only two.txt's Undo is left: one.txt's went with its timer",
  );
  assert.equal(s.$('listMsg').textContent, 'Removed two.txt. Undo is in its place for 10 seconds.');
});

// The page writes the whole settings object, so writes made close together
// must each start from the one before, or the last one puts back what an
// earlier one changed.
test('settings page: a change made while an earlier one is still being stored builds on it', async () => {
  const s = loadSettings({ 'xsh:settings': { allowlist: 'friend', customLists: LISTS3 } });
  await settle();
  s.click('rm-uone');
  flip(s, 'uthree', false);
  s.click('addOpen');
  s.$('listUrl').value = 'https://a.example/four.txt';
  s.submit('addForm');
  await settle();
  const saved = s.chrome.store['xsh:settings'];
  assert.deepEqual(
    saved.customLists.map((c) => [c.url, c.on]),
    [
      [LISTS3[1].url, false],
      [LISTS3[2].url, false],
      ['https://a.example/four.txt', true],
    ],
  );
  assert.equal(saved.allowlist, 'friend');
  s.click('undo');
  flip(s, 'utwo', true);
  await settle();
  assert.deepEqual(
    s.chrome.store['xsh:settings'].customLists.map((c) => [c.id === 'uone' ? 'uone' : c.url, c.on]),
    [
      ['uone', true],
      [LISTS3[1].url, true],
      [LISTS3[2].url, false],
      ['https://a.example/four.txt', true],
    ],
  );
});

test('settings page: Undo puts a list back as it was switched, even when Remove came before the switch was stored', async () => {
  const s = loadSettings({ 'xsh:settings': { customLists: LISTS3 } });
  await settle();
  const onOf = (id) => {
    const c = s.chrome.store['xsh:settings'].customLists.find((x) => x.id === id);
    return c ? c.on : 'gone';
  };
  assert.deepEqual([onOf('utwo'), onOf('uthree')], [false, true]);
  flip(s, 'uthree', false);
  s.click('rm-uthree');
  await settle();
  assert.equal(onOf('uthree'), 'gone');
  s.click('undo');
  await settle();
  assert.equal(onOf('uthree'), false, 'switched off, then removed: it comes back off');
  assert.equal(s.$('listMsg').textContent, 'three.txt is back.');
  flip(s, 'utwo', true);
  s.click('rm-utwo');
  await settle();
  s.click('undo');
  await settle();
  assert.equal(onOf('utwo'), true, 'switched on, then removed: it comes back on');
  assert.equal(s.$('listMsg').textContent, 'two.txt is back. Downloading it again.');
});

test('settings page: a redraw keeps focus on the switch it was on, and moves none while typing', async () => {
  const s = loadSettings({ 'xsh:settings': {} });
  await settle();
  const old = s.$('list-levelsio');
  old.focus();
  flip(s, 'levelsio', true);
  await settle();
  assert.equal(s.$('list-levelsio') === old, false, 'the row was drawn again');
  assert.equal(s.document.activeElement === s.$('list-levelsio'), true, 'focus is on the new switch');
  s.click('addOpen');
  s.$('listUrl').value = 'https://a.exa';
  const moves = s.focused.length;
  await s.chrome.storage.local.set({ 'xsh:list': record(['h1'], AI_URL) });
  await settle();
  assert.equal(stat(s, 'clankwall-ai'), '1 account · updated just now', 'it drew again');
  assert.equal(s.focused.length, moves, 'a record arriving moves no focus');
  assert.equal(s.document.activeElement.id, 'listUrl');
  assert.equal(s.$('listUrl').value, 'https://a.exa');
});

test('settings page: where focus goes after Try again is used up by the next draw, even when its list is gone', async () => {
  const url = 'https://a.example/one.txt';
  const entry = { id: 'uone', url, on: true };
  const s = loadSettings({
    'xsh:settings': { customLists: [entry] },
    'xsh:list:uone': record([], url, { fetchedAt: 0, lastAttemptAt: 1, lastError: 'HTTP 500' }),
  });
  await settle();
  // Another tab removes the list while this tab's Try again is running.
  s.chrome.runtime.sendMessage = async () => {
    await s.chrome.storage.local.set({ 'xsh:settings': { customLists: [] } });
    return { ok: false, reason: 'HTTP 500', count: 0 };
  };
  s.click('retry-uone');
  await settle();
  assert.equal(s.$('list-uone'), null);
  assert.equal(s.document.activeElement === s.document.body, true, 'focus went with the row');
  const moves = s.focused.length;
  // That tab's Undo puts the list back; focus is still on the page itself.
  await s.chrome.storage.local.set({ 'xsh:settings': { customLists: [entry] } });
  await settle();
  assert.equal(s.$('retry-uone') === null, false, 'the row is back with its Try again');
  assert.equal(s.focused.length, moves, 'the old target does not pull focus on this later draw');
});

test('settings page: Undo is refused when the address is back already or five lists are added', async () => {
  const s = loadSettings({ 'xsh:settings': { customLists: LISTS3 } });
  await settle();
  s.click('rm-uone');
  await settle();
  s.$('listUrl').value = LISTS3[0].url;
  s.submit('addForm');
  await settle();
  const now = s.chrome.store['xsh:settings'].customLists;
  assert.equal(now.length, 3);
  s.click('undo');
  await settle();
  assert.equal(s.$('listMsg').textContent, 'one.txt is already here.');
  assert.equal(s.$('listMsg').classList.contains('bad'), true);
  assert.deepEqual(s.chrome.store['xsh:settings'].customLists, now, 'nothing written');

  const five = [1, 2, 3, 4, 5].map((n) => ({ id: `u${n}`, url: `https://a.example/${n}.txt`, on: true }));
  const t = loadSettings({ 'xsh:settings': { customLists: five } });
  await settle();
  t.click('rm-u2');
  await settle();
  t.$('listUrl').value = 'https://a.example/6.txt';
  t.submit('addForm');
  await settle();
  const full = t.chrome.store['xsh:settings'].customLists;
  assert.equal(full.length, 5);
  t.click('undo');
  await settle();
  assert.equal(t.$('listMsg').textContent, '2.txt could not go back: 5 lists are added. Remove one first.');
  assert.deepEqual(t.chrome.store['xsh:settings'].customLists, full, 'nothing written');
});

test('settings page: Try again asks the background to download the lists again and says how it went', async () => {
  const url = 'https://a.example/one.txt';
  const s = loadSettings({
    'xsh:settings': { customLists: [{ id: 'uone', url, on: true }] },
    'xsh:list:uone': record([], url, { fetchedAt: 0, lastAttemptAt: 1, lastError: 'HTTP 500' }),
  });
  const sent = [];
  let answer;
  s.chrome.runtime.sendMessage = (msg) => {
    sent.push(msg);
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  await settle();
  s.click('retry-uone');
  await settle();
  assert.deepEqual(sent.map((m) => JSON.stringify(m)), ['{"type":"xsh:refresh"}'], 'the message is made in the page, so compared as JSON');
  assert.equal(s.$('listMsg').textContent, 'Downloading the lists that are on again…');
  assert.equal(stat(s, 'uone'), 'Downloading…');
  assert.equal(s.$('retry-uone').getAttribute('aria-disabled'), 'true');
  assert.equal(s.$('retry-uone').disabled, false, 'never disabled, so it keeps focus');
  s.click('retry-uone');
  await settle();
  assert.equal(sent.length, 1, 'one download at a time');
  // The background stores the new attempt before it answers.
  await s.chrome.storage.local.set({ 'xsh:list:uone': record([], url, { fetchedAt: 0, lastError: 'HTTP 500' }) });
  answer({ ok: false, reason: 'HTTP 500', count: 0 });
  await settle();
  assert.equal(s.$('listMsg').textContent, 'It failed again. The note under the list says what to try.');
  assert.equal(s.$('listMsg').classList.contains('bad'), true);
  assert.equal(stat(s, 'uone'), 'Download failed');
  assert.equal(s.$('retry-uone').hasAttribute('aria-disabled'), false);
  assert.equal(s.focused.at(-1), 'retry-uone');

  s.click('retry-uone');
  await settle();
  await s.chrome.storage.local.set({ 'xsh:list:uone': record(['h1'], url) });
  answer({ ok: true, reason: null, count: 1 });
  await settle();
  assert.equal(s.$('listMsg').textContent, 'Downloaded. Every list that is on is up to date.');
  assert.equal(stat(s, 'uone'), '1 account · updated just now');
  assert.equal(s.$('retry-uone'), null);
  assert.equal(s.focused.at(-1), 'list-uone', 'Try again is gone, so focus goes to the switch');
});

test('settings page: Try again that cannot reach the background says so', async () => {
  const url = 'https://a.example/one.txt';
  const s = loadSettings({
    'xsh:settings': { customLists: [{ id: 'uone', url, on: true }] },
    'xsh:list:uone': record([], url, { fetchedAt: 0, lastError: 'HTTP 500' }),
  });
  s.chrome.runtime.sendMessage = async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  await settle();
  s.click('retry-uone');
  await settle();
  assert.equal(s.$('listMsg').textContent, 'The download could not start: Could not establish connection. Receiving end does not exist.');
  assert.equal(s.$('listMsg').classList.contains('bad'), true);
  assert.equal(stat(s, 'uone'), 'Download failed');
});

// The background answers ok:false with a reason both when a list failed and
// when the refresh itself threw; the list's own record tells them apart.
test('settings page: Try again tells a download that did not run from another list failing', async () => {
  const url = 'https://a.example/one.txt';
  const s = loadSettings({
    'xsh:settings': { customLists: [{ id: 'uone', url, on: true }] },
    'xsh:list:uone': record([], url, { fetchedAt: 0, lastAttemptAt: 1, lastError: 'HTTP 500' }),
  });
  let reply;
  s.chrome.runtime.sendMessage = async () => reply();
  await settle();
  // refresh() threw before any list was tried: background.js answers { ok: false, reason: String(e) }.
  reply = () => ({ ok: false, reason: 'Error: QUOTA_BYTES quota exceeded' });
  s.click('retry-uone');
  await settle();
  assert.equal(s.$('listMsg').textContent, 'The download did not finish: Error: QUOTA_BYTES quota exceeded.');
  assert.equal(s.$('listMsg').classList.contains('bad'), true);
  // This list came down; another list that is on did not.
  reply = async () => {
    await s.chrome.storage.local.set({ 'xsh:list:uone': record(['h1'], url) });
    return { ok: false, reason: 'clankwall: AI flags: HTTP 503', count: 1 };
  };
  s.click('retry-uone');
  await settle();
  assert.equal(s.$('listMsg').textContent, 'This list downloaded. Another list that is on failed; the note under it says what to try.');
  assert.equal(stat(s, 'uone'), '1 account · updated just now');
});

test('settings page: two added lists with the same file name are told apart by their addresses', async () => {
  const lists = [
    { id: 'ua', url: 'https://gist.githubusercontent.com/one/abc/raw/list.txt', on: true },
    { id: 'ub', url: 'https://gist.githubusercontent.com/two/def/raw/list.txt', on: false },
  ];
  const s = loadSettings({ 'xsh:settings': { customLists: lists } });
  await settle();
  for (const { id, url } of lists) {
    assert.equal(rowOf(s, id).querySelector('label').textContent, 'list.txt');
    assert.equal(s.$(`where-${id}`).textContent, url.slice('https://'.length));
    assert.equal(s.$(`list-${id}`).getAttribute('aria-describedby'), `where-${id} stat-${id}`);
    assert.equal(s.$(`rm-${id}`).getAttribute('aria-describedby'), `where-${id}`);
  }
  assert.equal(s.$('list-levelsio').getAttribute('aria-describedby'), 'stat-levelsio', 'a built-in list has no address line');
});

test('settings page: a built-in list that came back too short or too big says when it tries again', async () => {
  const hour = 60 * 60e3;
  const s = loadSettings({
    'xsh:settings': { lists: { levelsio: true, 'clankwall-all': true } },
    'xsh:list:levelsio': record(['a1', 'a2', 'a3'], 'https://blockedforaireply.levels.io/api/usernames.txt', {
      fetchedAt: Date.now() - hour,
      lastError: 'list shrank from 3 to 1',
    }),
    [ALL_KEY]: record([], ALL_URL, { fetchedAt: 0, lastError: 'feed larger than 1000000 bytes' }),
  });
  await settle();
  assert.equal(
    failNote(s, 'levelsio').text,
    'The new copy was much shorter than the last one, so it was not used. It tries again at its next refresh, or press Try again. ' +
      'Until then it hides the 3 accounts from the last good download.',
  );
  assert.equal(failNote(s, 'clankwall-all').text, 'The list is bigger than the extension reads. It tries again within 6 hours, or press Try again.');
});

test('settings page: a file picked while another is still being read wins', async () => {
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { extraList: '' } });
  await settle();
  let finish;
  const slow = { name: 'a.txt', size: 8, text: () => new Promise((resolve) => (finish = resolve)) };
  Object.defineProperty(p.$('file'), 'files', { configurable: true, value: [slow] });
  p.$('file').dispatchEvent(new p.document.defaultView.Event('change'));
  p.pickFile('b.txt', 'spam_b\n');
  await settle();
  finish('spam_a\n');
  await settle();
  assert.equal(p.$('fileKind').textContent, 'b.txt: a list of 1 handle, for Also hide');
  assert.deepEqual(p.changes(), ['Also hide gains 1 account: @spam_b.']);
  p.click('confirm');
  await settle();
  assert.equal(p.chrome.store['xsh:settings'].extraList, 'spam_b');
});

test('settings page: an address typed while the last one is being added stays', async () => {
  const s = loadSettings({ 'xsh:settings': {} });
  await settle();
  s.click('addOpen');
  s.$('listUrl').value = 'https://a.example/one.txt';
  s.submit('addForm');
  s.$('listUrl').value = 'https://a.example/tw';
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'].customLists.map((c) => c.url), ['https://a.example/one.txt']);
  assert.equal(s.$('listUrl').value, 'https://a.example/tw');
});

// A built-in list that has a copy keeps hiding it after a failed download. The
// alarm tries a list again only once it is due, so its note promises no time.
test('settings page: a failed built-in list says when it tries again, and a stale one keeps its copy', async () => {
  const hour = 60 * 60e3;
  const s = loadSettings({
    'xsh:settings': { lists: { levelsio: true, 'clankwall-all': true } },
    'xsh:list:levelsio': record(['a1', 'a2', 'a3'], 'https://blockedforaireply.levels.io/api/usernames.txt', { fetchedAt: Date.now() - hour, lastError: 'HTTP 503' }),
    [ALL_KEY]: record([], ALL_URL, { fetchedAt: 0, lastError: 'network error: Failed to fetch' }),
  });
  await settle();
  assert.equal(stat(s, 'levelsio'), '3 accounts · last download failed');
  assert.deepEqual(failNote(s, 'levelsio'), {
    what: "The list's site answered with an error.",
    text: "The list's site answered with an error. It tries again at its next refresh, or press Try again. Until then it hides the 3 accounts from the last good download.",
    reported: 'Reported: HTTP 503',
  });
  assert.equal(stat(s, 'clankwall-all'), 'Download failed');
  assert.deepEqual(failNote(s, 'clankwall-all'), {
    what: "The list's site could not be reached.",
    text: "The list's site could not be reached. You may be offline, or the site may be down. It tries again within 6 hours, or press Try again.",
    reported: 'Reported: network error: Failed to fetch',
  });
  assert.equal(failNote(s, 'clankwall-ai'), null, 'not downloaded yet is not a failure');
  assert.equal(stat(s, 'clankwall-ai'), 'Not downloaded yet');
  assert.equal(s.$('summary').textContent, 'Hiding replies from 3 accounts on 4 lists. 2 lists need a look.');
  // Switched off, a list shows no failure.
  flip(s, 'clankwall-all', false);
  await settle();
  assert.equal(stat(s, 'clankwall-all'), 'Off');
  assert.equal(failNote(s, 'clankwall-all'), null);
});

// Every reason lib's fetchList gives has its own plain words and next step.
test('settings page: every download failure reason gets its own explanation', async () => {
  const cases = [
    ['HTTP 404', 'Nothing is at that address any more.', 'Check the address.'],
    ['HTTP 410', 'Nothing is at that address any more.', 'Check the address.'],
    ['HTTP 500', "The list's site answered with an error.", 'It tries again within 6 hours, or press Try again.'],
    ['unexpected content-type text/html', 'That address opens a web page, not a list.', 'on GitHub, the Raw button'],
    ['feed is mostly not handles (7 invalid lines)', "The file there isn't a list of X handles.", 'one handle per line'],
    ['empty list', "The file there isn't a list of X handles.", 'one handle per line'],
    ['list shrank from 100 to 10', 'The new copy was much shorter than the last one, so it was not used.', 'remove it and add it again'],
    ['feed larger than 1000000 bytes', 'The list is bigger than the extension reads.', 'Ask its owner for a smaller file'],
    ['too many handles', 'The list is bigger than the extension reads.', 'Ask its owner for a smaller file'],
    ['read error: aborted', 'The download could not be used.', 'It tries again within 6 hours, or press Try again.'],
  ];
  const customLists = cases.slice(0, 5).map((c, i) => ({ id: `u${i}`, url: `https://a.example/${i}.txt`, on: true }));
  for (let start = 0; start < cases.length; start += 5) {
    const chunk = cases.slice(start, start + 5);
    const store = { 'xsh:settings': { customLists } };
    chunk.forEach(([reason], i) => {
      store[`xsh:list:u${i}`] = record([], customLists[i].url, { fetchedAt: 0, lastError: reason });
    });
    const s = loadSettings(store);
    await settle();
    chunk.forEach(([reason, what, next], i) => {
      const n = failNote(s, `u${i}`);
      assert.equal(n.what, what, reason);
      assert.ok(n.text.includes(next), `${reason}: ${n.text}`);
      assert.equal(n.reported, `Reported: ${reason}`);
    });
  }
});

test('settings page: the summary says when no list is on and when hiding is paused', async () => {
  const off = loadSettings({ 'xsh:settings': { lists: { 'clankwall-ai': false, recommended: false } } });
  await settle();
  assert.equal(off.$('summary').textContent, 'No list is on.');
  const paused = loadSettings({ 'xsh:list': record(['h1'], AI_URL), 'xsh:settings': { paused: true } });
  await settle();
  assert.equal(paused.$('summary').textContent, 'Hiding is paused in the popup. When it is on, it hides replies from 1 account on 2 lists.');
});

test('settings page: an open About stays open when the lists draw again', async () => {
  const s = loadSettings({ 'xsh:settings': {} });
  await settle();
  const d = rowOf(s, 'levelsio').querySelector('details');
  d.setAttribute('open', '');
  d.dispatchEvent(new s.document.defaultView.Event('toggle'));
  flip(s, 'clankwall-all', true);
  await settle();
  assert.equal(rowOf(s, 'levelsio').querySelector('details').hasAttribute('open'), true);
  assert.equal(rowOf(s, 'clankwall-ai').querySelector('details').hasAttribute('open'), false);
});

test('settings page: importing still gets only the AI list handles', async () => {
  const s = loadSettings({
    'xsh:list': record(['aionly'], AI_URL),
    [ALL_KEY]: record(['spamonly'], ALL_URL),
    'xsh:settings': { lists: ALL_ON, muteEnabled: true, muteAccount: ME },
  });
  await settle();
  s.pickFile('shared.txt', 'aionly\nspamonly\n');
  await settle();
  const t = s.changes().join(' ');
  assert.match(t, /Also hide gains 2 accounts/);
  assert.equal(s.$('muteNote').textContent.includes('@spamonly'), true, 'only the AI list is already muted, so the other is new');
  assert.equal(s.$('muteNote').textContent.includes('@aionly'), false);
});

test('lists, fetching: a new AI list address while a fetch of the old one is out is fetched after it, and only its result is kept', async () => {
  const pending = [];
  const bg = withOldValues(loadBackground((url) => new Promise((resolve) => pending.push({ url, resolve }))));
  Object.assign(bg.chrome.store, { 'xsh:settings': {} });
  const one = 'https://one.example/list.txt';
  const two = 'https://two.example/list.txt';
  await bg.chrome.storage.local.set({ 'xsh:settings': { feedUrl: one } });
  await settle();
  assert.deepEqual(pending.map((p) => p.url), [one]);
  await bg.chrome.storage.local.set({ 'xsh:settings': { feedUrl: two } });
  await settle();
  assert.deepEqual(pending.map((p) => p.url), [one], 'the new address waits for the fetch in flight');
  pending[0].resolve(ok('old1\nold2\n'));
  await settle();
  assert.deepEqual(pending.map((p) => p.url), [one, two]);
  assert.equal('xsh:list' in bg.chrome.store, false, "the old address's result is not kept");
  pending[1].resolve(ok('new1\nnew2\n'));
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].source, two);
  assert.deepEqual(bg.chrome.store['xsh:list'].handles, ['new1', 'new2']);
});

test('settings page: the lists message sits inside a live region that is always there', async () => {
  const s = loadSettings({ 'xsh:settings': {} });
  await settle();
  const msg = s.$('listMsg');
  assert.equal(msg.hasAttribute('role'), false);
  assert.equal(msg.parentElement.getAttribute('role'), 'status');
  assert.equal(msg.parentElement.hasAttribute('hidden'), false);
});

// ------------------------------------------------- Recommended (#79)

const LV_ND = 'https://blockedforaireply.levels.io/api/accounts.ndjson';
const CR_ND = 'https://ai-anti-slop.startupbros.com/v1/list.ndjson';
const REC_KEY = 'xsh:list:recommended';
const lvRow = (username, tier = 'confirmed') =>
  JSON.stringify({ username, levelsio: tier, evidence: tier === 'confirmed' ? [{ text: 'AI bot' }] : [] });
const lvBody = (names, extra = []) => [...names.map((n) => lvRow(n)), ...extra.map((n) => lvRow(n, 'blocked'))].join('\n');
const recRecord = (aiPart, lvPart, extra = {}) =>
  record([...new Set([...aiPart, ...lvPart])].sort(), LV_ND, { parts: [{ source: AI_URL, handles: aiPart }, { source: LV_ND, handles: lvPart }], ...extra });

test('Recommended: an update with one source refused reads as part of a refresh failing, not as a failed list, in the popup and on the settings page', async () => {
  const at = Date.now();
  const store = {
    'xsh:list': record(['aionly'], AI_URL),
    [REC_KEY]: recRecord(['aionly'], ['lv_b'], { lastError: 'ai-anti-slop.startupbros.com: network error: Failed to fetch', partial: true }),
    'xsh:settings': {},
  };
  const p = loadPopup(store);
  await settle();
  assert.equal(p.document.getElementById('err').textContent, 'Recommended: part of the last refresh failed (just now): ai-anti-slop.startupbros.com: network error: Failed to fetch. The rest updated.');
  const s = loadSettings(structuredClone(store));
  await settle();
  assert.equal(stat(s, 'recommended'), '2 accounts · updated just now · a source failed');
  assert.equal(s.$('stat-recommended').classList.contains('bad'), false);
  assert.deepEqual(failNote(s, 'recommended'), {
    what: 'Not every one of its sources could be downloaded. The rest updated.',
    text: 'Not every one of its sources could be downloaded. The rest updated. A source that failed keeps its last good copy until a download of it works. It tries again at its next refresh, or press Try again.',
    reported: 'Reported: ai-anti-slop.startupbros.com: network error: Failed to fetch',
  });
  // Every source failing is still a failed refresh.
  const all = loadPopup({ ...structuredClone(store), [REC_KEY]: recRecord(['aionly'], ['lv_b'], { fetchedAt: at - 3600e3, lastError: 'clankwall.vogel.dev: HTTP 503; blockedforaireply.levels.io: HTTP 503' }) });
  await settle();
  assert.equal(all.document.getElementById('err').textContent, 'Recommended: last refresh failed (just now): clankwall.vogel.dev: HTTP 503; blockedforaireply.levels.io: HTTP 503. Still using the previous list.');
});

test('Recommended: on by default, so install fetches its three files and stores each part; a part that halves keeps its old copy', async () => {
  const lv = Array.from({ length: 24 }, (_, i) => `lv${String(i).padStart(2, '0')}`);
  let body = lvBody(lv, ['old_block']);
  // The readers' list is empty, as it is until reports agree.
  const bg = loadBackground((url) => ok(url === AI_URL ? 'aionly\nboth\n' : url === LV_ND ? body : url === CR_ND ? '' : 'nope'));
  bg.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  // AI flags is on too, so clankwall's file is fetched once for each list.
  assert.deepEqual(bg.requests.map((r) => r.url).sort(), [AI_URL, AI_URL, LV_ND, CR_ND].sort());
  const rec = bg.chrome.store[REC_KEY];
  assert.deepEqual(rec.handles, ['aionly', 'both', ...lv]);
  assert.deepEqual(rec.parts, [
    { source: AI_URL, handles: ['aionly', 'both'] },
    { source: LV_ND, handles: lv },
    { source: CR_ND, handles: [] },
  ]);
  assert.deepEqual([rec.source, rec.lastError, rec.seq], [LV_ND, null, 1]);
  assert.deepEqual(bg.chrome.store['xsh:list'].handles, ['aionly', 'both']);
  // levelsio's part falls from 24 to 4; clankwall's is unchanged.
  body = lvBody(lv.slice(0, 4));
  assert.deepEqual(await reply(send(bg, { type: 'xsh:refresh' }, undefined)), {
    ok: false,
    reason: 'Recommended: blockedforaireply.levels.io: list shrank from 24 to 4',
    count: 26,
  });
  // The update is stored (clankwall's part read again), with levelsio's part as it was.
  const kept = bg.chrome.store[REC_KEY];
  assert.deepEqual([kept.handles, kept.parts, kept.seq], [rec.handles, rec.parts, 2]);
  assert.equal(kept.lastError, 'blockedforaireply.levels.io: list shrank from 24 to 4');
  assert.equal(kept.partial, true);
  // Switched off, it is not fetched.
  const off = loadBackground((url) => ok(url === AI_URL ? 'aionly\nboth\n' : body));
  off.chrome.store['xsh:settings'] = { lists: { recommended: false } };
  off.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.deepEqual(off.requests.map((r) => r.url), [AI_URL]);
  assert.equal(REC_KEY in off.chrome.store, false);
});

test('Recommended: a label names the host of the file that holds the account, and Recommended once', async () => {
  const bg = labelBackground({
    settings: { labeling: true },
    handles: ['aionly'],
    source: AI_URL,
    store: { [REC_KEY]: recRecord(['aionly'], ['reply_a', 'lv_b']) },
  });
  assert.deepEqual(await reply(send(bg, LABEL_MSG, 7)), { ok: true, label: 'slop', added: 'extraList' });
  const rec = bg.chrome.store['xsh:label:2'];
  assert.deepEqual([rec.list, rec.lists, rec.hidden], ['blockedforaireply.levels.io', ['recommended'], true]);
  // An account in clankwall's file names clankwall, under both lists that hold it.
  const ai = labelBackground({
    settings: { labeling: true },
    handles: ['reply_a'],
    source: AI_URL,
    store: { [REC_KEY]: recRecord(['reply_a'], ['lv_b']) },
  });
  await reply(send(ai, LABEL_MSG, 7));
  const both = ai.chrome.store['xsh:label:2'];
  assert.deepEqual([both.list, both.lists], ['clankwall.vogel.dev', ['recommended', 'clankwall-ai']]);
});

test('Recommended: the settings page shows it first and on, with its note and a removal link for each site', async () => {
  const s = loadSettings({
    'xsh:list': record(['aionly', 'both'], AI_URL),
    [REC_KEY]: recRecord(['aionly', 'both'], ['lv_a', 'lv_b', 'lv_c']),
    'xsh:settings': {},
  });
  await settle();
  assert.equal(rows(s)[0].getAttribute('data-list'), 'recommended');
  const rec = rowOf(s, 'recommended');
  assert.equal(rec.querySelector('label').textContent, 'Recommended');
  assert.equal(rec.querySelector('input').checked, true);
  assert.equal(rec.querySelector('input').disabled, false);
  assert.equal(stat(s, 'recommended'), '5 accounts · updated just now');
  assert.equal(s.$('summary').textContent, 'Hiding replies from 5 accounts on 2 lists.');
  assert.equal(rec.querySelector('details summary').textContent, 'About Recommended');
  assert.match(rec.textContent, /AI Anti-Slop's pick: clankwall's AI flags; the accounts @levelsio blocked with a public reply, each linked on levelsio's page; and the readers' list, the accounts three or more AI Anti-Slop readers who share their labels reported as slop\. Both sites say their flags are not proof, and the readers' list counts reports, which are not proof either\. Hides replies only; muting uses clankwall's AI flags\./);
  assert.deepEqual(
    [...rec.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('target'), a.getAttribute('rel')]),
    [
      ['https://clankwall.vogel.dev/?filter=ai', "clankwall's page, where you can ask for a removal", '_blank', 'noopener'],
      ['https://blockedforaireply.levels.io/', "levelsio's page, where you can ask for a removal", '_blank', 'noopener'],
      ['https://ai-anti-slop.startupbros.com/', "The readers' list page, with how it is made and where you can ask for a removal", '_blank', 'noopener'],
    ],
  );
  assert.equal(rec.querySelector('button'), null, 'a built-in list has no Remove');
  // Switching it off is stored like any built-in's switch.
  flip(s, 'recommended', false);
  await settle();
  assert.deepEqual(s.chrome.store['xsh:settings'], { lists: { recommended: false } });
  assert.equal(stat(s, 'recommended'), 'Off');
  assert.equal(s.$('summary').textContent, 'Hiding replies from 2 accounts on 1 list.');
});

test('Recommended: in the default state the popup counts both lists', async () => {
  const p = loadPopup({
    'xsh:list': record(['aionly', 'both'], AI_URL),
    [REC_KEY]: recRecord(['aionly', 'both'], ['lv_a']),
    'xsh:settings': {},
  });
  await settle();
  const text = (id) => p.document.getElementById(id).textContent;
  assert.equal(text('list'), '3 accounts on 2 lists');
  assert.equal(text('listAge'), 'From 2 lists, oldest updated just now');
  assert.equal(p.document.getElementById('err').hidden, true);
});

test('Recommended, muting: with it on by default, an account only in levelsio\'s part is never noted, visited or waited on, and one muted before is unmuted', async () => {
  const extra = { [REC_KEY]: recRecord(['aionly', 'both'], ['lvonly']) };
  // lists {}: Recommended on by default, All flags off.
  const bg = await twoListBackground({ lists: {}, extra });
  await send(bg, { type: 'xsh:sighting', handle: 'lvonly' }, 7);
  assert.equal(bg.chrome.store['xsh:mutes'], undefined, 'nothing written to the mute record');
  const urls = [];
  for (let i = 0; i < 3; i++) {
    await alarm(bg);
    const tab = lastTab(bg);
    urls.push(tab.url);
    if (tab.url.endsWith('/muted/all')) break;
    await answer(bg, { status: 'muted' });
    due(bg);
  }
  assert.deepEqual(urls, ['https://x.com/aionly', 'https://x.com/both', 'https://x.com/settings/muted/all']);
  assert.equal(bg.chrome.store['xsh:mutes'].handles.lvonly, undefined);
  // Run now waits on the same number with Recommended on as with it off.
  const on = await twoListBackground({ lists: {}, extra, timers: fakeTimers() });
  const off = await twoListBackground({ lists: { recommended: false }, extra, timers: fakeTimers() });
  assert.deepEqual(await runOn(on), { ok: true, waiting: 2 });
  assert.deepEqual(await runOn(off), { ok: true, waiting: 2 });
  await settle();
  assert.equal(lastTab(on).url, 'https://x.com/aionly');
  // An account it muted that is only in levelsio's part is unmuted.
  const was = await twoListBackground({ lists: {}, extra: { ...extra, 'xsh:mutes': { ...lib.emptyMutes(), handles: { lvonly: mutedAs(ME) } } } });
  await alarm(was);
  const tab = lastTab(was);
  assert.equal(tab.url, 'https://x.com/lvonly');
  const job = await send(was, { type: 'xsh:job' }, tab.id);
  assert.deepEqual([job.kind, job.handle], ['unmute', 'lvonly']);
});

// --------------------------------------------------- Sharing labels (#81)

const CROWD = 'https://ai-anti-slop.startupbros.com';
const SKEY = 'fedcba9876543210fedcba9876543210';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body) });
const isPost = (r) => !!(r.init && r.init.method && r.init.method !== 'GET');
const settleLong = async () => {
  for (let i = 0; i < 40; i++) await tick();
};
const OTHER_MSG = { type: 'xsh:label', label: 'not_slop', handle: 'other', url: '/other/status/3', page: null, text: '' };
const takeAll = (path, body) =>
  path === '/v1/reports'
    ? json(200, { ok: true, accepted: body.reports.map((r) => r.status), rejected: [], deferred: [] })
    : json(200, { ok: true, removed: path === '/v1/retract' ? body.statuses.length : 0 });

// A background whose AI Anti-Slop server answers answer(path, body) to every
// POST; every list it downloads is empty.
function shareBackground({ settings = { labeling: true }, store = {}, answer = () => assert.fail('posted') } = {}) {
  let bg = null;
  bg = loadBackground((url) => {
    const req = bg.requests[bg.requests.length - 1];
    if (isPost(req)) {
      assert.ok(url.startsWith(`${CROWD}/v1/`), `posted to ${url}`);
      return answer(url.slice(CROWD.length), JSON.parse(req.init.body));
    }
    return ok('');
  });
  bg.chrome.store['xsh:list'] = { handles: [], fetchedAt: Date.now(), source: 's' };
  bg.chrome.store['xsh:settings'] = settings;
  Object.assign(bg.chrome.store, structuredClone(store));
  return bg;
}

test('sharing (planted negative): while it is off nothing is posted, not for a label, a cleared label, Delete all labels, the share alarm, an update or a browser start', async () => {
  // The switch is the sharing record's on: absent, false, not exactly true, or
  // a sharing field in settings (which is not the switch) all leave it off.
  const offs = [
    [{ labeling: true }, {}],
    [{ labeling: true }, { on: false }],
    [{ labeling: true }, { on: 'true' }],
    [{ labeling: true }, { on: 1 }],
    [{ labeling: true, sharing: true }, {}],
  ];
  for (const [settings, on] of offs) {
    // A queue left over from when it was on.
    const left = { ...on, key: SKEY, queue: [{ op: 'report', label: 'slop', handle: 'reply_a', status: '9', thread: null, hash: null, seq: 1 }], seq: 1, sent: 2 };
    const bg = shareBackground({ settings, store: { 'xsh:share': left } });
    assert.equal((await reply(send(bg, LABEL_MSG, 7))).ok, true);
    await reply(send(bg, { ...LABEL_MSG, label: null }, 7));
    await reply(send(bg, LABEL_MSG, 7));
    await reply(send(bg, OTHER_MSG, 7));
    await reply(fromPopup(bg, { type: 'xsh:labels-clear' }));
    bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
    bg.chrome.runtime.onInstalled.fire({ reason: 'update' });
    bg.chrome.runtime.onStartup.fire();
    await settleLong();
    assert.deepEqual(bg.requests.filter(isPost), [], JSON.stringify([settings, on]));
    // The one address of AI Anti-Slop's server it asks for is the readers' list, downloaded with no body.
    for (const r of bg.requests.filter((q) => new URL(q.url).origin === CROWD)) {
      assert.deepEqual([r.url, r.init.method, r.init.body, r.init.credentials], [`${CROWD}/v1/list.ndjson`, undefined, undefined, 'omit']);
    }
    // What was waiting is dropped, not sent, and no send is set up.
    assert.deepEqual(bg.chrome.store['xsh:share'].queue, []);
    assert.equal('xsh-share' in bg.chrome.alarmTable, false);
  }
});

test('sharing: turned on from an extension page with the saved labels, it makes a key and posts each label as a report, text/plain and without cookies', async () => {
  const bg = shareBackground({ answer: takeAll });
  await reply(send(bg, LABEL_MSG, 7));
  await reply(send(bg, OTHER_MSG, 7));
  // The two labels were made on different days, so the order they go in is the days', newest first.
  const DAY = 86400000;
  bg.chrome.store['xsh:label:2'].at = Date.now() - 2 * DAY;
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  // A content script cannot turn it on.
  assert.equal(await send(bg, { type: 'xsh:share-start', backfill: true }, 7), undefined);
  assert.equal(bg.chrome.store['xsh:share'], undefined);
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-start', backfill: true })), { ok: true, queued: 2 });
  await settleLong();
  const st = bg.chrome.store['xsh:share'];
  assert.match(st.key, /^[0-9a-f]{32}$/);
  assert.equal(st.on, true);
  // The switch is not written into settings, which the popup and the settings page write whole.
  assert.equal('sharing' in bg.chrome.store['xsh:settings'], false);
  const posts = bg.requests.filter(isPost);
  assert.deepEqual(posts.map((r) => r.url), [`${CROWD}/v1/reports`]);
  const init = posts[0].init;
  assert.deepEqual([init.method, { ...init.headers }, init.credentials, init.cache], ['POST', { 'content-type': 'text/plain;charset=UTF-8' }, 'omit', 'no-store']);
  assert.deepEqual(JSON.parse(init.body), {
    v: 1,
    key: st.key,
    reports: [
      { label: 'not_slop', handle: 'other', status: '3', thread: null, day: dayOf(bg.chrome.store['xsh:label:3'].at) },
      { label: 'slop', handle: 'reply_a', status: '2', thread: '1', day: dayOf(Date.now() - 2 * DAY) },
    ],
  });
  // The words of the post are not in what was sent, nor a hash of them.
  assert.equal(init.body.includes('hello'), false);
  assert.equal(init.body.includes('hash'), false);
  assert.deepEqual([st.queue, st.sent, st.lastError, st.retryAt], [[], 2, null, null]);
  // Without "Also share", the labels already saved stay unsent.
  const fresh = shareBackground({ answer: takeAll });
  await reply(send(fresh, LABEL_MSG, 7));
  assert.deepEqual(await reply(fromPopup(fresh, { type: 'xsh:share-start' })), { ok: true, queued: 0 });
  await settleLong();
  assert.deepEqual(fresh.requests.filter(isPost), []);
});

test('sharing: while it is on a label is queued and sent at the share alarm; clearing it sends a retraction, and so does Delete all labels', async () => {
  const bg = shareBackground({ store: { 'xsh:share': { on: true, key: SKEY } }, answer: takeAll });
  await reply(send(bg, LABEL_MSG, 7));
  let st = bg.chrome.store['xsh:share'];
  assert.deepEqual(st.queue.map((i) => [i.op, i.status, i.label]), [['report', '2', 'slop']]);
  assert.ok(bg.chrome.alarmTable['xsh-share'].when >= Date.now() + 29000, 'sent at the alarm, which gathers labels made close together');
  assert.deepEqual(bg.requests.filter(isPost), []);
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  assert.deepEqual(bg.requests.filter(isPost).map((r) => r.url), [`${CROWD}/v1/reports`]);
  await reply(send(bg, { ...LABEL_MSG, label: null }, 7));
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  let last = bg.requests.filter(isPost).at(-1);
  // The account's verdict is taken back (no other label on it is left to send).
  assert.deepEqual([last.url, JSON.parse(last.init.body)], [`${CROWD}/v1/retract`, { v: 1, key: SKEY, statuses: [], handles: ['reply_a'] }]);
  // Two labels made, then Delete all labels before they went: only the retractions go.
  await reply(send(bg, LABEL_MSG, 7));
  await reply(send(bg, OTHER_MSG, 7));
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:labels-clear' })), { ok: true, removed: 2 });
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  const posts = bg.requests.filter(isPost);
  assert.equal(posts.length, 3);
  last = posts.at(-1);
  assert.deepEqual([last.url, JSON.parse(last.init.body).statuses, JSON.parse(last.init.body).handles.sort()], [`${CROWD}/v1/retract`, [], ['other', 'reply_a']], 'one retraction for each account, not each label');
  st = bg.chrome.store['xsh:share'];
  assert.deepEqual([st.queue, st.sent], [[], 1]);
});

const labelMsg = (label, id, handle = 'reply_a') => ({ type: 'xsh:label', label, handle, url: `/${handle}/status/${id}`, page: '/op/status/1', text: 'words ' + id });
const queueOf = (bg) => bg.chrome.store['xsh:share'].queue.map((i) => [i.op, i.op === 'retract-handle' ? i.handle : i.status, i.label || null]);
const fireShare = async (bg) => {
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
};
const bodies = (bg) => bg.requests.filter(isPost).map((r) => [r.url.slice(CROWD.length), JSON.parse(r.init.body)]);
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);

test('sharing: clearing a label that is not the account\'s last takes back the account and sends its newest remaining label', async () => {
  const bg = shareBackground({ store: { 'xsh:share': { on: true, key: SKEY } }, answer: takeAll });
  await reply(send(bg, labelMsg('slop', '2'), 7));
  await reply(send(bg, labelMsg('not_slop', '5'), 7));
  await reply(send(bg, labelMsg('slop', '8', 'other'), 7));
  await fireShare(bg);
  const before = bg.requests.filter(isPost).length;
  // Clearing post 5 leaves post 2 (Slop) as the account's newest label.
  assert.deepEqual(await reply(send(bg, { ...labelMsg(null, '5') }, 7)), { ok: true, label: null });
  assert.deepEqual(queueOf(bg), [['retract-handle', 'reply_a', null], ['report', '2', 'slop']]);
  await fireShare(bg);
  const posts = bodies(bg).slice(before);
  assert.deepEqual(
    posts.map(([path]) => path),
    ['/v1/retract', '/v1/reports'],
  );
  assert.deepEqual(posts[0][1], { v: 1, key: SKEY, statuses: [], handles: ['reply_a'] });
  assert.deepEqual(posts[1][1].reports, [{ label: 'slop', handle: 'reply_a', status: '2', thread: '1', day: dayOfMs(bg.chrome.store['xsh:label:2'].at) }]);
  assert.deepEqual(bg.chrome.store['xsh:share'].queue, []);
  // The other account was not touched.
  assert.equal(JSON.stringify(posts).includes('other'), false);
  // Clearing the last label on the account sends the retraction alone.
  await reply(send(bg, labelMsg(null, '2'), 7));
  assert.deepEqual(queueOf(bg), [['retract-handle', 'reply_a', null]]);
  // A label that was never stored (cleared twice) is retracted by its post, as before.
  await fireShare(bg);
  await reply(send(bg, labelMsg(null, '2'), 7));
  assert.deepEqual(queueOf(bg), [['retract', '2', null]]);
});

test('sharing: a label on the other side than the account\'s newest takes the account back first; on the same side it is the report alone', async () => {
  const bg = shareBackground({ store: { 'xsh:share': { on: true, key: SKEY } }, answer: takeAll });
  await reply(send(bg, labelMsg('slop', '2'), 7));
  await reply(send(bg, labelMsg('slop', '5'), 7));
  assert.deepEqual(queueOf(bg), [['report', '2', 'slop'], ['report', '5', 'slop']], 'the same side: no retraction');
  // The other side: the queued reports for the account are replaced by the retraction and the new report.
  await reply(send(bg, labelMsg('not_slop', '6'), 7));
  assert.deepEqual(queueOf(bg), [['retract-handle', 'reply_a', null], ['report', '6', 'not_slop']]);
  await fireShare(bg);
  assert.deepEqual(bodies(bg).map(([path]) => path), ['/v1/retract', '/v1/reports']);
  // Changing a post's own label to the other side is a change of side too.
  await reply(send(bg, labelMsg('slop', '6'), 7));
  assert.deepEqual(queueOf(bg), [['retract-handle', 'reply_a', null], ['report', '6', 'slop']]);
  // Another account's label is not affected by this account's.
  await reply(send(bg, labelMsg('not_slop', '9', 'other'), 7));
  assert.deepEqual(queueOf(bg), [['retract-handle', 'reply_a', null], ['report', '6', 'slop'], ['report', '9', 'not_slop']]);
});

test('sharing: Delete all labels takes back each account once, not each label', async () => {
  const bg = shareBackground({ store: { 'xsh:share': { on: true, key: SKEY } }, answer: takeAll });
  await reply(send(bg, labelMsg('slop', '2'), 7));
  await reply(send(bg, labelMsg('slop', '5'), 7));
  await reply(send(bg, labelMsg('not_slop', '9', 'other'), 7));
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:labels-clear' })), { ok: true, removed: 3 });
  assert.deepEqual(queueOf(bg).sort(), [['retract-handle', 'other', null], ['retract-handle', 'reply_a', null]]);
  await fireShare(bg);
  assert.deepEqual(bodies(bg).map(([path]) => path), ['/v1/retract']);
  assert.deepEqual(bodies(bg)[0][1].statuses, []);
  assert.deepEqual(bodies(bg)[0][1].handles.slice().sort(), ['other', 'reply_a']);
});

test('sharing: turned on with the saved labels it queues the newest label of each account from the last 88 days, newest first', async () => {
  const DAY = 86400000;
  const now = Date.now();
  const rec = (handle, id, daysAgo, label = 'slop') => ({ at: now - daysAgo * DAY, label, handle, url: `https://x.com/${handle}/status/${id}`, text: 'words', page: 'https://x.com/op/status/1' });
  const bg = shareBackground({
    answer: takeAll,
    store: {
      'xsh:label:11': rec('acct_a', '11', 10),
      'xsh:label:12': rec('acct_a', '12', 5),
      'xsh:label:13': rec('acct_a', '13', 2, 'not_slop'),
      'xsh:label:21': rec('acct_b', '21', 100),
      'xsh:label:31': rec('acct_c', '31', 20),
    },
  });
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-start', backfill: true })), { ok: true, queued: 2 });
  await settleLong();
  assert.deepEqual(bodies(bg).map(([path]) => path), ['/v1/reports']);
  assert.deepEqual(bodies(bg)[0][1].reports, [
    { label: 'not_slop', handle: 'acct_a', status: '13', thread: '1', day: dayOfMs(now - 2 * DAY) },
    { label: 'slop', handle: 'acct_c', status: '31', thread: '1', day: dayOfMs(now - 20 * DAY) },
  ]);
});

test('sharing: a report queued by 0.10.0 is sent after the update with no hash and no day', async () => {
  const legacy = { op: 'report', label: 'slop', handle: 'reply_a', status: '2', thread: '1', hash: 'b'.repeat(16), seq: 1 };
  const bg = shareBackground({ store: { 'xsh:share': { on: true, key: SKEY, queue: [legacy], seq: 1 } }, answer: takeAll });
  bg.chrome.runtime.onStartup.fire();
  await settleLong();
  assert.deepEqual(bg.chrome.store['xsh:share'].queue, [legacy], 'kept as stored until it is sent');
  await fireShare(bg);
  assert.deepEqual(bodies(bg), [['/v1/reports', { v: 1, key: SKEY, reports: [{ label: 'slop', handle: 'reply_a', status: '2', thread: '1' }] }]]);
  assert.deepEqual(bg.chrome.store['xsh:share'].queue, []);
});

test('sharing: a 429 or a put-off report waits for the time the server gives, no answer 30 minutes, and nothing is sent before then', async () => {
  let mode = '429';
  const bg = shareBackground({
    store: { 'xsh:share': { on: true, key: SKEY } },
    answer: (path, body) => {
      if (mode === '429') return json(429, { ok: false, reason: 'too many new installs from this network today', retryAfter: 3600000 });
      if (mode === 'defer') return json(200, { ok: true, accepted: [], rejected: [], deferred: body.reports.map((r) => r.status), retryAfter: 7200000 });
      throw new TypeError('Failed to fetch');
    },
  });
  await reply(send(bg, LABEL_MSG, 7));
  const t0 = Date.now();
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  let st = bg.chrome.store['xsh:share'];
  assert.deepEqual([st.queue.length, st.lastError], [1, 'the server asked to wait: too many new installs from this network today']);
  // Never before the hour the server gave; the jitter adds up to an hour.
  assert.ok(st.retryAt >= t0 + 3600000 && st.retryAt <= Date.now() + 2 * 3600000);
  assert.equal(bg.chrome.alarmTable['xsh-share'].when, st.retryAt);
  // The alarm firing early sends nothing.
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  assert.equal(bg.requests.filter(isPost).length, 1);
  // Due, and put off by the daily cap.
  bg.chrome.store['xsh:share'] = { ...bg.chrome.store['xsh:share'], retryAt: Date.now() - 1 };
  mode = 'defer';
  const t1 = Date.now();
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  st = bg.chrome.store['xsh:share'];
  assert.deepEqual([st.queue.length, st.lastError, bg.requests.filter(isPost).length, st.fails], [1, null, 2, 0]);
  assert.ok(st.retryAt >= t1 + 7200000 && st.retryAt <= Date.now() + 7200000 + 3600000);
  // Due, and no answer.
  bg.chrome.store['xsh:share'] = { ...bg.chrome.store['xsh:share'], retryAt: Date.now() - 1 };
  mode = 'offline';
  const t2 = Date.now();
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  st = bg.chrome.store['xsh:share'];
  assert.deepEqual([st.queue.length, st.lastError, st.fails], [1, 'could not reach the server (Failed to fetch)', 1]);
  // 30 minutes, times 0.75 to 1.25 for the jitter.
  assert.ok(st.retryAt >= t2 + 22.5 * 60000 && st.retryAt <= Date.now() + 37.5 * 60000);
});

test('sharing: Turn off drops what is waiting and sends nothing more; Delete what I shared posts the key to forget and then drops it; a failed delete keeps it', async () => {
  let forgetOk = false;
  const bg = shareBackground({
    store: { 'xsh:share': { on: true, key: SKEY, sent: 4 } },
    answer: (path, body) => {
      if (path === '/v1/forget') return forgetOk ? json(200, { ok: true, removed: 4 }) : json(503, { ok: false, reason: 'busy' });
      return takeAll(path, body);
    },
  });
  await reply(send(bg, LABEL_MSG, 7));
  // Only an extension page can turn it off or delete.
  assert.equal(await send(bg, { type: 'xsh:share-stop' }, 7), undefined);
  assert.equal(await send(bg, { type: 'xsh:share-forget' }, 7), undefined);
  assert.equal(bg.chrome.store['xsh:share'].on, true);
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-stop' })), { ok: true });
  let st = bg.chrome.store['xsh:share'];
  assert.deepEqual([st.on, st.key, st.queue, st.sent], [false, SKEY, [], 4]);
  assert.equal('xsh-share' in bg.chrome.alarmTable, false);
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  assert.deepEqual(bg.requests.filter(isPost), []);
  // A delete the server did not confirm keeps the key, so it can be tried again.
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-forget' })), { ok: false, reason: 'the server answered 503' });
  assert.equal(bg.chrome.store['xsh:share'].key, SKEY);
  forgetOk = true;
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-forget' })), { ok: true, removed: 4 });
  assert.deepEqual(
    bg.requests.filter(isPost).map((r) => [r.url, JSON.parse(r.init.body)]),
    [
      [`${CROWD}/v1/forget`, { v: 1, key: SKEY }],
      [`${CROWD}/v1/forget`, { v: 1, key: SKEY }],
    ],
  );
  st = bg.chrome.store['xsh:share'];
  assert.deepEqual([st.on, st.key, st.sent, st.queue], [false, null, 0, []]);
  // Turned on again, it is a new reader with a new key.
  await reply(fromPopup(bg, { type: 'xsh:share-start' }));
  const again = bg.chrome.store['xsh:share'].key;
  assert.match(again, /^[0-9a-f]{32}$/);
  assert.notEqual(again, SKEY);
});

test('sharing: Delete what I shared with sharing on turns it off first, and waits for a send already out so the delete covers it', async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const order = [];
  const bg = shareBackground({
    store: { 'xsh:share': { on: true, key: SKEY } },
    answer: async (path, body) => {
      order.push(path);
      if (path === '/v1/reports') await held;
      return path === '/v1/forget' ? json(200, { ok: true, removed: 1 }) : takeAll(path, body);
    },
  });
  await reply(send(bg, LABEL_MSG, 7));
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  assert.deepEqual(order, ['/v1/reports']);
  const done = fromPopup(bg, { type: 'xsh:share-forget' });
  await settleLong();
  assert.equal(bg.chrome.store['xsh:share'].on, false);
  assert.deepEqual(order, ['/v1/reports'], 'the delete waits for the report out');
  release();
  assert.deepEqual(await reply(done), { ok: true, removed: 1 });
  assert.deepEqual(order, ['/v1/reports', '/v1/forget']);
  assert.equal(bg.chrome.store['xsh:share'].key, null);
});

test('sharing: turning it on while Delete what I shared is out is refused, so it never ends on with no key', async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const bg = shareBackground({
    store: { 'xsh:share': { on: true, key: SKEY } },
    answer: async (path, body) => {
      if (path === '/v1/forget') {
        await held;
        return json(200, { ok: true, removed: 1 });
      }
      return takeAll(path, body);
    },
  });
  await reply(send(bg, LABEL_MSG, 7));
  const done = fromPopup(bg, { type: 'xsh:share-forget' });
  await settleLong();
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-start', backfill: true })), {
    ok: false,
    reason: 'Delete what I shared is still running; try again when it ends',
  });
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-forget' })), { ok: false, reason: 'Delete what I shared is already running' });
  release();
  assert.deepEqual(await reply(done), { ok: true, removed: 1 });
  const st = bg.chrome.store['xsh:share'];
  assert.deepEqual([st.on, st.key, st.queue], [false, null, []]);
  assert.deepEqual(bg.requests.filter(isPost).map((r) => r.url), [`${CROWD}/v1/forget`]);
  // Once it has ended, turning on works and makes a new key.
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-start' })), { ok: true, queued: 0 });
  assert.match(bg.chrome.store['xsh:share'].key, /^[0-9a-f]{32}$/);
  assert.notEqual(bg.chrome.store['xsh:share'].key, SKEY);
});

test('sharing: a label made while a send is set for sooner keeps that time, so steady labelling does not put the send off; one set for later is brought forward', async () => {
  const bg = shareBackground({ store: { 'xsh:share': { on: true, key: SKEY } }, answer: takeAll });
  const soon = Date.now() + 5000;
  bg.chrome.alarms.create('xsh-share', { when: soon });
  await reply(send(bg, LABEL_MSG, 7));
  assert.equal(bg.chrome.alarmTable['xsh-share'].when, soon);
  // The minute's wait after a full send, say: the new label's send comes sooner.
  const later = Date.now() + 600000;
  bg.chrome.alarms.create('xsh-share', { when: later });
  await reply(send(bg, OTHER_MSG, 7));
  const when = bg.chrome.alarmTable['xsh-share'].when;
  assert.ok(when >= Date.now() + 29000 && when <= Date.now() + 30000, String(when - Date.now()));
  assert.deepEqual(bg.chrome.store['xsh:share'].queue.map((i) => i.status), ['2', '3']);
});

test('sharing: the settings page says what is sent before it is on, then turns it on, off and deletes through the background', async () => {
  // Five labels on three accounts (one of them too old for the server to take) and one that is no label.
  const made = (handle, id, daysAgo, o = {}) => ({ at: Date.now() - daysAgo * 86400000, label: 'slop', handle, url: `https://x.com/${handle}/status/${id}`, text: '', page: null, ...o });
  const s = loadSettings({
    'xsh:settings': {},
    'xsh:labelCount': 5,
    'xsh:label:11': made('acct_a', '11', 3),
    'xsh:label:12': made('acct_a', '12', 5, { label: 'not_slop' }),
    'xsh:label:13': made('acct_b', '13', 2),
    'xsh:label:14': made('acct_c', '14', 1),
    'xsh:label:15': made('acct_d', '15', 120),
    'xsh:label:16': { label: 'meh' },
  });
  const sent = [];
  const queued = (n) => Array.from({ length: n }, (_, i) => ({ op: 'report', label: 'slop', handle: 'a', status: String(i + 1), thread: null, hash: null, seq: i + 1 }));
  s.chrome.runtime.sendMessage = async (msg) => {
    sent.push({ ...msg });
    if (msg.type === 'xsh:share-start') {
      s.chrome.store['xsh:share'] = { on: true, key: SKEY, queue: queued(3), seq: 3 };
      return { ok: true, queued: 3 };
    }
    if (msg.type === 'xsh:share-stop') {
      s.chrome.store['xsh:share'] = { key: SKEY, sent: 3 };
      return { ok: true };
    }
    s.chrome.store['xsh:share'] = {};
    return { ok: true, removed: 3 };
  };
  await settle();
  const all = (sel) => [...s.document.querySelectorAll(sel)].map((e) => e.textContent);
  assert.deepEqual(all('#shareBody h3'), ['What is sent', 'What is never sent', 'Where it goes']);
  assert.deepEqual(all('#shareBody .facts li'), [
    "For each label: that it is slop or not slop, the account's handle, the post's id, the id of the post whose page it was on, and the day you labelled it. The post's words are not sent.",
    'A random code made for this browser, so that you count as one reader and can delete what you sent. It is not your X account.',
    "The post's words, your X account, other pages you visit, your lists and your settings.",
    'To ai-anti-slop.startupbros.com, run by AI Anti-Slop. It keeps one entry for each account you labelled: whether your newest label says slop or not slop and its day, with the post and page ids, the hour and a keyed hash of the first part of your IP address (never the address) from the report that set that side, so that one network cannot count as many readers. An entry is deleted 90 days after your newest label on that account.',
    'While sharing is on, clearing a label takes back what the server keeps for that account and sends your newest remaining label on it, if there is one. Delete what I shared removes everything from this browser. Turning sharing off stops sending and keeps what was sent.',
  ]);
  assert.equal(s.$('shareBackfill').checked, false, 'the labels already saved are shared only when ticked');
  assert.equal(s.$('shareBackfill').closest('label').textContent, 'Also share the newest saved label for 3 accounts, from the last 88 days', 'the number is of accounts with a label the server would take, not of labels');
  assert.equal(s.$('shareForget'), null, 'nothing shared yet, nothing to delete');
  const link = s.document.querySelector('#shareBody .shareLink a');
  assert.deepEqual([link.getAttribute('href'), link.textContent], ['https://ai-anti-slop.startupbros.com/', "The readers' list and how it is made"]);
  assert.deepEqual(sent, [], 'nothing happens until the button');
  s.$('shareBackfill').checked = true;
  s.click('shareOn');
  await settle();
  assert.deepEqual(sent, [{ type: 'xsh:share-start', backfill: true }]);
  assert.equal(s.$('shareMsg').textContent, 'Sharing is on. The newest label for 3 accounts is queued to send.');
  assert.equal(s.document.querySelector('#shareBody .shareState').textContent, 'Sharing is on. 0 reports sent · 3 waiting.');
  assert.equal(s.focused.at(-1), 'shareOff');
  s.click('shareOff');
  await settle();
  assert.deepEqual(sent.at(-1), { type: 'xsh:share-stop' });
  assert.equal(s.$('shareMsg').textContent, 'Sharing is off. Nothing more is sent.');
  assert.equal(s.document.querySelector('#shareBody .hint').textContent, '3 reports sent from this browser stay on the server until you delete them.');
  // Delete what I shared asks twice.
  s.click('shareForget');
  await settle();
  assert.equal(s.$('shareForget').textContent, 'Click again to delete what you shared');
  assert.equal(sent.length, 2);
  s.click('shareForget');
  await settle();
  assert.deepEqual(sent.at(-1), { type: 'xsh:share-forget' });
  assert.equal(s.$('shareMsg').textContent, 'Deleted 3 reports from the server. Sharing is off.');
  assert.equal(s.$('shareForget'), null);
  assert.ok(s.$('shareOn'));
});

test('sharing: a failed send shows on the settings page with when it tries again; a failed delete says nothing was deleted', async () => {
  const s = loadSettings({
    'xsh:settings': {},
    'xsh:share': { on: true, key: SKEY, sent: 5, lastSentAt: Date.now() - 120000, lastError: 'could not reach the server (Failed to fetch)', retryAt: Date.UTC(2099, 0, 1, 15, 4) },
  });
  s.chrome.runtime.sendMessage = async () => ({ ok: false, reason: 'could not reach the server (Failed to fetch)' });
  await settle();
  assert.equal(s.document.querySelector('#shareBody .shareState').textContent, 'Sharing is on. 5 reports sent · last sent 2 min ago.');
  const when = new Date(Date.UTC(2099, 0, 1, 15, 4)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(s.document.querySelector('#shareBody .shareErr').textContent, `The last send did not go through: could not reach the server (Failed to fetch). It tries again by itself after ${when}.`);
  s.click('shareForget');
  await settle();
  s.click('shareForget');
  await settle();
  assert.equal(s.$('shareMsg').textContent, 'Nothing was deleted: could not reach the server (Failed to fetch). Sharing is off; try again.');
});

test('sharing: the popup says whether sharing is on, and its button opens the settings page at sharing', async () => {
  const created = [];
  const tabs = { query: async () => [], sendMessage: async () => null, create: async (info) => created.push(info) };
  const off = loadPopup({ 'xsh:settings': {} }, {}, tabs);
  await settle();
  const text = (p, id) => p.document.getElementById(id).textContent;
  assert.equal(text(off, 'shareLine'), "Sharing is off. Shared labels help build the readers' list, one of Recommended's sources.");
  assert.equal(text(off, 'shareOpen'), 'Share your labels');
  off.document.getElementById('shareOpen').dispatchEvent(new off.window.Event('click'));
  assert.deepEqual(created.map((c) => ({ ...c })), [{ url: `chrome-extension://${EXT_ID}/src/settings.html#share` }]);
  const on = loadPopup({ 'xsh:settings': {}, 'xsh:share': { on: true, key: SKEY, sent: 1, queue: [{ op: 'retract', status: '4', seq: 1 }], seq: 1 } }, {}, tabs);
  await settle();
  assert.equal(text(on, 'shareLine'), 'Sharing is on: 1 report sent, 1 waiting.');
  assert.equal(text(on, 'shareOpen'), 'Sharing settings');
  // A sharing field in settings is not the switch.
  const stale = loadPopup({ 'xsh:settings': { sharing: true }, 'xsh:share': { key: SKEY } }, {}, tabs);
  await settle();
  assert.equal(text(stale, 'shareLine'), "Sharing is off. Shared labels help build the readers' list, one of Recommended's sources.");
});

test('sharing: a popup save of settings it read before Turn off sharing does not turn sharing back on', async () => {
  const bg = shareBackground({ answer: takeAll });
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-start' })), { ok: true, queued: 0 });
  const p = loadPopup(bg.chrome.store);
  await settle();
  // From here the popup reads and writes the background's storage, and
  // sharing is turned off between its save's read and its write.
  const local = bg.chrome.storage.local;
  let between = false;
  p.chrome.storage.local = {
    ...local,
    get: async (keys) => {
      const got = await local.get(keys);
      if (!between && [].concat(keys).includes('xsh:settings')) {
        between = true;
        assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:share-stop' })), { ok: true });
      }
      return got;
    },
  };
  const box = p.document.getElementById('mentions');
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  await settleLong();
  assert.equal(between, true);
  assert.equal(bg.chrome.store['xsh:settings'].hideBotMentions, true, 'the popup save went through');
  // A label made afterwards is not sent.
  assert.equal((await reply(send(bg, LABEL_MSG, 7))).ok, true);
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-share' });
  await settleLong();
  assert.deepEqual(bg.requests.filter(isPost).map((r) => r.url), []);
  assert.deepEqual(bg.chrome.store['xsh:share'].queue, []);
  assert.equal(bg.chrome.store['xsh:share'].on, false);
});

test('sharing: with sharing off, a key and no send counted, the settings page still offers Delete what I shared', async () => {
  // A request the server stored can lose its answer, which leaves sent at 0.
  const s = loadSettings({ 'xsh:settings': {}, 'xsh:share': { key: SKEY } });
  await settle();
  assert.ok(s.$('shareOn'));
  assert.equal(s.$('shareForget').textContent, 'Delete what I shared');
  assert.equal(s.document.querySelector('#shareBody .hint').textContent, 'Anything sent from this browser stays on the server until you delete it.');
});

// Report a problem or suggest something, in the popup's and the settings
// page's footers: GitHub's issue chooser with the manifest's version and the
// browser's name filled in (lib's feedbackUrl and browserName).
const BRAVE_NAV = {
  userAgentData: { brands: [{ brand: 'Chromium', version: '158' }, { brand: 'Not.A/Brand', version: '24' }, { brand: 'Brave', version: '158' }], platform: 'Windows' },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
};
const CHOOSER = 'https://github.com/StartupBros-com/ai-anti-slop/issues/new/choose';
const VERSION = JSON.parse(src('manifest.json')).version;
const SHARE_KEY = '0123456789abcdef0123456789abcdef';

test('popup: Report a problem links to the issue chooser with the version and browser', async () => {
  const p = loadPopup({ 'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' }, 'xsh:share': { on: true, key: SHARE_KEY } }, { navigator: BRAVE_NAV });
  await settle();
  const a = p.document.getElementById('feedback');
  const href = a.getAttribute('href');
  assert.equal(href, `${CHOOSER}?version=${VERSION}&browser=Brave%20158%20on%20Windows`);
  assert.ok(!href.includes('startupbros') && !href.includes(SHARE_KEY), 'no Muting as account and no sharing code');
  assert.equal(a.textContent, 'Report a problem');
  assert.match(a.getAttribute('title'), /GitHub account/);
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener');
  const q = loadPopup({});
  await settle();
  assert.equal(q.document.getElementById('feedback').getAttribute('href'), `${CHOOSER}?version=${VERSION}`, 'without a navigator, the version alone');
});

test('settings: Report a problem links to the issue chooser with the version and browser', async () => {
  const s = loadSettings({ 'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' }, 'xsh:share': { on: true, key: SHARE_KEY } }, { navigator: BRAVE_NAV });
  await settle();
  const href = s.$('feedback').getAttribute('href');
  assert.equal(href, `${CHOOSER}?version=${VERSION}&browser=Brave%20158%20on%20Windows`);
  assert.ok(!href.includes('startupbros') && !href.includes(SHARE_KEY), 'no Muting as account and no sharing code');
  assert.equal(s.$('feedback').textContent, 'Report a problem or suggest something');
});
