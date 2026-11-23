// AI Anti-Slop background service worker: keeps the handle list fresh in
// chrome.storage.local, and, when the user has turned muting on, mutes listed
// accounts one at a time in background tabs it opens and closes itself, and
// unmutes accounts it muted once muting no longer picks them. Its
// network requests are the addresses of the lists that are on (three for
// Recommended) and, only while the user has turned sharing on, the reports it
// posts to AI Anti-Slop's server (DEFAULTS.crowdBase); muting goes through X's
// own page and reads only the AI list.
importScripts('lib.js');

const L = self.XSlopHide;
const K = L.STORAGE_KEYS;
const ALARM = 'xsh-refresh';
const MUTE_ALARM = 'xsh-mute';
const JOB_ALARM = 'xsh-job-timeout';
const SHARE_ALARM = 'xsh-share';
const JOB_KEY = 'xsh:job'; // chrome.storage.session: the one job in flight
const JOB_TABS_KEY = 'xsh:jobTabs'; // chrome.storage.session: tabs opened for jobs
const VISIT_KEY = 'xsh:visit'; // chrome.storage.local: { tabId, windowId, startedAt } of the visit in progress, to close its tab after an update
const RUN_KEY = L.RUN_KEY; // chrome.storage.session: a Run now in progress
const PRESENT_TIMEOUT_MS = 1500;

async function settings() {
  const o = await chrome.storage.local.get(K.settings);
  return o[K.settings] || {};
}

const stored = async () => (await chrome.storage.local.get(K.list))[K.list];

// Each list has its own record, at L.listKey(id). Muting reads only the AI
// list's (stored() above), never a union with the others.
const recordOf = async (id) => (await chrome.storage.local.get(L.listKey(id)))[L.listKey(id)];

// Install, alarm, startup, popup and settings triggers can overlap. They share
// one in-flight refresh per list, so only one fetch and one write happen at a
// time for each. A call for another address (the AI list's feedUrl changed)
// waits for the one in flight and then fetches the new address.
const inflight = new Map();
function refreshList(sub) {
  const cur = inflight.get(sub.id);
  if (cur && cur.url === sub.url) return cur.p;
  const p = (cur ? cur.p.catch(() => {}) : Promise.resolve())
    .then(() => runRefresh(sub))
    .finally(() => {
      if (inflight.get(sub.id) === entry) inflight.delete(sub.id);
    });
  const entry = { url: sub.url, p };
  inflight.set(sub.id, entry);
  return p;
}

async function runRefresh(sub) {
  const key = L.listKey(sub.id);
  const prev = await recordOf(sub.id);
  const startSeq = (prev && prev.seq) || 0;
  const result = await L.fetchList({
    url: sub.url,
    format: sub.format,
    sources: sub.sources,
    fetchImpl: fetch,
    prevHandles: prev && prev.handles,
    prevParts: prev && prev.parts,
  });
  const latest = await recordOf(sub.id);
  // An added list removed while its fetch was out leaves no record behind,
  // and neither does a fetch of an address the list no longer has.
  const exists = L.subscriptions(await settings()).some((l) => l.id === sub.id && l.url === sub.url);
  const record = exists ? L.commitRecord(latest, result, sub.url, startSeq, Date.now()) : null;
  if (record) await chrome.storage.local.set({ [key]: record });
  const kept = record || latest;
  // A list of several sources can update with one of them refused (reason
  // set): the update is stored, but the answer is not ok.
  return { ok: result.ok && !result.reason, reason: result.reason || null, count: kept ? kept.handles.length : 0, handles: kept ? kept.handles : [] };
}

// Refresh every list that is on, in parallel. Answers { ok, reason, count }:
// ok when every list fetched, reason the first failure (named by its list
// when more than one is on), count the size of the union of their records.
async function refresh() {
  const subs = L.enabledLists(await settings());
  const results = await Promise.all(subs.map((sub) => refreshList(sub)));
  const failed = results.findIndex((r) => !r.ok);
  let reason = null;
  if (failed >= 0) reason = subs.length > 1 ? `${subs[failed].name}: ${results[failed].reason}` : results[failed].reason;
  return { ok: failed < 0, reason, count: L.unionHandles(results).length };
}

async function refreshIfDue() {
  const now = Date.now();
  for (const sub of L.enabledLists(await settings())) {
    const rec = await recordOf(sub.id);
    if (L.isDue(rec && rec.fetchedAt, now, L.DEFAULTS.refreshMinutes)) refreshList(sub).catch(() => {});
  }
}

