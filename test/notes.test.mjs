// The one-line note that stands in for a post hidden by a list, and the
// consent card, run against the real src/content.js under linkedom. Handles
// are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { post, page as bare, meLink, runContent, stateWith, tick, lib } from './helpers.mjs';

const ME = 'me_user';
const page = (cells) => bare([meLink(ME), ...cells]);
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

const PAGE = '/op/status/1';
const UNDO_MS = 6000;
const NAMES = { listed_a: "the readers' list", listed_b: "clankwall's AI flags" };
const HANDLES = ['listed_a', 'listed_b'];
const THREAD = () => [post({ author: 'op', status: '1' }), post({ author: 'listed_a', status: '2' }), post({ author: 'reply_c', status: '3' })];
const on = (settings = {}, handles = HANDLES, names = NAMES) => stateWith(handles, { labeling: true, ...settings }, names);

const noteOf = (t, status) => t.document.querySelector(`[data-fixture="${status}"] [data-xsh-hidenote]`);
const noteText = (t, status) => noteOf(t, status).querySelector('[data-xsh-hidenote-text]').textContent;
const act = (t, status, name) => noteOf(t, status).querySelector(`[data-xsh-note-act="${name}"]`);
const cellOf = (t, status) => t.document.querySelector(`[data-fixture="${status}"]`);
const toast = (t) => t.document.querySelector('[data-xsh-toast]');
const toastText = (t) => toast(t).querySelector('[data-xsh-toast-text]').textContent;
const undoBtn = (t) => toast(t).querySelector('[data-xsh-undo]');
const card = (t) => t.document.querySelector('[data-xsh-consent]');

function click(t, el, trusted = true) {
  const e = new t.window.Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: trusted });
  el.dispatchEvent(e);
  return e;
}

function key(t, name) {
  const e = new t.window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'key', { value: name });
  Object.defineProperty(e, 'isTrusted', { value: true });
  t.document.dispatchEvent(e);
}

// The rule that hides every child of a collapsed cell except the note.
const COLLAPSE_RULE = '[data-xsh-hidden][data-xsh-collapsed]>:not([data-xsh-hidenote])';

// Planted negative 1.
test('a post whose author is only on a list shows a note naming that list, with Show and Not slop, and its article is not displayed', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  const note = noteOf(t, '2');
  assert.ok(note, 'the note is there');
  assert.equal(note.parentNode === cellOf(t, '2'), true, 'a child of the cell');
  assert.equal(cellOf(t, '2').firstElementChild === note, true, 'its first child');
  assert.match(note.textContent, /^Hidden: on the readers' list/);
  assert.deepEqual([...note.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('type')]), [
    ['Show', 'button'],
    ['Not slop', 'button'],
  ]);
  // X's own nodes stay in the cell, hidden by the style: every child but the note matches the hide rule.
  const css = t.document.getElementById('xsh-note-style').textContent;
  assert.ok(css.includes(`${COLLAPSE_RULE}{display:none!important}`), 'the rule that hides X\'s nodes');
  const kids = [...cellOf(t, '2').children];
  assert.deepEqual(kids.map((k) => k.matches(COLLAPSE_RULE)), [false, true]);
  assert.equal(cellOf(t, '2').hasAttribute('data-xsh-collapsed'), true);
  assert.equal(cellOf(t, '2').querySelector('article') !== null, true, "X's article is still in the cell");
  // Visible posts have no note.
  assert.equal(noteOf(t, '3'), null);
  assert.equal(noteOf(t, '1'), null);
  // It is one line: no markup beyond the text and two buttons, and a fixed height.
  assert.ok(css.includes('height:32px'));
  assert.equal(note.textContent.includes('\n'), false);
});

