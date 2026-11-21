// Userscript adapter: supplies state to content.js through Greasemonkey APIs
// when the extension is not installed. Included only in dist/x-slop-hide.user.js.
/* global GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_registerMenuCommand, GM_addValueChangeListener, setInterval */
(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  const K = L.STORAGE_KEYS;
  const subscribers = [];

  // The handles of clankwall's lists that are on, as one list. The userscript
  // reads neither Recommended, levelsio's list nor an added one: its @connect
  // names clankwall only.
  const read = () => {
    const settings = GM_getValue(K.settings, {});
    const recs = L.enabledLists(settings, { userscript: true }).map((l) => GM_getValue(L.listKey(l.id), null));
    return { list: { handles: L.unionHandles(recs) }, settings };
  };
  const notify = () => {
    const s = read();
    for (const cb of subscribers) cb(s);
  };

  // A fetch-shaped wrapper so lib.fetchList validates exactly as the extension does.
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: true,
        timeout: L.DEFAULTS.timeoutMs,
        onload: (r) => {
          const ctype = /^content-type:\s*(.*)$/im.exec(r.responseHeaders || '');
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            headers: { get: (name) => (/^content-type$/i.test(name) && ctype ? ctype[1].trim() : null) },
            text: () => Promise.resolve(r.responseText || ''),
          });
        },
        onerror: () => reject(new Error('request failed')),
        ontimeout: () => reject(new Error('timed out')),
      });
    });
  }

  // One refresh at a time per list per tab. Tabs share GM storage, so the
  // commit re-reads the stored list and drops a result a newer refresh superseded.
  const inflight = new Map();
  function refreshList(sub, force) {
    if (inflight.has(sub.id)) return inflight.get(sub.id);
    const key = L.listKey(sub.id);
    const prev = GM_getValue(key, null);
    if (!force && !L.isRefreshDue(prev, Date.now())) return Promise.resolve();
    const startSeq = (prev && prev.seq) || 0;
    const p = L.fetchList({ url: sub.url, format: sub.format, fetchImpl: gmFetch, prevHandles: prev && prev.handles })
      .then((result) => {
        const record = L.commitRecord(GM_getValue(key, null), result, sub.url, startSeq, Date.now());
        if (record) GM_setValue(key, record);
        notify();
      })
      .finally(() => inflight.delete(sub.id));
    inflight.set(sub.id, p);
    return p;
  }
  function refresh(force) {
    return Promise.all(L.enabledLists(read().settings, { userscript: true }).map((sub) => refreshList(sub, force)));
  }

  function patchSettings(patch) {
    GM_setValue(K.settings, Object.assign({}, GM_getValue(K.settings, {}), patch));
    notify();
  }

  globalThis.XSlopHideAdapter = {
    load: () => Promise.resolve(read()),
    subscribe(cb) {
      subscribers.push(cb);
    },
  };

  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(K.list, (_n, _o, _v, remote) => remote && notify());
    GM_addValueChangeListener(L.listKey('clankwall-all'), (_n, _o, _v, remote) => remote && notify());
    GM_addValueChangeListener(K.settings, (_n, _o, _v, remote) => remote && notify());
  }
  // Set one bot's row. The userscript cannot mute, so it offers Show and Hide.
  function setBot(handle, mode) {
    const s = read().settings || {};
    patchSettings({ bots: Object.assign({}, s.bots || {}, { [handle]: mode }) });
  }
  const botModes = () => {
    const s = read();
    return L.botModes(s.settings, s.list && s.list.handles);
  };
  const editHandles = (key, question) => {
    const cur = read().settings[key] || '';
    const next = prompt(question, cur.replace(/\n/g, ' '));
    if (next != null) patchSettings({ [key]: [...L.parseAllowlist(next)].sort().join('\n') });
  };

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Pause / resume hiding', () => patchSettings({ paused: !read().settings.paused }));
    GM_registerMenuCommand('Show / hide @grok', () => setBot(L.GROK, botModes()[L.GROK] === 'show' ? 'hide' : 'show'));
    GM_registerMenuCommand('Refresh list now', () => refresh(true));
    GM_registerMenuCommand('Hide every account clankwall flagged / AI flags only', () => {
      const cur = read().settings.lists;
      const lists = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
      patchSettings({ lists: Object.assign({}, lists, { 'clankwall-all': lists['clankwall-all'] !== true }) });
      refresh(false);
    });
    GM_registerMenuCommand('Edit always-show list', () =>
      editHandles('allowlist', 'Accounts to always show (space or comma separated):'),
    );
    GM_registerMenuCommand('Edit extra accounts to hide', () =>
      editHandles('extraList', 'Accounts to hide as well as the list (space or comma separated):'),
    );
    GM_registerMenuCommand('Show or hide a bot', () => {
      const modes = botModes();
      const now = L.BOTS.map((b) => `@${b.name} ${modes[b.handle]}`).join(', ');
      const next = prompt(`Type a bot and show or hide, such as "askperplexity hide". Now: ${now}`, '');
      const m = /^\s*@?([A-Za-z0-9_]{1,15})\s+(show|hide)\s*$/i.exec(next || '');
      const bot = m && L.BOTS.find((b) => b.handle === m[1].toLowerCase());
      if (bot) setBot(bot.handle, m[2].toLowerCase());
    });
    GM_registerMenuCommand('Hide / show posts that tag a hidden bot', () =>
      patchSettings({ hideBotMentions: read().settings.hideBotMentions !== true }),
    );
  }
  // A tab can stay open for days through in-app navigation: check whether
  // the list is due on a timer, and again when the tab comes back into view
  // (background tabs may throttle or suspend timers).
  refresh(false);
  setInterval(() => refresh(false), L.DEFAULTS.checkMinutes * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh(false);
  });
})();