// A settings change: fetch a list that was switched on (or whose address
// changed) when its record is missing, came from another address or is due,
// and delete the record of an added list that was removed. Any other change
// to settings starts no fetch.
async function listsChanged(change) {
  const { on, gone } = L.listChanges((change && change.oldValue) || {}, (change && change.newValue) || {});
  if (gone.length) await chrome.storage.local.remove(gone.map((id) => L.listKey(id)));
  const now = Date.now();
  for (const sub of L.enabledLists((change && change.newValue) || {}).filter((l) => on.includes(l.id))) {
    const rec = await recordOf(sub.id);
    if (!rec || rec.source !== sub.url || L.isRefreshDue(rec, now)) refreshList(sub).catch(() => {});
  }
}

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: L.DEFAULTS.refreshMinutes });
  });
}

// ------------------------------------------------------------------ muting

const mutesRec = async () => (await chrome.storage.local.get(K.mutes))[K.mutes] || L.emptyMutes();
const saveMutes = (rec) => chrome.storage.local.set({ [K.mutes]: rec });
const getJob = async () => (await chrome.storage.session.get(JOB_KEY))[JOB_KEY] || null;
const setJob = (job) => chrome.storage.session.set({ [JOB_KEY]: job });
// Every path that ends a job goes through clearJob, so the local copy of the
// visit goes with it.
const clearJob = async () => {
  await chrome.storage.session.remove(JOB_KEY);
  await chrome.storage.local.remove(VISIT_KEY);
};

// An update or reload clears session storage but leaves the visit's tab open.
// Called inside serial(). Closes the tab the previous worker opened, only if
// the visit is younger than the tab timeout and this worker has no job on that
// tab; the key goes either way. Without the "tabs" permission a tab's address
// is hidden, so what is checked is what can be seen: the tab still exists, in
// the window the visit opened it in, and is not the tab in front of the user.
// Not ruled out: a browser quit and reopened within the tab timeout of a visit,
// with an update installing on that launch, can hand the same id and window to
// another tab.
async function sweepStrandedVisit(closeTab) {
  const rec = (await chrome.storage.local.get(VISIT_KEY))[VISIT_KEY];
  if (!rec) return;
  const job = await getJob();
  if (job && job.tabId === rec.tabId) return; // this worker's own visit
  await chrome.storage.local.remove(VISIT_KEY);
  const age = Date.now() - rec.startedAt; // NaN, or below 0 once the clock went back, is not fresh
  if (!closeTab || !(age >= 0 && age < L.DEFAULTS.muteTabTimeoutMs)) return;
  const tab = await chrome.tabs.get(rec.tabId).catch(() => null); // a malformed id throws; serial() catches it
  if (tab && tab.windowId === rec.windowId && !tab.active) await chrome.tabs.remove(rec.tabId).catch(() => {});
}

// Every read-modify-write of the mute record and the job goes through this
// chain, so an alarm, a tab's report and a sighting never interleave.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const muting = (s) => L.mutingOn(s);

async function ensureMuteAlarm() {
  const s = await settings();
  const a = await chrome.alarms.get(MUTE_ALARM);
  if (muting(s) && !a) chrome.alarms.create(MUTE_ALARM, { periodInMinutes: 1 });
  if (!muting(s) && a) chrome.alarms.clear(MUTE_ALARM);
}

function gapMs() {
  const [lo, hi] = L.DEFAULTS.muteGapMinutes;
  return Math.round((lo + Math.random() * (hi - lo)) * 60000);
}

// ------------------------------------------------------------------ Run now
//
// The user pressed Run now in the popup: every unmute and mute waiting is
// visited one after another, a few seconds apart, past the daily caps and
// without waiting for an x.com tab. The checks of settings/muted/all still run
// every muteCheckEvery mutes, and anything that stops the day ends the run.
// It also ends on Stop, when nothing is left to visit, when muting is turned
// off or bound to another account, and when session storage empties (browser
// closed, extension reloaded or updated).

const getRun = async () => (await chrome.storage.session.get(RUN_KEY))[RUN_KEY] || null;
const endRun = () => chrome.storage.session.remove(RUN_KEY);

function runGapMs() {
  const [lo, hi] = L.DEFAULTS.muteRunGapMs;
  return Math.round(lo + Math.random() * (hi - lo));
}

// The next step of a run comes from the visit that just ended, not from the
// once-a-minute alarm, which stays as the fallback if the worker is stopped.
function chainRun(ms) {
  setTimeout(() => runTick().catch(() => {}), ms);
}