test('the note names the list that holds the account and never how many readers reported it', async () => {
  const t = runContent(page([post({ author: 'op', status: '1' }), post({ author: 'listed_b', status: '2' })]), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.equal(noteText(t, '2'), "Hidden: on clankwall's AI flags");
  assert.equal(/\d/.test(noteOf(t, '2').textContent), false);
});

// Planted negative 2.
test('Not slop on the note saves a not_slop label after the Undo window and the account ends in Always show; Undo inside the window saves nothing and the note returns', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: { worker: true }, clock: true });
  await settle();
  click(t, act(t, '2', 'not-slop'));
  // The post shows at once.
  assert.equal(t.hidden('2'), false);
  assert.equal(noteOf(t, '2'), null);
  assert.equal(toastText(t), 'Marked @listed_a not slop and added it to Always show.');
  assert.deepEqual(t.saves, []);
  t.advance(UNDO_MS);
  await settle();
  assert.equal(t.saves.length, 1);
  assert.deepEqual([t.saves[0].label, t.saves[0].handle], ['not_slop', 'listed_a']);
  assert.match(t.state().settings.allowlist, /listed_a/);
  assert.equal(t.hidden('2'), false);
  assert.equal(noteOf(t, '2'), null);

  // Undo inside the window.
  const u = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: { worker: true }, clock: true });
  await settle();
  click(u, act(u, '2', 'not-slop'));
  assert.equal(u.hidden('2'), false);
  click(u, undoBtn(u));
  await settle();
  u.advance(UNDO_MS * 2);
  await settle();
  assert.deepEqual(u.saves, []);
  assert.equal(u.state().settings.allowlist, undefined);
  assert.equal(u.hidden('2'), true);
  assert.ok(noteOf(u, '2'), 'the note is back');
  assert.match(noteOf(u, '2').textContent, /^Hidden: on the readers' list/);
});

test('Not slop on a post whose label is already not slop saves it again instead of clearing it', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: { stored: { 2: 'not_slop' } }, clock: true });
  await settle();
  click(t, act(t, '2', 'not-slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.map((s) => s.label), ['not_slop']);
});

test('Show reveals that one post, stores nothing, and is forgotten when the page changes', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  const before = JSON.stringify(t.state());
  click(t, act(t, '2', 'show'));
  assert.equal(t.hidden('2'), false);
  assert.equal(noteOf(t, '2'), null);
  assert.equal(toast(t).querySelector('[data-xsh-toast-box]').hasAttribute('hidden'), true, 'no notice: nothing was saved');
  t.advance(UNDO_MS * 2);
  await settle();
  assert.deepEqual(t.saves, []);
  assert.equal(JSON.stringify(t.state()), before);
  // A rescan on the same page keeps it shown.
  t.content.rescanAll();
  assert.equal(t.hidden('2'), false);
  // Navigating forgets it.
  t.location.pathname = '/op/status/9';
  t.document.querySelector('main').insertAdjacentHTML('beforeend', '<div></div>');
  await settle();
  assert.equal(t.hidden('2'), true);
  assert.ok(noteOf(t, '2'), 'the note is back');
});

test('Show is forgotten when the page changes through a page with no posts and back', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  click(t, act(t, '2', 'show'));
  assert.equal(t.hidden('2'), false);
  const timeline = t.document.querySelector('[aria-label="Timeline"]');
  // X removes the timeline on a page with no posts, then draws it again.
  t.location.pathname = '/messages';
  timeline.innerHTML = '<div></div>';
  await settle();
  t.location.pathname = PAGE;
  timeline.innerHTML = THREAD().join('');
  await settle();
  assert.equal(t.hidden('2'), true);
  assert.ok(noteOf(t, '2'), 'the note is back');
});

test('a click the page makes by script, not the user, does nothing on the note', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  click(t, act(t, '2', 'show'), false);
  click(t, act(t, '2', 'not-slop'), false);
  t.advance(UNDO_MS);
  await settle();
  assert.equal(t.hidden('2'), true);
  assert.ok(noteOf(t, '2'));
  assert.deepEqual(t.saves, []);
});

test('the note does not change what the popup counts: hidden posts and authors are the same with Show pressed', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  let s = t.content.stats();
  assert.deepEqual([s.hiddenPosts, s.hiddenNow, Array.from(s.hiddenAuthors)], [1, 1, ['listed_a']]);
  click(t, act(t, '2', 'show'));
  s = t.content.stats();
  assert.deepEqual([s.hiddenPosts, Array.from(s.hiddenAuthors)], [1, ['listed_a']]);
  assert.deepEqual(t.sightings, []);
});

// linkedom does not move focus (it has no activeElement), so each button that
// should receive it records the call.
const watchFocus = (...els) => {
  const got = [];
  for (const el of els) el.focus = () => got.push(el);
  return got;
};

