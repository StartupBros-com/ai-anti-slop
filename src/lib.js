// Shared, side-effect-free logic for AI Anti-Slop (formerly Human Replies Only
// and x-slop-hide).
//
// Loaded three ways, so it must not depend on any one environment:
//   - content script: listed before content.js in manifest.json (shares the isolated world)
//   - background service worker: importScripts('lib.js')
//   - node tests: require() via module.exports
(function (root) {
  'use strict';

  // X handles: 1-15 of [A-Za-z0-9_], matched case-insensitively. Stored lowercased.
  const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
  const PROFILE_HREF_RE = /^\/([A-Za-z0-9_]{1,15})$/;

  const DEFAULTS = Object.freeze({
    feedUrl: 'https://clankwall.vogel.dev/api/usernames.txt',
    refreshMinutes: 360,
    // After a failed attempt, wait this long before trying again.
    retryMinutes: 30,
    // How often an open userscript tab checks whether the list is due.
    checkMinutes: 15,
    timeoutMs: 20000,
    maxBytes: 1000000,
    maxHandles: 50000,
    // Refuse an update that drops below this fraction of the stored list:
    // a broken or truncated fetch must never silently switch hiding off.
    minShrinkRatio: 0.5,
    // The shrink guard only applies once the stored list is big enough for a
    // ratio to mean something.
    shrinkGuardFloor: 20,
    // Muting (off unless the user turns it on). Per UTC day: at most this many
    // mutes, and this many profile visits (an already-muted account costs a
    // visit, not a mute). These are the default; muteCaps lists every daily
    // cap the user may pick, and visits are always capped at twice the mutes.
    muteDailyCap: 25,
    muteVisitCap: 50,
    // The only daily caps muteCap() returns. 100 is the ceiling: a stored
    // value outside this list reads as muteDailyCap.
    muteCaps: Object.freeze([25, 50, 100]),
    // Minutes between visits, picked at random in this range. The alarm that
    // drives muting fires once a minute (the floor at Chrome 116).
    muteGapMinutes: [1, 3],
    // During Run now, milliseconds between one visit's tab closing and the
    // next opening, picked at random in this range. A run skips the daily
    // caps and the gap above, not the checks or the reasons to stop the day.
    muteRunGapMs: [2000, 5000],
    // Visits in a row, inside a run, that end in an error or find no post
    // before muting stops for the day. X unreachable, or pages X will not
    // serve, would otherwise spend every account's tries in one sitting; a run
    // tries each account once before any second try, so this many leaves
    // none of them given up on.
    muteRunMisses: 5,
    // A mute tab still open after this long is closed and counted as a failure.
    muteTabTimeoutMs: 90000,
    // Mutes made since the last check of settings/muted/all. A background tab
    // renders only its first 9 rows (seen 2026-11-06), so check well before that.
    muteCheckEvery: 5,
    // After a check that could not read settings/muted/all, how long until it
    // is tried again: one of X's 15-minute rate-limit windows. A second
    // failure in a row stops the day.
    muteCheckRetryMs: 15 * 60000,
    // Attempts at one account that end in a timeout or error before it is left alone.
    muteMaxAttempts: 2,
    // Accounts seen while browsing, muted ahead of the rest of the list.
    muteFrontMax: 50,
    // Labels (extension only, on unless the user turns them off): at most
    // this many saved, each keeping at most this many characters of reply text.
    labelMax: 2000,
    labelTextMax: 1000,
    // Lists. clankwall's and levelsio's NDJSON exports carry a line of JSON
    // for every account (levelsio's with its evidence, about 1 MB on
    // 2026-11-21), so their size cap is larger than a plain list's.
    ndjsonMaxBytes: 8000000,
    // Lists the user may add by address, and the longest address taken.
    customListMax: 5,
    listUrlMax: 500,
    // Sharing labels (off unless the user turns it on): the server reports
    // go to, which also publishes the readers' list Recommended reads; the
    // most reports or retractions in one request (the server's cap); the
    // most requests one send makes before it waits a minute; the longest
    // queue kept (labelMax reports plus their retractions); the wait after a
    // send that failed, which doubles with each failure in a row up to the
    // longest wait; and how far back a label may be and still be shared (the
    // server refuses one made more than 90 days ago; two days of margin for
    // the queue).
    crowdBase: 'https://ai-anti-slop.startupbros.com',
    shareBatch: 50,
    shareRequestsPerSend: 10,
    shareQueueMax: 4000,
    shareRetryMinutes: 30,
    shareRetryMaxMinutes: 360,
    shareBackfillDays: 88,
  });

  // The xsh: prefix is from before the rename. Changing it would strand every
  // installed copy's settings, lists, mute record and labels.
  const STORAGE_KEYS = Object.freeze({
    list: 'xsh:list',
    settings: 'xsh:settings',
    mutes: 'xsh:mutes',
    // How many labels are saved; each label is its own key, LABEL_PREFIX + post id.
    labelCount: 'xsh:labelCount',
    // Sharing: whether it is on, the install's key, what is waiting to be sent and how sending went (shareState).
    share: 'xsh:share',
  });

  // chrome.storage.session: a Run now in progress, { startedAt, account }.
  // Session storage empties when the browser closes and when the extension is
  // reloaded or updated, which ends the run.
  const RUN_KEY = 'xsh:run';

  const LABEL_PREFIX = 'xsh:label:';
  const LABELS = Object.freeze(['slop', 'not_slop']);

  function normalizeHandle(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (s.startsWith('@')) s = s.slice(1);
    s = s.toLowerCase();
    return HANDLE_RE.test(s) ? s : null;
  }

  // One handle per line. Blank lines and lines starting with '#' or '!' are
  // comments. Anything else that is not a valid handle counts as rejected.
  function parseList(text, opts) {
    const maxHandles = (opts && opts.maxHandles) || DEFAULTS.maxHandles;
    const seen = new Set();
    let rejected = 0;
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('!')) continue;
      const h = normalizeHandle(t);
      if (h) seen.add(h);
      else rejected++;
      if (seen.size > maxHandles) {
        return { handles: [], rejected, error: 'too many handles' };
      }
    }
    return { handles: [...seen].sort(), rejected, error: null };
  }

  // An NDJSON export (clankwall's, levelsio's): one JSON object per line,
  // whose `username` is the handle. Blank lines are skipped; a line that is
  // not JSON, or has no username that is a handle, counts as rejected. With
  // opts.keep, a row it returns false for is left out and not counted as
  // rejected: a filter that keeps a few rows of many is not a broken feed.
  // Same limit and return shape as parseList.
  function parseNdjsonUsernames(text, opts) {
    const maxHandles = (opts && opts.maxHandles) || DEFAULTS.maxHandles;
    const keep = opts && typeof opts.keep === 'function' ? opts.keep : null;
    const seen = new Set();
    let rejected = 0;
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let h = null;
      let row = null;
      try {
        const o = JSON.parse(t);
        if (o && typeof o === 'object' && typeof o.username === 'string') {
          h = normalizeHandle(o.username);
          row = o;
        }
      } catch (e) {
        // not JSON: rejected below
      }
      if (!h) rejected++;
      else if (!keep || keep(row)) seen.add(h);
      if (seen.size > maxHandles) {
        return { handles: [], rejected, error: 'too many handles' };
      }
    }
    return { handles: [...seen].sort(), rejected, error: null };
  }

  // The rows of levelsio's accounts.ndjson that Recommended takes: the
  // "confirmed" tier (blocked with a public reply) with at least one evidence
  // item, the link to that reply. The file's other tiers carry no evidence.
  function levelsioConfirmed(row) {
    return row.levelsio === 'confirmed' && Array.isArray(row.evidence) && row.evidence.length > 0;
  }

  // The NDJSON list formats, each with the rows it keeps (null: every row).
  // Any other format is plain text, one handle per line.
  // crowd-ndjson is the readers' list AI Anti-Slop's server publishes: one
  // { username, reporters, since } per line, every row listed.
  const NDJSON_FORMATS = Object.freeze({ 'clankwall-ndjson': null, 'levelsio-confirmed': levelsioConfirmed, 'crowd-ndjson': null });
  const isNdjson = (format) => Object.prototype.hasOwnProperty.call(NDJSON_FORMATS, format);

  function acceptUpdate(prevHandles, nextHandles, opts) {
    const ratio = (opts && opts.minShrinkRatio) || DEFAULTS.minShrinkRatio;
    const floor = (opts && opts.shrinkGuardFloor) || DEFAULTS.shrinkGuardFloor;
    const prevCount = prevHandles ? prevHandles.length : 0;
    // A source that may be empty (opts.allowEmpty: the readers' list, empty
    // until reports agree) is taken empty only while its stored copy is too
    // small for the shrink guard: an empty answer never wipes a list of size.
    if (!nextHandles || nextHandles.length === 0) {
      if (opts && opts.allowEmpty && prevCount < floor) return { ok: true, reason: null };
      return { ok: false, reason: 'empty list' };
    }
    if (prevCount >= floor && nextHandles.length < prevCount * ratio) {
      return { ok: false, reason: `list shrank from ${prevCount} to ${nextHandles.length}` };
    }
    return { ok: true, reason: null };
  }

  function isDue(fetchedAt, now, refreshMinutes) {
    const minutes = refreshMinutes || DEFAULTS.refreshMinutes;
    if (!fetchedAt) return true;
    return now - fetchedAt >= minutes * 60 * 1000;
  }

  // Fetch and validate a feed. fetchImpl is the platform fetch (or a GM
  // wrapper). Never throws: returns { ok, handles, rejected } or { ok:false, reason }.
  // args.format is 'text' (one handle per line, the default) or one of
  // NDJSON_FORMATS; the size cap defaults to match. With args.sources, the
  // list is made of several feeds (fetchSources).
  async function fetchList(args) {
    if (Array.isArray(args.sources)) return fetchSources(args);
    const url = args.url || DEFAULTS.feedUrl;
    const fetchImpl = args.fetchImpl;
    const ndjson = isNdjson(args.format);
    const maxBytes = args.maxBytes || (ndjson ? DEFAULTS.ndjsonMaxBytes : DEFAULTS.maxBytes);
    let res;
    try {
      const init = { cache: 'no-store', credentials: 'omit' };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        init.signal = AbortSignal.timeout(args.timeoutMs || DEFAULTS.timeoutMs);
      }
      res = await fetchImpl(url, init);
    } catch (e) {
      return { ok: false, reason: `network error: ${(e && e.message) || e}` };
    }
    if (!res || !res.ok) return { ok: false, reason: `HTTP ${res ? res.status : '?'}` };
    const ctype = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/html/i.test(ctype)) return { ok: false, reason: `unexpected content-type ${ctype}` };
    let text;
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, reason: `read error: ${(e && e.message) || e}` };
    }
    if (text.length > maxBytes) return { ok: false, reason: `feed larger than ${maxBytes} bytes` };
    const parsed = ndjson
      ? parseNdjsonUsernames(text, { maxHandles: args.maxHandles, keep: NDJSON_FORMATS[args.format] })
      : parseList(text, { maxHandles: args.maxHandles });
    if (parsed.error) return { ok: false, reason: parsed.error };
    if (parsed.rejected > parsed.handles.length) {
      return { ok: false, reason: `feed is mostly not handles (${parsed.rejected} invalid lines)` };
    }
    const verdict = acceptUpdate(args.prevHandles, parsed.handles, args);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    return { ok: true, handles: parsed.handles, rejected: parsed.rejected };
  }

  // Fetch a list made of several feeds (Recommended). Each source is fetched
  // and checked as a list of its own, against its own part of the stored
  // record (args.prevParts): a source that comes back empty or shrunk is
  // refused even when the others would keep the union's count up. A refused
  // source keeps its previous part (none: no handles) while the others
  // update, and the result's reason names each refused source's host. Only
  // when every source is refused is the update refused. On success the
  // handles are the union, and parts holds { source, handles } for each
  // source, in order.
  async function fetchSources(args) {
    const prev = Array.isArray(args.prevParts) ? args.prevParts : [];
    const was = args.sources.map((src) => prev.find((p) => p && p.source === src.url) || null);
    const results = await Promise.all(
      args.sources.map((src, i) =>
        fetchList({
          url: src.url,
          format: src.format,
          fetchImpl: args.fetchImpl,
          prevHandles: was[i] && was[i].handles,
          timeoutMs: args.timeoutMs,
          allowEmpty: src.allowEmpty === true,
        }),
      ),
    );
    const hostOf = (u) => {
      try {
        return new URL(u).host;
      } catch (e) {
        return u;
      }
    };
    const failures = results.map((r, i) => (r.ok ? null : `${hostOf(args.sources[i].url)}: ${r.reason}`)).filter(Boolean);
    if (failures.length === results.length) return { ok: false, reason: failures.join('; ') };
    const parts = results.map((r, i) => ({
      source: args.sources[i].url,
      handles: r.ok ? r.handles : (was[i] && Array.isArray(was[i].handles) ? was[i].handles : []),
    }));
    return { ok: true, handles: unionHandles(parts), parts, rejected: 0, reason: failures.length ? failures.join('; ') : null };
  }

  // Merge a fetch result into the stored record. A failed fetch keeps the
  // previous handles (and parts) and fetchedAt and records why it failed.
  function nextRecord(prev, result, url, now) {
    const base = prev || { handles: [], fetchedAt: 0, source: url };
    if (result.ok) {
      // A list of several sources may succeed with some refused (reason
      // names them): those kept their previous parts, and the record says why
      // and is marked partial, since the rest did update.
      const rec = { handles: result.handles, fetchedAt: now, source: url, lastAttemptAt: now, lastError: result.reason || null };
      if (result.parts) rec.parts = result.parts;
      if (result.reason) rec.partial = true;
      return rec;
    }
    const failed = Object.assign({}, base, { lastAttemptAt: now, lastError: result.reason });
    delete failed.partial;
    return failed;
  }

  // Commit a refresh against the record stored right now, not the one read
  // before the fetch. `seq` counts successful commits; startSeq is the value
  // read when the refresh began. If a newer refresh succeeded meanwhile, this
  // result is stale and is dropped (null: write nothing), so an older failed
  // or older successful fetch can never overwrite a newer list.
  function commitRecord(latest, result, url, startSeq, now) {
    const seq = (latest && latest.seq) || 0;
    if (seq > (startSeq || 0)) return null;
    const rec = nextRecord(latest, result, url, now);
    rec.seq = result.ok ? seq + 1 : seq;
    return rec;
  }

  // Due for a refresh: the list is older than the refresh interval, and the
  // last attempt (a failure, if the list is old) is older than the retry gap.
  function isRefreshDue(rec, now) {
    if (!isDue(rec && rec.fetchedAt, now, DEFAULTS.refreshMinutes)) return false;
    const last = rec && rec.lastAttemptAt;
    return !last || now - last >= DEFAULTS.retryMinutes * 60 * 1000;
  }

  function parseAllowlist(text) {
    const out = new Set();
    for (const tok of String(text || '').split(/[\s,]+/)) {
      const h = normalizeHandle(tok);
      if (h) out.add(h);
    }
    return out;
  }

  // ----------------------------------------------------------------- lists
  //
  // The lists AI Anti-Slop hides from. Three come with it; the user may switch
  // them on or off and add up to customListMax more by address. Muting reads
  // only MUTE_LIST: every other list hides replies and nothing more.
  const BUILTIN_LISTS = Object.freeze([
    // AI Anti-Slop's own pick, on by default: two of the lists below, as
    // their published files are fetched, plus the readers' list, which AI
    // Anti-Slop's server builds from the labels its users chose to share
    // (sharing, below). That server is the only list this project hosts; it
    // may be empty, so its part is allowed to be (allowEmpty). Fetched by the
    // extension alone (userscript: false): the userscript's @connect names
    // clankwall's host only. Its record keeps each source's handles (parts)
    // beside the union.
    Object.freeze({
      id: 'recommended', name: 'Recommended', format: 'recommended', on: true, mute: false, userscript: false,
      url: 'https://blockedforaireply.levels.io/api/accounts.ndjson',
      sources: Object.freeze([
        Object.freeze({ url: DEFAULTS.feedUrl, format: 'text', name: 'clankwall', noteName: "clankwall's AI flags", about: 'https://clankwall.vogel.dev/?filter=ai' }),
        Object.freeze({ url: 'https://blockedforaireply.levels.io/api/accounts.ndjson', format: 'levelsio-confirmed', name: 'levelsio', noteName: "levelsio's list", about: 'https://blockedforaireply.levels.io/' }),
        Object.freeze({
          url: `${DEFAULTS.crowdBase}/v1/list.ndjson`,
          format: 'crowd-ndjson',
          name: "the readers' list",
          noteName: "the readers' list",
          about: `${DEFAULTS.crowdBase}/`,
          aboutText: "The readers' list page, with how it is made and where you can ask for a removal",
          allowEmpty: true,
        }),
      ]),
      about: null,
      note: "AI Anti-Slop's pick: clankwall's AI flags; the accounts @levelsio blocked with a public reply, each linked on levelsio's page; and the readers' list, the accounts three or more AI Anti-Slop readers who share their labels reported as slop. Both sites say their flags are not proof, and the readers' list counts reports, which are not proof either. Hides replies only; muting uses clankwall's AI flags.",
    }),
    Object.freeze({
      id: 'clankwall-ai', name: 'clankwall: AI flags', format: 'text', on: true, mute: true,
      about: 'https://clankwall.vogel.dev/?filter=ai',
      note: 'Accounts whose replies clankwall scored as AI. Muting uses this list. Recommended includes it, so while Recommended is on, switching this off hides no fewer replies.',
    }),
    Object.freeze({
      id: 'clankwall-all', name: 'clankwall: All flags', format: 'clankwall-ndjson', on: false, mute: false,
      url: 'https://clankwall.vogel.dev/api/accounts.ndjson',
      about: 'https://clankwall.vogel.dev/',
      note: 'Every account clankwall flagged, AI or spam, mostly crypto spam. About half of those not on the AI list rest on a single flag, so expect some mistakes. Hides replies only.',
    }),
    // Fetched by the extension alone (userscript: false): the userscript's
    // @connect names clankwall's host only.
    Object.freeze({
      id: 'levelsio', name: 'levelsio: Blocked for AI reply', format: 'text', on: false, mute: false, userscript: false,
      url: 'https://blockedforaireply.levels.io/api/usernames.txt',
      about: 'https://blockedforaireply.levels.io/',
      note: 'Accounts @levelsio blocked, plus accounts clankwall flagged as AI. Some were blocked with a public "Blocked for AI reply" reply; most without one, many of them older blocks not yet reviewed. The list\'s page calls its flags judgment calls, not proof. Recommended includes the ones blocked with a public reply. Hides replies only.',
    }),
  ]);
  const MUTE_LIST = 'clankwall-ai';
  // For the note that stands in for a hidden post: the name of the first list
  // that is on and holds each account, as { handle: name }. `records` maps a
  // list's storage key (listKey) to its stored record. A list made of several
  // sources (Recommended) is named by the source whose file holds the account
  // (its noteName), when the record keeps its parts. A list added by address
  // is named only "a list you added": the note is in x.com's page, where X's
  // scripts can read it, and the address may hold a token. Only handles are
  // read, so the name never says how many readers reported an account.
  function listNamesOf(settings, records) {
    const out = {};
    const recs = records || {};
    for (const l of enabledLists(settings)) {
      const rec = recs[listKey(l.id)];
      if (!rec) continue;
      const claim = (handles, name) => {
        if (!Array.isArray(handles)) return;
        for (const h of handles) if (typeof h === 'string' && h !== '__proto__' && !Object.prototype.hasOwnProperty.call(out, h)) out[h] = name;
      };
      if (l.sources && Array.isArray(rec.parts)) {
        for (const src of l.sources) {
          const part = rec.parts.find((p) => p && p.source === src.url);
          if (part) claim(part.handles, src.noteName || src.name);
        }
      } else {
        claim(rec.handles, l.builtin ? l.name : 'a list you added');
      }
    }
    return out;
  }

  // The built-in lists the userscript can fetch: its @connect names
  // clankwall's host alone.
  const USERSCRIPT_LISTS = new Set(BUILTIN_LISTS.filter((b) => b.userscript !== false).map((b) => b.id));

  // Where a list's record is stored. The AI list keeps the key it has always
  // had, so nothing is migrated; every other list is xsh:list:<id>.
  function listKey(id) {
    return id === MUTE_LIST ? STORAGE_KEYS.list : `${STORAGE_KEYS.list}:${id}`;
  }

  // Whether a storage key holds a list record (xsh:label:* and
  // xsh:labelCount do not start with xsh:list).
  function isListKey(k) {
    return typeof k === 'string' && (k === STORAGE_KEYS.list || k.startsWith(`${STORAGE_KEYS.list}:`));
  }

  // Check an address the user typed for a list: https only, no password in
  // it, no #fragment, and not absurdly long. Returns { ok: true, url } with
  // the cleaned address, or { ok: false, reason } in plain words.
  function checkListUrl(raw) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) return { ok: false, reason: 'Type the address of a list.' };
    let u;
    try {
      u = new URL(t);
    } catch (e) {
      return { ok: false, reason: 'That is not a web address.' };
    }
    if (u.protocol !== 'https:') return { ok: false, reason: 'Use an address that starts with https://' };
    if (u.username || u.password) return { ok: false, reason: 'Leave the user name and password out of the address.' };
    u.hash = '';
    const url = u.href;
    if (url.length > DEFAULTS.listUrlMax) {
      return { ok: false, reason: `The address is longer than ${DEFAULTS.listUrlMax} characters.` };
    }
    return { ok: true, url };
  }

  const CUSTOM_ID_RE = /^u[a-z0-9]{1,16}$/;

  // The lists the user added, as stored settings hold them, with every
  // malformed entry dropped: not an object, a bad id or address, a repeated
  // id. At most customListMax are kept, in stored order. Each comes back as
  // { id, url, on } with the cleaned address.
  function customListsOf(settings) {
    const raw = settings && settings.customLists;
    const out = [];
    if (!Array.isArray(raw)) return out;
    const ids = new Set();
    for (const c of raw) {
      if (out.length >= DEFAULTS.customListMax) break;
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !CUSTOM_ID_RE.test(c.id) || ids.has(c.id)) continue;
      const chk = checkListUrl(c.url);
      if (!chk.ok) continue;
      ids.add(c.id);
      out.push({ id: c.id, url: chk.url, on: c.on !== false });
    }
    return out;
  }

  // Every list, built-ins first and then the user's own in stored order, as
  // { id, name, url, format, sources, on, builtin, mute, locked, about, note }.
  // A built-in is on by its own default (`on`) until the user switches it;
  // the AI list is also on, and locked on, while muting is on, because
  // muting reads it.
  function subscriptions(settings) {
    const s = settings || {};
    const chosen = s.lists && typeof s.lists === 'object' && !Array.isArray(s.lists) ? s.lists : {};
    const out = [];
    for (const b of BUILTIN_LISTS) {
      let on;
      let locked = false;
      if (b.id === MUTE_LIST) {
        locked = mutingOn(s);
        on = locked || chosen[b.id] !== false;
      } else {
        on = b.on ? chosen[b.id] !== false : chosen[b.id] === true;
      }
      const url = b.id === MUTE_LIST ? s.feedUrl || DEFAULTS.feedUrl : b.url;
      out.push({ id: b.id, name: b.name, url, format: b.format, sources: b.sources || null, on, builtin: true, mute: b.mute, locked, about: b.about, note: b.note });
    }
    for (const c of customListsOf(s)) {
      const u = new URL(c.url);
      out.push({
        id: c.id,
        // The query too, so two addresses that differ only there get two names.
        name: u.host + u.pathname + u.search,
        url: c.url,
        format: 'text',
        sources: null,
        on: c.on,
        builtin: false,
        mute: false,
        locked: false,
        about: c.url,
        note: null,
      });
    }
    return out;
  }

  // The lists that are on. With opts.userscript, only those the userscript
  // can fetch (USERSCRIPT_LISTS): it cannot reach any other address.
  function enabledLists(settings, opts) {
    const userscript = !!(opts && opts.userscript);
    return subscriptions(settings).filter((l) => l.on && !(userscript && !USERSCRIPT_LISTS.has(l.id)));
  }

  // The settings change that adds a list by address, or why it is refused:
  // past customListMax lists, an address some list already uses (the built-in
  // ones included) or an address checkListUrl refuses. The new id is "u" and
  // the time in base 36, made unique if taken.
  function addListPatch(settings, raw, now) {
    const chk = checkListUrl(raw);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const custom = customListsOf(settings);
    if (custom.length >= DEFAULTS.customListMax) {
      return { ok: false, reason: `You can add at most ${DEFAULTS.customListMax} lists. Remove one first.` };
    }
    const subs = subscriptions(settings);
    if (subs.some((l) => l.url === chk.url)) return { ok: false, reason: 'That list is already here.' };
    const taken = new Set(subs.map((l) => l.id));
    let id = `u${Number(now).toString(36)}`;
    while (taken.has(id)) id += 'x';
    id = id.slice(0, 17);
    while (taken.has(id)) id = `${id.slice(0, 16)}${Math.floor(Math.random() * 36).toString(36)}`;
    return { ok: true, patch: { customLists: [...custom, { id, url: chk.url, on: true }] }, id };
  }

  // The settings change that removes one added list, or null when there is none by that id.
  function removeListPatch(settings, id) {
    const custom = customListsOf(settings);
    if (!custom.some((c) => c.id === id)) return null;
    return { customLists: custom.filter((c) => c.id !== id) };
  }

  // The settings change that switches one list on or off: a built-in's goes
  // in settings.lists, an added list's in its own entry. The AI list cannot
  // be switched off while muting is on.
  function listOnPatch(settings, id, on) {
    const s = settings || {};
    const sub = subscriptions(s).find((l) => l.id === id);
    if (!sub) return { ok: false, reason: 'There is no such list.' };
    if (id === MUTE_LIST && !on && sub.locked) {
      return { ok: false, reason: 'Muting uses this list, so it stays on while muting is on.' };
    }
    if (sub.builtin) {
      const lists = s.lists && typeof s.lists === 'object' && !Array.isArray(s.lists) ? s.lists : {};
      return { ok: true, patch: { lists: Object.assign({}, lists, { [id]: !!on }) } };
    }
    return { ok: true, patch: { customLists: customListsOf(s).map((c) => (c.id === id ? Object.assign({}, c, { on: !!on }) : c)) } };
  }

  // What a settings change did to the lists: `on` holds the ids that are on
  // now and were not before, or whose address changed (they need a fetch);
  // `gone` the added lists that were removed (their records can go).
  function listChanges(oldSettings, newSettings) {
    const before = new Map(subscriptions(oldSettings).map((l) => [l.id, l]));
    const after = subscriptions(newSettings);
    const now = new Set(after.map((l) => l.id));
    const on = after
      .filter((l) => {
        const was = before.get(l.id);
        return l.on && !(was && was.on && was.url === l.url);
      })
      .map((l) => l.id);
    const gone = [...before.values()].filter((l) => !l.builtin && !now.has(l.id)).map((l) => l.id);
    return { on, gone };
  }

  // The sorted, de-duplicated handles of every record given. A record may be
  // missing or have no handles.
  function unionHandles(records) {
    const out = new Set();
    for (const r of records || []) {
      if (r && Array.isArray(r.handles)) for (const h of r.handles) out.add(h);
    }
    return [...out].sort();
  }

  // ------------------------------------------------------------------ bots
  //
  // Accounts that answer when a post tags them. People who tag one in a
  // thread may want its answer, so each has its own row in the popup: Show,
  // Hide here, or Mute on X. A bot with no choice saved follows the list:
  // hidden when the list (or the user's extra accounts) has it, shown when
  // not, and never muted. clankwall listed only @grok on 2026-11-06.
  const GROK = 'grok';
  const BOTS = Object.freeze(
    [
      { handle: 'grok', name: 'grok', note: "X's assistant" },
      { handle: 'askperplexity', name: 'AskPerplexity', note: "Perplexity's answer bot" },
      { handle: 'pangram', name: 'pangram', note: 'AI-text detector' },
      { handle: 'bot', name: 'bot', note: "xAI's Grok Bot" },
      { handle: 'threadreaderapp', name: 'threadreaderapp', note: 'thread unroller' },
      { handle: 'unrollhelper', name: 'UnrollHelper', note: 'thread unroller' },
    ].map((b) => Object.freeze(b)),
  );
  const BOT_HANDLES = new Set(BOTS.map((b) => b.handle));
  const BOT_MODES = Object.freeze(['show', 'hide', 'mute']);

  // The choice saved for one bot, or null. 0.3.0's showGrok switch counts as
  // choosing Show for @grok until its row is changed. Read only: nothing
  // here rewrites stored settings.
  function botChoice(settings, handle) {
    const s = settings || {};
    const saved = s.bots && typeof s.bots === 'object' ? s.bots[handle] : undefined;
    if (BOT_MODES.includes(saved)) return saved;
    if (handle === GROK && s.showGrok === true) return 'show';
    return null;
  }

  // Each bot's mode as it applies now, keyed by handle: the saved choice,
  // else what the list says. An Always-show entry wins over both.
  function botModes(settings, listHandles) {
    const s = settings || {};
    const listed = new Set(listHandles || []);
    for (const h of parseAllowlist(s.extraList)) listed.add(h);
    const allow = parseAllowlist(s.allowlist);
    const out = {};
    for (const { handle } of BOTS) {
      out[handle] = allow.has(handle) ? 'show' : botChoice(s, handle) || (listed.has(handle) ? 'hide' : 'show');
    }
    return out;
  }

  // Handles that are never hidden: the user's allowlist, plus each bot whose
  // row is set to Show. A bot row adds only that bot, never a wider allow.
  function effectiveAllow(settings) {
    const out = parseAllowlist(settings && settings.allowlist);
    for (const { handle } of BOTS) if (botChoice(settings, handle) === 'show') out.add(handle);
    return out;
  }

  // Handles whose posts are hidden: the list, the user's extra accounts,
  // and each bot whose row is set to Hide or Mute. effectiveAllow still wins.
  function effectiveList(listHandles, settings) {
    const out = new Set(listHandles || []);
    for (const h of parseAllowlist(settings && settings.extraList)) out.add(h);
    for (const { handle } of BOTS) {
      const c = botChoice(settings, handle);
      if (c === 'hide' || c === 'mute') out.add(handle);
    }
    return out;
  }

  // Bots whose tags hide a post: those hidden or muted now, when the user
  // has turned on hiding posts that tag them. Empty otherwise.
  function mentionTargets(settings, listHandles) {
    const out = new Set();
    if (!(settings && settings.hideBotMentions === true)) return out;
    const modes = botModes(settings, listHandles);
    for (const h of Object.keys(modes)) if (modes[h] !== 'show') out.add(h);
    return out;
  }

  // True when el sits inside a [role="link"] container below article, which is
  // how X renders a quoted post. Bounded at article so an ancestor outside the
  // post can never change the answer.
  function insideQuoteCard(el, article) {
    for (let n = el.parentElement; n && n !== article; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('role') === 'link') return true;
    }
    return false;
  }

  // What x.com/<handle> says when the account is gone, or null for any other
  // page. Gone means deleted or deactivated ("This account doesn't exist") or
  // suspended ("Account suspended"), and the value is X's heading, such as
  // those. On 2026-11-19 such a profile had an emptyState box, no profile
  // header (no UserName, no userActions ⋯ button) and a tab title with no
  // "(@handle)". A live profile, one behind X's "temporarily restricted"
  // caution page, and one whose lookup X refused ("Something went wrong")
  // each lacked at least one of these, so it takes all of them.
  function profileGone(doc) {
    if (!doc || !doc.querySelector) return null;
    const col = doc.querySelector('[data-testid="primaryColumn"]') || doc;
    const box = col.querySelector('[data-testid="emptyState"]');
    if (!box) return null;
    if (col.querySelector('[data-testid="UserName"], [data-testid="userActions"]')) return null;
    if (/\(@[A-Za-z0-9_]{1,15}\)/.test(String(doc.title || ''))) return null;
    const head = box.querySelector('[data-testid="empty_state_header_text"]') || box;
    const text = String(head.textContent || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 80) || 'no account at this address';
  }

  // The handle of the account that wrote this post, lowercased, or null.
  // It reads the first User-Name block that is not inside a quote card, so
  // quoted posts and @-mentions never count as the author.
  function authorHandleOf(article) {
    if (!article || !article.querySelectorAll) return null;
    for (const un of article.querySelectorAll('[data-testid="User-Name"]')) {
      if (insideQuoteCard(un, article)) continue;
      for (const a of un.querySelectorAll('a[href]')) {
        const m = PROFILE_HREF_RE.exec(a.getAttribute('href') || '');
        if (m) return m[1].toLowerCase();
      }
      return null;
    }
    return null;
  }

  // The handle whose profile or permalink this page is (/<handle>, /<handle>/status/…).
  function pageOwner(pathname) {
    const first = String(pathname || '').split('/')[1] || '';
    const h = first.toLowerCase();
    return HANDLE_RE.test(h) ? h : null;
  }

  function shouldHide(author, ctx) {
    if (!author || ctx.paused) return false;
    if (!ctx.list.has(author)) return false;
    if (ctx.allow && ctx.allow.has(author)) return false;
    // A listed account's own profile or post page was opened on purpose.
    if (ctx.owner && ctx.owner === author) return false;
    return true;
  }

  // The first bot in `targets` that this post tags in its own text, or null.
  // A tag is an @-link in the post's own tweetText; text inside a quoted post
  // and the "Replying to" line (which X draws outside tweetText) do not count.
  function mentionIn(article, targets) {
    if (!article || !article.querySelectorAll || !targets || targets.size === 0) return null;
    for (const t of article.querySelectorAll('[data-testid="tweetText"]')) {
      if (insideQuoteCard(t, article)) continue;
      for (const a of t.querySelectorAll('a[href]')) {
        const m = PROFILE_HREF_RE.exec(a.getAttribute('href') || '');
        if (m && targets.has(m[1].toLowerCase())) return m[1].toLowerCase();
      }
    }
    return null;
  }

  // Whether a post by `author` that tags the bot `mentioned` is hidden. Never
  // the user's own posts, an Always-show author's, or anything on the page of
  // the author or of a tagged bot, since that page was opened on purpose.
  function shouldHideMention(author, mentioned, ctx) {
    if (!mentioned || !author || ctx.paused) return false;
    if (ctx.allow && ctx.allow.has(author)) return false;
    if (ctx.me && ctx.me === author) return false;
    if (ctx.owner && (ctx.owner === author || (ctx.mentions && ctx.mentions.has(ctx.owner)))) return false;
    return true;
  }

  // ---------------------------------------------------------------- muting

  // Whether muting is on: switched on and for an account. Every read that
  // means "muting is on" goes through this one test.
  function mutingOn(settings) {
    const s = settings;
    return !!(s && s.muteEnabled && s.muteAccount);
  }

  function utcDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Which item of a post's ⋯ menu to click, from the item labels X showed
  // (2026-11-06): "mute" on a listed account's post, "unmute" once muted,
  // "unfollow @h" when the user follows it, and a separate "mute this
  // conversation" that must never match. Returns
  //   { action: 'click', index }                 the one exact Mute item
  //   { action: 'done', status: 'already' }      already muted: nothing to click
  //   { action: 'refuse', status, reason, stopDay }
  function chooseMuteItem(items, handle) {
    const labels = (items || []).map(norm);
    const h = String(handle || '').toLowerCase();
    if (labels.some((l) => l === 'unmute' || l === `unmute @${h}`)) return { action: 'done', status: 'already' };
    if (labels.some((l) => l === `unfollow @${h}`)) {
      return { action: 'refuse', status: 'followed', reason: `you follow @${h}`, stopDay: false };
    }
    const hits = labels.map((l, i) => (l === 'mute' || l === `mute @${h}` ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) {
      return {
        action: 'refuse',
        status: 'refused',
        reason: `${hits.length} exact Mute items in the menu [${labels.join(' | ')}]`,
        stopDay: true,
      };
    }
    return { action: 'click', index: hits[0] };
  }

  // Which item of a post's ⋯ menu undoes a mute AI Anti-Slop made: the one
  // exact Unmute item ("unmute" on 2026-11-06, or "unmute @h"), never "unmute
  // this conversation". A menu that offers Mute instead means the account is
  // no longer muted. Returns
  //   { action: 'click', index }                 the one exact Unmute item
  //   { action: 'done', status: 'not-muted' }    not muted: nothing to click
  //   { action: 'refuse', status, reason, stopDay }
  function chooseUnmuteItem(items, handle) {
    const labels = (items || []).map(norm);
    const h = String(handle || '').toLowerCase();
    const hits = labels.map((l, i) => (l === 'unmute' || l === `unmute @${h}` ? i : -1)).filter((i) => i >= 0);
    const mute = labels.some((l) => l === 'mute' || l === `mute @${h}`);
    if (hits.length === 1 && !mute) return { action: 'click', index: hits[0] };
    if (hits.length === 0 && mute) return { action: 'done', status: 'not-muted' };
    return {
      action: 'refuse',
      status: 'refused',
      reason: `${hits.length} exact Unmute items${mute ? ' and a Mute item' : ''} in the menu [${labels.join(' | ')}]`,
      stopDay: true,
    };
  }

  // A fresh record of what muting has done: per account and per UTC day.
  function emptyMutes() {
    return { handles: {}, days: {}, front: [], nextAt: 0, sinceCheck: [] };
  }

  // The record is keyed by handle, and '__proto__' and 'constructor' pass
  // HANDLE_RE, so entries are read and written as own properties only.
  function entryOf(r, h) {
    return r.handles && Object.prototype.hasOwnProperty.call(r.handles, h) ? r.handles[h] : undefined;
  }

  function setEntry(r, h, e) {
    Object.defineProperty(r.handles, h, { value: e, enumerable: true, writable: true, configurable: true });
  }

  // Statuses that end work on an account. 'error' does not, until it has
  // happened muteMaxAttempts times, and neither does a first 'no-post': on
  // 2026-11-06, 3 of 4 profiles showed their first post before its ⋯ button.
  // 'gone' (deleted or suspended) settles at once and is never visited again.
  const SETTLED = new Set(['muted', 'already', 'followed', 'no-post', 'failed', 'gone']);

  function isSettled(st) {
    if (!st || !SETTLED.has(st.status)) return false;
    if (st.status === 'no-post') return (st.attempts || 1) >= DEFAULTS.muteMaxAttempts;
    return true;
  }

  // Accounts muting may visit, in order: the list, then the user's extra
  // accounts, then bots whose row is set to Mute on X. Never an Always-show
  // account, and never a bot whose row says anything else: muting one
  // account-wide is a much bigger step than hiding its replies, so a bot is
  // muted only when the user picked that for it.
  function muteEligible(listHandles, settings) {
    const allow = parseAllowlist(settings && settings.allowlist);
    const extra = [...parseAllowlist(settings && settings.extraList)].sort();
    const bots = BOTS.map((b) => b.handle).filter((h) => botChoice(settings, h) === 'mute');
    const out = [];
    const seen = new Set();
    for (const h of [...(listHandles || []), ...extra, ...bots]) {
      if (seen.has(h)) continue;
      seen.add(h);
      if (allow.has(h)) continue;
      if (BOT_HANDLES.has(h) && botChoice(settings, h) !== 'mute') continue;
      out.push(h);
    }
    return out;
  }

  // Accounts to visit, in order: those seen while browsing first, then the
  // rest of muteEligible, then accounts being tried again. Never an account
  // already settled.
  function muteCandidates(listHandles, settings, rec) {
    const r = rec || emptyMutes();
    const eligible = muteEligible(listHandles, settings);
    const ok = new Set(eligible);
    const fresh = [];
    const retry = [];
    const seen = new Set();
    for (const h of [...(r.front || []), ...eligible]) {
      if (seen.has(h)) continue;
      seen.add(h);
      if (!ok.has(h)) continue;
      const st = entryOf(r, h);
      if (isSettled(st)) continue;
      // An account it unmuted cleanly that is wanted again is not a failed
      // try, so it goes with the accounts not visited yet.
      const cleared = st && (st.status === 'unmuted' || st.status === 'not-muted');
      (st && !cleared ? retry : fresh).push(h);
    }
    return [...fresh, ...retry];
  }

  // Accounts to unmute, oldest mute first: ones AI Anti-Slop muted itself, as
  // the account muting is on for now, that muteEligible no longer picks (off
  // the list and not in Also hide, moved to Always show, or a bot whose row
  // left Mute on X). Never an account it found already muted: the user muted
  // that one. None at all while the stored list is empty, so a first fetch
  // that failed never reads as every account leaving the list. An account
  // whose unmute failed muteMaxAttempts times stays muted.
  function unmuteCandidates(listHandles, settings, rec) {
    const account = settings && settings.muteAccount;
    if (!account || !listHandles || listHandles.length === 0) return [];
    const r = rec || emptyMutes();
    const eligible = new Set(muteEligible(listHandles, settings));
    const out = [];
    for (const h of Object.keys(r.handles || {})) {
      const e = entryOf(r, h);
      if (!e || e.status !== 'muted' || e.account !== account || eligible.has(h)) continue;
      if ((e.unmuteAttempts || 0) >= DEFAULTS.muteMaxAttempts) continue;
      out.push(h);
    }
    return out.sort((a, b) => (entryOf(r, a).at || 0) - (entryOf(r, b).at || 0) || (a < b ? -1 : 1));
  }

  // The outcomes a visit's page can report, by job kind. Any other status
  // counts as an error, one of the account's muteMaxAttempts, so no reply can
  // keep an account waiting for ever; Run now has no visit cap to bound that.
  const JOB_STATUSES = Object.freeze({
    mute: Object.freeze(['muted', 'already', 'followed', 'no-post', 'gone', 'error', 'refused', 'wrong-account', 'login']),
    unmute: Object.freeze(['unmuted', 'not-muted', 'no-post', 'gone', 'error', 'refused', 'wrong-account', 'login']),
  });
  function jobResult(kind, result) {
    const r = result || {};
    const known = JOB_STATUSES[kind];
    if (!known || known.includes(r.status)) return r;
    return { status: 'error', reason: `unknown result: ${String(r.status).slice(0, 40)}` };
  }

  // Whether a visit's result, already through jobResult, is a miss for
  // muteRunMisses: nothing clicked and nothing learned about the account.
  // 'gone' is not one: the visit learned the account is deleted or suspended,
  // and lists hold runs of those (4 of the 18 visits in one run on 2026-11-19).
  function runMissed(result) {
    return !!result && (result.status === 'error' || result.status === 'no-post');
  }

  // How many accounts Run now would visit: every unmute and mute waiting.
  // Each visit settles its account, counts one of its muteMaxAttempts, or
  // stops the day, so a run over these ends.
  function runWaiting(listHandles, settings, rec) {
    return unmuteCandidates(listHandles, settings, rec).length + muteCandidates(listHandles, settings, rec).length;
  }

  // Mutes recorded before 0.8.0 do not say which account made them. They get
  // the account muting is on for when this version first runs, which made them
  // unless the user switched accounts before updating. Returns the same object
  // when there is nothing to stamp, so the caller writes only on a change.
  function stampAccount(rec, account) {
    const r0 = rec || emptyMutes();
    if (!account) return r0;
    const todo = Object.keys(r0.handles || {}).filter((h) => {
      const e = entryOf(r0, h);
      return e && e.status === 'muted' && !e.account;
    });
    if (!todo.length) return r0;
    const r = structuredCloneish(r0);
    for (const h of todo) entryOf(r, h).account = account;
    return r;
  }

  function dayOf(rec, today) {
    return (rec.days && rec.days[today]) || { mutes: 0, unmutes: 0, visits: 0, stopped: null };
  }

  // The daily mute cap the user picked: 25, 50 or 100. Anything else,
  // including a missing setting, reads as 25, so no stored value can raise
  // the cap past 100.
  function muteCap(settings) {
    const v = settings && settings.muteCap;
    return DEFAULTS.muteCaps.includes(v) ? v : DEFAULTS.muteDailyCap;
  }

  // A cap above the default mutes past the default only while the user has
  // an x.com tab of their own open (visitNeedsXOpen says when).
  function capNeedsXOpen(cap) {
    return cap > DEFAULTS.muteDailyCap;
  }

  // Whether the next visit outside a run needs an x.com tab of the user's
  // own: only at a cap above the default, and only once today is past what
  // the default allows (its mutes, unmutes included, or its visits). Below
  // that a higher cap visits as the default does, so 50 or 100 never visits
  // less than 25 would, and a tab that cannot answer (one left open across an
  // update, cut off from the new worker until it is refreshed) holds back
  // only the mutes past the default.
  function visitNeedsXOpen(rec, today, cap) {
    if (!capNeedsXOpen(cap)) return false;
    const base = muteBudget(rec, today, DEFAULTS.muteDailyCap);
    return !(base.mutesLeft > 0 && base.visitsLeft > 0);
  }

  // What today's caps leave at the given daily cap (the default when cap is
  // not one of muteCaps). Mutes and unmutes share the cap: mutesLeft is what
  // is left of it for either. Visits are capped at twice the cap. `stopped`
  // is set when muting stopped itself for the day (an unexpected menu, a
  // wrong account, a mute not on the list).
  function muteBudget(rec, today, cap) {
    const c = DEFAULTS.muteCaps.includes(cap) ? cap : DEFAULTS.muteDailyCap;
    const d = dayOf(rec || emptyMutes(), today);
    const unmutes = d.unmutes || 0;
    return {
      mutesLeft: Math.max(0, c - d.mutes - unmutes),
      visitsLeft: Math.max(0, 2 * c - d.visits),
      stopped: d.stopped || null,
      mutes: d.mutes,
      unmutes,
      visits: d.visits,
      cap: c,
      visitCap: 2 * c,
    };
  }

  // Fold one visit's outcome into the record (a new object). The visit was
  // already counted when its tab opened. Outcomes:
  //   muted        clicked the Mute item (toast text kept; confirmed later)
  //   already      the menu offered Unmute
  //   followed     the user follows the account: left alone
  //   no-post      no post by the account with a ⋯ button on its profile:
  //                tried once more, then left alone
  //   gone         the profile says the account is deleted or suspended:
  //                left alone from then on (profileGone)
  //   refused      the menu was not one we act on: stops muting for the day
  //   wrong-account, login   the tab is not logged in as the bound account: stops the day
  //   error        timeout, closed tab, a menu that did not open: retried, up to muteMaxAttempts
  // A mute records `account`, the account the job ran as, so it is unmuted
  // only as that account.
  function recordOutcome(rec, handle, outcome, now, account) {
    const r = structuredCloneish(rec || emptyMutes());
    const today = utcDay(now);
    const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
    const prev = entryOf(r, handle) || {};
    const status = outcome.status;
    const entry = { status, at: now };
    if (outcome.reason) entry.reason = String(outcome.reason).slice(0, 200);
    if (status === 'muted') {
      d.mutes += 1;
      if (account) entry.account = account;
      entry.toast = outcome.toast ? String(outcome.toast).slice(0, 120) : null;
      entry.confirmed = null;
      r.sinceCheck = [...(r.sinceCheck || []), handle];
    }
    if (status === 'error') {
      entry.attempts = (prev.attempts || 0) + 1;
      if (entry.attempts >= DEFAULTS.muteMaxAttempts) entry.status = 'failed';
    }
    if (status === 'no-post') entry.attempts = (prev.status === 'no-post' ? prev.attempts || 1 : 0) + 1;
    if (['refused', 'wrong-account', 'login'].includes(status)) {
      d.stopped = `@${handle}: ${status}${outcome.reason ? ` (${String(outcome.reason).slice(0, 160)})` : ''}`;
      // Not settled: the account is tried again on a later day.
      if (status !== 'refused') delete entry.status;
    }
    if (entry.status) setEntry(r, handle, entry);
    r.front = (r.front || []).filter((h) => h !== handle);
    r.days[today] = d;
    return r;
  }

  // Fold one unmute visit's outcome into the record (a new object). The visit
  // was already counted when its tab opened. Outcomes:
  //   unmuted      clicked the Unmute item: counts against today's cap
  //   not-muted    the menu offered Mute: unmuted already, so nothing to click
  //   no-post, error   tried again, up to muteMaxAttempts, then left muted
  //   gone         deleted or suspended, so there is nothing to click: left
  //                muted and not tried again
  //   refused, wrong-account, login   stops the day; tried again on a later day
  // Until an unmute succeeds the entry stays `muted`, so a failed visit never
  // loses the record that AI Anti-Slop made the mute.
  function recordUnmute(rec, handle, outcome, now) {
    const r = structuredCloneish(rec || emptyMutes());
    const today = utcDay(now);
    const d = Object.assign({ mutes: 0, unmutes: 0, visits: 0, stopped: null }, r.days[today]);
    const prev = entryOf(r, handle);
    const status = outcome.status;
    const reason = outcome.reason ? String(outcome.reason).slice(0, 200) : null;
    if (status === 'unmuted') d.unmutes += 1;
    if (prev && prev.status === 'muted') {
      if (status === 'unmuted' || status === 'not-muted') {
        const e = { status, at: now, mutedAt: prev.at || null };
        if (prev.account) e.account = prev.account;
        if (status === 'unmuted') e.toast = outcome.toast ? String(outcome.toast).slice(0, 120) : null;
        setEntry(r, handle, e);
        // No longer muted, so the next check of the muted list has nothing to find.
        r.sinceCheck = (r.sinceCheck || []).filter((x) => x !== handle);
      } else if (status === 'error' || status === 'no-post') {
        prev.unmuteAttempts = (prev.unmuteAttempts || 0) + 1;
        prev.unmuteAt = now;
        if (reason) prev.unmuteReason = reason;
      } else if (status === 'gone') {
        prev.unmuteAttempts = DEFAULTS.muteMaxAttempts;
        prev.unmuteAt = now;
        if (reason) prev.unmuteReason = reason;
      }
    }
    if (['refused', 'wrong-account', 'login'].includes(status)) {
      d.stopped = `@${handle}: ${status === 'refused' ? 'unmute refused' : status}${reason ? ` (${reason.slice(0, 160)})` : ''}`;
    }
    r.days[today] = d;
    return r;
  }

  // Fold a read of settings/muted/all's top rows into the record. Every mute
  // since the last check should be there; one that is not stops muting for
  // the day, because something is not as it looked.
  function recordCheck(rec, rows, now) {
    const r = structuredCloneish(rec || emptyMutes());
    const seen = new Set((rows || []).map((h) => String(h).toLowerCase()));
    const missing = [];
    for (const h of r.sinceCheck || []) {
      const e = entryOf(r, h);
      if (!e || e.status !== 'muted') continue;
      e.confirmed = seen.has(h);
      e.checkedAt = now;
      if (!e.confirmed) missing.push(h);
    }
    r.sinceCheck = [];
    delete r.checkRetry;
    if (missing.length) {
      const today = utcDay(now);
      const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
      d.stopped = `not on settings/muted/all after muting: @${missing.join(', @')}`;
      r.days[today] = d;
    }
    return { rec: r, missing };
  }

  // Fold a check that could not read settings/muted/all into the record (a
  // new object). The mutes since the last check stay waiting for the next
  // one. The first failure sets checkRetry, the time muteCheckRetryMs on
  // when the check, as the same account, may run again (checkWaitMs). The
  // second try failing too stops the day: a failure as that account before
  // muteCheckRetryMs has passed since the try was due. One later than that
  // (the browser was closed, muting was off, the mutes waiting were
  // unmuted) is a first failure again. Kept apart from nextAt, which Run
  // now clears, so pressing Run now does not skip the wait. Only an error
  // (the page did not load, or showed no rows) is tried again: logged out or
  // logged in as another account stops the day at once, as a visit does.
  function recordCheckFailed(rec, result, now, account) {
    const r = structuredCloneish(rec || emptyMutes());
    const res = result || {};
    const why = `settings/muted/all check: ${res.status}${res.reason ? ` (${res.reason})` : ''}`;
    const who = account || null;
    const c = r.checkRetry;
    if (res.status !== 'error' || (c && c.account === who && now < (Number(c.at) || 0) + DEFAULTS.muteCheckRetryMs)) {
      delete r.checkRetry;
      return stopDay(r, now, why);
    }
    r.checkRetry = { at: now + DEFAULTS.muteCheckRetryMs, account: who, reason: why.slice(0, 200) };
    return r;
  }

  // Milliseconds until a failed check may run again as this account; 0 when
  // none is waiting.
  function checkWaitMs(rec, account, now) {
    const c = rec && rec.checkRetry;
    if (!c || c.account !== (account || null)) return 0;
    return Math.max(0, (Number(c.at) || 0) - now);
  }

  // A profile tab was opened: it counts against today's visit cap whatever it finds.
  function countVisit(rec, now) {
    const r = structuredCloneish(rec || emptyMutes());
    const today = utcDay(now);
    const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
    d.visits += 1;
    r.days[today] = d;
    return r;
  }

  // Stop muting until the next UTC day, with the reason the popup shows.
  function stopDay(rec, now, reason) {
    const r = structuredCloneish(rec || emptyMutes());
    const today = utcDay(now);
    const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
    d.stopped = String(reason).slice(0, 200);
    r.days[today] = d;
    return r;
  }

  // Put an account seen while browsing at the front of the queue.
  function noteSighting(rec, handle) {
    const r = structuredCloneish(rec || emptyMutes());
    const front = (r.front || []).filter((h) => h !== handle);
    front.unshift(handle);
    r.front = front.slice(0, DEFAULTS.muteFrontMax);
    return r;
  }

  function structuredCloneish(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // Totals for the popup.
  function muteSummary(rec) {
    const r = rec || emptyMutes();
    const vals = Object.values(r.handles || {});
    return {
      muted: vals.filter((e) => e.status === 'muted').length,
      confirmed: vals.filter((e) => e.status === 'muted' && e.confirmed === true).length,
      notFound: vals.filter((e) => e.status === 'muted' && e.confirmed === false).length,
      unmuted: vals.filter((e) => e.status === 'unmuted').length,
      already: vals.filter((e) => e.status === 'already').length,
      followed: vals.filter((e) => e.status === 'followed').length,
      skipped: vals.filter((e) => e.status === 'no-post' || e.status === 'failed').length,
      gone: vals.filter((e) => e.status === 'gone').length,
    };
  }

  // ---------------------------------------------------------------- labels
  //
  // A label is the user's own call on one reply: slop or not slop. Each is
  // stored under its own key (LABEL_PREFIX + the post id) in the extension's
  // local storage. It leaves the browser in a file the user exports and, only
  // while the user has turned sharing on, as a report (see sharing below),
  // which never carries the post's words.

  // Whether labels are on. They are until the user turns them off: settings
  // that never had the switch (a new install, or one from before labels were
  // on by default) count as on. Any value but true or none at all is off.
  function labelsOn(settings) {
    const v = settings ? settings.labeling : undefined;
    return v === undefined || v === true;
  }

  const STATUS_PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:[/?#]|$)/;
  const X_ORIGIN_RE = /^https:\/\/(?:mobile\.)?(?:x|twitter)\.com(?=\/)/i;

  // Whether an address is a page the content script runs on, as the
  // manifest's matches name them: https, on x.com or twitter.com (or their
  // mobile hosts). Chrome gives a message's sender.url with the host in
  // lower case, so nothing else counts: not x.com.example.com, not http.
  function isXPageUrl(url) {
    return typeof url === 'string' && /^https:\/\/(?:mobile\.)?(?:x|twitter)\.com\//.test(url);
  }

  // The author handle and post id in a post's path or x.com URL
  // (/h/status/123, https://x.com/h/status/123/photo/1), or null.
  function statusOf(href) {
    const p = String(href || '').replace(X_ORIGIN_RE, '');
    const m = STATUS_PATH_RE.exec(p);
    return m ? { handle: m[1].toLowerCase(), id: m[2] } : null;
  }

  const STATUS_PAGE_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/;

  // The post a page is about, when the path is that post's own page
  // (/h/status/123), or null. Its quotes, likes and photo pages
  // (/h/status/123/quotes) are not the post's page.
  function statusPageOf(pathname) {
    const m = STATUS_PAGE_RE.exec(String(pathname || ''));
    return m ? { handle: m[1].toLowerCase(), id: m[2] } : null;
  }

  const statusUrl = (s) => `https://x.com/${s.handle}/status/${s.id}`;

  // Check and trim a label message from a content script. Returns
  // { ok: false, reason } when anything in it is not what a label looks like,
  // { ok: true, id, handle, label: null } for clearing one, else
  // { ok: true, id, handle, label, record } with the record to store. ctx is
  // what is stored now ({ handles, source } of the list, and settings); the
  // record says what the list and the two boxes held before this label.
  function labelRecord(msg, ctx, now) {
    const m = msg || {};
    const label = m.label === null ? null : LABELS.includes(m.label) ? m.label : undefined;
    if (label === undefined) return { ok: false, reason: 'unknown label' };
    const post = statusOf(m.url);
    if (!post) return { ok: false, reason: 'not a post URL' };
    const handle = normalizeHandle(m.handle);
    if (!handle) return { ok: false, reason: 'not a handle' };
    // The account that goes into a box must be the one the post's link names.
    if (handle !== post.handle) return { ok: false, reason: "not the post's author" };
    if (label === null) return { ok: true, id: post.id, handle, label: null };
    const c = ctx || {};
    const s = c.settings || {};
    const page = statusPageOf(m.page);
    const hostOf = (u) => {
      try {
        return new URL(u).host || 'list';
      } catch (e) {
        return 'list';
      }
    };
    // With ctx.lists (the lists that are on, each { id, url, handles }) the
    // account is held when any of them has it; without it, the one list.
    const held = Array.isArray(c.lists) ? c.lists.filter((l) => l && new Set(l.handles || []).has(handle)) : null;
    const handles = Array.isArray(c.lists) ? unionHandles(c.lists) : c.handles;
    const host = held ? (held[0] ? hostOf(held[0].url) : null) : hostOf(c.source || DEFAULTS.feedUrl);
    const text = typeof m.text === 'string' ? Array.from(m.text).slice(0, DEFAULTS.labelTextMax).join('') : '';
    const record = {
      at: now,
      label,
      handle,
      url: statusUrl(post),
      text,
      page: page ? statusUrl(page) : null,
      list: held ? host : new Set(handles || []).has(handle) ? host : null,
      extra: parseAllowlist(s.extraList).has(handle),
      allow: parseAllowlist(s.allowlist).has(handle),
      // Whether AI Anti-Slop hides this account's replies on that page, with
      // hiding not paused. Posts hidden for tagging a bot are not counted.
      hidden: shouldHide(handle, {
        list: effectiveList(handles, s),
        allow: effectiveAllow(s),
        owner: page ? page.handle : null,
        paused: false,
      }),
    };
    // One list can come as several entries, one per source (Recommended).
    if (held) record.lists = [...new Set(held.map((l) => l.id))];
    return { ok: true, id: post.id, handle, label, record };
  }

  // The settings change a label makes, or null for none: slop adds the
  // account to Also hide, not_slop adds it to Always show. Neither takes an
  // account out of a box, and clearing a label changes nothing.
  function labelPatch(settings, handle, label) {
    const field = label === 'slop' ? 'extraList' : label === 'not_slop' ? 'allowlist' : null;
    const h = normalizeHandle(handle);
    if (!field || !h) return null;
    const text = String((settings && settings[field]) || '');
    if (parseAllowlist(text).has(h)) return null;
    const kept = text.replace(/\s+$/, '');
    return { [field]: kept ? `${kept}\n${h}` : h };
  }

  // The label records in a storage snapshot (chrome.storage.local.get(null)),
  // oldest first.
  function labelsFrom(all) {
    const o = all || {};
    return Object.keys(o)
      .filter((k) => k.startsWith(LABEL_PREFIX))
      .map((k) => o[k])
      .filter((r) => r && typeof r === 'object' && LABELS.includes(r.label))
      .sort((a, b) => (a.at || 0) - (b.at || 0));
  }

  // One JSON object per line, ending in a newline when there is any.
  function labelsJsonl(records) {
    const rows = (records || []).map((r) => JSON.stringify(r));
    return rows.length ? `${rows.join('\n')}\n` : '';
  }

  // ---------------------------------------------------------------- sharing
  //
  // Off unless the user turns it on in settings. The switch is the sharing
  // record's own `on` (state.on === true), not a field of xsh:settings: the
  // popup and the settings page each write xsh:settings whole, so a save from
  // a copy read before sharing was turned off would turn it back on. Only the
  // background writes the sharing record, inside serial().
  // While it is on, each label saved is queued as a report and each label
  // cleared as a retraction, and the background sends them to crowdBase. A
  // report holds the label, the account, the post's id, the id of the post
  // whose page it was on and the UTC day the label was made; each request
  // carries the install's random key. The words, the user's X account, other
  // pages and settings are never sent. The server keeps one verdict per
  // install and account (server/README.md, "How a report changes a verdict"),
  // so the client leaves it holding the account's newest remaining label.

  function shareOn(state) {
    return !!state && typeof state === 'object' && state.on === true;
  }

  const SHARE_KEY_RE = /^[0-9a-f]{32}$/;
  const POST_ID_RE = /^\d{1,25}$/;
  // Only a 0.10.0 queue item holds a hash (of the post's words); it is read
  // so that item survives the update, and never sent.
  const HASH_RE = /^[0-9a-f]{16}$/;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DAY_MS = 86400000;
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  function dayOk(d) {
    if (typeof d !== 'string' || !DAY_RE.test(d)) return false;
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && utcDay(t) === d;
  }

  // A new install key: 16 random bytes as 32 lowercase hex characters. It
  // is not derived from anything about the user or the browser.
  function newShareKey(cryptoImpl) {
    const c = cryptoImpl || globalThis.crypto;
    return hex(c.getRandomValues(new Uint8Array(16)));
  }

  // The report a saved label makes, { label, handle, status, thread, day },
  // or null when the record is not a label. day is the UTC day the label was
  // made (null for a record with no usable time).
  function reportOf(record) {
    const r = record || {};
    if (!LABELS.includes(r.label)) return null;
    const post = statusOf(r.url);
    const handle = normalizeHandle(r.handle);
    if (!post || !handle || handle !== post.handle) return null;
    const page = r.page ? statusOf(r.page) : null;
    const day = Number.isFinite(r.at) && r.at > 0 && r.at <= 8.64e15 ? utcDay(r.at) : null;
    return { label: r.label, handle, status: post.id, thread: page ? page.id : null, day };
  }

  const shareItemOk = (i) => {
    if (!i || typeof i !== 'object' || !Number.isInteger(i.seq)) return false;
    if (i.op === 'retract-handle') return !!normalizeHandle(i.handle);
    if (!POST_ID_RE.test(String(i.status))) return false;
    if (i.op === 'retract') return true;
    return (
      i.op === 'report' &&
      LABELS.includes(i.label) &&
      !!normalizeHandle(i.handle) &&
      (i.thread === null || POST_ID_RE.test(String(i.thread))) &&
      (i.day == null || dayOk(i.day)) &&
      (i.hash == null || HASH_RE.test(String(i.hash)))
    );
  };

  // held maps an account to what the server last confirmed this install's
  // verdict on it to be: { s: its label, l: the day it is dated, in ms, as the
  // server dates it, or later }, 'none' when the server was told to take it back,
  // or 'unknown' when an answer left it uncertain. A plain object read with
  // hasOwnProperty and written with defineProperty, since '__proto__' is a
  // valid handle.
  const heldGet = (held, h) => (Object.prototype.hasOwnProperty.call(held, h) ? held[h] : undefined);
  const heldSet = (held, h, v) => Object.defineProperty(held, h, { value: v, enumerable: true, writable: true, configurable: true });
  function heldOf(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (normalizeHandle(k) !== k) continue;
      if (v === 'none' || v === 'unknown') heldSet(out, k, v);
      else if (v && typeof v === 'object' && LABELS.includes(v.s) && Number.isFinite(v.l) && v.l > 0) heldSet(out, k, { s: v.s, l: v.l });
    }
    return out;
  }

  // The stored sharing record, read defensively: { on, key, queue, seq, sent,
  // lastSentAt, lastError, retryAt, fails, held, legacy }. on is true only
  // while sharing is on. key is null until sharing is first turned on, and
  // again after Delete what I shared. fails counts the sends in a row that
  // failed. held is described above; an account missing from it holds
  // nothing, unless legacy is true: the key sent reports with 0.10.0, which
  // kept no held, so an account not confirmed since then is unknown.
  function shareState(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    const key = typeof s.key === 'string' && SHARE_KEY_RE.test(s.key) ? s.key : null;
    const hadHeld = !!(s.held && typeof s.held === 'object');
    return {
      on: s.on === true,
      key,
      queue: Array.isArray(s.queue) ? s.queue.filter(shareItemOk) : [],
      seq: int(s.seq),
      sent: int(s.sent),
      lastSentAt: int(s.lastSentAt) || null,
      lastError: typeof s.lastError === 'string' && s.lastError ? s.lastError : null,
      retryAt: int(s.retryAt) || null,
      fails: int(s.fails),
      held: key ? heldOf(s.held) : {},
      legacy: !!key && (s.legacy === true || (!hadHeld && int(s.sent) > 0)),
      // True once the user has answered the consent card, or turned sharing on
      // or off on the settings page: they are not asked again. A code means
      // sharing was turned on once, so a record from 0.10.0, which kept no
      // answer, counts as answered.
      asked: s.asked === true || key !== null,
    };
  }

  // Queue a report ({ label, handle, status, thread, day }), a retraction of
  // one post ({ retract: status }) or a retraction of the install's verdict on
  // an account ({ retractHandle: handle }). A report or a retraction of a post
  // replaces whatever was queued for that post, and a report also replaces any
  // report queued for the same account, since the server keeps one verdict for
  // each install and account; a retraction of an account replaces what was
  // queued for that account (its reports and an earlier retraction of it), so
  // only the last word is sent. Each item gets a number
  // of its own, so a send that finishes after the item was replaced leaves the
  // new one queued. Past shareQueueMax the reports of the oldest days go
  // first (an undated 0.10.0 report counts as oldest), and a retraction goes
  // only when nothing but retractions is left.
  function enqueueShare(state, item) {
    const st = shareState(state);
    const it = item || {};
    const seq = st.seq + 1;
    let next;
    if (it.retractHandle != null) next = { op: 'retract-handle', handle: normalizeHandle(it.retractHandle), seq };
    else if (it.retract != null) next = { op: 'retract', status: String(it.retract), seq };
    else {
      next = {
        op: 'report',
        label: it.label,
        handle: normalizeHandle(it.handle),
        status: String(it.status),
        thread: it.thread == null ? null : String(it.thread),
        day: it.day == null ? null : String(it.day),
        seq,
      };
    }
    if (!shareItemOk(next)) return st;
    const queue =
      next.op === 'retract-handle'
        ? st.queue.filter((i) => i.handle !== next.handle)
        : st.queue.filter(
            (i) => i.op === 'retract-handle' || (i.status !== next.status && !(next.op === 'report' && i.op === 'report' && i.handle === next.handle)),
          );
    queue.push(next);
    const dayOf = (i) => i.day || '';
    while (queue.length > DEFAULTS.shareQueueMax) {
      let drop = -1;
      queue.forEach((i, at) => {
        if (i.op !== 'report') return;
        if (drop < 0 || dayOf(i) < dayOf(queue[drop]) || (dayOf(i) === dayOf(queue[drop]) && i.seq < queue[drop].seq)) drop = at;
      });
      queue.splice(drop < 0 ? 0 : drop, 1);
    }
    return Object.assign(st, { seq, queue });
  }

  // The next request to send, or null for none: while any retraction is
  // queued, one /v1/retract with up to shareBatch post retractions and up to
  // shareBatch account retractions; else up to shareBatch reports, newest day
  // first (undated ones last, ties in the order they were queued).
  // { path, key, items, body }; body is what is posted, as JSON.
  function shareBatch(state) {
    const st = shareState(state);
    if (!st.key) return null;
    const n = DEFAULTS.shareBatch;
    const retracts = st.queue.filter((i) => i.op === 'retract').slice(0, n);
    const handles = st.queue.filter((i) => i.op === 'retract-handle').slice(0, n);
    if (retracts.length || handles.length) {
      const body = { v: 1, key: st.key, statuses: retracts.map((i) => i.status) };
      if (handles.length) body.handles = handles.map((i) => i.handle);
      return { path: '/v1/retract', key: st.key, items: [...retracts, ...handles], body };
    }
    const dayOf = (i) => i.day || '';
    const reports = st.queue
      .filter((i) => i.op === 'report')
      .sort((a, b) => (dayOf(a) === dayOf(b) ? a.seq - b.seq : dayOf(a) < dayOf(b) ? 1 : -1))
      .slice(0, n);
    if (!reports.length) return null;
    // First, the accounts among them whose verdict on the server is on the
    // other side, or unknown, are taken back: the server keeps a verdict
    // against a report of the other side unless the report's day is later
    // (or the same day, for Not slop), so the report alone would not always
    // replace it. handles names them; items is empty, since nothing leaves
    // the queue when it is done.
    const first = [...new Set(reports.filter((i) => retractFirst(st, i)).map((i) => i.handle))];
    if (first.length) return { path: '/v1/retract', key: st.key, items: [], handles: first, body: { v: 1, key: st.key, statuses: [], handles: first } };
    return {
      path: '/v1/reports',
      key: st.key,
      items: reports,
      body: {
        v: 1,
        key: st.key,
        reports: reports.map((i) => {
          const r = { label: i.label, handle: i.handle, status: i.status, thread: i.thread };
          if (i.day) r.day = i.day;
          return r;
        }),
      },
    };
  }

  // Whether a queued report must wait for its account to be taken back: the
  // server may hold the other side, or what it holds is unknown. The server
  // keeps a verdict against a report of the other side unless the report's day
  // is later (or the same day, for Not slop), so a report alone would not
  // always replace it; after a taking-back, any report does.
  function retractFirst(st, item) {
    const v = heldGet(st.held, item.handle);
    if (v === undefined) return st.legacy;
    if (v === 'none') return false;
    if (v === 'unknown') return true;
    return v.s !== item.label;
  }

  // What held says once a report may have reached the server: its side, dated
  // by its day (a 0.10.0 report has none: the hour), when the server held
  // nothing or the same side; unknown otherwise. It is written whenever the
  // server may have taken the report, so it says more than the server holds,
  // which costs at most one taking-back more. Only a browser closed between
  // the server taking a report and its answer being stored leaves it out, until
  // that report is sent again or replaced.
  function heldAfter(st, item, now) {
    const l = item.day ? Date.parse(`${item.day}T00:00:00Z`) : Math.floor(now / 3600000) * 3600000;
    const v = heldGet(st.held, item.handle);
    let next = 'unknown';
    if (v === 'none' || (v === undefined && !st.legacy)) next = { s: item.label, l };
    else if (v && typeof v === 'object' && v.s === item.label) next = { s: v.s, l: Math.max(v.l, l) };
    heldSet(st.held, item.handle, next);
  }

  // An account dated more than 92 days back holds nothing: the server deletes
  // a verdict 90 days after its day.
  function pruneHeld(st, now) {
    const cut = now - 92 * DAY_MS;
    for (const h of Object.keys(st.held)) {
      const v = st.held[h];
      if (!v || typeof v !== 'object' || v.l >= cut) continue;
      if (st.legacy) heldSet(st.held, h, 'none');
      else delete st.held[h];
    }
  }

  // Milliseconds from now to the next UTC midnight, when the server's daily
  // counts start again.
  function msToUtcMidnight(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
  }

  // The record after one request. res is { status, body } (status 0: no
  // answer, with res.error). What the server took, or refused as malformed,
  // leaves the queue; what it put off stays, and nothing is sent before
  // retryAt. A request refused whole as malformed (400) or too large (413)
  // leaves the queue too: sent again it would be refused again. Any other
  // answer that is not 200 keeps it. A result for another key (the record
  // was deleted while the request was out) changes nothing.
  // Waits are spread so that installs do not all come back at once: a failure
  // waits shareRetryMinutes, doubling with each failure in a row up to
  // shareRetryMaxMinutes, times a factor of 0.75 to 1.25; a 429 or a put-off
  // report waits what the server said (at most 26 hours), else until UTC
  // midnight, plus up to an hour. rand() is a number from 0 to 1.
  function shareResult(state, batch, res, now, rand = Math.random) {
    const st = shareState(state);
    if (!batch || batch.key !== st.key) return st;
    const r = res || {};
    const body = r.body && typeof r.body === 'object' ? r.body : {};
    const seqs = new Set(batch.items.map((i) => i.seq));
    // Out of the queue: what this request carried, by the server's name for it
    // (a post's id), unless it was replaced while the request was out.
    const drop = (statuses) => {
      const out = new Set(statuses);
      st.queue = st.queue.filter((i) => !(seqs.has(i.seq) && out.has(i.status)));
    };
    const dropAll = () => {
      st.queue = st.queue.filter((i) => !seqs.has(i.seq));
    };
    const why = typeof body.reason === 'string' && body.reason ? body.reason : null;
    const jitter = () => {
      const v = Number(rand());
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    };
    const wait = (ms) => Math.round(now + (Number.isFinite(ms) && ms > 0 ? Math.min(ms, 26 * 3600000) : msToUtcMidnight(now)) + jitter() * 3600000);
    const later = () => {
      st.fails += 1;
      const base = Math.min(DEFAULTS.shareRetryMinutes * 2 ** (st.fails - 1), DEFAULTS.shareRetryMaxMinutes) * 60000;
      return Math.round(now + base * (0.75 + 0.5 * jitter()));
    };
    // Reports the server may have taken go in held, whatever the answer (or
    // none at all): only those a 200 answer names as put off or refused are
    // surely not on the server.
    if (batch.path === '/v1/reports') {
      const ok = r.status === 200 && body.ok === true;
      const not = new Set(ok ? [...(Array.isArray(body.deferred) ? body.deferred : []), ...(Array.isArray(body.rejected) ? body.rejected : [])].map(String) : []);
      batch.items.forEach((i, n) => {
        if (!not.has(i.status) && !not.has(`#${n}`)) heldAfter(st, i, now);
      });
      pruneHeld(st, now);
    }
    if (!r.status) {
      st.lastError = `could not reach the server${r.error ? ` (${r.error})` : ''}`;
      st.retryAt = later();
    } else if (r.status === 429) {
      st.lastError = `the server asked to wait${why ? `: ${why}` : ''}`;
      st.retryAt = wait(Number(body.retryAfter));
    } else if ((r.status !== 200 && r.status !== 400 && r.status !== 413) || (r.status === 200 && body.ok !== true)) {
      // 5xx, any other refusal (403, 404, 408, ...) that a proxy or a server
      // mid-deploy may give, or a 200 that is not ok: kept, and tried later.
      st.lastError = `the server answered ${r.status}${why ? `: ${why}` : ''}`;
      st.retryAt = later();
    } else if (r.status !== 200) {
      dropAll();
      // A taking-back that comes before reports, refused, would be planned
      // again and again: those accounts' reports are dropped instead.
      const first = new Set(batch.handles || []);
      if (first.size) st.queue = st.queue.filter((i) => !(i.op === 'report' && first.has(i.handle)));
      st.lastError = `the server refused ${batch.items.length + first.size} (${r.status}${why ? `: ${why}` : ''})`;
      st.retryAt = null;
      st.fails = 0;
    } else if (batch.path === '/v1/retract') {
      dropAll();
      // Each account taken back now holds nothing on the server. (A post's
      // retraction names no account, so held stays as it was: at worst one
      // more taking-back later, never one missed.)
      const taken = [...batch.items.filter((i) => i.op === 'retract-handle').map((i) => i.handle), ...(batch.handles || [])];
      for (const h of taken) {
        if (st.legacy) heldSet(st.held, h, 'none');
        else delete st.held[h];
      }
      Object.assign(st, { lastSentAt: now, lastError: null, retryAt: null, fails: 0 });
    } else {
      const list = (k) => (Array.isArray(body[k]) ? body[k].map(String) : []);
      const accepted = list('accepted');
      const deferred = new Set(list('deferred'));
      // A refused item is named by its status, or by "#<index>" when it had none.
      const rejected = list('rejected').map((x) => {
        const i = /^#\d+$/.test(x) ? batch.items[Number(x.slice(1))] : null;
        return i ? i.status : x;
      });
      // An item the answer does not name is not left queued forever.
      const named = new Set([...accepted, ...rejected, ...deferred]);
      const unnamed = batch.items.filter((i) => !named.has(i.status)).map((i) => i.status);
      drop([...accepted, ...rejected, ...unnamed]);
      st.sent += accepted.length;
      st.lastSentAt = now;
      st.lastError = rejected.length ? `the server refused ${rejected.length} as malformed` : null;
      if (deferred.size) st.retryAt = wait(Number(body.retryAfter));
      else Object.assign(st, { retryAt: null, fails: 0 });
    }
    return st;
  }

  // Which label is the newer: the one made later, to the millisecond, and
  // Not slop only when both were made at the same moment. (The server can
  // only compare days, so it gives a tie on the day to Not slop; shareBatch
  // takes the account back first whenever that rule would keep the wrong
  // side.) x and y are { rep, rec } (a report and the label record it came
  // from); positive when x is newer.
  function newerLabel(x, y) {
    const ax = Number(x.rec.at) || 0;
    const ay = Number(y.rec.at) || 0;
    if (ax !== ay) return ax - ay;
    if (x.rep.label !== y.rep.label) return x.rep.label === 'not_slop' ? 1 : -1;
    return 0;
  }

  // The newest label (see newerLabel) on each account among the records.
  // Records that are not labels, and the post named by
  // exceptStatus, are left out. With now, a label made more than
  // shareBackfillDays before it is left out too, since the server refuses a
  // label made more than 90 days back (a little margin for the queue).
  function newestLabels(records, { now, exceptStatus } = {}) {
    const best = new Map();
    for (const rec of records || []) {
      const rep = reportOf(rec);
      if (!rep || rep.status === exceptStatus) continue;
      const cand = { rep, rec };
      const cur = best.get(rep.handle);
      if (!cur || newerLabel(cand, cur) > 0) best.set(rep.handle, cand);
    }
    let out = [...best.values()];
    if (now != null) {
      const oldest = utcDay(now - DEFAULTS.shareBackfillDays * DAY_MS);
      out = out.filter((c) => c.rep.day && c.rep.day >= oldest);
    }
    return out;
  }

  // The reports to queue for the labels already saved, when sharing is turned
  // on with "Also share" ticked: one per account, its newest label, newest
  // first, none the server would refuse as too old.
  function backfillReports(records, now) {
    return newestLabels(records, { now })
      .sort((a, b) => -newerLabel(a, b))
      .map((c) => c.rep);
  }

  // What to queue after a stored label was cleared, given the label records
  // stored before (the cleared one included): the account's verdict is taken
  // back, and the newest label still kept on that account, if any and not too
  // old, is sent again, so the server ends holding it.
  function shareItemsOnClear(records, record, now) {
    const post = statusOf(record && record.url);
    const handle = normalizeHandle(record && record.handle) || (post && post.handle);
    if (!post || !handle) return [];
    const same = (records || []).filter((r) => r && normalizeHandle(r.handle) === handle);
    const keep = newestLabels(same, { now, exceptStatus: post.id })[0];
    const items = [{ retractHandle: handle }];
    if (keep) items.push(keep.rep);
    return items;
  }

  // What to queue after Delete all labels: one retraction for each account
  // among the deleted labels.
  function shareItemsOnClearAll(records) {
    const handles = new Set();
    for (const rec of records || []) {
      const rep = reportOf(rec);
      if (rep) handles.add(rep.handle);
    }
    return [...handles].map((h) => ({ retractHandle: h }));
  }

  // What the settings page and the consent card tell the user is sent, as
  // sections of a heading and items of text, with the server's host filled in.
  function shareDisclosure(host) {
    return [
      {
        heading: 'What is sent',
        items: [
          "For each label: that it is slop or not slop, the account's handle, the post's id, the id of the post whose page it was on, and the day you labelled it. The post's words are not sent.",
          'A random code made for this browser, so that you count as one reader and can delete what you sent. It is not your X account.',
        ],
      },
      {
        heading: 'What is never sent',
        items: ["The post's words, your X account, other pages you visit, your lists and your settings."],
      },
      {
        heading: 'Where it goes',
        items: [
          `To ${host}, run by AI Anti-Slop. It keeps one entry for each account you labelled: whether your newest label says slop or not slop and its day, with the post and page ids, the hour and a keyed hash of the first part of your IP address (never the address) from the report that set that side, so that one network cannot count as many readers. An entry is deleted 90 days after your newest label on that account.`,
          'While sharing is on, clearing a label takes back what the server keeps for that account and sends your newest remaining label on it, if there is one. Delete what I shared removes everything from this browser. Turning sharing off stops sending and keeps what was sent.',
        ],
      },
    ];
  }

  // ------------------------------------------------------------------ settings files
  //
  // The extension's settings page exports and imports these. A settings file
  // carries the two account boxes, each bot's saved choice and the tag
  // setting, and nothing else: never muting on or off, the daily number, the
  // account muting runs as, the list URL, pause or labels. A text file of
  // handles, one per line, is a shared list, and import adds it to Also hide.
  // The tag keeps the name from before the renames: every later version must
  // import a 0.6.x export, and 0.6.x a later one.
  const SETTINGS_FORMAT = 'x-slop-hide-settings';
  const SETTINGS_VERSION = 1;
  // The only settings an import ever writes.
  const IMPORT_KEYS = Object.freeze(['allowlist', 'extraList', 'bots', 'hideBotMentions']);

  const sortedHandles = (text) => [...parseAllowlist(text)].sort();

  // The object Export settings saves (as JSON).
  function settingsExport(settings, now) {
    const s = settings || {};
    const bots = {};
    for (const { handle } of BOTS) {
      const c = botChoice(s, handle);
      if (c) bots[handle] = c;
    }
    return {
      format: SETTINGS_FORMAT,
      version: SETTINGS_VERSION,
      exported: utcDay(now),
      alwaysShow: sortedHandles(s.allowlist),
      alsoHide: sortedHandles(s.extraList),
      bots,
      hideBotMentions: s.hideBotMentions === true,
    };
  }

  // Also hide as a shared list: one handle per line, the format import reads.
  function alsoHideText(settings) {
    const hs = sortedHandles(settings && settings.extraList);
    return hs.length ? `${hs.join('\n')}\n` : '';
  }

  const refuse = (reason) => ({ ok: false, reason });

  function handleArray(v, name) {
    if (v === undefined) return { ok: true, handles: [] };
    if (!Array.isArray(v)) return refuse(`"${name}" is not a list`);
    if (v.length > DEFAULTS.maxHandles) return refuse(`"${name}" has more than ${DEFAULTS.maxHandles} accounts`);
    const out = new Set();
    for (const raw of v) {
      const h = typeof raw === 'string' ? normalizeHandle(raw) : null;
      if (!h) return refuse(`"${name}" has an entry that is not an X handle`);
      out.add(h);
    }
    return { ok: true, handles: [...out].sort() };
  }

  function readSettingsJson(text) {
    let o;
    try {
      o = JSON.parse(text);
    } catch (e) {
      return refuse('the file is not valid JSON');
    }
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.format !== SETTINGS_FORMAT) {
      return refuse('the file is not an AI Anti-Slop settings file');
    }
    if (o.version !== SETTINGS_VERSION) return refuse('this settings file comes from a newer or unknown version');
    const show = handleArray(o.alwaysShow, 'alwaysShow');
    if (!show.ok) return show;
    const hide = handleArray(o.alsoHide, 'alsoHide');
    if (!hide.ok) return hide;
    const bots = {};
    if (o.bots !== undefined) {
      if (!o.bots || typeof o.bots !== 'object' || Array.isArray(o.bots)) return refuse('"bots" is not an object');
      for (const [key, mode] of Object.entries(o.bots)) {
        const h = normalizeHandle(key);
        if (!h || !BOT_HANDLES.has(h)) return refuse('"bots" names an account that is not one of the bots');
        if (!BOT_MODES.includes(mode)) return refuse('"bots" has a choice other than show, hide or mute');
        bots[h] = mode;
      }
    }
    if (o.hideBotMentions !== undefined && typeof o.hideBotMentions !== 'boolean') {
      return refuse('"hideBotMentions" is not true or false');
    }
    // Every other key, muteEnabled, muteCap, muteAccount and feedUrl
    // included, is ignored.
    return { ok: true, kind: 'settings', alwaysShow: show.handles, alsoHide: hide.handles, bots, hideBotMentions: o.hideBotMentions };
  }

  function readHandleLines(text) {
    const out = new Set();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const h = normalizeHandle(line);
      if (!h) return refuse(`line ${i + 1} is not an X handle`);
      out.add(h);
      if (out.size > DEFAULTS.maxHandles) return refuse(`the file has more than ${DEFAULTS.maxHandles} accounts`);
    }
    if (!out.size) return refuse('the file has no handles');
    return { ok: true, kind: 'list', alwaysShow: [], alsoHide: [...out].sort(), bots: {}, hideBotMentions: undefined };
  }

  // A file the user picked, as text: a settings file (it starts with "{"),
  // or a list of handles. Anything wrong refuses the whole file.
  function readSettingsFile(text) {
    const t = typeof text === 'string' ? text.replace(/^﻿/, '') : '';
    if (!t.trim()) return refuse('the file is empty');
    if (t.length > DEFAULTS.maxBytes) return refuse(`the file is larger than ${DEFAULTS.maxBytes / 1000000} MB`);
    return t.trimStart().startsWith('{') ? readSettingsJson(t) : readHandleLines(t);
  }

  // What importing a read file into the current settings changes. `patch`
  // is the one settings write, holding only IMPORT_KEYS. The boxes only gain
  // accounts, appended to the text already there; the file's bot choices and
  // tag setting replace the current ones. The rest describes the change:
  // `muteTargets` are accounts muting does not reach now and would after the
  // import (whether or not muting is on), `muteBots` the bots among them,
  // `staysShown` accounts added to Also hide that Always show keeps visible,
  // and `staysShownBots` the other bots added to Also hide that stay visible
  // because they are set to Show.
  function importPlan(settings, file, listHandles) {
    const s = settings || {};
    const f = file || {};
    const patch = {};
    const add = (field, handles) => {
      const have = parseAllowlist(s[field]);
      const fresh = (handles || []).filter((h) => !have.has(h));
      if (fresh.length) {
        const kept = String(s[field] || '').replace(/\s+$/, '');
        patch[field] = kept ? `${kept}\n${fresh.join('\n')}` : fresh.join('\n');
      }
      return fresh;
    };
    const addShow = add('allowlist', f.alwaysShow);
    const addHide = add('extraList', f.alsoHide);
    const botChanges = [];
    const bots = Object.assign({}, s.bots && typeof s.bots === 'object' ? s.bots : {});
    for (const { handle } of BOTS) {
      const to = f.bots && f.bots[handle];
      if (!BOT_MODES.includes(to)) continue;
      const from = botChoice(s, handle);
      if (from === to) continue;
      bots[handle] = to;
      botChanges.push({ handle, from, to });
    }
    if (botChanges.length) patch.bots = bots;
    let mentions = null;
    if (typeof f.hideBotMentions === 'boolean' && f.hideBotMentions !== (s.hideBotMentions === true)) {
      patch.hideBotMentions = f.hideBotMentions;
      mentions = f.hideBotMentions;
    }
    const next = Object.assign({}, s, patch);
    const before = new Set(muteEligible(listHandles, s));
    const muteTargets = muteEligible(listHandles, next).filter((h) => !before.has(h));
    const allow = effectiveAllow(next);
    const always = parseAllowlist(next.allowlist);
    return {
      patch,
      empty: Object.keys(patch).length === 0,
      addShow,
      addHide,
      botChanges,
      mentions,
      muteTargets,
      muteBots: muteTargets.filter((h) => BOT_HANDLES.has(h)),
      staysShown: addHide.filter((h) => always.has(h)),
      staysShownBots: addHide.filter((h) => allow.has(h) && !always.has(h)),
      muting: mutingOn(s),
      muteAccount: s.muteAccount || null,
      muteCap: muteCap(s),
    };
  }

  // Report a problem or suggest something: GitHub's issue chooser, which hands
  // these fields to whichever form the reader picks (a field the form lacks is
  // ignored). Installs that never update keep the address a release shipped,
  // so it names no template file. It carries the version and the browser and
  // nothing else; test/feedback.test.mjs checks the bug form has both fields.
  const REPO_URL = 'https://github.com/StartupBros-com/ai-anti-slop';
  const FEEDBACK_FIELDS = Object.freeze(['version', 'browser']);

  // The browser's name, major version and platform, such as "Brave 158 on
  // Windows", from a navigator; '' when it says nothing usable. Chromium
  // browsers list their own brand beside "Chromium" and a made-up one (Brave:
  // Chromium 158, "Not.A/Brand" 24, Brave 158), and their user agent string
  // says Chrome, so the brands come first.
  function browserName(nav) {
    if (!nav || typeof nav !== 'object') return '';
    const d = nav.userAgentData;
    const brands = d && Array.isArray(d.brands) ? d.brands.filter((b) => b && typeof b.brand === 'string' && !/not.?a.?brand/i.test(b.brand)) : [];
    const own = brands.find((b) => b.brand !== 'Chromium') || brands[0];
    const ua = typeof nav.userAgent === 'string' ? nav.userAgent : '';
    let name = own ? `${own.brand} ${String(own.version || '').split('.')[0]}`.trim() : '';
    // Edge's and Opera's strings say Chrome too, before their own token.
    for (const [token, label] of [['Edg', 'Microsoft Edge'], ['OPR', 'Opera'], ['Firefox', 'Firefox'], ['Chrome', 'Chrome']]) {
      if (name) break;
      const m = new RegExp(`\\b${token}/(\\d+)`).exec(ua);
      if (m) name = `${label} ${m[1]}`;
    }
    if (!name) return '';
    let os = d && typeof d.platform === 'string' ? d.platform : '';
    if (!os) os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
    return (os ? `${name} on ${os}` : name).slice(0, 80);
  }

  function feedbackUrl(version, browser) {
    const values = { version, browser };
    const q = FEEDBACK_FIELDS.filter((k) => typeof values[k] === 'string' && values[k])
      .map((k) => `${k}=${encodeURIComponent(values[k])}`)
      .join('&');
    return `${REPO_URL}/issues/new/choose${q ? `?${q}` : ''}`;
  }

  const api = {
    HANDLE_RE,
    DEFAULTS,
    STORAGE_KEYS,
    BUILTIN_LISTS,
    MUTE_LIST,
    listKey,
    isListKey,
    checkListUrl,
    subscriptions,
    enabledLists,
    listNamesOf,
    isXPageUrl,
    addListPatch,
    removeListPatch,
    listOnPatch,
    listChanges,
    unionHandles,
    parseNdjsonUsernames,
    levelsioConfirmed,
    normalizeHandle,
    parseList,
    acceptUpdate,
    isDue,
    fetchList,
    nextRecord,
    commitRecord,
    isRefreshDue,
    parseAllowlist,
    GROK,
    BOTS,
    BOT_MODES,
    botChoice,
    botModes,
    effectiveAllow,
    effectiveList,
    mentionTargets,
    insideQuoteCard,
    profileGone,
    authorHandleOf,
    pageOwner,
    shouldHide,
    mentionIn,
    shouldHideMention,
    utcDay,
    mutingOn,
    chooseMuteItem,
    chooseUnmuteItem,
    emptyMutes,
    muteEligible,
    muteCandidates,
    unmuteCandidates,
    runWaiting,
    RUN_KEY,
    jobResult,
    runMissed,
    stampAccount,
    muteCap,
    capNeedsXOpen,
    visitNeedsXOpen,
    muteBudget,
    recordOutcome,
    recordUnmute,
    recordCheck,
    recordCheckFailed,
    checkWaitMs,
    countVisit,
    stopDay,
    noteSighting,
    muteSummary,
    LABEL_PREFIX,
    LABELS,
    labelsOn,
    statusOf,
    statusPageOf,
    labelRecord,
    labelPatch,
    labelsFrom,
    labelsJsonl,
    shareOn,
    newShareKey,
    reportOf,
    shareState,
    enqueueShare,
    shareBatch,
    msToUtcMidnight,
    shareResult,
    backfillReports,
    shareItemsOnClear,
    shareItemsOnClearAll,
    shareDisclosure,
    SETTINGS_FORMAT,
    SETTINGS_VERSION,
    IMPORT_KEYS,
    settingsExport,
    alsoHideText,
    readSettingsFile,
    importPlan,
    REPO_URL,
    FEEDBACK_FIELDS,
    browserName,
    feedbackUrl,
  };
  root.XSlopHide = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