// Called inside serial(). Refuses when muting is off, the day has stopped or
// nothing is waiting; otherwise stores the run and lets the next step go now.
async function startRun() {
  const s = await settings();
  if (!muting(s)) return { ok: false, reason: 'muting is off' };
  const now = Date.now();
  const rec = L.stampAccount(await mutesRec(), s.muteAccount);
  const b = L.muteBudget(rec, L.utcDay(now), L.muteCap(s));
  if (b.stopped) return { ok: false, reason: `stopped for today: ${b.stopped}` };
  const list = await stored();
  const waiting = L.runWaiting(list && list.handles, s, rec);
  if (!waiting) return { ok: false, reason: 'nothing is waiting' };
  await chrome.storage.session.set({ [RUN_KEY]: { startedAt: now, account: s.muteAccount } });
  rec.nextAt = 0;
  await saveMutes(rec);
  return { ok: true, waiting };
}

// Called inside serial(). Muting goes back to its daily pace from now.
async function stopRun() {
  if (!(await getRun())) return { ok: true };
  await endRun();
  const rec = await mutesRec();
  rec.nextAt = Math.max(rec.nextAt || 0, Date.now() + gapMs());
  await saveMutes(rec);
  return { ok: true };
}

// Called inside serial(), after a settings change.
async function endRunIfOff() {
  const run = await getRun();
  if (!run) return;
  const s = await settings();
  if (!muting(s) || s.muteAccount !== run.account) await endRun();
}

// Job tabs still open, newest last, so the x.com check below never counts
// one. An id leaves the list when its tab closes; one whose close failed
// stays, which is when the check needs it. At most 50 are kept.
const jobTabs = async () => (await chrome.storage.session.get(JOB_TABS_KEY))[JOB_TABS_KEY] || [];
async function noteJobTab(id) {
  const ids = (await jobTabs()).filter((t) => t !== id);
  ids.push(id);
  await chrome.storage.session.set({ [JOB_TABS_KEY]: ids.slice(-50) });
}
async function forgetJobTab(id) {
  const ids = await jobTabs();
  if (!ids.includes(id)) return;
  const rest = ids.filter((t) => t !== id);
  if (rest.length) await chrome.storage.session.set({ [JOB_TABS_KEY]: rest });
  else await chrome.storage.session.remove(JOB_TABS_KEY);
}

// One tab's answer to "is this an x.com tab of the user's own?": true only
// from an AI Anti-Slop content script that was not given a job. A tab with
// no content script (any other site) rejects, as does one slower than
// PRESENT_TIMEOUT_MS.
function askTab(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), PRESENT_TIMEOUT_MS);
    Promise.resolve()
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'xsh:present' }))
      .then(
        (v) => {
          clearTimeout(timer);
          if (v === true) resolve(true);
          else reject(new Error('not a user tab'));
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
  });
}

// Whether the user has an x.com tab of their own open: what a daily cap
// above 25 needs before a mute visit past the day's first 25
// (L.visitNeedsXOpen). A tab opened before the extension was updated or
// reloaded cannot answer until it is refreshed. Needs no permission: without
// "tabs", tabs.query returns tabs without their URLs, so every tab is asked
// except discarded ones and the ones opened for jobs.
async function userHasXOpen() {
  const skip = new Set(await jobTabs());
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return false;
  }
  const asks = (tabs || [])
    .filter((t) => t && Number.isInteger(t.id) && t.id >= 0 && !t.discarded && !skip.has(t.id))
    .map((t) => askTab(t.id));
  if (!asks.length) return false;
  try {
    return await Promise.any(asks);
  } catch (e) {
    return false;
  }
}

// Open one job's tab in the background. The tab is never made active. A mute
// or unmute job opens the account's profile; a check opens the muted list.
async function startJob(kind, handle, account, now) {
  const url = kind === 'check' ? 'https://x.com/settings/muted/all' : `https://x.com/${handle}`;
  const tab = await chrome.tabs.create({ url, active: false });
  await noteJobTab(tab.id);
  const job = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    handle: handle || null,
    account,
    tabId: tab.id,
    startedAt: now,
    claimed: false,
    pageTimeoutMs: L.DEFAULTS.muteTabTimeoutMs - 20000,
  };
  await chrome.storage.local.set({ [VISIT_KEY]: { tabId: tab.id, windowId: tab.windowId, startedAt: now } });
  await setJob(job);
  chrome.alarms.create(JOB_ALARM, { when: now + L.DEFAULTS.muteTabTimeoutMs });
  return job;
}

// Whether a job may still go ahead. Settings and the list can change while
// its tab loads and waits for a post: muting turned off, another account, a
// bot's row moved off Mute on X, an account added to Always show, an account
// back on the list. A mute job must still be for an account muting may visit;
// an unmute job, for one it would still unmute.
async function stillWanted(job) {
  const s = await settings();
  if (!muting(s) || s.muteAccount !== job.account) return false;
  if (job.kind === 'check') return true;
  const list = await stored();
  const handles = list && list.handles;
  if (job.kind === 'mute') return L.muteEligible(handles, s).includes(job.handle);
  if (job.kind === 'unmute') return L.unmuteCandidates(handles, s, await mutesRec()).includes(job.handle);
  return false;
}