test("focus moves to the revealed post's own Hide as slop button, and Undo puts it back on Not slop", async () => {
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'listed_a', status: '2', actions: true, head: 'grok' })];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  const slop = t.document.querySelector('[data-fixture="2"] [data-xsh-label="slop"]');
  const got = watchFocus(slop);
  click(t, act(t, '2', 'show'));
  assert.equal(got.length === 1 && got[0] === slop, true, "Show: the post's own button");
  // Not slop on a post with a button of its own: that button.
  const t3 = runContent(page(cells), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  const own = t3.document.querySelector('[data-fixture="2"] [data-xsh-label="slop"]');
  const got3 = watchFocus(own, undoBtn(t3));
  click(t3, act(t3, '2', 'not-slop'));
  assert.equal(got3.length === 1 && got3[0] === own, true);
  // Undo returns focus to the note's Not slop button.
  const focused = [];
  t3.window.HTMLElement.prototype.focus = function focus() {
    focused.push(this.getAttribute('data-xsh-note-act'));
  };
  click(t3, undoBtn(t3));
  assert.equal(act(t3, '2', 'not-slop') !== null, true, 'the note is back');
  assert.deepEqual(focused, ['not-slop'], 'focus goes to its Not slop button');
});

// Planted negative: a focused node that is moved in the page loses focus, as in
// Chrome. On x.com, X fills in a revealed post's header icons a moment after
// Show, which moved the button Show had just focused, and focus fell to the page.
test("the post's Hide as slop button keeps focus when X fills in the header icons after it was focused", async () => {
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'listed_a', status: '2', head: 'more' })];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {}, clock: true });
  const doc = t.document;
  let active = null;
  t.window.HTMLElement.prototype.focus = function focus() {
    active = this;
  };
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => (active && active.isConnected ? active : doc.body) });
  // linkedom defines insertBefore below Node.prototype: wrap it where an element finds it.
  let owner = doc.body;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'insertBefore')) owner = Object.getPrototypeOf(owner);
  const insert = owner.insertBefore;
  owner.insertBefore = function insertBefore(node, ref) {
    if (active && node.contains && node.contains(active)) active = null;
    return insert.call(this, node, ref);
  };
  // Nodes are compared with ===: a failed equal on two linkedom nodes formats their whole tree.
  try {
    await settle();
    click(t, act(t, '2', 'show'));
    await settle();
    const slop = doc.querySelector('[data-fixture="2"] [data-xsh-label="slop"]');
    assert.ok(doc.activeElement === slop, "Show focused the post's own button");
    // X adds Grok's button beside More: the button's spot moves to before it.
    const icons = doc.querySelector('[data-fixture="2"] [data-icons]');
    icons.insertAdjacentHTML('afterbegin', '<div><button aria-label="Grok actions" type="button"><svg viewBox="0 0 24 24"></svg></button></div>');
    await settle();
    const bar = doc.querySelector('[data-fixture="2"] [data-xsh-bar]');
    assert.ok(bar.parentElement === icons, 'the button moved into the group of icons');
    assert.ok(doc.activeElement === slop, 'and kept focus');
  } finally {
    owner.insertBefore = insert;
  }
});

