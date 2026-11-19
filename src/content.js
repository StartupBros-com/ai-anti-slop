// AI Anti-Slop content script: hides x.com timeline cells whose post author is
// on the list. In the user's own tabs it never clicks anything.
//
// Muting, when the user has turned it on, happens only in a tab the background
// worker opened for one job (see runJob below): there it clicks a post's ⋯ and
// X's own Mute item, then reports back, and the worker closes the tab. It never
// calls X's API.
//
// Labels, unless the user has turned them off (extension only): every post
// X lists (home, search, profiles, lists, notifications, a post's page) gets
// one icon button, Hide as slop, in its header, left of X's Grok and More
// icons, except where a click could never hide it (labelTarget). A click
// there, and the Undo it offers, are the only things this script acts on in
// the user's own tabs, and only a click the browser marks as the user's own.
// A click shows on the page at once and is handed to the background worker
// to save only when its 6-second Undo window ends, so an undone click is
// never saved and never reaches muting.
//
// State comes from an adapter: the extension adapter below (chrome.storage,
// filled by background.js), or globalThis.XSlopHideAdapter when the userscript
// build supplies one. The userscript adapter has no jobs and no labels, so it
// only hides.
(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  if (!L) return;

  const ATTR = 'data-xsh-hidden';
  const ARTICLE = 'article[data-testid="tweet"]';
  const CELL = '[data-testid="cellInnerDiv"]';

  let list = new Set();
  let allow = new Set();
  let mentions = new Set(); // bots whose tags hide a post
  let paused = false;
  let muting = false;
  let lastPath = location.pathname;
  let meUnknown = false; // a tagged post was left visible, or a button drawn, before whoAmI() answered
  const hiddenPosts = new Set(); // distinct posts hidden in this tab
  const hiddenAuthors = new Set();
  const hiddenMentions = new Set(); // distinct posts hidden for tagging a bot

  // Labels (see the header). BAR marks the holder of a post's button, its
  // value the post id.
  const BAR = 'data-xsh-bar';
  let labeling = false;
  let listed = new Set(); // the list itself, for the button's tooltip
  let allowBox = new Set(); // Always show, as typed
  let extraBox = new Set(); // Also hide, as typed
  const labels = new Map(); // post id -> 'slop' | 'not_slop' | null, once read
  const asked = new Set(); // post ids whose label was read or is being read
  const toRead = new Set();
  const notes = new Map(); // post id -> why the last click was not saved

  // How long a label click can be undone before it is saved.
  const UNDO_MS = 6000;
  // The one click still inside its Undo window, or null.
  let pending = null;
  // Accounts a click has put in a box that the stored settings do not show
  // there yet: { handle, field } with field 'extraList' (Also hide) or
  // 'allowlist' (Always show). Each stays until the stored settings have it,
  // or its click is undone or refused.
  let overlay = [];
  // What hiding goes by: the stored list and boxes plus the overlay.
  let viewList = new Set();
  let viewAllow = new Set();
  let viewExtraBox = new Set();
  let viewAllowBox = new Set();
  // The notice that says what a click did and offers Undo: [data-xsh-toast],
  // a polite live region kept on the page while labelling is on.
  const TOAST = 'data-xsh-toast';
  let toastTimer = null;

  function injectStyle() {
    if (document.getElementById('xsh-style')) return;
    const st = document.createElement('style');
    st.id = 'xsh-style';
    st.textContent = `[${ATTR}]{display:none!important}`;
    (document.head || document.documentElement).appendChild(st);
  }

  // The button's look, added only while labels are on, so a page with them
  // off gets nothing beyond the hide rule. It copies X's own icons: a 19px
  // glyph in X's grey (More's, read where it goes: headStyle), red with a
  // round tint on hover, filled red once the post is labelled. The tint
  // circle is 35x36 px. A post without More gets the button in a row of its
  // own under the text.
  function injectBarStyle() {
    if (document.getElementById('xsh-bar-style')) return;
    const st = document.createElement('style');
    st.id = 'xsh-bar-style';
    st.textContent =
      // In a post's header, left of Grok and More, with the 8px X leaves between those two.
      `[${BAR}]{display:flex;flex:none;align-items:center;margin:0 8px 0 0;color:rgb(113,118,123)}` +
      `[${BAR}][data-xsh-own-row]{margin:4px 0 8px 64px}` +
      `[${BAR}] button{position:relative;display:flex;align-items:center;justify-content:center;width:19px;height:20px;margin:0;padding:0;border:0;background:none;color:inherit;cursor:pointer;transition:color .15s ease-out}` +
      `[${BAR}] button::before{content:"";position:absolute;inset:-8px;border-radius:9999px;transition:background-color .15s ease-out}` +
      `[${BAR}] svg{position:relative;width:18.75px;height:18.75px;overflow:visible}` +
      `[${BAR}] .xsh-fill{fill:none}` +
      `[${BAR}] button[aria-pressed="true"]{color:rgb(244,33,46)}` +
      `[${BAR}] button[aria-pressed="true"] .xsh-fill{fill:currentColor}` +
      `[${BAR}] button[aria-pressed="true"] .xsh-cross{display:none}` +
      `@media (hover:hover){[${BAR}] button:hover{color:rgb(244,33,46)}[${BAR}] button:hover::before{background:rgba(244,33,46,.1)}}` +
      `[${BAR}] button:focus-visible{outline:none}` +
      `[${BAR}] button:focus-visible::before{box-shadow:0 0 0 2px rgb(29,155,240)}` +
      `@media (forced-colors:active){[${BAR}] button:focus-visible{outline:2px solid Highlight}[${BAR}] button[aria-pressed="true"]{color:Highlight}}` +
      `@media (prefers-reduced-motion:reduce){[${BAR}] button,[${BAR}] button::before{transition:none}}` +
      `[${TOAST}]{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:14px/1.4 system-ui,sans-serif}` +
      `[${TOAST}] [data-xsh-toast-box]{display:flex;gap:12px;align-items:center;max-width:min(90vw,480px);padding:10px 14px;border-radius:8px;background:rgb(15,20,25);color:#fff;box-shadow:0 2px 12px rgba(0,0,0,.35);pointer-events:auto}` +
      `[${TOAST}] [hidden]{display:none!important}` +
      `[${TOAST}] button{font:inherit;font-weight:700;color:rgb(29,155,240);background:transparent;border:0;padding:4px 6px;cursor:pointer}`;
    (document.head || document.documentElement).appendChild(st);
  }

  function postKey(article) {
    const t = article.querySelector('a[href*="/status/"] time');
    const a = t && t.closest('a');
    return (a && a.getAttribute('href')) || null;
  }

  function evaluate(article, owner) {
    const author = L.authorHandleOf(article);
    const cell = article.closest(CELL) || article;
    const hide = L.shouldHide(author, { list: viewList, allow: viewAllow, owner, paused });
    if (hide) {
      if (cell.getAttribute(ATTR) !== author) cell.setAttribute(ATTR, author);
      // Hidden only by a click not yet saved: not a sighting and not counted,
      // so an undone click leaves no trace and a saved one is counted then.
      if (!L.shouldHide(author, { list, allow, owner, paused })) return;
      // Seen while browsing: muted ahead of the rest of the list.
      if (muting && !hiddenAuthors.has(author) && adapter.noteSighting) adapter.noteSighting(author);
      hiddenAuthors.add(author);
      const k = postKey(article);
      if (k) hiddenPosts.add(k);
      return;
    }
    // A post that tags a hidden bot. Not a sighting: its author is not listed.
    const tagged = mentions.size ? L.mentionIn(article, mentions) : null;
    // Until the sidebar shows who is logged in, the user's own posts cannot be
    // told apart, so a tagged post stays visible; onMutations looks again then.
    const who = tagged ? whoAmI() : null;
    if (tagged && !who) meUnknown = true;
    if (who && L.shouldHideMention(author, tagged, { allow: viewAllow, owner, paused, me: who.me, mentions })) {
      const v = `mention:${tagged}`;
      if (cell.getAttribute(ATTR) !== v) cell.setAttribute(ATTR, v);
      const k = postKey(article);
      if (k) hiddenMentions.add(k);
    } else if (cell.hasAttribute(ATTR)) {
      cell.removeAttribute(ATTR);
    }
  }

  // ---------------------------------------------------------------- labels

  // The post a button would label, or null: any post with its own link and
  // author, wherever X lists it, except where a click could never hide it:
  // the user's own posts (`who` is whoAmI()), and posts by the account whose
  // profile or post page is open, which hiding leaves alone (L.shouldHide's
  // owner). On a post's own page that is the post itself and its author's
  // replies under it.
  function labelTarget(article, who) {
    const url = postKey(article);
    const post = url && L.statusOf(url);
    if (!post) return null;
    const author = L.authorHandleOf(article);
    if (!author || author === L.pageOwner(location.pathname)) return null;
    if (who && who.me === author) return null;
    return { id: post.id, url, author };
  }

  // The post's own text (not a quoted post's), with emoji, which X draws as
  // images, read from their alt text.
  function postText(article) {
    const el = [...article.querySelectorAll('[data-testid="tweetText"]')].find((t) => !L.insideQuoteCard(t, article));
    if (!el) return '';
    const parts = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) parts.push(c.data);
        else if (c.nodeType === 1 && c.tagName === 'IMG') parts.push(c.getAttribute('alt') || '');
        else if (c.nodeType === 1) walk(c);
      }
    };
    walk(el);
    return parts.join('').trim();
  }

  // The post's button holder, wherever it sits inside the post (not inside a
  // post nested in it).
  function barOf(article) {
    for (const b of article.querySelectorAll(`[${BAR}]`)) if (b.closest(ARTICLE) === article) return b;
    return null;
  }

  // X's More (⋯) button at the top right of a post, not one in a post nested
  // in it, or null.
  function caretOf(article) {
    for (const c of article.querySelectorAll('[data-testid="caret"]')) if (c.closest(ARTICLE) === article) return c;
    return null;
  }

  // One of the icons beside More: a box holding a button and no link, which
  // the author's names beside them always hold (Grok's button is named only
  // in X's own language, so it is found by its shape).
  const BUTTONISH = 'button, [role="button"]';
  const isIconBox = (el) => !!(el.matches(BUTTONISH) || el.querySelector(BUTTONISH)) && !el.querySelector('a[href]');

  // Where the button goes in a post's header: first in the group of icons at
  // its top right (Grok, then More), or just before More when More stands
  // alone. That group is the right end of the header and grows leftward, so
  // none of X's icons moves, as each would in the action row. Returns
  // { parent, before }, or null when the post has no More button (yet).
  function headSpot(article, bar) {
    const caret = caretOf(article);
    if (!caret) return null;
    // The lowest box holding More and something else of X's (not the button,
    // which may sit beside More already), and More's branch in it.
    const xKids = (el) => [...el.children].filter((c) => c !== bar).length;
    let branch = caret;
    let box = caret.parentElement;
    while (box && box !== article && xKids(box) < 2) {
      branch = box;
      box = box.parentElement;
    }
    const others = box && box !== article ? [...box.children].filter((c) => c !== branch && c !== bar) : [];
    if (others.length && others.every(isIconBox)) return { parent: box, before: [...box.children].find((c) => c !== bar) };
    return { parent: caret.parentElement, before: caret };
  }

  // X opens a post on a click anywhere in it, and has keyboard shortcuts:
  // none of these events, done on the button or in the notice, reaches its
  // handlers.
  const STOPPED = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup'];

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BUBBLE = 'M5.5 4.5h13a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H12l-4.75 3.9V17H5.5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z';
  const CROSS = 'M9.5 8.25l5 5m0-5l-5 5';
  let iconSeq = 0;

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // A speech bubble with an X in it. Labelled, the bubble fills and the X is
  // cut out of it, by a mask of the icon's own (a mask shared between icons
  // would stop drawing once the post holding it is hidden).
  function makeIcon() {
    const id = `xsh-cross-${++iconSeq}`;
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    const mask = svgEl('mask', { id });
    mask.appendChild(svgEl('rect', { width: '24', height: '24', fill: '#fff' }));
    mask.appendChild(svgEl('path', { d: CROSS, stroke: '#000', 'stroke-width': '1.75', 'stroke-linecap': 'round' }));
    svg.appendChild(mask);
    svg.appendChild(svgEl('path', { class: 'xsh-fill', d: BUBBLE, mask: `url(#${id})`, stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linejoin': 'round' }));
    svg.appendChild(svgEl('path', { class: 'xsh-cross', d: CROSS, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round' }));
    return svg;
  }

  function makeBar() {
    const bar = document.createElement('div');
    bar.setAttribute(BAR, '');
    bar.setAttribute('data-xsh-note', '');
    const b = document.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('data-xsh-label', 'slop');
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', 'Hide as slop');
    b.setAttribute('title', 'Hide as slop');
    b.appendChild(makeIcon());
    bar.appendChild(b);
    for (const type of STOPPED) bar.addEventListener(type, (e) => onBarEvent(e, bar));
    return bar;
  }

  // Why an account shows despite a Slop label, or what already covers it.
  function boxNote(author) {
    if (viewAllowBox.has(author)) return 'in Always show';
    if (viewExtraBox.has(author)) return 'in Also hide';
    if (listed.has(author)) return 'on the list';
    return '';
  }

  // Bring a button up to date. Writes only what differs, so its own
  // mutations settle on the next pass. The note goes in the tooltip.
  function renderBar(bar, id, author) {
    const on = labels.get(id) === 'slop';
    const b = bar.querySelector('[data-xsh-label]');
    const note = notes.get(id) || boxNote(author);
    if (bar.getAttribute('data-xsh-note') !== note) bar.setAttribute('data-xsh-note', note);
    if (!b) return;
    if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
    const tip = (on ? 'Labelled slop: click to remove the label' : 'Hide as slop') + (note ? ` (${note})` : '');
    if (b.getAttribute('title') !== tip) b.setAttribute('title', tip);
  }

  // The button's look in the header, read where it goes: More's grey, and the
  // space after it that makes the 8px X leaves between Grok and More. X's
  // group of icons spaces them itself (a column gap); More's own box does not.
  function headStyle(article, parent) {
    if (typeof getComputedStyle !== 'function') return '';
    const icon = caretOf(article).querySelector('svg');
    const color = icon ? getComputedStyle(icon).color : '';
    const gap = parseFloat(getComputedStyle(parent).columnGap) || 0;
    return `${color ? `color:${color};` : ''}margin-right:${Math.max(0, 8 - gap)}px`;
  }

  // Put the button in the post's header, left of Grok and More (headSpot), or
  // under the post when it has no More button (yet: X fills a post in over
  // several passes). Never in the action row, where it would move X's icons.
  function placeBar(article, bar) {
    const spot = headSpot(article, bar);
    if (spot ? bar.parentNode === spot.parent && bar.nextElementSibling === spot.before : bar.parentNode === article) return;
    if (spot) {
      spot.parent.insertBefore(bar, spot.before);
      bar.removeAttribute('data-xsh-own-row');
      const style = headStyle(article, spot.parent);
      if (style) bar.setAttribute('style', style);
      else bar.removeAttribute('style');
    } else {
      article.appendChild(bar);
      bar.setAttribute('data-xsh-own-row', '');
      bar.removeAttribute('style');
    }
  }

  // Add, update or remove the button on one post. X reuses a post's nodes
  // for another post, so the button is re-keyed whenever the post's link
  // changes.
  function syncBar(article, who) {
    if (!labeling) return;
    const t = labelTarget(article, who);
    let bar = barOf(article);
    if (!t) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) bar = makeBar();
    placeBar(article, bar);
    if (bar.getAttribute(BAR) !== t.id) bar.setAttribute(BAR, t.id);
    if (bar.getAttribute('data-xsh-author') !== t.author) bar.setAttribute('data-xsh-author', t.author);
    renderBar(bar, t.id, t.author);
    if (!asked.has(t.id)) readLabel(t.id);
  }

  // Bring the buttons on these posts up to date. Until the sidebar shows who
  // is logged in, the user's own posts cannot be told apart and get a button;
  // onMutations looks again then, and takes it off.
  function syncBars(arts) {
    if (!labeling) return;
    const who = whoAmI();
    if (!who && arts.length) meUnknown = true;
    for (const art of arts) syncBar(art, who);
  }

  function renderId(id) {
    for (const bar of document.querySelectorAll(`[${BAR}]`)) {
      if (bar.getAttribute(BAR) === id) renderBar(bar, id, bar.getAttribute('data-xsh-author') || '');
    }
  }

  // Read stored labels for posts as their buttons appear, a batch at a time.
  function readLabel(id) {
    asked.add(id);
    toRead.add(id);
    if (toRead.size > 1) return;
    setTimeout(() => {
      const ids = [...toRead];
      toRead.clear();
      Promise.resolve(adapter.getLabels ? adapter.getLabels(ids) : {})
        .then((got) => {
          for (const id of ids) if (!labels.has(id)) labels.set(id, (got && got[id]) || null);
          for (const id of ids) renderId(id);
        })
        .catch(() => {});
    }, 0);
  }

  function onBarEvent(e, bar) {
    e.stopPropagation();
    if (e.type !== 'click') return;
    e.preventDefault();
    // A click made by the page's own script, not the user: ignored.
    if (e.isTrusted === false) return;
    const btn = e.target && e.target.closest ? e.target.closest('[data-xsh-label]') : null;
    const article = bar.closest(ARTICLE);
    if (btn && article) labelClick(article, btn.getAttribute('data-xsh-label'), btn);
  }

  // Rebuild what hiding goes by from the stored state and the overlay, first
  // dropping overlay entries the stored boxes now hold.
  function refreshView() {
    overlay = overlay.filter((o) => !(o.field === 'extraList' ? extraBox : allowBox).has(o.handle));
    viewList = new Set(list);
    viewAllow = new Set(allow);
    viewExtraBox = new Set(extraBox);
    viewAllowBox = new Set(allowBox);
    for (const o of overlay) {
      if (o.field === 'extraList') {
        viewList.add(o.handle);
        viewExtraBox.add(o.handle);
      } else {
        viewAllow.add(o.handle);
        viewAllowBox.add(o.handle);
      }
    }
  }

  function dropEntry(entry) {
    if (entry) overlay = overlay.filter((o) => o !== entry);
  }

  // A click on Hide as slop. On a post already labelled slop it clears the
  // label; on one labelled Not slop (only older versions drew that button)
  // it labels it slop. The page changes now; the save waits for the window
  // to end.
  function labelClick(article, which, btn) {
    if (!labeling) return;
    // Until the sidebar shows who is logged in, the post may be the user's
    // own, and the click would put their own handle in Also hide.
    const who = whoAmI();
    if (!who) {
      showToast('Not saved: x.com has not shown who is logged in yet. Try again in a moment.', false);
      return;
    }
    const t = labelTarget(article, who);
    if (!t) return;
    // One click at a time: one still in its window is saved first.
    commit();
    const had = labels.has(t.id);
    const prev = had ? labels.get(t.id) : null;
    const label = prev === which ? null : which;
    // What will be saved is read now: by the time the window ends, X may
    // have reused this post's nodes, or the page may have changed.
    const msg = { label, handle: t.author, url: t.url, page: location.pathname, text: postText(article) };
    // The box the click adds the account to, as the worker's save will.
    const field = label === 'slop' ? 'extraList' : null;
    const entry = field && !(field === 'extraList' ? viewExtraBox : viewAllowBox).has(t.author) ? { handle: t.author, field } : null;
    if (entry) overlay.push(entry);
    pending = { id: t.id, which, had, prev, note: notes.get(t.id), label, msg, entry, btn, timer: setTimeout(commit, UNDO_MS) };
    notes.delete(t.id);
    labels.set(t.id, label);
    refreshView();
    rescanAll();
    renderId(t.id);
    const cell = article.closest(CELL) || article;
    showToast(clickText(label, entry, t.author, cell.hasAttribute(ATTR), label === 'slop' && viewAllowBox.has(t.author)), true);
    // A click that hides the post hides the button too: focus moves to Undo.
    if (btn && document.activeElement === btn && btn.closest(`[${ATTR}]`)) {
      const u = undoButton();
      if (u) u.focus();
    }
  }

  // What the notice says a click did. gone: the post is hidden now (not so
  // while hiding is paused or the account is in Always show). allowed: the
  // account is in Always show, as one labelled Not slop before 0.9.0 is, so
  // the label hides nothing.
  function clickText(label, entry, handle, gone, allowed) {
    if (label === null) return 'Slop label removed.';
    const did = gone ? `Hid @${handle}` : `Labelled @${handle} as slop`;
    const text = entry ? `${did} and added it to Also hide.` : `${did}.`;
    return allowed ? `${text} It still shows: it is in Always show.` : text;
  }

  // Put a post's label back as it was before a click.
  function restoreLabel(p) {
    if (p.had) {
      labels.set(p.id, p.prev);
    } else {
      // Its stored label had not been read yet: read it again.
      labels.delete(p.id);
      asked.delete(p.id);
    }
  }

  // Hand the click still in its window, if any, to the worker to save now.
  function commit() {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    const undoHadFocus = isUndoFocused();
    closeToast();
    if (undoHadFocus) focusNext(p);
    let sent;
    try {
      sent = Promise.resolve(adapter.saveLabel(p.msg));
    } catch (e) {
      sent = Promise.reject(e);
    }
    sent
      .catch((e) => ({ ok: false, reason: String((e && e.message) || e) }))
      .then((res) => (res && res.ok ? saved(p) : refused(p, (res && res.reason) || 'no answer')));
  }

  // Saved. The click's own change is dropped only with the stored state read
  // after the save, so a hidden post is never shown between the two.
  function saved(p) {
    return Promise.resolve()
      .then(() => adapter.load())
      .then(
        (s) => {
          dropEntry(p.entry);
          applyState(s);
        },
        () => {
          dropEntry(p.entry);
          refreshView();
          rescanAll();
        },
      );
  }

  // Refused or lost: the page goes back to what is stored, and the button's
  // tooltip says why.
  function refused(p, reason) {
    dropEntry(p.entry);
    const note = `not saved: ${reason}`;
    if (pending && pending.id === p.id) {
      // A newer click on this post is still in its window and stays shown.
      // Its Undo goes back to the stored label, with this note.
      pending.had = false;
      pending.note = note;
    } else if (labels.get(p.id) === p.label) {
      // The label before this click may itself have been a click that was
      // never saved: read the stored one again.
      labels.delete(p.id);
      asked.delete(p.id);
      notes.set(p.id, note);
    }
    // Otherwise a newer click on this post was already sent, and its answer
    // decides what the button shows.
    refreshView();
    rescanAll();
    renderId(p.id);
    // A newer click still in its window keeps its notice and its Undo.
    if (!pending) showToast(`Not saved: ${reason}`, false);
  }

  // Undo the click still in its window: nothing was saved, so nothing is
  // sent. quiet, when labelling is turned off, skips the notice and focus.
  function undo(quiet) {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    dropEntry(p.entry);
    restoreLabel(p);
    if (p.note) notes.set(p.id, p.note);
    else notes.delete(p.id);
    refreshView();
    rescanAll();
    renderId(p.id);
    if (quiet) return;
    showToast('Undone.', false);
    // Back to the button the click was made with, if it shows again.
    const bar = p.btn && p.btn.closest(`[${BAR}]`);
    if (bar && bar.getAttribute(BAR) === p.id && document.contains(p.btn) && !p.btn.closest(`[${ATTR}]`)) p.btn.focus();
  }

  const toastEl = () => document.querySelector(`[${TOAST}]`);
  const undoButton = () => document.querySelector(`[${TOAST}] [data-xsh-undo]`);
  const isUndoFocused = () => {
    const u = undoButton();
    return !!u && document.activeElement === u;
  };

  // Kept on the page while labelling is on, empty between clicks, so screen
  // readers announce what goes into it.
  function makeToast() {
    if (toastEl()) return;
    const el = document.createElement('div');
    el.setAttribute(TOAST, '');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const box = document.createElement('div');
    box.setAttribute('data-xsh-toast-box', '');
    box.setAttribute('hidden', '');
    const text = document.createElement('span');
    text.setAttribute('data-xsh-toast-text', '');
    const u = document.createElement('button');
    u.setAttribute('type', 'button');
    u.setAttribute('data-xsh-undo', '');
    u.textContent = 'Undo';
    box.appendChild(text);
    box.appendChild(u);
    el.appendChild(box);
    for (const type of STOPPED) el.addEventListener(type, onToastEvent);
    (document.body || document.documentElement).appendChild(el);
  }

  function onToastEvent(e) {
    e.stopPropagation();
    if (e.type !== 'click') return;
    e.preventDefault();
    if (e.isTrusted === false) return;
    if (e.target && e.target.closest && e.target.closest('[data-xsh-undo]')) undo(false);
  }

  function showToast(text, offerUndo) {
    if (!labeling) return;
    makeToast();
    const el = toastEl();
    el.querySelector('[data-xsh-toast-text]').textContent = text;
    const u = el.querySelector('[data-xsh-undo]');
    if (offerUndo) u.removeAttribute('hidden');
    else u.setAttribute('hidden', '');
    el.querySelector('[data-xsh-toast-box]').removeAttribute('hidden');
    clearTimeout(toastTimer);
    toastTimer = offerUndo ? null : setTimeout(closeToast, UNDO_MS);
  }

  function closeToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    const el = toastEl();
    if (!el) return;
    el.querySelector('[data-xsh-toast-text]').textContent = '';
    el.querySelector('[data-xsh-toast-box]').setAttribute('hidden', '');
  }

  // The window ended with focus on Undo, which now hides: move it to the
  // same button on the next post that shows, if there is one.
  function focusNext(p) {
    const all = [...document.querySelectorAll(`[${BAR}] [data-xsh-label="${p.which}"]`)];
    const i = p.btn ? all.indexOf(p.btn) : -1;
    if (i < 0) return;
    const next = all.slice(i + 1).find((b) => !b.closest(`[${ATTR}]`));
    if (next) next.focus();
  }

  function onLabelChange(id, label) {
    if (pending && pending.id === id) {
      // A click on this post is still in its window and stays shown. Its
      // Undo goes back to the label now stored.
      pending.had = true;
      pending.prev = label || null;
      asked.add(id);
      return;
    }
    labels.set(id, label || null);
    asked.add(id);
    renderId(id);
  }

  function rescanAll() {
    const owner = L.pageOwner(location.pathname);
    const arts = document.querySelectorAll(ARTICLE);
    for (const art of arts) evaluate(art, owner);
    syncBars(arts);
    // Cells hidden earlier whose post has since been replaced or unlisted.
    for (const cell of document.querySelectorAll(`[${ATTR}]`)) {
      const art = cell.matches(ARTICLE) ? cell : cell.querySelector(ARTICLE);
      if (!art) cell.removeAttribute(ATTR);
    }
  }

  function onMutations(records) {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      // Leaving the page ends a label click's Undo window.
      commit();
      rescanAll();
      return;
    }
    // The sidebar's profile link arrived after some tagged posts: look at them again.
    if (meUnknown && whoAmI()) {
      meUnknown = false;
      rescanAll();
      return;
    }
    const owner = L.pageOwner(lastPath);
    const touched = new Set();
    const dirtyCells = new Set();
    for (const r of records) {
      if (r.type === 'attributes') {
        // An href rewritten in place, as when a recycled node gets a new post.
        const host = r.target && r.target.nodeType === 1 ? r.target.closest(ARTICLE) : null;
        if (host) touched.add(host);
        continue;
      }
      // Removed nodes no longer have a useful parent. Revisit their surviving
      // target article or hidden cell after the whole mutation batch settles.
      if (r.removedNodes && r.removedNodes.length && r.target && r.target.nodeType === 1) {
        const host = r.target.closest(ARTICLE);
        if (host) touched.add(host);
        const cell = r.target.closest(CELL);
        if (cell && cell.hasAttribute(ATTR)) dirtyCells.add(cell);
      }
      for (const n of r.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        // n is a post, sits inside one (X fills the author block in late), or holds some.
        const host = n.closest(ARTICLE);
        if (host) touched.add(host);
        // One subtree walk finds posts and previously hidden, reinserted cells.
        if (n.hasAttribute(ATTR)) dirtyCells.add(n);
        for (const element of n.querySelectorAll(`${ARTICLE}, [${ATTR}]`)) {
          if (!host && element.matches(ARTICLE)) touched.add(element);
          if (element.hasAttribute(ATTR)) dirtyCells.add(element);
        }
      }
    }
    for (const cell of dirtyCells) {
      if (!document.contains(cell)) continue;
      const articles = cell.matches(ARTICLE) ? [cell] : cell.querySelectorAll(ARTICLE);
      if (!articles.length) cell.removeAttribute(ATTR);
      else for (const art of articles) touched.add(art);
    }
    // A node added then removed in the same batch must not affect live state or stats.
    const live = [];
    for (const art of touched) {
      if (!document.contains(art)) continue;
      evaluate(art, owner);
      live.push(art);
    }
    syncBars(live);
  }

  function applyState(s) {
    const handles = (s.list && s.list.handles) || [];
    const st = s.settings || {};
    list = L.effectiveList(handles, s.settings);
    allow = L.effectiveAllow(s.settings);
    mentions = L.mentionTargets(s.settings, handles);
    paused = !!st.paused;
    muting = !!st.muteEnabled;
    listed = new Set(handles);
    allowBox = L.parseAllowlist(st.allowlist);
    extraBox = L.parseAllowlist(st.extraList);
    labeling = !!(L.labelsOn(st) && adapter.saveLabel);
    if (labeling) {
      injectBarStyle();
      makeToast();
    } else {
      // Turned off inside a click's window: the click is dropped, as the
      // worker would refuse it now.
      undo(true);
      for (const bar of document.querySelectorAll(`[${BAR}]`)) bar.remove();
      const el = toastEl();
      if (el) el.remove();
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
    }
    refreshView();
    rescanAll();
  }

  // Who this tab is logged in as: { me } from the sidebar's profile link,
  // { login: true } when x.com shows a login button, null while still loading.
  function whoAmI() {
    if (document.querySelector('[data-testid="loginButton"]')) return { login: true };
    const a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const m = a && /^\/([A-Za-z0-9_]{1,15})$/.exec(a.getAttribute('href') || '');
    return m ? { me: m[1].toLowerCase() } : null;
  }

  function stats() {
    const who = whoAmI();
    return {
      listed: list.size,
      paused,
      me: (who && who.me) || null,
      hiddenNow: document.querySelectorAll(`[${ATTR}]`).length,
      hiddenPosts: hiddenPosts.size,
      hiddenAuthors: [...hiddenAuthors].sort(),
      hiddenMentions: hiddenMentions.size,
    };
  }

  // ------------------------------------------------------------ mute jobs

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  async function waitFor(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step || 500);
    }
  }

  // How long to wait for the page to show who is logged in, a post, or rows.
  const waitMs = (job) => job.waitMs || 20000;

  // The job's tab must be logged in as the account muting was turned on for.
  async function wrongAccount(job) {
    const who = await waitFor(whoAmI, waitMs(job));
    if (!who) return { status: 'error', reason: 'the page never showed who is logged in' };
    if (who.login) return { status: 'login', reason: 'x.com shows a login button' };
    if (who.me !== job.account) return { status: 'wrong-account', reason: `logged in as @${who.me}, not @${job.account}` };
    return null;
  }

  // On x.com/<handle>: open the ⋯ menu of a post the account wrote (reposts
  // and quoted posts do not count). Returns { items }, the menu's items, or
  // { result } to report instead. X shows a muted account's posts on its own
  // profile, and their menu offers Unmute (seen 2026-11-06).
  async function openPostMenu(job) {
    const h = job.handle;
    const bad = await wrongAccount(job);
    if (bad) return { result: bad };
    // A post appears a few seconds before its ⋯ button does (seen on 3 of 4
    // profiles on 2026-11-06), so wait for one that has the button.
    // A deleted or suspended account's profile shows X's notice instead, so
    // the wait ends once that has shown on two polls in a row.
    const own = () => [...document.querySelectorAll(ARTICLE)].filter((a) => L.authorHandleOf(a) === h);
    let goneSeen = 0;
    const found = await waitFor(() => {
      for (const a of own()) {
        const c = a.querySelector('[data-testid="caret"]');
        if (c) return { caret: c };
      }
      const gone = L.profileGone(document);
      goneSeen = gone ? goneSeen + 1 : 0;
      return goneSeen >= 2 ? { gone } : null;
    }, waitMs(job));
    if (found && found.gone) return { result: { status: 'gone', reason: found.gone } };
    if (!found) {
      return {
        result: { status: 'no-post', reason: own().length ? 'its posts have no ⋯ button' : 'no post by the account on its profile' },
      };
    }
    found.caret.click();
    const menu = await waitFor(() => document.querySelector('[role="menu"]'), 5000, 300);
    if (!menu) return { result: { status: 'error', reason: 'the ⋯ menu did not open' } };
    await sleep(300); // the items arrive just after the menu node
    return { items: [...menu.querySelectorAll('[role="menuitem"]')] };
  }

  // Click one menu item once the worker says the job still stands, then read
  // what X shows: a confirmation sheet (left unanswered) or a toast. Settings
  // or the list may have changed since this tab claimed the job; the worker
  // answers no (and closes this tab) if the click is no longer wanted.
  async function clickConfirmed(job, item, status) {
    if (!adapter.confirmJob || !(await adapter.confirmJob(job))) {
      return { status: 'error', reason: `the worker did not confirm the ${job.kind}` };
    }
    item.click();
    const sheet = () => document.querySelector('[data-testid="confirmationSheetDialog"]');
    const toast = () => {
      const t = document.querySelector('[data-testid="toast"]');
      return t && textOf(t) ? t : null;
    };
    await waitFor(() => sheet() || toast(), 4000, 250);
    if (sheet()) return { status: 'refused', reason: 'X asked for a confirmation; left it unanswered' };
    const t = toast();
    return { status, toast: t ? textOf(t) : null };
  }

  // Click X's own Mute item in a post's menu. Tested with synthetic clicks on
  // 2026-11-06, including in a background tab that drew no frames. A menu we
  // decline stays open: the worker closes the tab.
  async function muteJob(job) {
    const open = await openPostMenu(job);
    if (open.result) return open.result;
    const pick = L.chooseMuteItem(open.items.map(textOf), job.handle);
    if (pick.action === 'done') return { status: pick.status };
    if (pick.action === 'refuse') return { status: pick.status, reason: pick.reason };
    return clickConfirmed(job, open.items[pick.index], 'muted');
  }

  // Click X's own Unmute item in a post's menu, for an account AI Anti-Slop
  // muted that muting no longer picks.
  async function unmuteJob(job) {
    const open = await openPostMenu(job);
    if (open.result) return open.result;
    const pick = L.chooseUnmuteItem(open.items.map(textOf), job.handle);
    if (pick.action === 'done') return { status: pick.status };
    if (pick.action === 'refuse') return { status: pick.status, reason: pick.reason };
    return clickConfirmed(job, open.items[pick.index], 'unmuted');
  }

  function mutedRows() {
    const out = [];
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      const a = cell.querySelector('a[href]');
      const m = a && /^\/([A-Za-z0-9_]{1,15})$/.exec(a.getAttribute('href') || '');
      if (m) out.push(m[1].toLowerCase());
    }
    return out;
  }

  // On x.com/settings/muted/all: the rows it renders, newest mute first. A
  // background tab renders only the first 9 or so and loads no more on scroll
  // (seen 2026-11-06), which is why the worker checks every few mutes.
  async function checkJob(job) {
    const bad = await wrongAccount(job);
    if (bad) return bad;
    const any = await waitFor(() => mutedRows().length || document.querySelector('[data-testid="emptyState"]'), waitMs(job));
    if (!any) return { status: 'error', reason: 'settings/muted/all showed no rows' };
    // Rows arrive in batches: read them once the count has held for a second.
    let n = mutedRows().length;
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      const m = mutedRows().length;
      if (m === n) break;
      n = m;
    }
    return { status: 'checked', rows: mutedRows() };
  }

  async function runJob(job) {
    const k = job.kind;
    const work = k === 'mute' ? muteJob(job) : k === 'unmute' ? unmuteJob(job) : k === 'check' ? checkJob(job) : null;
    if (!work) return;
    let timer = null;
    const timeout = new Promise((r) => {
      timer = setTimeout(() => r({ status: 'error', reason: 'timed out in the page' }), job.pageTimeoutMs || 60000);
    });
    let result;
    try {
      result = await Promise.race([work, timeout]);
    } catch (e) {
      result = { status: 'error', reason: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
    return adapter.reportJob(Object.assign({ id: job.id }, result));
  }

  function extensionAdapter() {
    const K = L.STORAGE_KEYS;
    // Once the extension context is gone (reload or update), chrome.runtime and
    // chrome.storage calls throw synchronously, before any promise exists: make
    // that a rejection.
    const safe = (call) => {
      try {
        return Promise.resolve(call());
      } catch (e) {
        return Promise.reject(e);
      }
    };
    const send = (msg) => safe(() => chrome.runtime.sendMessage(msg));
    // The handles of every list that is on, as one list: hiding does not care
    // which list an account came from. The AI list's record comes with the
    // settings; any other list's is a second read.
    const read = () =>
      chrome.storage.local.get([K.list, K.settings]).then((o) => {
        const settings = o[K.settings];
        const keys = L.enabledLists(settings).map((l) => L.listKey(l.id));
        const rest = keys.filter((k) => k !== K.list);
        const more = rest.length ? chrome.storage.local.get(rest) : Promise.resolve({});
        return more.then((recs) => ({
          list: { handles: L.unionHandles(keys.map((k) => (k === K.list ? o[K.list] : recs[k]))) },
          settings,
        }));
      });
    return {
      load: read,
      subscribe(cb) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && Object.keys(changes).some((k) => k === K.settings || L.isListKey(k))) read().then(cb);
        });
      },
      serveStats(fn) {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
          if (msg && msg.type === 'xsh:stats') sendResponse(fn());
        });
      },
      // The worker answers with a job only for a tab it opened for one.
      getJob: () => send({ type: 'xsh:job' }).catch(() => null),
      confirmJob: (job) =>
        send({ type: 'xsh:job-go', id: job.id }).then((ok) => ok === true, () => false),
      reportJob: (result) => send({ type: 'xsh:job-result', result }).catch(() => {}),
      noteSighting: (handle) => send({ type: 'xsh:sighting', handle }).catch(() => {}),
      // Asked by the worker before a mute visit past the day's first 25 at 50
      // or 100 a day: is an x.com tab of the user's own open? fn answers no in
      // a job's tab.
      answerPresent(fn) {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
          if (!msg || msg.type !== 'xsh:present') return false;
          Promise.resolve()
            .then(fn)
            .then((v) => sendResponse(v === true), () => sendResponse(false));
          return true;
        });
      },
      // The worker checks and stores a label; it answers { ok } or { ok: false, reason }.
      saveLabel: (m) =>
        chrome.runtime
          .sendMessage(Object.assign({}, m, { type: 'xsh:label' }))
          .catch((e) => ({ ok: false, reason: String((e && e.message) || e) })),
      getLabels(ids) {
        const keys = ids.map((id) => L.LABEL_PREFIX + id);
        return safe(() => chrome.storage.local.get(keys)).then((o) => {
          const out = {};
          for (const id of ids) {
            const r = o[L.LABEL_PREFIX + id];
            out[id] = r && L.LABELS.includes(r.label) ? r.label : null;
          }
          return out;
        });
      },
      subscribeLabels(cb) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          for (const k of Object.keys(changes)) {
            if (!k.startsWith(L.LABEL_PREFIX)) continue;
            const v = changes[k].newValue;
            cb(k.slice(L.LABEL_PREFIX.length), v && L.LABELS.includes(v.label) ? v.label : null);
          }
        });
      },
    };
  }

  const adapter =
    globalThis.XSlopHideAdapter ||
    (typeof chrome !== 'undefined' && chrome.storage && chrome.runtime && chrome.runtime.id ? extensionAdapter() : null);
  if (!adapter) return;

  injectStyle();
  new MutationObserver(onMutations).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  adapter.subscribe(applyState);
  if (adapter.subscribeLabels) adapter.subscribeLabels(onLabelChange);
  // Leaving the page or the tab ends a label click's Undo window: it is
  // handed to the worker now. Each does nothing with no click waiting.
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', commit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') commit();
  });
  if (adapter.serveStats) adapter.serveStats(stats);
  adapter.load().then(applyState);
  // A tab the worker opened for a job gets the job; every other tab gets null.
  let jobAsk = Promise.resolve(null);
  if (adapter.getJob && adapter.reportJob) {
    jobAsk = Promise.resolve(adapter.getJob()).catch(() => null);
    jobAsk.then((job) => job && runJob(job));
  }
  if (adapter.answerPresent) adapter.answerPresent(() => jobAsk.then((job) => !job, () => false));

  // Exposed for the userscript adapter and the live test harness only.
  globalThis.XSlopHideContent = { stats, rescanAll, applyState, runJob };
})();