// Drop a job unrecorded and close its tab. The visit it cost stays counted.
async function dropJob(job) {
  await clearJob();
  chrome.alarms.clear(JOB_ALARM);
  await closeJobTab(job.tabId);
  if (await getRun()) chainRun(runGapMs());
}

// Close a job's tab. Its id leaves the job-tab list only once the close
// succeeded; a tab that stayed open keeps being skipped by the x.com check.
async function closeJobTab(id) {
  const closed = await chrome.tabs.remove(id).then(
    () => true,
    () => false,
  );
  if (closed) await forgetJobTab(id);
}

// Fold a job's result into the record, close its tab and set the next visit.
async function finishJob(job, reported) {
  const now = Date.now();
  const result = L.jobResult(job.kind, reported);
  let rec = await mutesRec();
  if (job.kind === 'mute') {
    rec = L.recordOutcome(rec, job.handle, result, now, job.account);
  } else if (job.kind === 'unmute') {
    rec = L.recordUnmute(rec, job.handle, result, now);
  } else if (result.status === 'checked') {
    rec = L.recordCheck(rec, result.rows, now).rec;
  } else {
    // An unreadable muted list means mutes cannot be confirmed: try once more
    // after a wait, then stop for the day.
    rec = L.recordCheckFailed(rec, result, now, job.account);
  }
  let run = await getRun();
  if (run && job.kind !== 'check') {
    const misses = L.runMissed(result) ? (run.misses || 0) + 1 : 0;
    if (misses >= L.DEFAULTS.muteRunMisses) {
      const why = `${result.status}${result.reason ? ` (${result.reason})` : ''}`;
      rec = L.stopDay(rec, now, `Run now: ${misses} visits in a row did nothing, the last @${job.handle}: ${why}`);
      await endRun();
      run = null;
    } else if (misses !== (run.misses || 0)) {
      run = Object.assign({}, run, { misses });
      await chrome.storage.session.set({ [RUN_KEY]: run });
    }
  }
  const gap = run ? runGapMs() : gapMs();
  rec.nextAt = now + gap;
  await saveMutes(rec);
  await clearJob(); // before closing, so onRemoved does not see this job
  chrome.alarms.clear(JOB_ALARM);
  await closeJobTab(job.tabId);
  if (run) chainRun(gap + 50);
}

// What tickWith returns when a mute visit past the day's first 25 is due at
// 50 or 100 a day and the tabs have not been asked yet.
const ASK_TABS = 'ask-tabs';

// One step of the mute loop, run by the alarm once a minute (runTick): finish
// a job that ran out of time, or start the next one if today's caps allow.
// Takes no argument, because serial() passes the previous step's result.
function tick() {
  return tickWith(null);
}

// The alarm's step. At 50 or 100 a day a mute visit past the day's first 25
// also needs an x.com tab of the user's own open, and the tabs are asked
// outside the queue: a tab
// that has just loaded answers only once the worker has answered its
// xsh:job question, which waits in the queue behind any step running there.
async function runTick() {
  if ((await serial(tick)) !== ASK_TABS) return;
  const open = await userHasXOpen();
  await serial(() => tickWith(open));
}