test('the card keeps its buttons in view while the disclosure scrolls', async () => {
  const t = consentRun();
  await settle();
  await hideClick(t, '2');
  assert.ok(card(t));
  const css = t.document.getElementById('xsh-consent-style').textContent;
  assert.match(css, /\[data-xsh-consent-actions\]\{position:sticky;bottom:0;/);
  assert.match(css, /\[data-xsh-consent\]\{[^}]*max-height:[^}]*overflow:auto/);
  // No bottom padding on the card: the sticky row stops at the padding's edge,
  // and on x.com scrolled text showed through the strip below it.
  assert.match(css, /\[data-xsh-consent\]\{[^}]*padding:14px 16px 0;/);
  // Bottom right, over X's sidebar: at the bottom left it covered X's Post
  // button and account menu, and the posts at widths up to 1,440 px.
  assert.match(css, /\[data-xsh-consent\]\{position:fixed;right:16px;bottom:16px;/);
});

test('Also hide, a pending Hide as slop click and a tag of a bot stay fully hidden, with no note', async () => {
  // Also hide.
  const a = runContent(page(THREAD()), { pathname: PAGE, state: on({ extraList: 'listed_a' }), labels: {} });
  await settle();
  assert.equal(a.hidden('2'), true);
  assert.equal(noteOf(a, '2'), null);
  assert.equal(cellOf(a, '2').hasAttribute('data-xsh-collapsed'), false);
  // A Hide as slop click not yet saved, on a post Show revealed.
  const c = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  click(c, act(c, '2', 'show'));
  c.content.rescanAll();
  const hide = c.document.querySelector('[data-fixture="2"] [data-xsh-label="slop"]');
  click(c, hide);
  assert.equal(c.hidden('2'), true);
  assert.equal(noteOf(c, '2'), null, 'hidden by the click, not by the list');
  assert.equal(cellOf(c, '2').hasAttribute('data-xsh-collapsed'), false);
  // A post that tags a bot.
  const m = runContent(page([post({ author: 'op', status: '1' }), post({ author: 'friend', mention: 'grok', status: '2' })]), {
    pathname: PAGE,
    state: on({ hideBotMentions: true, bots: { grok: 'hide' } }, []),
    labels: {},
  });
  await settle();
  assert.equal(cellOf(m, '2').getAttribute('data-xsh-hidden'), 'mention:grok');
  assert.equal(noteOf(m, '2'), null);
});

test('hideFully, paused hiding, the userscript adapter and a mute job\'s tab give no note', async () => {
  const full = runContent(page(THREAD()), { pathname: PAGE, state: on({ hideFully: true }), labels: {} });
  await settle();
  assert.equal(full.hidden('2'), true);
  assert.equal(noteOf(full, '2'), null);
  assert.equal(cellOf(full, '2').hasAttribute('data-xsh-collapsed'), false);

  const paused = runContent(page(THREAD()), { pathname: PAGE, state: on({ paused: true }), labels: {} });
  await settle();
  assert.equal(paused.hidden('2'), false);
  assert.equal(noteOf(paused, '2'), null);

  // No saveLabel: the userscript's adapter.
  const userscript = runContent(page(THREAD()), { pathname: PAGE, state: on() });
  await settle();
  assert.equal(userscript.hidden('2'), true);
  assert.equal(noteOf(userscript, '2'), null);
  assert.equal(userscript.document.getElementById('xsh-note-style'), null);

  // A tab the worker opened for a job.
  const job = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {}, job: { id: 'j1', kind: 'check', account: ME, waitMs: 50, pageTimeoutMs: 500 } });
  await settle();
  assert.equal(job.hidden('2'), true);
  assert.equal(noteOf(job, '2'), null);
  assert.equal(cellOf(job, '2').hasAttribute('data-xsh-collapsed'), false);
});

test('turning hideFully on or off swaps the note and the full hide in place', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.ok(noteOf(t, '2'));
  t.push(on({ hideFully: true }));
  assert.equal(noteOf(t, '2'), null);
  assert.equal(t.hidden('2'), true);
  assert.equal(cellOf(t, '2').hasAttribute('data-xsh-collapsed'), false);
  t.push(on());
  assert.ok(noteOf(t, '2'));
  assert.equal(cellOf(t, '2').querySelectorAll('[data-xsh-hidenote]').length, 1);
});

