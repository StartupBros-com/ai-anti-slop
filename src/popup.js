(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  const K = L.STORAGE_KEYS;
  const $ = (id) => document.getElementById(id);

  // render() runs again after every change; writing only what differs keeps
  // the live regions (role=status, role=alert) from announcing a message twice.
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }
  function setHidden(el, hidden) {
    if (el.hidden !== hidden) el.hidden = hidden;
  }

  function ago(ms) {
    if (!ms) return 'never';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The daily number, and why none goes past the top one: hiding already
  // covers this browser, so muting only adds the X apps.
  function renderCap(s, m, handles) {
    const cap = L.muteCap(s);
    const sel = $('muteCap');
    if (document.activeElement !== sel) setChoice(sel, String(cap));
    // Above the lowest number, muting past it runs only while x.com is open:
    // said beside the choice, not only in How muting works, or it seems to
    // stall. One line at the popup's 400 pixels.
    const low = Math.min(...L.DEFAULTS.muteCaps);
    setHidden($('capNote'), cap === low);
    setText($('capNote'), cap === low ? '' : `Mutes past ${low} need an x.com tab open.`);
    const top = Math.max(...L.DEFAULTS.muteCaps);
    const left = L.muteCandidates(handles, s, m).length;
    setText(
      $('capWhy'),
      `No setting goes above ${top}: hiding already covers this browser, and muting only adds the X apps.` +
        (left
          ? ` At ${top} a day, muting the ${plural(left, 'account', 'accounts')} left takes ${plural(Math.ceil(left / top), 'day', 'days')}; Run now visits them all at once.`
          : ''),
    );
  }

  // Run now: everything waiting, one visit after another, past the number a
  // day. Offered while muting is on, the day has not stopped and something is
  // waiting; while a run goes, the button stops it.
  let running = false;
  function renderRun(s, m, handles, run) {
    const on = L.mutingOn(s);
    const b = L.muteBudget(m, L.utcDay(Date.now()), L.muteCap(s));
    const waiting = on ? L.runWaiting(handles, s, m) : 0;
    running = !!(on && run && run.account === s.muteAccount);
    // The caution sits apart from the button, under the counts; they show together.
    const offer = on && !b.stopped && (running || waiting > 0);
    setHidden($('runRow'), !offer);
    setHidden($('runWhat'), !offer);
    setText($('runNow'), running ? 'Stop' : 'Run now');
    const n = plural(waiting, 'account', 'accounts');
    setText(
      $('runWhat'),
      running
        ? `Running: ${n} left, a few seconds apart. Closing the browser also ends it.`
        : `Mutes and unmutes the ${n} waiting now, past your number a day. That is more scripted clicking at once than any daily number.`,
    );
  }
  function runNote(text) {
    setHidden($('runMsg'), !text);
    setText($('runMsg'), text || '');
  }

  // Off: only the hint to fill Always show first. On: who it mutes as,
  // today's mutes as a bar and in words, and the totals so far. A stopped
  // day also says when muting starts again and where each reason is explained.
  // A day can go over its number with Run now (or a lower number picked
  // later that day): the line then gives the counts without "of".
  function renderMuting(s, m, run) {
    const on = L.mutingOn(s);
    $('mute').checked = on;
    setHidden($('muteHint'), on);
    setHidden($('muteOn'), !on);
    // The totals sit in How muting works, outside muteOn, so they hide on their own.
    setHidden($('muteTotals'), !on);
    if (!on) {
      setHidden($('muteStop'), true);
      setHidden($('muteNext'), true);
      return;
    }
    const now = Date.now();
    const b = L.muteBudget(m, L.utcDay(now), L.muteCap(s));
    const t = L.muteSummary(m);
    const inRun = !!(run && run.account === s.muteAccount);
    // A check of the muted list that failed waits before its second try, run
    // or not, and nothing is visited until then (background.js tickWith).
    const wait = !b.stopped && (m.sinceCheck || []).length ? L.checkWaitMs(m, s.muteAccount, now) : 0;
    let next = '';
    if (wait) next = ` · your muted list did not load, next try in ${Math.ceil(wait / 60000)} min`;
    else if (!inRun && m.nextAt && m.nextAt > now) next = ` · next visit in ${Math.ceil((m.nextAt - now) / 60000)} min`;
    setText($('muteWho'), `Muting as @${s.muteAccount}`);
    // Mutes and unmutes share the daily cap; unmutes are named only once there are some.
    const used = b.mutes + b.unmutes;
    const kinds = `${plural(b.mutes, 'mute', 'mutes')}, ${plural(b.unmutes, 'unmute', 'unmutes')}`;
    let actions;
    if (used > b.cap) actions = b.unmutes ? `${used} (${kinds}; over ${b.cap} a day)` : `${plural(b.mutes, 'mute', 'mutes')} (over ${b.cap} a day)`;
    else actions = b.unmutes ? `${used} of ${b.cap} (${kinds})` : `${b.mutes} of ${b.cap} mutes`;
    const visits = b.visits > b.visitCap ? plural(b.visits, 'visit', 'visits') : `${b.visits} of ${b.visitCap} visits`;
    $('muteBar').setAttribute('max', String(b.cap));
    $('muteBar').setAttribute('value', String(Math.min(used, b.cap)));
    setText($('muteToday'), `Today (UTC): ${actions}, ${visits}${next}`);
    setText(
      $('muteTotals'),
      `So far: ${t.muted} muted (${t.confirmed} seen on your muted list, ${t.notFound} not found there), ` +
        `${t.unmuted ? `${t.unmuted} unmuted, ` : ''}${t.already} already muted, ${t.followed} you follow, ${t.skipped} skipped` +
        `${t.gone ? `, ${t.gone} deleted or suspended` : ''}.`,
    );
    setHidden($('muteStop'), !b.stopped);
    setHidden($('muteNext'), !b.stopped);
    setText($('muteStop'), b.stopped ? `Stopped for today: ${b.stopped}` : '');
  }

  // Labels: on or off, how many are saved, export and a two-click delete.
  let deleteArmed = false;
  function renderLabels(s, n) {
    if (n === 0) deleteArmed = false;
    $('labeling').checked = L.labelsOn(s);
    setText($('labelsSum'), `${L.labelsOn(s) ? 'On' : 'Off'} · ${n} saved`);
    setText($('export'), `Export labels (${n})`);
    // A button that is disabled while it has focus drops focus to the page;
    // hand it to the labels switch first.
    const active = document.activeElement;
    if (n === 0 && (active === $('export') || active === $('deleteLabels')) && typeof $('labeling').focus === 'function') {
      $('labeling').focus();
    }
    $('export').disabled = n === 0;
    $('deleteLabels').disabled = n === 0;
    $('deleteLabels').className = deleteArmed ? 'armed' : '';
    setText($('deleteLabels'), deleteArmed ? `Click again to delete ${plural(n, 'label', 'labels')}` : 'Delete all labels');
  }
  // Sharing is set on the settings page; the popup says whether it is on.
  function renderShare(raw) {
    const st = L.shareState(raw);
    if (L.shareOn(st)) {
      setText($('shareLine'), `Sharing is on: ${plural(st.sent, 'report', 'reports')} sent${st.queue.length ? `, ${st.queue.length} waiting` : ''}.`);
      setText($('shareOpen'), 'Sharing settings');
    } else {
      setText($('shareLine'), "Sharing is off. Shared labels help build the readers' list, one of Recommended's sources.");
      setText($('shareOpen'), 'Share your labels');
    }
  }
  function labelsNote(text) {
    setHidden($('labelsMsg'), !text);
    setText($('labelsMsg'), text || '');
  }

  // The tab line: the number first, then where it came from.
  function renderTab(text, more, num) {
    const el = $('tab');
    el.className = num == null ? 'hero say' : 'hero';
    if (num == null) {
      setText(el, text);
    } else if (el.textContent !== `${num} ${text}`) {
      const big = document.createElement('span');
      big.className = 'num';
      big.textContent = String(num);
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = text;
      el.replaceChildren(big, ' ', what);
    }
    setHidden($('tabMore'), !more);
    setText($('tabMore'), more || '');
  }

  // The muting section alone: what a visit or a run changes. It writes no
  // field the user types in, so it can run while the popup is in use.
  async function renderMutingPart() {
    const o = await chrome.storage.local.get([K.list, K.settings, K.mutes]);
    const rec = o[K.list] || { handles: [] };
    const s = o[K.settings] || {};
    const m = o[K.mutes] || L.emptyMutes();
    const run = (await chrome.storage.session.get(L.RUN_KEY))[L.RUN_KEY] || null;
    renderMuting(s, m, run);
    renderRun(s, m, rec.handles, run);
    renderCap(s, m, rec.handles);
  }

  // The list lines: what the lists that are on hold between them, how old
  // they are and the first one whose last refresh failed. With only the AI
  // list on, the lines are the ones it always had. Returns the handles of
  // every list that is on, for the bot rows.
  async function renderLists(s, aiRec) {
    const on = L.enabledLists(s);
    const keys = on.map((l) => L.listKey(l.id));
    if (on.length === 1 && on[0].id === L.MUTE_LIST) {
      const rec = aiRec || { handles: [] };
      let host = '';
      try {
        host = new URL(rec.source || L.DEFAULTS.feedUrl).host;
      } catch (_) {
        host = String(rec.source || '');
      }
      setText($('list'), `${plural(rec.handles.length, 'account', 'accounts')} on the list`);
      setText($('listAge'), `From ${host}, ${rec.fetchedAt ? `updated ${ago(rec.fetchedAt)}` : 'not fetched yet'}`);
      setHidden($('err'), !rec.lastError);
      setText($('err'), rec.lastError ? `Last refresh failed (${ago(rec.lastAttemptAt)}): ${rec.lastError}.${rec.fetchedAt ? ' Still using the previous list.' : ''}` : '');
      return rec.handles;
    }
    const recs = keys.length ? await chrome.storage.local.get(keys) : {};
    const handles = L.unionHandles(keys.map((k) => recs[k]));
    if (!on.length) {
      setText($('list'), 'No list is on');
      setText($('listAge'), '');
      setHidden($('err'), true);
      setText($('err'), '');
      return handles;
    }
    const k = plural(on.length, 'list', 'lists');
    setText($('list'), `${plural(handles.length, 'account', 'accounts')} on ${k}`);
    const times = keys.map((key) => (recs[key] && recs[key].fetchedAt) || 0);
    setText($('listAge'), times.includes(0) ? `From ${k}, not all fetched yet` : `From ${k}, oldest updated ${ago(Math.min(...times))}`);
    const i = keys.findIndex((key) => recs[key] && recs[key].lastError);
    const bad = i >= 0 ? recs[keys[i]] : null;
    setHidden($('err'), !bad);
    setText(
      $('err'),
      !bad
        ? ''
        : bad.partial && bad.fetchedAt
          ? `${on[i].name}: part of the last refresh failed (${ago(bad.lastAttemptAt)}): ${bad.lastError}. The rest updated.`
          : `${on[i].name}: last refresh failed (${ago(bad.lastAttemptAt)}): ${bad.lastError}.${bad.fetchedAt ? ' Still using the previous list.' : ''}`,
    );
    return handles;
  }

  async function render() {
    await renderMutingPart();
    const o = await chrome.storage.local.get([K.list, K.settings, K.labelCount, K.share]);
    const s = o[K.settings] || {};
    const n = o[K.labelCount];
    renderLabels(s, Number.isInteger(n) && n > 0 ? n : 0);
    renderShare(o[K.share]);
    const handles = await renderLists(s, o[K.list]);
    $('paused').checked = !!s.paused;
    if (document.activeElement !== $('allow')) $('allow').value = s.allowlist || '';
    if (document.activeElement !== $('extra')) $('extra').value = s.extraList || '';
    const count = (text) => L.parseAllowlist(text).size;
    setText($('listsSum'), `Always show ${count(s.allowlist)} · Also hide ${count(s.extraList)}`);
    renderBots(s, handles);
    $('mentions').checked = s.hideBotMentions === true;

    let st = null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      try {
        st = await chrome.tabs.sendMessage(tab.id, { type: 'xsh:stats' });
      } catch (_) {
        // No content script in this tab (not x.com).
      }
    }
    // No answer: another site, or an x.com tab opened before the extension
    // was installed or reloaded, which has no content script until it reloads.
    if (!st) return renderTab('Open x.com in this tab to see what was hidden.', 'If it is already open, reload the tab.');
    if (st.paused) return renderTab('Hiding is paused', 'Turn off Pause hiding to hide posts again.');
    // Tag hiding counts apart from the list; when it hid everything, its count leads.
    if (!st.hiddenPosts && st.hiddenMentions) {
      const one = st.hiddenMentions === 1;
      return renderTab(`${one ? 'post' : 'posts'} hidden on this tab`, `${one ? 'It tags a bot.' : 'Each one tags a bot.'} ${st.hiddenNow} on screen now.`, st.hiddenMentions);
    }
    const more = [];
    if (st.hiddenPosts) more.push(`From ${plural(st.hiddenAuthors.length, 'account', 'accounts')}.`);
    if (st.hiddenMentions) more.push(`Plus ${plural(st.hiddenMentions, 'post that tags', 'posts that tag')} a bot.`);
    // The page marks every hidden post the same way, so this counts both kinds.
    if (more.length) more.push(`${st.hiddenNow} on screen now.`);
    renderTab(`${st.hiddenPosts === 1 ? 'post' : 'posts'} hidden on this tab`, more.join(' '), st.hiddenPosts);
  }

  async function saveSettings(patch) {
    const o = await chrome.storage.local.get(K.settings);
    await chrome.storage.local.set({ [K.settings]: Object.assign({}, o[K.settings] || {}, patch) });
  }

  // One row per bot: a link to its profile (for a manual block) and a
  // Show / Hide here / Mute on X choice. Built once; render sets the values.
  const LABELS = { show: 'Show', hide: 'Hide here', mute: 'Mute on X' };
  // The folded heading's counts, short enough to sit on the heading's line.
  const SHORT = { show: 'Show', hide: 'Hide', mute: 'Mute' };
  // Through the options, not select.value, and clearing before selecting:
  // the test DOM (linkedom) has a read-only select.value and loses a
  // selection when a later option is set to false.
  const options = (sel) => [...sel.querySelectorAll('option')];
  const setChoice = (sel, v) => {
    for (const o of options(sel)) o.selected = false;
    const hit = options(sel).find((o) => o.value === v);
    if (hit) hit.selected = true;
  };
  const choiceOf = (sel) => (options(sel).find((o) => o.selected) || {}).value;
  function buildBots() {
    for (const b of L.BOTS) {
      const row = document.createElement('div');
      row.className = 'bot';
      const who = document.createElement('span');
      who.className = 'who';
      const a = document.createElement('a');
      a.href = `https://x.com/${b.name}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `@${b.name}`;
      const note = document.createElement('span');
      note.className = 'note muted';
      note.textContent = b.note;
      // Shown, and read with the choice, only while Always show locks the row.
      const why = document.createElement('span');
      why.className = 'note muted';
      why.id = `bot-${b.handle}-why`;
      why.hidden = true;
      why.textContent = 'Locked to Show: it is in Always show.';
      who.append(a, note, why);
      const sel = document.createElement('select');
      sel.id = `bot-${b.handle}`;
      sel.setAttribute('aria-label', `What to do with @${b.name}`);
      for (const m of L.BOT_MODES) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = LABELS[m];
        sel.append(o);
      }
      sel.addEventListener('change', async () => {
        const mode = choiceOf(sel);
        if (!L.BOT_MODES.includes(mode)) return;
        const o = await chrome.storage.local.get(K.settings);
        const cur = o[K.settings] || {};
        await saveSettings({ bots: Object.assign({}, cur.bots || {}, { [b.handle]: mode }) });
        render();
      });
      row.append(who, sel);
      $('bots').append(row);
    }
  }

  // An Always show entry wins over a bot's row, so the row is locked to Show.
  // The section's summary line counts the rows, so it reads while folded.
  function renderBots(s, handles) {
    const modes = L.botModes(s, handles);
    const allow = L.parseAllowlist(s.allowlist);
    const n = { show: 0, hide: 0, mute: 0 };
    for (const b of L.BOTS) n[modes[b.handle]] += 1;
    setText($('botsSum'), L.BOT_MODES.map((m) => `${SHORT[m]} ${n[m]}`).join(' · '));
    for (const b of L.BOTS) {
      const sel = $(`bot-${b.handle}`);
      if (!sel || document.activeElement === sel) continue;
      setChoice(sel, modes[b.handle]);
      const locked = allow.has(b.handle);
      sel.disabled = locked;
      setHidden($(`bot-${b.handle}-why`), !locked);
      if (locked) sel.setAttribute('aria-describedby', `bot-${b.handle}-why`);
      else sel.removeAttribute('aria-describedby');
    }
  }

  // Turning muting on binds it to the account logged in on this tab's x.com;
  // the worker then refuses to mute from any other account.
  $('mute').addEventListener('change', async () => {
    const box = $('mute'); // not e.target: read again after an await, it can be gone
    $('muteErr').hidden = true;
    if (!box.checked) {
      await saveSettings({ muteEnabled: false, muteAccount: null });
      return render();
    }
    let me = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const st = tab && tab.id != null ? await chrome.tabs.sendMessage(tab.id, { type: 'xsh:stats' }) : null;
      me = st && st.me;
    } catch (_) {
      me = null;
    }
    if (!me) {
      box.checked = false;
      $('muteErr').hidden = false;
      $('muteErr').textContent = 'Open x.com in this tab, logged in as the account to mute from, then turn this on.';
      return;
    }
    await saveSettings({ muteEnabled: true, muteAccount: me });
    render();
  });

  // The worker answers Run now with { ok, waiting } or { ok: false, reason }.
  let runAsked = false;
  $('runNow').addEventListener('click', async () => {
    if (runAsked) return;
    runAsked = true;
    const on = !running;
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: 'xsh:run', on });
    } catch (e) {
      r = { ok: false, reason: String(e) };
    } finally {
      runAsked = false;
    }
    runNote(r && r.ok ? '' : `Not ${on ? 'started' : 'stopped'}: ${(r && r.reason) || 'no answer'}`);
    redraw();
  });

  // The list lines alone: counts, age and the last refresh error. Text only,
  // so like the muting section they can be drawn while the popup is in use.
  async function renderListLines() {
    const o = await chrome.storage.local.get([K.list, K.settings]);
    await renderLists(o[K.settings] || {}, o[K.list]);
  }

  // While the popup is open, visits change the mute record, a run starts or
  // ends, a list is fetched and lists are turned on or off: draw the muting
  // section and the list lines again, never the boxes the user may be typing
  // in. Draws do not overlap; a change during one draws once more.
  let drawing = null;
  let drawAgain = false;
  function redraw() {
    if (drawing) {
      drawAgain = true;
      return;
    }
    drawing = renderMutingPart()
      .then(renderListLines)
      .catch(() => {})
      .finally(() => {
        drawing = null;
        if (drawAgain) {
          drawAgain = false;
          redraw();
        }
      });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    const local = area === 'local' && (changes[K.mutes] || changes[K.settings] || changes[K.share] || Object.keys(changes).some(L.isListKey));
    if (local || (area === 'session' && changes[L.RUN_KEY])) redraw();
  });

  $('muteCap').addEventListener('change', () => {
    const v = Number(choiceOf($('muteCap')));
    if (!L.DEFAULTS.muteCaps.includes(v)) return;
    saveSettings({ muteCap: v }).then(render);
  });
  $('labeling').addEventListener('change', (e) => saveSettings({ labeling: e.target.checked }).then(render));
  // A JSONL file of every saved label, built from the label keys themselves
  // (the count is only a cache). The previous file's URL is freed first.
  let exportUrl = null;
  $('export').addEventListener('click', async () => {
    const recs = L.labelsFrom(await chrome.storage.local.get(null));
    if (!recs.length) return labelsNote('No labels saved yet.');
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(new Blob([L.labelsJsonl(recs)], { type: 'application/x-ndjson' }));
    const a = document.createElement('a');
    a.setAttribute('href', exportUrl);
    a.setAttribute('download', `ai-anti-slop-labels-${L.utcDay(Date.now())}.jsonl`);
    document.body.append(a);
    a.click();
    a.remove();
    labelsNote(`Exported ${plural(recs.length, 'label', 'labels')}.`);
  });
  // The first click only arms the button; the second deletes. The worker
  // deletes the labels; Also hide and Always show stay as they are.
  $('deleteLabels').addEventListener('click', async () => {
    if (!deleteArmed) {
      deleteArmed = true;
      return render();
    }
    deleteArmed = false;
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: 'xsh:labels-clear' });
    } catch (e) {
      r = { ok: false, reason: String(e) };
    }
    labelsNote(r && r.ok ? `Deleted ${plural(r.removed, 'label', 'labels')}.` : `Not deleted: ${(r && r.reason) || 'no answer'}`);
    render();
  });
  $('paused').addEventListener('change', (e) => saveSettings({ paused: e.target.checked }).then(render));
  $('mentions').addEventListener('change', (e) => saveSettings({ hideBotMentions: e.target.checked }).then(render));
  // One write for both boxes, so neither can overwrite the other with a stale value.
  $('save').addEventListener('click', () => {
    const clean = (id) => [...L.parseAllowlist($(id).value)].sort().join('\n');
    const allowlist = clean('allow');
    const extraList = clean('extra');
    $('allow').value = allowlist;
    $('extra').value = extraList;
    saveSettings({ allowlist, extraList }).then(render);
  });
  // Export and import live on the options page: a file picker opened from
  // the popup can close the popup before the file is read.
  $('files').addEventListener('click', () => chrome.runtime.openOptionsPage());
  // Choosing lists lives there too.
  $('chooseLists').addEventListener('click', () => chrome.runtime.openOptionsPage());
  // So does sharing, opened at its section.
  $('shareOpen').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/settings.html#share') }));
  // Report a problem or suggest something: GitHub's issue chooser with this
  // version and browser filled in (lib's feedbackUrl). The page's own link,
  // without them, stays if either cannot be read.
  try {
    $('feedback').setAttribute('href', L.feedbackUrl(chrome.runtime.getManifest().version, L.browserName(globalThis.navigator)));
  } catch {}
  // aria-disabled, not disabled, while it refreshes: a disabled button drops
  // keyboard focus. aria-disabled does not stop clicks, so the flag does.
  // The button is an icon, so its name changes, never its text.
  let refreshing = false;
  const nameRefresh = (btn, name) => {
    btn.setAttribute('aria-label', name);
    btn.setAttribute('title', name);
  };
  $('refresh').addEventListener('click', async () => {
    if (refreshing) return;
    refreshing = true;
    const btn = $('refresh');
    btn.setAttribute('aria-disabled', 'true');
    nameRefresh(btn, 'Refreshing…');
    try {
      await chrome.runtime.sendMessage({ type: 'xsh:refresh' });
    } finally {
      refreshing = false;
      btn.removeAttribute('aria-disabled');
      nameRefresh(btn, 'Refresh list now');
      render();
    }
  });

  buildBots();
  render();
})();