// xOpen is null until the tabs are asked, then whether the user has an x.com
// tab open. A check of settings/muted/all runs either way.
async function tickWith(xOpen) {
  const s = await settings();
  const job = await getJob();
  let run = await getRun();
  const now = Date.now();
  if (job) {
    if (!muting(s)) {
      // Turned off mid-job: drop it unrecorded.
      if (run) await endRun();
      await dropJob(job);
      return;
    }
    if (now - job.startedAt >= L.DEFAULTS.muteTabTimeoutMs) {
      await finishJob(job, { status: 'error', reason: `no answer from the tab in ${L.DEFAULTS.muteTabTimeoutMs / 1000} s` });
    }
    return;
  }
  if (!muting(s)) {
    if (run) await endRun();
    return;
  }
  if (run && run.account !== s.muteAccount) {
    await endRun();
    run = null;
  }
  const got = await mutesRec();
  let rec = L.stampAccount(got, s.muteAccount);
  if (rec !== got) await saveMutes(rec);
  if (now < (rec.nextAt || 0)) return;
  const cap = L.muteCap(s);
  const b = L.muteBudget(rec, L.utcDay(now), cap);
  if (b.stopped) {
    if (run) await endRun();
    return;
  }
  const list = await stored();
  const handles = list && list.handles;
  // Unmutes go first: an account that left the list was most likely listed
  // by mistake. Both share today's cap.
  const unmutes = L.unmuteCandidates(handles, s, rec);
  const candidates = L.muteCandidates(handles, s, rec);
  const next = unmutes.length ? { kind: 'unmute', handle: unmutes[0] } : candidates.length ? { kind: 'mute', handle: candidates[0] } : null;
  const pending = (rec.sinceCheck || []).length;
  // A check that failed waits before it runs again (L.recordCheckFailed),
  // and until then nothing is visited, however few mutes wait to be checked.
  // A run waits with it.
  if (pending && L.checkWaitMs(rec, s.muteAccount, now)) return;
  // A run skips the caps and the x.com-tab rule; nothing else.
  let canVisit = next !== null && (run !== null || (b.mutesLeft > 0 && b.visitsLeft > 0));
  // A check is due after muteCheckEvery mutes, and the second try of one
  // that failed comes first once its wait is over.
  const retry = !!(rec.checkRetry && rec.checkRetry.account === s.muteAccount);
  if (pending >= L.DEFAULTS.muteCheckEvery || (pending && retry)) {
    await startJob('check', null, s.muteAccount, now);
    return;
  }
  if (!run && canVisit && L.visitNeedsXOpen(rec, L.utcDay(now), cap)) {
    if (xOpen === null) return ASK_TABS;
    canVisit = xOpen === true;
  }
  if (pending && !canVisit) {
    await startJob('check', null, s.muteAccount, now);
    return;
  }
  if (!canVisit) {
    if (run) await endRun(); // nothing left to visit
    return;
  }
  await startJob(next.kind, next.handle, s.muteAccount, now);
  rec = L.countVisit(rec, now);
  await saveMutes(rec);
}

// ------------------------------------------------------------------ sharing
//
// Only while the sharing record's on is true (L.shareOn). saveLabel and clearLabels
// queue reports and retractions inside serial(); sendShare posts them outside
// it, so a slow server never holds up a label, and stores each answer inside
// it again. Turning sharing off empties the queue, and sendShare reads the
// switch before every request, so nothing is sent while it is off.

const shareRec = async () => L.shareState((await chrome.storage.local.get(K.share))[K.share]);

// Send what is queued at `at` (or soon). Chrome fires an alarm no sooner than
// 30 seconds after it is set, which also gathers labels made close together
// into one request.
function shareSoon(at) {
  chrome.alarms.create(SHARE_ALARM, { when: Math.max(Date.now() + 30000, at || 0) });
}

// Called inside serial(): queue the items, and come back to send them. A
// send already set for no later than this one would be is kept, so labels
// made less than 30 seconds apart do not keep putting the send off.
async function queueShare(items) {
  let st = await shareRec();
  for (const it of items) st = L.enqueueShare(st, it);
  await chrome.storage.local.set({ [K.share]: st });
  const set = await chrome.alarms.get(SHARE_ALARM);
  const now = Date.now();
  const want = Math.max(now + 30000, st.retryAt || 0);
  if (set && set.scheduledTime > now && set.scheduledTime <= want) return;
  shareSoon(st.retryAt);
}

// A queue left by a worker that stopped before it sent.
async function ensureShareAlarm() {
  const st = await shareRec();
  if (L.shareOn(st) && st.queue.length && !(await chrome.alarms.get(SHARE_ALARM))) shareSoon(st.retryAt);
}

// POST a JSON body as text/plain, which needs no CORS preflight, without
// cookies. Never throws: { status, body } (body: the parsed JSON answer, or
// null), or { status: 0, error } when no answer came.
async function postShare(path, body) {
  try {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(L.DEFAULTS.timeoutMs);
    const res = await fetch(L.DEFAULTS.crowdBase + path, init);
    let data = null;
    try {
      data = JSON.parse(await res.text());
    } catch (e) {
      data = null;
    }
    return { status: res.status, body: data };
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e) };
  }
}

// One send at a time: up to shareRequestsPerSend requests, then a minute's
// wait if more is queued. Each request is planned and its answer stored
// inside serial(), with the network call between them outside it.
let sending = null;
function sendShare() {
  if (!sending) sending = sendLoop().finally(() => (sending = null));
  return sending;
}