test('the page settles: a note is placed once and nothing changes after', async () => {
  const t = runContent(page(THREAD()), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  const seen = [];
  const mo = new t.window.MutationObserver((r) => seen.push(...r));
  mo.observe(t.document.body, { childList: true, subtree: true, attributes: true });
  for (let i = 0; i < 5; i++) await tick();
  mo.disconnect();
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------- the real adapter

const AI = 'https://clankwall.vogel.dev/api/usernames.txt';
const LV = 'https://blockedforaireply.levels.io/api/accounts.ndjson';
const CROWD = `${lib.DEFAULTS.crowdBase}/v1/list.ndjson`;

function contentChrome(store) {
  const listeners = [];
  const sent = [];
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
    runtime: {
      id: 'xshtest',
      onMessage: { addListener() {} },
      // Like the worker: no job for a tab it did not open.
      sendMessage: async (m) => {
        sent.push(JSON.parse(JSON.stringify(m)));
        return m.type === 'xsh:job' ? null : { ok: true };
      },
    },
    sent,
  };
}

test('with the extension\'s own adapter, the note names the list a Recommended part came from, and a list that holds the account first', async () => {
  const rec = {
    handles: ['aionly', 'crowdonly', 'lvonly'],
    fetchedAt: 1,
    source: LV,
    parts: [
      { source: AI, handles: ['aionly'] },
      { source: LV, handles: ['lvonly'] },
      { source: CROWD, handles: ['crowdonly'] },
    ],
  };
  const store = { 'xsh:list': { handles: ['aionly', 'both'], fetchedAt: 1, source: AI }, 'xsh:list:recommended': rec, 'xsh:settings': { labeling: true } };
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'aionly', status: '2' }), post({ author: 'crowdonly', status: '3' }), post({ author: 'lvonly', status: '4' })];
  const t = runContent(page(cells), { pathname: PAGE, chrome: contentChrome(store) });
  await settle();
  assert.deepEqual(['2', '3', '4'].map((s) => noteText(t, s)), [
    "Hidden: on clankwall's AI flags",
    "Hidden: on the readers' list",
    "Hidden: on levelsio's list",
  ]);
});

test('with the extension\'s own adapter, a list added by address is named "a list you added", and its address is nowhere in the page', async () => {
  const url = 'https://lists.example.test/private/team.txt?access_token=SECRET1';
  const store = {
    'xsh:list': { handles: [], fetchedAt: 1, source: AI },
    'xsh:list:u1': { handles: ['addedonly'], fetchedAt: 1, source: url },
    'xsh:settings': { labeling: true, lists: { recommended: false }, customLists: [{ id: 'u1', url, on: true }] },
  };
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'addedonly', status: '2' })];
  const t = runContent(page(cells), { pathname: PAGE, chrome: contentChrome(store) });
  await settle();
  assert.equal(noteText(t, '2'), 'Hidden: on a list you added');
  const html = t.document.documentElement.outerHTML;
  assert.ok(!html.includes('SECRET1') && !html.includes('example.test'), 'the address is not in the page');
});

// ----------------------------------------------------------- the consent card

const ASK = { ok: true, label: 'slop', askShare: true };
const hideClick = async (t, status) => {
  click(t, t.document.querySelector(`[data-fixture="${status}"] [data-xsh-label="slop"]`));
  t.advance(UNDO_MS);
  await settle();
};
const CELLS = () => [
  post({ author: 'op', status: '1' }),
  post({ author: 'reply_a', status: '2', head: 'grok' }),
  post({ author: 'reply_b', status: '3', head: 'grok' }),
];
const consentRun = (extra = {}) => runContent(page(CELLS()), { pathname: PAGE, state: stateWith([], { labeling: true }), labels: { answer: () => ASK, ...extra }, clock: true });

test('a saved Hide as slop whose answer asks shows the consent card once, with the disclosure and three buttons', async () => {
  const t = consentRun();
  await settle();
  assert.equal(card(t), null);
  await hideClick(t, '2');
  const c = card(t);
  assert.ok(c, 'the card is there');
  assert.equal(c.getAttribute('role'), 'dialog');
  assert.ok(c.getAttribute('aria-label'));
  assert.notEqual(c.getAttribute('aria-modal'), 'true', 'not modal');
  const host = new URL(lib.DEFAULTS.crowdBase).host;
  const text = c.textContent;
  for (const sec of lib.shareDisclosure(host)) {
    assert.ok(text.includes(sec.heading), sec.heading);
    for (const item of sec.items) assert.ok(text.includes(item), item);
  }
  assert.deepEqual([...c.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('type')]), [
    ['Share', 'button'],
    ['Not now', 'button'],
    ['Details', 'button'],
  ]);
  // At most once per tab, even after it is dismissed.
  click(t, c.querySelector('[data-xsh-consent-act="not-now"]'));
  await settle();
  assert.equal(card(t), null);
  await hideClick(t, '3');
  assert.equal(card(t), null);
});

