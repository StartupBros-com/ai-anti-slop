// The settings page (the extension's options page, opened in its own tab by
// the popup's Choose lists and Export or import).
//
// Lists: switch lists on and off, add one by address, remove one (with Undo
// for 10 seconds) and try a failed download again. Every change goes through
// lib's addListPatch, removeListPatch and listOnPatch; the background
// downloads what is switched on and deletes a removed list's record.
//
// Share your labels: off until the user reads what is sent and turns it
// on; the background sends, this page shows how it went (drawShare).
//
// Back up and share: export a settings file or Also hide as a list; import
// reads one file the user picks, shows what it would change, and writes only
// after Confirm. Every import write goes through lib.importPlan, which
// touches only the account boxes, the bot choices and the tag setting.
(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  const K = L.STORAGE_KEYS;
  const $ = (id) => document.getElementById(id);

  const num = (n) => n.toLocaleString('en-US');
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

  function ago(ms) {
    if (!ms) return 'never';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  // h('p', { class: 'x', onclick: fn }, child, 'text', ...): text goes in as
  // text nodes, never as markup.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(typeof kid === 'object' ? kid : String(kid));
    return el;
  }

  // Stroke icons on a 24-unit grid, built as SVG elements and hidden from
  // screen readers: each sits beside words.
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
    ext: [['path', { d: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
    refresh: [['path', { d: 'M20 11A8 8 0 0 0 5.3 6.7L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.3L20 16M20 20v-4h-4' }]],
    chev: [['path', { d: 'm6 9 6 6 6-6' }]],
    alert: [['path', { d: 'M12 4 3 20h18L12 4zM12 10v4M12 17h.01' }]],
  };
  function icon(name, size, extra) {
    const s = size || 16;
    const svg = document.createElementNS(SVG, 'svg');
    const attrs = { class: `ico${extra ? ` ${extra}` : ''}`, width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, a] of ICONS[name]) {
      const part = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(a)) part.setAttribute(k, String(v));
      svg.append(part);
    }
    return svg;
  }

  function note(el, text, bad) {
    el.hidden = !text;
    el.textContent = text || '';
    if (bad) el.classList.add('bad');
    else el.classList.remove('bad');
  }

  async function getSettings() {
    return (await chrome.storage.local.get(K.settings))[K.settings] || {};
  }

  // Settings are one stored object, so every write here goes through this
  // queue: one at a time, each from a fresh read. A change made while an
  // earlier one is still being stored then builds on it instead of putting
  // back what it removed. `fn` gets the settings and answers what to write
  // as `patch` (nothing when it has none, or `ok` is false); update answers
  // whatever `fn` answered. The popup writes the same object outside this
  // queue, so a change it makes in the moment between a read and a write
  // here can still be lost, as before.
  let writing = Promise.resolve();
  function update(fn) {
    const run = writing.then(async () => {
      const cur = await getSettings();
      const out = await fn(cur);
      if (out && out.ok !== false && out.patch) await chrome.storage.local.set({ [K.settings]: Object.assign({}, cur, out.patch) });
      return out;
    });
    writing = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------------ lists

  // An added list is titled by its file name, with its address under it: a
  // full address as a title wraps mid-word at any width.
  function titled(sub) {
    if (sub.builtin) return { title: sub.name, where: '' };
    let title = sub.name;
    let where = sub.name;
    try {
      const u = new URL(sub.url);
      where = u.host + u.pathname + u.search;
      const file = u.pathname.split('/').filter(Boolean).pop();
      title = u.host;
      if (file) {
        try {
          title = decodeURIComponent(file);
        } catch (_) {
          title = file;
        }
      }
    } catch (_) {}
    return { title, where };
  }

  function stateOf(sub, rec) {
    if (trying && sub.on) return 'trying';
    if (!sub.on) return 'off';
    if (rec && rec.lastError) return rec.fetchedAt ? 'stale' : 'failed';
    if (rec && rec.fetchedAt) return 'ok';
    return 'waiting';
  }

  // One line of status for a list, in words, so no state rests on colour.
  function statusText(state, count, rec) {
    switch (state) {
      case 'trying':
        return 'Downloading…';
      case 'off':
        return 'Off';
      case 'failed':
        return 'Download failed';
      case 'stale':
        return `${plural(count, 'account', 'accounts')} · last download failed`;
      case 'waiting':
        return 'Not downloaded yet';
      default:
        return `${plural(count, 'account', 'accounts')} · updated ${ago(rec.fetchedAt)}`;
    }
  }

  // A failed download: what went wrong in plain words and what to do, for
  // every reason lib's fetchList returns. The raw reason is shown as reported.
  // A list never downloaded is due at every 6-hourly refresh; one with a good
  // copy is due 6 hours after that copy, so its next try has no promised time.
  function failHelp(sub, rec, count) {
    const reason = rec && rec.lastError ? String(rec.lastError) : '';
    if (!reason) return null;
    const stale = !!rec.fetchedAt;
    const own = !sub.builtin;
    const later = stale ? 'It tries again at its next refresh' : 'It tries again within 6 hours';
    const retry = `${later}, or press Try again.`;
    let what;
    let next;
    if (/^network error/.test(reason)) {
      what = own ? 'The extension could not read the file at this address.' : "The list's site could not be reached.";
      next = own
        ? "Its host may not let other sites read it, or you may be offline. A raw GitHub or Gist link to the same file works."
        : `You may be offline, or the site may be down. ${retry}`;
    } else if (/^HTTP (404|410)$/.test(reason)) {
      what = 'Nothing is at that address any more.';
      next = own ? 'Check the address. To change it, remove this list and add the right one.' : retry;
    } else if (/^HTTP/.test(reason)) {
      what = "The list's site answered with an error.";
      next = retry;
    } else if (/^unexpected content-type/.test(reason)) {
      what = 'That address opens a web page, not a list.';
      next = own ? 'Use the raw link to the text file (on GitHub, the Raw button).' : retry;
    } else if (/^feed is mostly not handles|^empty list/.test(reason)) {
      what = "The file there isn't a list of X handles.";
      next = own ? 'Check that the address points at the list itself, one handle per line.' : retry;
    } else if (/^list shrank/.test(reason)) {
      what = 'The new copy was much shorter than the last one, so it was not used.';
      next = own ? 'If the list really got shorter, remove it and add it again.' : retry;
    } else if (/^feed larger than|^too many handles/.test(reason)) {
      what = 'The list is bigger than the extension reads.';
      next = own ? 'Ask its owner for a smaller file, or remove it.' : retry;
    } else {
      what = 'The download could not be used.';
      next = retry;
    }
    const kept = stale ? `Until then it hides the ${plural(count, 'account', 'accounts')} from the last good download.` : '';
    return { what, next: [next, kept].filter(Boolean).join(' '), reason };
  }

  // What the page keeps between draws: the open About boxes, a removal Undo
  // can still put back, whether Try again is downloading, and where focus
  // goes once the next draw has put the right rows in place.
  const openAbout = new Set();
  let undo = null; // { entry: { id, url, on }, index, name, timer }
  let trying = false;
  let focusNext = null; // ids, first one present wins, used when focus was lost

  // Replace a region's children and keep focus on the element with the same
  // id, so a redraw after a switch flips does not drop the keyboard.
  function swap(region, nodes) {
    const a = document.activeElement;
    const id = a && a.id && region.contains(a) ? a.id : null;
    region.replaceChildren(...nodes);
    if (id) {
      const again = $(id);
      if (again && typeof again.focus === 'function') again.focus({ preventScroll: true });
    }
  }

  function row(sub, rec) {
    const { title, where } = titled(sub);
    const count = rec && Array.isArray(rec.handles) ? rec.handles.length : 0;
    const state = stateOf(sub, rec);
    const statId = `stat-${sub.id}`;
    // An added list's address is part of its description: two Gists can both
    // be named list.txt, and only the address tells them apart.
    const whereId = where ? `where-${sub.id}` : null;
    const described = [whereId, statId, sub.locked ? `lock-${sub.id}` : null].filter(Boolean).join(' ');
    const box = h('input', { type: 'checkbox', role: 'switch', id: `list-${sub.id}`, 'aria-describedby': described });
    box.checked = sub.on;
    box.disabled = sub.locked;
    box.addEventListener('change', async () => {
      const want = box.checked;
      const r = await update((cur) => L.listOnPatch(cur, sub.id, want));
      if (!r.ok) {
        note($('listMsg'), r.reason, true);
        return draw();
      }
      note($('listMsg'), '');
    });
    const stat = h('p', { class: `stat${state === 'failed' || state === 'stale' ? ' bad' : ''}`, id: statId });
    if (state === 'trying') stat.append(icon('refresh', 14, 'spin'));
    if (state === 'failed' || state === 'stale') stat.append(icon('alert', 14));
    stat.append(statusText(state, count, rec));
    const lock = sub.locked ? h('p', { class: 'stat', id: `lock-${sub.id}` }, icon('lock', 13), 'Stays on while muting is on') : null;
    const main = h(
      'div',
      { class: 'main' },
      h('label', { for: box.id, class: `name${sub.locked ? ' locked' : ''}` }, title),
      where ? h('p', { class: 'where', id: whereId }, where) : null,
      stat,
      lock,
    );
    const ctl = h('div', { class: 'ctl' });
    if (!sub.builtin) {
      ctl.append(
        h(
          'button',
          { type: 'button', class: 'text', id: `rm-${sub.id}`, 'aria-label': `Remove ${title}`, 'aria-describedby': whereId, onclick: () => removeList(sub, title) },
          'Remove',
        ),
      );
    }
    ctl.append(box);
    const li = h('li', { class: 'row', 'data-list': sub.id }, main, ctl);
    const help = sub.on ? failHelp(sub, rec, count) : null;
    if (help) {
      const again = h('button', { type: 'button', id: `retry-${sub.id}`, onclick: () => tryAgain(sub.id) }, icon('refresh', 14), 'Try again');
      if (trying) again.setAttribute('aria-disabled', 'true');
      li.append(
        h(
          'div',
          { class: 'fail' },
          h(
            'div',
            { class: 'callout warn' },
            icon('alert'),
            h('div', {}, h('p', {}, h('strong', {}, help.what), help.next ? ` ${help.next}` : ''), h('p', { class: 'reported' }, `Reported: ${help.reason}`), again),
          ),
        ),
      );
    }
    if (sub.builtin) {
      // A list made of several sources links each source's page.
      const pages = sub.sources
        ? sub.sources.map((src) =>
            h('p', {}, h('a', { href: src.about, target: '_blank', rel: 'noopener' }, src.aboutText || `${src.name}'s page, where you can ask for a removal`, icon('ext', 13))),
          )
        : [h('p', {}, h('a', { href: sub.about, target: '_blank', rel: 'noopener' }, 'Its page, where you can ask for a removal', h('span', { class: 'vh' }, ` (${sub.name})`), icon('ext', 13)))];
      const d = h(
        'details',
        { class: 'more', open: openAbout.has(sub.id) },
        h('summary', { id: `about-${sub.id}` }, `About ${sub.name}`, icon('chev', 14, 'chev')),
        sub.note ? h('p', {}, sub.note) : null,
        ...pages,
      );
      d.addEventListener('toggle', () => (d.hasAttribute('open') ? openAbout.add(sub.id) : openAbout.delete(sub.id)));
      li.append(d);
    }
    return li;
  }

  function undoRow() {
    return h('li', { class: 'undo', 'data-undo': '' }, h('span', {}, `Removed ${undo.name}.`), h('button', { type: 'button', id: 'undo', onclick: undoRemove }, 'Undo'));
  }

  // The newest draw wins, so a slow one cannot put old rows back. Focus held
  // in a region stays on the same id; focus lost (its element gone) moves to
  // the first of focusNext that is on the page.
  let drawSeq = 0;
  async function draw() {
    const mine = ++drawSeq;
    const s = await getSettings();
    const subs = L.subscriptions(s);
    const recs = await chrome.storage.local.get(subs.map((l) => L.listKey(l.id)));
    if (mine !== drawSeq) return;
    const recOf = (sub) => recs[L.listKey(sub.id)] || null;

    const on = subs.filter((l) => l.on);
    const accounts = L.unionHandles(on.map(recOf)).length;
    const failing = on.filter((l) => recOf(l) && recOf(l).lastError).length;
    const lists = `${plural(accounts, 'account', 'accounts')}`;
    const sum = $('summary');
    if (!on.length) sum.replaceChildren('No list is on.');
    else if (s.paused) sum.replaceChildren('Hiding is paused in the popup. When it is on, it hides replies from ', h('strong', {}, lists), ` on ${plural(on.length, 'list', 'lists')}.`);
    else sum.replaceChildren('Hiding replies from ', h('strong', {}, lists), ` on ${plural(on.length, 'list', 'lists')}.`);
    if (failing && on.length) sum.append(' ', h('span', { class: 'bad' }, `${plural(failing, 'list needs', 'lists need')} a look.`));

    swap(
      $('builtRows'),
      subs.filter((l) => l.builtin).map((l) => row(l, recOf(l))),
    );
    const own = subs.filter((l) => !l.builtin);
    const ownNodes = own.map((l) => row(l, recOf(l)));
    if (undo) ownNodes.splice(Math.min(undo.index, ownNodes.length), 0, undoRow());
    swap($('ownRows'), ownNodes);
    $('ownRows').hidden = !ownNodes.length;
    const max = L.DEFAULTS.customListMax;
    $('ownH').textContent = `Added by you · ${own.length} of ${max}`;
    $('addHint').textContent =
      'A text file with one handle per line, such as an Also hide export or a raw Gist link. ' +
      `Lists you add hide replies only; muting uses clankwall's AI flags alone. ${own.length} of ${max} added.`;

    const bots = Object.keys(L.settingsExport(s, Date.now()).bots).length;
    $('have').textContent =
      `Always show ${num(L.parseAllowlist(s.allowlist).size)}, Also hide ${num(L.parseAllowlist(s.extraList).size)}, ` +
      `${plural(bots, 'bot choice', 'bot choices')} and the tag setting. It leaves out muting, pause, list choices and labels.`;

    // The draw that wins uses up focusNext, so it never fires on a later,
    // unrelated draw.
    if (focusNext) {
      const want = focusNext;
      focusNext = null;
      const a = document.activeElement;
      const lost = !a || a === document.body || !a.isConnected;
      const target = want.map((id) => $(id)).find(Boolean);
      if (target && lost && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
  }

  // Remove at once and keep what Undo needs: the entry as lib stores it and
  // its place, both read from the settings this removal changes, so a switch
  // flipped just before is what Undo puts back. The background deletes the
  // list's record; Undo puts the entry back and the background downloads it
  // again.
  async function removeList(sub, title) {
    const out = await update((cur) => {
      const patch = L.removeListPatch(cur, sub.id);
      if (!patch) return null;
      const custom = L.subscriptions(cur).filter((l) => !l.builtin);
      const index = custom.findIndex((l) => l.id === sub.id);
      const { id, url, on } = custom[index];
      return { patch, index, entry: { id, url, on } };
    });
    if (!out) return;
    if (undo) clearTimeout(undo.timer);
    const said = `Removed ${title}. Undo is in its place for 10 seconds.`;
    undo = { entry: out.entry, index: out.index, name: title, said, timer: setTimeout(endUndo, 10000) };
    note($('listMsg'), said);
    focusNext = ['undo', 'addOpen'];
    draw();
  }

  async function undoRemove() {
    const u = undo;
    if (!u) return;
    clearTimeout(u.timer);
    undo = null;
    const out = await update((cur) => {
      const subs = L.subscriptions(cur);
      const custom = subs.filter((l) => !l.builtin).map((l) => ({ id: l.id, url: l.url, on: l.on }));
      if (subs.some((l) => l.url === u.entry.url || l.id === u.entry.id)) return { ok: false, reason: `${u.name} is already here.` };
      if (custom.length >= L.DEFAULTS.customListMax) {
        return { ok: false, reason: `${u.name} could not go back: ${L.DEFAULTS.customListMax} lists are added. Remove one first.` };
      }
      custom.splice(Math.min(u.index, custom.length), 0, u.entry);
      return { ok: true, patch: { customLists: custom } };
    });
    if (!out.ok) {
      note($('listMsg'), out.reason, true);
      focusNext = ['addOpen'];
      return draw();
    }
    note($('listMsg'), `${u.name} is back.${u.entry.on ? ' Downloading it again.' : ''}`);
    focusNext = [`list-${u.entry.id}`, 'addOpen'];
    draw();
  }

  // Undo's time is up: its offer leaves the message too. Focus follows only
  // when it was on Undo; anywhere else it stays where the user put it.
  function endUndo() {
    const u = undo;
    undo = null;
    if (u && $('listMsg').textContent === u.said) note($('listMsg'), `Removed ${u.name}.`);
    if (document.activeElement && document.activeElement.id === 'undo') focusNext = ['addOpen'];
    draw();
  }

  // Try again downloads every list that is on (the popup's refresh) and
  // waits for the answer; until then the lists that are on say Downloading.
  // The answer's ok covers every list, so the list's own record says how
  // this one went: a new attempt with an error, a new attempt without one
  // (another list failed), or no new attempt (the download did not run).
  async function tryAgain(id) {
    if (trying) return;
    trying = true;
    note($('listMsg'), 'Downloading the lists that are on again…');
    draw();
    const key = L.listKey(id);
    const attempt = async () => {
      const rec = (await chrome.storage.local.get(key))[key];
      return rec ? { at: rec.lastAttemptAt, error: rec.lastError } : null;
    };
    let r;
    let before = null;
    try {
      before = await attempt();
      r = await chrome.runtime.sendMessage({ type: 'xsh:refresh' });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    const after = r && !r.error ? await attempt() : null;
    trying = false;
    const why = (s) => String(s).replace(/[\s.]+$/, '');
    if (r && r.ok) note($('listMsg'), 'Downloaded. Every list that is on is up to date.');
    else if (!r || r.error) note($('listMsg'), `The download could not start: ${why((r && r.error) || 'no answer from the extension')}.`, true);
    else if (after && after.at && (!before || after.at !== before.at)) {
      note(
        $('listMsg'),
        after.error ? 'It failed again. The note under the list says what to try.' : 'This list downloaded. Another list that is on failed; the note under it says what to try.',
        true,
      );
    } else note($('listMsg'), `The download did not finish: ${why(r.reason || 'no reason given')}.`, true);
    focusNext = [`retry-${id}`, `list-${id}`];
    draw();
  }

  function setAdd(open) {
    $('addForm').hidden = !open;
    $('addOpen').setAttribute('aria-expanded', String(open));
    if (open) $('listUrl').focus();
  }
  $('addOpen').addEventListener('click', () => setAdd($('addForm').hidden));

  let adding = false;
  async function addList() {
    if (adding) return;
    adding = true;
    try {
      const typed = $('listUrl').value;
      const r = await update((cur) => L.addListPatch(cur, typed, Date.now()));
      if (!r.ok) {
        note($('listMsg'), r.reason, true);
        $('listUrl').focus();
        return;
      }
      // Anything typed while it was being stored stays.
      if ($('listUrl').value === typed) $('listUrl').value = '';
      note($('listMsg'), 'Added. Downloading it now.');
    } finally {
      adding = false;
    }
  }
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    addList();
  });

  // ------------------------------------------------------------------ export

  // The previous file's URL is freed before the next one is made.
  let fileUrl = null;
  function download(text, type, name) {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.setAttribute('href', fileUrl);
    a.setAttribute('download', name);
    document.body.append(a);
    a.click();
    a.remove();
  }

  $('exportSettings').addEventListener('click', async () => {
    const settings = await getSettings();
    const now = Date.now();
    const out = L.settingsExport(settings, now);
    const name = `ai-anti-slop-settings-${L.utcDay(now)}.json`;
    download(`${JSON.stringify(out, null, 2)}\n`, 'application/json', name);
    note(
      $('msg'),
      `Exported ${name}: Always show ${out.alwaysShow.length}, Also hide ${out.alsoHide.length}, ` +
        `${plural(Object.keys(out.bots).length, 'bot choice', 'bot choices')}.`,
    );
  });

  $('exportList').addEventListener('click', async () => {
    const settings = await getSettings();
    const text = L.alsoHideText(settings);
    if (!text) return note($('msg'), 'Also hide is empty, so there is no list to export. Add accounts to it in the popup first.');
    const name = `ai-anti-slop-also-hide-${L.utcDay(Date.now())}.txt`;
    download(text, 'text/plain', name);
    note($('msg'), `Exported ${name}, a list of ${plural(L.parseAllowlist(settings.extraList).size, 'account', 'accounts')}.`);
  });

  // ------------------------------------------------------------------ import

  const LABELS = { show: 'Show', hide: 'Hide here', mute: 'Mute on X' };
  const botName = (hd) => (L.BOTS.find((b) => b.handle === hd) || { name: hd }).name;
  // Handles in a preview line: the first few by name, then a count. A line
  // with more than that also lists every handle under Show all, so a long
  // shared list can be read in full before it is imported.
  const NAMED = 12;
  function names(hs) {
    const shown = hs.slice(0, NAMED).map((x) => `@${x}`);
    const more = hs.length - shown.length;
    return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
  }
  function fill(el, text, hs) {
    el.textContent = text;
    if (!hs || hs.length <= NAMED) return;
    el.append(h('details', {}, h('summary', {}, `Show all ${plural(hs.length, 'account', 'accounts')}`), h('p', {}, hs.map((x) => `@${x}`).join(', '))));
  }

  async function current() {
    const o = await chrome.storage.local.get([K.list, K.settings]);
    const rec = o[K.list];
    return { settings: o[K.settings] || {}, handles: (rec && Array.isArray(rec.handles) && rec.handles) || [] };
  }

  // The file read and checked, and the plan the preview shows, as JSON: at
  // Confirm the plan is made again from storage, and a different plan is
  // shown again instead of written.
  let pending = null;

  function reset() {
    pending = null;
    $('preview').hidden = true;
    $('stale').hidden = true;
    $('changes').textContent = '';
    $('file').value = '';
  }

  function line(text, hs) {
    const li = document.createElement('li');
    fill(li, text, hs);
    $('changes').append(li);
  }

  function showPlan(plan, stale) {
    $('changes').textContent = '';
    note($('msg'), '');
    if (plan.empty) {
      reset();
      return note($('msg'), 'Nothing to import: your settings already have everything in this file.');
    }
    const p = plan;
    if (p.addShow.length) line(`Always show gains ${plural(p.addShow.length, 'account', 'accounts')}: ${names(p.addShow)}.`, p.addShow);
    if (p.addHide.length) line(`Also hide gains ${plural(p.addHide.length, 'account', 'accounts')}: ${names(p.addHide)}.`, p.addHide);
    if (p.staysShown.length)
      line(`${names(p.staysShown)} will stay shown, because Always show has ${p.staysShown.length === 1 ? 'it' : 'them'}.`, p.staysShown);
    if (p.staysShownBots.length)
      line(`${names(p.staysShownBots.map(botName))} will stay shown, because ${p.staysShownBots.length === 1 ? 'it is' : 'they are'} set to Show.`);
    for (const c of p.botChanges) line(`@${botName(c.handle)}: ${c.from ? LABELS[c.from] : 'follows the list'} → ${LABELS[c.to]}.`);
    if (p.mentions !== null) line(`${p.mentions ? 'Turns on' : 'Turns off'} hiding posts that tag a bot set to Hide here or Mute on X.`);

    const t = p.muteTargets;
    const bots = p.muteBots.length ? ` Bots among them: ${p.muteBots.map((x) => `@${botName(x)}`).join(', ')}.` : '';
    const mute = $('muteNote');
    mute.hidden = !t.length;
    mute.className = p.muting ? 'callout warn' : 'callout note';
    fill(
      mute,
      !t.length
        ? ''
        : p.muting
          ? `Muting is on as @${p.muteAccount}. After this import it can also mute ${plural(t.length, 'more account', 'more accounts')}: ` +
            `${names(t)}.${bots} It mutes up to ${p.muteCap} a day and skips accounts you follow.`
          : `Muting is off. If you turn it on, it can also mute ${plural(t.length, 'account', 'accounts')} from this file: ${names(t)}.${bots}`,
      t,
    );
    $('stale').hidden = !stale;
    $('preview').hidden = false;
    // Made again at Confirm: focus on the warning, so it is read out first.
    (stale ? $('stale') : $('preview')).focus();
  }

  // The newest pick wins: a file still being read when another is picked is
  // dropped, so the preview always belongs to the file the input holds.
  let pickSeq = 0;
  $('file').addEventListener('change', async () => {
    const mine = ++pickSeq;
    const input = $('file');
    const f = input.files && input.files[0];
    pending = null;
    $('preview').hidden = true;
    note($('msg'), '');
    if (!f) return;
    let r;
    if (f.size > L.DEFAULTS.maxBytes) {
      r = { ok: false, reason: `the file is larger than ${L.DEFAULTS.maxBytes / 1000000} MB` };
    } else {
      try {
        r = L.readSettingsFile(await f.text());
      } catch (_) {
        r = { ok: false, reason: 'the file could not be read' };
      }
    }
    if (mine !== pickSeq) return;
    if (!r.ok) {
      reset();
      return note($('msg'), `Not imported: ${r.reason}. Pick a settings file or a text file with one handle per line.`, true);
    }
    const { settings, handles } = await current();
    if (mine !== pickSeq) return;
    const plan = L.importPlan(settings, r, handles);
    pending = { file: r, key: JSON.stringify(plan) };
    $('fileKind').textContent =
      r.kind === 'list' ? `${f.name}: a list of ${plural(r.alsoHide.length, 'handle', 'handles')}, for Also hide` : `${f.name}: a settings file`;
    showPlan(plan, false);
  });

  // One Confirm at a time. Cancel, or another file picked, while it reads
  // settings stops it before it writes.
  let confirming = false;
  $('confirm').addEventListener('click', async () => {
    const was = pending;
    if (!was || confirming) return;
    confirming = true;
    try {
      // In the write queue, so the plan is checked against the settings it
      // is written onto.
      const out = await update(async (settings) => {
        const { handles } = await current();
        if (pending !== was) return null;
        const plan = L.importPlan(settings, was.file, handles);
        const key = JSON.stringify(plan);
        if (key !== was.key) {
          was.key = key;
          return { ok: false, plan };
        }
        return { ok: true, plan, patch: plan.patch };
      });
      if (!out) return;
      const plan = out.plan;
      if (!out.ok) return showPlan(plan, true);
      const done = [];
      if (plan.addShow.length) done.push(`Always show gained ${plan.addShow.length}`);
      if (plan.addHide.length) done.push(`Also hide gained ${plan.addHide.length}`);
      if (plan.botChanges.length) done.push(plural(plan.botChanges.length, 'bot choice changed', 'bot choices changed'));
      if (plan.mentions !== null) done.push(`tag hiding turned ${plan.mentions ? 'on' : 'off'}`);
      // A file picked while this was being stored keeps its own preview.
      if (pending === was) {
        reset();
        $('file').focus();
      }
      note($('msg'), `Imported: ${done.join(', ')}.`);
      draw();
    } finally {
      confirming = false;
    }
  });

  $('cancel').addEventListener('click', () => {
    reset();
    note($('msg'), 'Nothing imported.');
    $('file').focus();
  });

  // ------------------------------------------------------------------ sharing
  //
  // Off until the user has read what is sent and turns it on here. On, off
  // and Delete what I shared are messages to the background (xsh:share-start,
  // xsh:share-stop, xsh:share-forget), which keeps the key and the queue;
  // this page only reads xsh:share to say how sending went.
  let shareBusy = false;
  let forgetArmed = false;
  let shareSeq = 0;
  let shareFocus = false; // after an action: move focus to the button that took the clicked one's place

  const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function shareFacts(host) {
    return [
      h('h3', {}, 'What is sent'),
      h(
        'ul',
        { class: 'facts' },
        h('li', {}, "For each label: that it is slop (or not slop, for a label saved before version 0.9.0), the account's handle, the post's id, the id of the post whose page it was on, and a hash of the post's words: a short code that is the same for the same words. The words themselves are not sent."),
        h('li', {}, 'A random code made for this browser, so that you count as one reader and can delete what you sent. It is not your X account.'),
      ),
      h('h3', {}, 'What is never sent'),
      h('ul', { class: 'facts' }, h('li', {}, "The post's words, your X account, other pages you visit, your lists and your settings.")),
      h('h3', {}, 'Where it goes'),
      h(
        'ul',
        { class: 'facts' },
        h('li', {}, `To ${host}, run by AI Anti-Slop. It keeps each report for up to 90 days, with the hour it came (not the minute) and a keyed hash of the first part of your IP address (never the address), so that one network cannot count as many readers.`),
        h('li', {}, 'Clearing a label takes its report back. Delete what I shared removes every report from this browser. Turning sharing off stops sending and keeps what was sent.'),
      ),
    ];
  }

  async function drawShare() {
    const mine = ++shareSeq;
    const o = await chrome.storage.local.get([K.settings, K.share, K.labelCount]);
    if (mine !== shareSeq) return;
    const on = L.shareOn(o[K.settings] || {});
    const st = L.shareState(o[K.share]);
    const saved = Number.isInteger(o[K.labelCount]) && o[K.labelCount] > 0 ? o[K.labelCount] : 0;
    const host = new URL(L.DEFAULTS.crowdBase).host;
    const busy = shareBusy ? 'true' : null;
    const nodes = [];
    const forget = () =>
      h(
        'button',
        { type: 'button', id: 'shareForget', class: forgetArmed ? 'armed' : null, 'aria-disabled': busy, onclick: onForget },
        forgetArmed ? 'Click again to delete what you shared' : 'Delete what I shared',
      );
    if (on) {
      const parts = [plural(st.sent, 'report sent', 'reports sent')];
      if (st.queue.length) parts.push(`${num(st.queue.length)} waiting`);
      if (st.lastSentAt) parts.push(`last sent ${ago(st.lastSentAt)}`);
      nodes.push(h('p', { class: 'shareState' }, h('strong', {}, 'Sharing is on.'), ` ${parts.join(' · ')}.`));
      if (st.lastError) {
        const when = st.retryAt && st.retryAt > Date.now() ? ` after ${clockTime(st.retryAt)}` : '';
        nodes.push(h('p', { class: 'shareErr' }, `The last send did not go through: ${st.lastError}. It tries again by itself${when}.`));
      }
      const more = h('details', { class: 'more' }, h('summary', {}, 'What is sent, and where', icon('chev', 14, 'chev')), ...shareFacts(host));
      nodes.push(more);
      nodes.push(h('div', { class: 'pv-actions' }, h('button', { type: 'button', id: 'shareOff', 'aria-disabled': busy, onclick: onStop }, 'Turn off sharing'), forget()));
    } else {
      nodes.push(...shareFacts(host));
      if (saved) {
        nodes.push(
          h('label', { class: 'backfill' }, h('input', { type: 'checkbox', id: 'shareBackfill' }), h('span', {}, `Also share the ${plural(saved, 'label', 'labels')} already saved`)),
        );
      }
      const row = [h('button', { type: 'button', id: 'shareOn', class: 'primary', 'aria-disabled': busy, onclick: onStart }, 'Turn on sharing')];
      if (st.key && st.sent) row.push(forget());
      nodes.push(h('div', { class: 'pv-actions' }, ...row));
      if (st.key && st.sent) nodes.push(h('p', { class: 'hint' }, `${plural(st.sent, 'report', 'reports')} sent from this browser stay on the server until you delete them.`));
    }
    nodes.push(h('p', { class: 'shareLink' }, h('a', { href: `${L.DEFAULTS.crowdBase}/`, target: '_blank', rel: 'noopener' }, "The readers' list and how it is made", icon('ext', 13))));
    const box = $('shareBackfill');
    const ticked = !!(box && box.checked);
    swap($('shareBody'), nodes);
    // A redraw keeps the tick; a new box starts unticked.
    if ($('shareBackfill')) $('shareBackfill').checked = ticked;
    // A button that went away with focus (on became off) hands it to the one in its place.
    if (document.activeElement === document.body || !document.activeElement) {
      const next = $(on ? 'shareOff' : 'shareOn');
      if (shareFocus && next) next.focus({ preventScroll: true });
    }
    shareFocus = false;
  }

  async function shareAction(msg, say) {
    if (shareBusy) return;
    shareBusy = true;
    forgetArmed = false;
    await drawShare();
    let r;
    try {
      r = await chrome.runtime.sendMessage(msg);
    } catch (e) {
      r = { ok: false, reason: String((e && e.message) || e) };
    }
    shareBusy = false;
    note($('shareMsg'), say(r || { ok: false, reason: 'no answer from the extension' }), !(r && r.ok));
    shareFocus = true;
    await drawShare();
  }

  const why = (r) => String(r.reason || 'no reason given').replace(/[\s.]+$/, '');

  function onStart() {
    const box = $('shareBackfill');
    shareAction({ type: 'xsh:share-start', backfill: !!(box && box.checked) }, (r) =>
      r.ok
        ? `Sharing is on. ${r.queued ? `${plural(r.queued, 'label is', 'labels are')} queued to send.` : 'Labels you make from now on are sent.'}`
        : `Sharing did not turn on: ${why(r)}.`,
    );
  }

  function onStop() {
    shareAction({ type: 'xsh:share-stop' }, (r) => (r.ok ? 'Sharing is off. Nothing more is sent.' : `Sharing did not turn off: ${why(r)}.`));
  }

  function onForget() {
    if (shareBusy) return;
    if (!forgetArmed) {
      forgetArmed = true;
      drawShare();
      return;
    }
    shareAction({ type: 'xsh:share-forget' }, (r) =>
      r.ok
        ? `Deleted ${plural(r.removed, 'report', 'reports')} from the server. Sharing is off.`
        : `Nothing was deleted: ${why(r)}. Sharing is off; try again.`,
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[K.settings] || Object.keys(changes).some((k) => L.isListKey(k))) draw();
    if (changes[K.settings] || changes[K.share] || changes[K.labelCount]) drawShare();
  });
  draw();
  // Opened from the popup's Share your labels: the section is below the
  // lists, which draw after the page loads, so it is scrolled to once drawn.
  drawShare().then(() => {
    const here = globalThis.location;
    if (here && here.hash === '#share' && typeof $('share').scrollIntoView === 'function') $('share').scrollIntoView();
  });
})();