async function sendLoop() {
  for (let n = 0; n < L.DEFAULTS.shareRequestsPerSend; n++) {
    const plan = await serial(async () => {
      const st = await shareRec();
      if (!L.shareOn(st)) {
        if (st.queue.length || st.retryAt) await chrome.storage.local.set({ [K.share]: Object.assign(st, { queue: [], retryAt: null }) });
        return null;
      }
      if (st.retryAt && st.retryAt > Date.now()) return { wait: st.retryAt };
      const batch = L.shareBatch(st);
      return batch ? { batch } : null;
    });
    if (!plan) return;
    if (plan.wait) return shareSoon(plan.wait);
    const res = await postShare(plan.batch.path, plan.batch.body);
    const st = await serial(async () => {
      const next = L.shareResult(await shareRec(), plan.batch, res, Date.now());
      // Turned off while the request was out: what it sent stays counted, the rest goes.
      if (!L.shareOn(next)) Object.assign(next, { queue: [], retryAt: null });
      await chrome.storage.local.set({ [K.share]: next });
      return next;
    });
    if (st.retryAt) return shareSoon(st.retryAt);
    if (!st.queue.length) return;
  }
  shareSoon(Date.now() + 60000);
}

// Called inside serial(). Turn sharing on, with a new key if this install
// has none, and queue a report for every label already saved when asked.
async function startShare(backfill) {
  // A delete still out drops the key when it ends, which would leave sharing
  // on with no key (and could send reports the delete misses).
  if (forgetting) return { ok: false, reason: 'Delete what I shared is still running; try again when it ends' };
  let st = await shareRec();
  if (!st.key) st.key = L.newShareKey();
  let queued = 0;
  if (backfill) {
    const reports = L.backfillReports(L.labelsFrom(await chrome.storage.local.get(null)), Date.now());
    for (const r of reports) st = L.enqueueShare(st, r);
    queued = reports.length;
  }
  st.on = true;
  st.asked = true;
  await chrome.storage.local.set({ [K.share]: st });
  // The caller sends at once; the alarm is there if this worker stops first.
  if (st.queue.length) shareSoon(st.retryAt);
  return { ok: true, queued };
}

// Called inside serial(). Turn sharing off: nothing waiting is sent. What
// was sent stays on the server until Delete what I shared, and the key stays
// so that delete can name it.
async function stopShare() {
  const st = await shareRec();
  await chrome.storage.local.set({ [K.share]: Object.assign(st, { on: false, asked: true, queue: [], retryAt: null }) });
  await chrome.alarms.clear(SHARE_ALARM);
  return { ok: true };
}

// Called inside serial(). The consent card's answer, from an x.com tab:
// 'share' turns sharing on for labels made from now on (no label already
// saved is queued), 'not-now' only records that the user answered. Refused
// once an answer is recorded or sharing is on, with no label saved yet, or
// while Delete what I shared runs. Nothing changes when it is refused.
async function shareConsent(choice) {
  if (choice !== 'share' && choice !== 'not-now') return { ok: false, reason: 'not a choice' };
  if (forgetting) return { ok: false, reason: 'Delete what I shared is running' };
  const st = await shareRec();
  if (L.shareOn(st) || st.asked) return { ok: false, reason: 'already answered' };
  const saved = Object.keys(await chrome.storage.local.get(null)).some((k) => k.startsWith(L.LABEL_PREFIX));
  if (!saved) return { ok: false, reason: 'no label saved' };
  if (choice === 'not-now') {
    await chrome.storage.local.set({ [K.share]: Object.assign(st, { asked: true }) });
    return { ok: true };
  }
  const r = await startShare(false);
  return r.ok ? { ok: true } : r;
}

// Delete what I shared: sharing goes off first, so nothing more is sent; a
// send already out is waited for, so the delete covers it; then the server
// deletes every report made with this install's key. Only once it says so is
// the key dropped (the next time sharing is turned on gets a new one).
// Sharing cannot be turned on while it runs.
let forgetting = false;
async function forgetShare() {
  if (forgetting) return { ok: false, reason: 'Delete what I shared is already running' };
  forgetting = true;
  try {
    return await forgetOnce();
  } finally {
    forgetting = false;
  }
}

async function forgetOnce() {
  const key = await serial(async () => {
    await stopShare();
    return (await shareRec()).key;
  });
  if (sending) await sending.catch(() => {});
  if (!key) return { ok: true, removed: 0 };
  const res = await postShare('/v1/forget', { v: 1, key });
  if (res.status !== 200 || !res.body || res.body.ok !== true) {
    const why = res.status ? `the server answered ${res.status}` : `could not reach the server${res.error ? ` (${res.error})` : ''}`;
    return { ok: false, reason: why };
  }
  await serial(async () => {
    // The answer to the consent card is kept: deleting what was shared is not a reason to ask again.
    const now = await shareRec();
    if (now.key === key) await chrome.storage.local.set({ [K.share]: Object.assign(L.shareState(null), { asked: now.asked }) });
  });
  return { ok: true, removed: Number(res.body.removed) || 0 };
}