test('Share and Not now send the choice and close the card; Details opens the settings; an untrusted click does nothing; Escape closes it', async () => {
  const t = consentRun();
  await settle();
  await hideClick(t, '2');
  const btn = (n) => card(t).querySelector(`[data-xsh-consent-act="${n}"]`);
  click(t, btn('share'), false);
  click(t, btn('details'), false);
  assert.deepEqual([t.consents, t.opened], [[], []]);
  click(t, btn('details'));
  assert.deepEqual(t.opened, ['settings']);
  assert.ok(card(t), 'Details leaves the card');
  click(t, btn('share'));
  await settle();
  assert.deepEqual(t.consents, ['share']);
  assert.equal(card(t), null);

  const n = consentRun();
  await settle();
  await hideClick(n, '2');
  click(n, card(n).querySelector('[data-xsh-consent-act="not-now"]'));
  await settle();
  assert.deepEqual(n.consents, ['not-now']);
  assert.equal(card(n), null);

  const e = consentRun();
  await settle();
  await hideClick(e, '2');
  key(e, 'Escape');
  assert.equal(card(e), null);
  assert.deepEqual(e.consents, [], 'Escape answers nothing');
});

test('Share answered while another label is in its Undo window keeps that Undo; the answer follows when the window ends', async () => {
  const slop3 = (t) => t.document.querySelector('[data-fixture="3"] [data-xsh-label="slop"]');
  const t = consentRun();
  await settle();
  await hideClick(t, '2');
  click(t, slop3(t));
  const labelText = toastText(t);
  click(t, card(t).querySelector('[data-xsh-consent-act="share"]'));
  await settle();
  assert.deepEqual(t.consents, ['share']);
  assert.equal(toastText(t), labelText, "the label's notice stays");
  assert.equal(undoBtn(t).hasAttribute('hidden'), false, 'with its Undo');
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.map((s) => s.url.split('/').pop()), ['2', '3']);
  assert.match(toastText(t), /^Sharing is on for labels you make from now on\./);

  const u = consentRun();
  await settle();
  await hideClick(u, '2');
  click(u, slop3(u));
  click(u, card(u).querySelector('[data-xsh-consent-act="share"]'));
  await settle();
  click(u, undoBtn(u));
  await settle();
  assert.match(toastText(u), /^Undone\. Sharing is on for labels you make from now on\./);
  u.advance(UNDO_MS * 2);
  await settle();
  assert.deepEqual(u.saves.map((s) => s.url.split('/').pop()), ['2'], 'the undone label is not saved');
});

test('Share refused because the answer is already recorded says so, and any other refusal gives its reason', async () => {
  const t = consentRun({ consent: () => ({ ok: false, reason: 'already answered' }) });
  await settle();
  await hideClick(t, '2');
  click(t, card(t).querySelector('[data-xsh-consent-act="share"]'));
  await settle();
  assert.equal(card(t), null);
  assert.equal(toastText(t), 'You have already answered this. Sharing can be turned on or off in settings.');
  const o = consentRun({ consent: () => ({ ok: false, reason: 'Delete what I shared is running' }) });
  await settle();
  await hideClick(o, '2');
  click(o, card(o).querySelector('[data-xsh-consent-act="share"]'));
  await settle();
  assert.equal(toastText(o), 'Sharing was not turned on: Delete what I shared is running');
});

test('a worker that does not ask gets no card; neither does the userscript or a mute job\'s tab', async () => {
  const quiet = runContent(page(CELLS()), { pathname: PAGE, state: stateWith([], { labeling: true }), labels: {}, clock: true });
  await settle();
  await hideClick(quiet, '2');
  assert.equal(card(quiet), null);

  // A job tab never shows it: it draws no button to click.
  const job = runContent(page(CELLS()), {
    pathname: PAGE,
    state: stateWith([], { labeling: true }),
    labels: { answer: () => ASK },
    job: { id: 'j1', kind: 'check', account: ME, waitMs: 50, pageTimeoutMs: 500 },
    clock: true,
  });
  await settle();
  assert.equal(job.document.querySelector('[data-xsh-label]') === null, true, 'no button in a job tab');
  assert.equal(card(job), null);

  // The userscript has no saveLabel, so no button to click and no card code path.
  const us = runContent(page(CELLS()), { pathname: PAGE, state: stateWith([], { labeling: true }) });
  await settle();
  assert.equal(us.document.querySelector('[data-xsh-label]'), null);
  assert.equal(card(us), null);
});