chrome.runtime.onInstalled.addListener((details) => {
  serial(() => sweepStrandedVisit(!!details && details.reason === 'update')).catch(() => {});
  ensureAlarm();
  ensureMuteAlarm();
  ensureShareAlarm().catch(() => {});
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  serial(() => sweepStrandedVisit(false)).catch(() => {}); // tab ids restart with the browser
  ensureAlarm();
  ensureMuteAlarm();
  ensureShareAlarm().catch(() => {});
  refreshIfDue();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[K.settings]) {
    ensureMuteAlarm();
    serial(endRunIfOff).catch(() => {});
    listsChanged(changes[K.settings]).catch(() => {});
  }
});

// Only the popup, or another page at the extension's own address (also when
// opened in a tab), never a content script, whose address is the site's.
function fromOwnPage(sender) {
  const own = chrome.runtime.getURL('');
  return !!sender && typeof sender.url === 'string' && sender.url.startsWith(own);
}

// A content script in an x.com or twitter.com tab: a tab, and the frame's
// address on the manifest's matches. Only the consent card's two messages
// accept it; everything about sharing that a page of the site could abuse
// stays on fromOwnPage.
function fromXTab(sender) {
  return !!sender && !!sender.tab && L.isXPageUrl(sender.url);
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refresh();
  if (a.name === MUTE_ALARM || a.name === JOB_ALARM) runTick();
  if (a.name === SHARE_ALARM) sendShare().catch(() => {});
});

// The user closed a job's tab before it reported: count it as an error.
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const job = await getJob();
    if (job && job.tabId === tabId) await finishJob(job, { status: 'error', reason: 'the tab was closed before it finished' });
    await forgetJobTab(tabId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'xsh:refresh') {
    refresh().then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
    return true; // async response
  }
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (msg.type === 'xsh:job') {
    // Only the tab opened for the job gets it, and only once (a reload of
    // that tab must not click again).
    serial(async () => {
      const job = await getJob();
      if (!job || job.tabId !== tabId || job.claimed) return null;
      if (!(await stillWanted(job))) {
        await dropJob(job);
        return null;
      }
      await setJob(Object.assign({}, job, { claimed: true }));
      return job;
    }).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === 'xsh:job-go') {
    // Asked by a mute job's tab just before it clicks Mute, up to a minute
    // after it claimed the job. No means the job was dropped and its tab closed.
    serial(async () => {
      const job = await getJob();
      if (!job || job.tabId !== tabId || job.id !== msg.id || !job.claimed) return false;
      if (await stillWanted(job)) return true;
      await dropJob(job);
      return false;
    }).then(sendResponse, () => sendResponse(false));
    return true;
  }
  if (msg.type === 'xsh:job-result') {
    serial(async () => {
      const job = await getJob();
      const r = msg.result || {};
      if (job && job.tabId === tabId && r.id === job.id) await finishJob(job, r);
    }).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if (msg.type === 'xsh:sighting') {
    serial(async () => {
      const s = await settings();
      const h = L.normalizeHandle(msg.handle);
      const list = await stored();
      // Only an account muting may visit: listed or extra, not Always-show,
      // and a bot only when its row says Mute on X.
      if (!muting(s) || !h || !L.muteEligible(list && list.handles, s).includes(h)) return;
      await saveMutes(L.noteSighting(await mutesRec(), h));
    }).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if (msg.type === 'xsh:label') {
    serial(() => saveLabel(msg)).then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'xsh:labels-clear') {
    if (!fromOwnPage(sender)) return false;
    serial(clearLabels).then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
  // Sharing: turned on (with the labels already saved, when msg.backfill is
  // true), turned off, or everything shared deleted. From the settings page only.
  if (msg.type === 'xsh:share-start' || msg.type === 'xsh:share-stop') {
    if (!fromOwnPage(sender)) return false;
    serial(() => (msg.type === 'xsh:share-start' ? startShare(msg.backfill === true) : stopShare())).then(
      (r) => {
        sendResponse(r);
        if (r && r.ok && msg.type === 'xsh:share-start') sendShare().catch(() => {});
      },
      (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }),
    );
    return true;
  }
  // The consent card on x.com: the user's answer, or Details.
  if (msg.type === 'xsh:share-consent') {
    if (!fromXTab(sender)) return false;
    serial(() => shareConsent(msg.choice)).then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'xsh:open-settings') {
    if (!fromXTab(sender)) return false;
    Promise.resolve()
      .then(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/settings.html#share') }))
      .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'xsh:share-forget') {
    if (!fromOwnPage(sender)) return false;
    forgetShare().then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'xsh:run') {
    // Run now ({ on: true }) or Stop ({ on: false }), from the popup only.
    if (!fromOwnPage(sender)) return false;
    serial(() => (msg.on === true ? startRun() : stopRun())).then(
      (r) => {
        sendResponse(r);
        if (r && r.ok && msg.on === true) runTick().catch(() => {});
      },
      (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }),
    );
    return true;
  }
  return false;
});