test('with the extension\'s own adapter the card\'s choices go to the worker as xsh:share-consent and xsh:open-settings', async () => {
  const store = { 'xsh:list': { handles: [], fetchedAt: 1, source: AI }, 'xsh:settings': { lists: { recommended: false } } };
  const chrome = contentChrome(store);
  chrome.runtime.sendMessage = async (m) => {
    chrome.sent.push(JSON.parse(JSON.stringify(m)));
    if (m.type === 'xsh:job') return null;
    return m.type === 'xsh:label' ? { ok: true, label: 'slop', askShare: true } : { ok: true };
  };
  const t = runContent(page(CELLS()), { pathname: PAGE, chrome, clock: true });
  await settle();
  await hideClick(t, '2');
  click(t, card(t).querySelector('[data-xsh-consent-act="details"]'));
  click(t, card(t).querySelector('[data-xsh-consent-act="share"]'));
  await settle();
  assert.deepEqual(chrome.sent.filter((m) => m.type.startsWith('xsh:share') || m.type === 'xsh:open-settings').map((m) => [m.type, m.choice]), [
    ['xsh:open-settings', undefined],
    ['xsh:share-consent', 'share'],
  ]);
});

// ------------------------------------------------------------------- lib

test('listNamesOf names the first list that is on and holds each account, by Recommended\'s source when the record keeps its parts', () => {
  const recs = {
    'xsh:list': { handles: ['a', 'both', '__proto__'] },
    'xsh:list:recommended': {
      handles: ['both', 'crowd', 'lv'],
      parts: [
        { source: lib.DEFAULTS.feedUrl, handles: ['a'] },
        { source: 'https://blockedforaireply.levels.io/api/accounts.ndjson', handles: ['lv', 'both'] },
        { source: CROWD, handles: ['crowd', 'both'] },
      ],
    },
    'xsh:list:clankwall-all': { handles: ['spam', 'a'] },
  };
  // Recommended comes first, then the AI list, then the lists that are on.
  assert.deepEqual({ ...lib.listNamesOf({ lists: { 'clankwall-all': true } }, recs) }, {
    a: "clankwall's AI flags",
    both: "levelsio's list",
    lv: "levelsio's list",
    crowd: "the readers' list",
    spam: 'clankwall: All flags',
  });
  // A list that is off names nothing; no record, no name.
  assert.deepEqual({ ...lib.listNamesOf({ lists: { recommended: false } }, recs) }, { a: 'clankwall: AI flags', both: 'clankwall: AI flags' });
  assert.deepEqual({ ...lib.listNamesOf({}, {}) }, {});
  assert.deepEqual({ ...lib.listNamesOf({}, null) }, {});
  // A list added by address is named as one, never by its address.
  const url = 'https://lists.example.test/private/team.txt?access_token=SECRET2';
  const added = lib.listNamesOf(
    { lists: { recommended: false }, customLists: [{ id: 'u1', url, on: true }] },
    { [lib.listKey('u1')]: { handles: ['added', 'a'] }, 'xsh:list': { handles: ['a'] } },
  );
  assert.deepEqual({ ...added }, { a: 'clankwall: AI flags', added: 'a list you added' });
  // A Recommended record from before it kept parts is named by the list.
  assert.deepEqual({ ...lib.listNamesOf({ lists: { 'clankwall-ai': false } }, { 'xsh:list:recommended': { handles: ['x'] } }) }, { x: 'Recommended' });
});

test('isXPageUrl accepts only https pages of x.com and twitter.com, as the manifest matches them', () => {
  for (const u of ['https://x.com/home', 'https://twitter.com/a/status/1', 'https://mobile.x.com/', 'https://mobile.twitter.com/x']) assert.equal(lib.isXPageUrl(u), true, u);
  for (const u of ['http://x.com/home', 'https://x.com.evil.example/', 'https://evil.example/x.com/', 'https://notx.com/', 'https://x.com', 'chrome-extension://abc/src/popup.html', '', null, undefined, 5]) {
    assert.equal(lib.isXPageUrl(u), false, String(u));
  }
});