// ------------------------------------------------------------------ labels

// Store one label from a content script, or clear it, after checking every
// field (lib.labelRecord). A new label adds the account to Also hide (slop)
// or Always show (not slop); clearing one changes neither box. Refused while
// labels are off, and once labelMax are saved.
// One read, then one write: settings are read in the same get as the label,
// so a popup save can only be overwritten inside that one gap.
async function saveLabel(msg) {
  const id = msg && typeof msg.url === 'string' ? (L.statusOf(msg.url) || {}).id : null;
  const key = id ? L.LABEL_PREFIX + id : null;
  const got = await chrome.storage.local.get([K.settings, K.list, K.labelCount, K.share, ...(key ? [key] : [])]);
  const s = got[K.settings] || {};
  const shareRecord = L.shareState(got[K.share]);
  const sharing = L.shareOn(shareRecord);
  if (!L.labelsOn(s)) return { ok: false, reason: 'labels are off' };
  const list = got[K.list];
  const ctx = { handles: list && list.handles, source: list && list.source, settings: s };
  // With another list on too, the label says which lists hold the account.
  // A list made of several sources (Recommended) comes as one entry per
  // source, so the label's host is the one whose file holds the account.
  const on = L.enabledLists(s);
  if (on.some((l) => l.id !== L.MUTE_LIST)) {
    const recs = await chrome.storage.local.get(on.map((l) => L.listKey(l.id)));
    ctx.lists = on.flatMap((l) => {
      const rec = recs[L.listKey(l.id)];
      if (rec && Array.isArray(rec.parts)) return rec.parts.map((p) => ({ id: l.id, url: p.source, handles: p.handles || [] }));
      return [{ id: l.id, url: (rec && rec.source) || l.url, handles: (rec && rec.handles) || [] }];
    });
  }
  const r = L.labelRecord(msg, ctx, Date.now());
  if (!r.ok) return { ok: false, reason: r.reason };
  if (L.LABEL_PREFIX + r.id !== key) return { ok: false, reason: 'not a post URL' };
  const had = !!got[key];
  let n = Number(got[K.labelCount]) || 0;
  if (r.label === null) {
    // While sharing is on, the account's other labels decide what the server
    // should hold once this one is gone (read before it is removed).
    const kept = sharing && had ? L.labelsFrom(await chrome.storage.local.get(null)) : null;
    if (had) {
      await chrome.storage.local.remove(key);
      await chrome.storage.local.set({ [K.labelCount]: Math.max(0, n - 1) });
    }
    // What the server keeps for the account is taken back and its newest
    // remaining label sent. A label that was not stored may still have been
    // reported by an earlier copy, so its post is retracted by id (the server
    // ignores one it never had).
    if (sharing) {
      const items = had ? L.shareItemsOnClear(kept, got[key], Date.now()) : [];
      await queueShare(items.length ? items : [{ retract: r.id }]);
    }
    return { ok: true, label: null };
  }
  const max = L.DEFAULTS.labelMax;
  if (!had && n >= max) {
    // The count is only a cache of the keys: recount before refusing.
    n = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(L.LABEL_PREFIX)).length;
    if (n >= max) return { ok: false, reason: `${max} labels saved: export and delete them to add more` };
  }
  const writes = { [key]: r.record, [K.labelCount]: had ? n : n + 1 };
  const patch = L.labelPatch(s, r.handle, r.label);
  if (patch) writes[K.settings] = Object.assign({}, s, patch);
  await chrome.storage.local.set(writes);
  // Its report replaces any queued for the account; if the server holds the
  // other side, the send takes the account back first (L.shareBatch).
  if (sharing) {
    const report = L.reportOf(r.record);
    if (report) await queueShare([report]);
  }
  const out = { ok: true, label: r.label, added: patch ? Object.keys(patch)[0] : null };
  // The page shows the consent card once: for a Slop label, while sharing is
  // off, no answer is recorded and no Delete what I shared is running.
  if (r.label === 'slop' && !sharing && !shareRecord.asked && !forgetting) out.askShare = true;
  return out;
}

// Delete every label and the count. The two boxes are left as they are.
// While sharing is on, what the server keeps for each of their accounts is taken back too.
async function clearLabels() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(L.LABEL_PREFIX));
  await chrome.storage.local.remove([...keys, K.labelCount]);
  if (keys.length && L.shareOn(L.shareState(all[K.share]))) await queueShare(L.shareItemsOnClearAll(L.labelsFrom(all)));
  return { ok: true, removed: keys.length };
}
