// Runs the real src/content.js label buttons against a linkedom post page
// shaped like x.com's: the post the page is about first, replies under it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { post, page as bare, headIcons, meLink, runContent, stateWith, tick } from './helpers.mjs';

// x.com as it is when logged in: the sidebar's profile link is drawn with the
// posts, unless a test draws its own. bare() is a page without it.
const ME = 'me_user';
const page = (cells) => (cells.some((c) => c.includes('AppTabBar_Profile_Link')) ? bare(cells) : bare([meLink(ME), ...cells]));

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

const PAGE = '/op/status/1';
// Reply 2 has X's icons at its top right (Grok, More) and its row of action
// icons; reply 3 has neither, so its button gets a row of its own.
const THREAD = [
  post({ author: 'op', status: '1', actions: true, head: 'grok' }),
  post({ author: 'reply_a', status: '2', actions: true, head: 'grok' }),
  post({ author: 'reply_b', quote: 'someone', status: '3' }),
];
const on = (settings = {}, handles = []) => stateWith(handles, { labeling: true, ...settings });

// A failing assertion prints its values, and printing a linkedom node walks
// the whole document, which hangs the run: check a node's absence as a boolean.
const absent = (el) => el === null;
const bar = (t, status) => t.document.querySelector(`[data-fixture="${status}"] [data-xsh-bar]`);
const bars = (t) => t.document.querySelectorAll('[data-xsh-bar]').length;
const button = (t, status, label) => bar(t, status).querySelector(`[data-xsh-label="${label}"]`);
const note = (t, status) => bar(t, status).getAttribute('data-xsh-note');
const tip = (t, status) => button(t, status, 'slop').getAttribute('title');
const pressed = (t, status) =>
  [...bar(t, status).querySelectorAll('[data-xsh-label]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-xsh-label'));

const UNDO_MS = 6000;
const toast = (t) => t.document.querySelector('[data-xsh-toast]');
const toastText = (t) => toast(t).querySelector('[data-xsh-toast-text]').textContent;
const toastOpen = (t) => !toast(t).querySelector('[data-xsh-toast-box]').hasAttribute('hidden');
const undoBtn = (t) => toast(t).querySelector('[data-xsh-undo]');

// A click as the user makes it (`trusted`), or as a page script makes it.
function click(t, el, trusted = true) {
  const e = new t.window.Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: trusted });
  el.dispatchEvent(e);
  return e;
}

// Every change to the page's nodes and attributes while `ticks` pass.
async function changesOver(t, ticks = 5) {
  const seen = [];
  const mo = new t.window.MutationObserver((records) => seen.push(...records));
  mo.observe(t.document.body, { childList: true, subtree: true, attributes: true });
  for (let i = 0; i < ticks; i++) await tick();
  mo.disconnect();
  return seen.length;
}

test('waiting for a saved label does not turn a clear into a repeat Slop label', async () => {
  let finish;
  const stored = new Promise((resolve) => { finish = resolve; });
  let reads = 0;
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), clock: true, labels: {
    read: () => { reads++; return stored; },
  } });
  await settle();
  assert.equal(reads, 1);
  click(t, button(t, '2', 'slop'));
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  assert.deepEqual(t.saves, [], 'a lookup in flight is neither a label nor an Undo timer');
  assert.equal(reads, 1, 'clicking while waiting does not start duplicate reads');
  finish({ 2: 'slop' });
  await settle();
  assert.deepEqual(pressed(t, '2'), ['slop']);
  click(t, button(t, '2', 'slop'));
  assert.deepEqual(pressed(t, '2'), []);
  t.advance(UNDO_MS);
  assert.deepEqual(t.saves.map(({ label }) => label), [null]);
});

test('a failed saved-label read can retry on a click without guessing or polling', async () => {
  const reads = [];
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), clock: true, labels: {
    read: (ids) => {
      reads.push([...ids]);
      return reads.length === 1 ? Promise.reject(new Error('temporary storage error')) : { 2: 'slop' };
    },
  } });
  await settle();
  t.notify();
  await settle();
  assert.deepEqual(reads, [['1', '2', '3']], 'a rescan does not repeat a rejected batch');
  click(t, button(t, '2', 'slop'));
  await settle();
  t.advance(UNDO_MS);
  assert.deepEqual(t.saves, [], 'the retry cannot save a guessed label');
  assert.deepEqual(reads, [['1', '2', '3'], ['2']]);
  assert.deepEqual(pressed(t, '2'), ['slop']);
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  assert.deepEqual(t.saves.map(({ label }) => label), [null]);
});

test("with labelling on, a post's page gets one Hide as slop button on every post, the post it is about included, left of Grok and More at its top right", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.deepEqual(['1', '2', '3'].map((s) => bar(t, s).getAttribute('data-xsh-bar')), ['1', '2', '3']);
  assert.deepEqual(['1', '2', '3'].map((s) => bar(t, s).getAttribute('data-xsh-author')), ['op', 'reply_a', 'reply_b']);
  const head = t.document.querySelector('[data-fixture="1"] [data-icons]');
  assert.equal(head.firstElementChild === bar(t, '1'), true, "the page's own post: first in its group at the top right, as on a reply");
  for (const s of ['1', '2', '3']) {
    const buttons = [...bar(t, s).querySelectorAll('button')];
    assert.equal(buttons.length, 1, 'one button: there is no Not slop');
    assert.deepEqual(['data-xsh-label', 'aria-label', 'title', 'aria-pressed', 'type'].map((a) => buttons[0].getAttribute(a)), ['slop', 'Hide as slop', 'Hide as slop', 'false', 'button']);
    assert.equal(buttons[0].textContent, '', 'an icon, named by aria-label');
    assert.equal(buttons[0].querySelector('svg').getAttribute('aria-hidden'), 'true');
  }
  const icons = t.document.querySelector('[data-fixture="2"] [data-icons]');
  const kids = [...icons.children];
  assert.equal(kids.length, 3);
  assert.equal(kids[0] === bar(t, '2'), true, 'first in the group at the top right');
  assert.equal(kids[1].querySelector('[aria-label="Grok actions"]') !== null, true, 'then Grok');
  assert.equal(kids[2].querySelector('[data-testid="caret"]') !== null, true, 'then More');
  assert.equal(bar(t, '2').hasAttribute('data-xsh-own-row'), false);
  const row = t.document.querySelector('[data-fixture="2"] [role="group"]');
  assert.equal(row.children.length, 2, "nothing added to X's action row");
  assert.equal(row.querySelector('[data-xsh-bar]') === null, true);
  const article3 = t.document.querySelector('[data-fixture="3"] article');
  assert.equal(bar(t, '3').parentNode === article3, true, 'no action row: under the post');
  assert.equal(bar(t, '3').hasAttribute('data-xsh-own-row'), true);
  const masks = [...t.document.querySelectorAll('[data-xsh-bar] mask')].map((m) => m.getAttribute('id'));
  assert.equal(new Set(masks).size, 3, "each icon's mask has its own id");
  assert.deepEqual(pressed(t, '2'), []);
  assert.equal(bars(t), 3);
  assert.ok(t.document.getElementById('xsh-bar-style'), 'the button has its look');
  assert.equal(t.document.getElementById('xsh-style').textContent, '[data-xsh-hidden]{display:none!important}', 'the hide rule is unchanged');
});

test('with More alone at the top right the button goes just before it; with only an action row it goes under the post, never in the row', async () => {
  const cells = [
    post({ author: 'op', status: '1', head: 'more' }),
    post({ author: 'reply_a', status: '2', actions: true, head: 'more' }),
    post({ author: 'reply_b', status: '3', actions: true }),
  ];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  const caret = t.document.querySelector('[data-fixture="2"] [data-testid="caret"]');
  assert.equal(bar(t, '2').nextElementSibling === caret, true, 'just before More');
  assert.equal(bar(t, '2').parentNode === caret.parentNode, true);
  assert.equal(bar(t, '2').hasAttribute('data-xsh-own-row'), false);
  const article3 = t.document.querySelector('[data-fixture="3"] article');
  assert.equal(bar(t, '3').parentNode === article3, true, 'no More: under the post');
  assert.equal(bar(t, '3').hasAttribute('data-xsh-own-row'), true);
  for (const s of ['2', '3']) {
    const row = t.document.querySelector(`[data-fixture="${s}"] [role="group"]`);
    assert.equal(row.children.length, 2, `reply ${s}: nothing added to X's action row`);
  }
  assert.equal(await changesOver(t), 0, 'placed once: no node moves again');
});

test("with X's Follow button and an empty box beside Grok and More (the page's own post at 420 px), the button goes just before Grok, not between Grok and More", async () => {
  // Post 3: Follow right beside Grok, with no empty box between (not seen live).
  const tight = post({ author: 'reply_b', status: '3', head: 'follow' }).replace('<div></div>', '');
  const cells = [post({ author: 'op', status: '1', head: 'follow' }), post({ author: 'reply_a', status: '2', head: 'grok' }), tight];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  const icons = t.document.querySelector('[data-fixture="1"] [data-icons]');
  const kids = [...icons.children];
  assert.equal(kids.length, 5);
  assert.equal(kids[0].querySelector('[data-testid="100-follow"]') !== null, true, 'Follow first, as X drew it');
  assert.equal(kids[1].children.length, 0, "then X's empty box");
  assert.equal(kids[2] === bar(t, '1'), true, 'then the button');
  assert.equal(kids[3].querySelector('[aria-label="Grok actions"]') !== null, true, 'then Grok');
  assert.equal(kids[4].querySelector('[data-testid="caret"]') !== null, true, 'then More');
  const tightKids = [...t.document.querySelector('[data-fixture="3"] [data-icons]').children];
  assert.equal(tightKids.indexOf(bar(t, '3')), 1, 'Follow has text, so it is not one of the icons: the button goes after it');
  assert.equal(tightKids[2].querySelector('[aria-label="Grok actions"]') !== null, true, 'and before Grok');
  assert.equal(await changesOver(t), 0, 'placed once: no node moves again');
  // X adds another icon left of the button: the button moves first again.
  const extra = cellFrom(t, '<div><button aria-label="Another" type="button"><svg viewBox="0 0 24 24"></svg></button></div>');
  icons.insertBefore(extra, bar(t, '1'));
  t.deliverMutations([added(icons, [extra])]);
  await settle();
  assert.equal([...icons.children].indexOf(bar(t, '1')), 2, 'after Follow and the empty box, before the new icon');
  assert.equal(bar(t, '1').nextElementSibling === extra, true);
});

test("in the header the button takes More's grey, and leaves X's 8px before the next icon, counting the gap X's group already has", async () => {
  // X spaces Grok and More by the group's column gap (8px), measured live.
  const styles = (el) => ({
    color: el.closest('[data-testid="caret"]') ? 'rgb(113, 118, 123)' : 'rgb(0, 0, 0)',
    columnGap: el.hasAttribute('data-icons') ? '8px' : 'normal',
  });
  const cells = [post({ author: 'op', status: '1', head: 'grok' }), post({ author: 'reply_a', status: '2', head: 'grok' }), post({ author: 'reply_b', status: '3', head: 'more' })];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {}, styles });
  await settle();
  assert.equal(bar(t, '2').getAttribute('style'), 'color:rgb(113, 118, 123);margin-right:0px', 'in the group: its gap is the space');
  assert.equal(bar(t, '3').getAttribute('style'), 'color:rgb(113, 118, 123);margin-right:8px', 'beside More alone: 8px of its own');
});

test('when X draws the top-right icons after the post, the button moves into them, once', async () => {
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2', actions: true })];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  const first = bar(t, '2');
  assert.equal(first.hasAttribute('data-xsh-own-row'), true, 'no More yet: under the post');
  const article = t.document.querySelector('[data-fixture="2"] article');
  article.insertAdjacentHTML('afterbegin', `<div><div><span>Name</span></div>${headIcons('grok')}</div>`);
  await settle();
  const icons = t.document.querySelector('[data-fixture="2"] [data-icons]');
  assert.equal(icons.firstElementChild === first, true, 'the same button, now first in the group');
  assert.equal(first.hasAttribute('data-xsh-own-row'), false);
  assert.equal(article.querySelectorAll('[data-xsh-bar]').length, 1);
  assert.equal(await changesOver(t), 0, 'settled: no node moves again');
  // X redraws the group: a new one, without the button.
  icons.parentNode.replaceWith(t.document.createRange().createContextualFragment(headIcons('grok')));
  await settle();
  const again = t.document.querySelector('[data-fixture="2"] [data-icons]');
  assert.equal(again.firstElementChild.hasAttribute('data-xsh-bar'), true, 'back in the redrawn group');
  assert.equal(article.querySelectorAll('[data-xsh-bar]').length, 1);
});

test('when X adds Grok beside a More that stood alone, the button moves first in the group, and back beside More when Grok goes', async () => {
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2', actions: true, head: 'more' })];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  const caret = t.document.querySelector('[data-fixture="2"] [data-testid="caret"]');
  const first = bar(t, '2');
  assert.equal(first.nextElementSibling === caret, true, 'More alone: just before it');
  // A wider window: X draws Grok first in the group, beside the box holding More.
  const icons = t.document.querySelector('[data-fixture="2"] [data-icons]');
  icons.insertAdjacentHTML('afterbegin', '<div data-grok><button aria-label="Grok actions" type="button"><svg viewBox="0 0 24 24"></svg></button></div>');
  await settle();
  assert.equal(icons.firstElementChild === first, true, 'the same button, now first in the group');
  assert.equal(icons.children[1].hasAttribute('data-grok'), true, 'then Grok');
  assert.equal(await changesOver(t), 0, 'settled: no node moves again');
  const grok = icons.querySelector('[data-grok]');
  grok.remove();
  t.deliverMutations([removed(icons, [grok])]);
  await settle();
  assert.equal(first.nextElementSibling === caret, true, 'Grok gone: just before More again');
  assert.equal(t.document.querySelectorAll('[data-fixture="2"] [data-xsh-bar]').length, 1);
  assert.equal(await changesOver(t), 0);
});

test("a post nested in a reply keeps its own More: the reply's button never goes into it", async () => {
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2' })];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: {} });
  const article = t.document.querySelector('[data-fixture="2"] article');
  article.insertAdjacentHTML('beforeend', `<article data-testid="tweet" role="article"><div data-nested>${headIcons('grok')}</div></article>`);
  await settle();
  assert.equal(bar(t, '2').parentNode === article, true, 'under the reply');
  assert.equal(t.document.querySelector('[data-nested] [data-xsh-bar]') === null, true);
});

test('the page settles: once every button is placed, nothing on the page changes', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.equal(bars(t), 3);
  assert.equal(await changesOver(t), 0);
  // The count above can see a change: one made while it watches is counted.
  const watching = changesOver(t);
  t.document.body.appendChild(t.document.createElement('div'));
  assert.ok((await watching) > 0, 'a change made while watching is counted');
});

test('labels are on by default: settings that never had the switch get the buttons', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: stateWith([]), labels: {} });
  await settle();
  assert.equal(bars(t), 3);
});

test("every page that lists posts gets the buttons, a profile's own posts included; none with labelling off, or without a way to save (the userscript)", async () => {
  const home = runContent(page(THREAD), { pathname: '/home', state: on(), labels: {} });
  const search = runContent(page(THREAD), { pathname: '/search', state: on(), labels: {} });
  const profile = runContent(page(THREAD), { pathname: '/op', state: on(), labels: {} });
  const profileTab = runContent(page(THREAD), { pathname: '/OP/with_replies', state: on(), labels: {} });
  await settle();
  for (const t of [home, search, profile, profileTab]) assert.deepEqual(barIds(t), ['1', '2', '3'], t.location.pathname);
  const icons = home.document.querySelector('[data-fixture="1"] [data-icons]');
  assert.equal(icons.firstElementChild === bar(home, '1'), true, 'in the same spot as on a reply: first at the top right');
  const off = runContent(page(THREAD), { pathname: PAGE, state: stateWith([], { labeling: false }), labels: {} });
  const truthy = runContent(page(THREAD), { pathname: PAGE, state: stateWith([], { labeling: 'true' }), labels: {} });
  const noSave = runContent(page(THREAD), { pathname: '/home', state: on() });
  await settle();
  for (const t of [off, truthy, noSave]) assert.equal(bars(t), 0);
  for (const t of [off, truthy, noSave]) assert.equal(absent(t.document.getElementById('xsh-bar-style')), true, 'no CSS while labelling is off');
  for (const t of [off, truthy, noSave]) assert.equal(absent(toast(t)), true, 'no notice while labelling is off');
  // Turned on, the buttons appear; turned off, they go.
  off.push(on());
  await settle();
  assert.equal(bars(off), 3);
  off.push(stateWith([], { labeling: false }));
  await settle();
  assert.equal(bars(off), 0);
  assert.equal(absent(toast(off)), true, 'the notice goes with the buttons');
});

// A post the page's post replies to, shown above it.
const UP = post({ author: 'parent', status: '0' });
const timeline = (t) => t.document.querySelector('[aria-label="Timeline"]');
const barIds = (t) => [...t.document.querySelectorAll('[data-xsh-bar]')].map((b) => b.getAttribute('data-xsh-bar'));
function cellFrom(t, html) {
  const d = t.document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild;
}
const added = (target, nodes) => ({ type: 'childList', target, addedNodes: nodes, removedNodes: [] });
const removed = (target, nodes) => ({ type: 'childList', target, addedNodes: [], removedNodes: nodes });

test("on a post's page every post gets a button: the post above it, the post itself and its author's own reply, and so on its quotes and photo pages", async () => {
  const ownReply = post({ author: 'op', status: '5' });
  const t = runContent(page([UP, ...THREAD, ownReply]), { pathname: PAGE, state: on(), labels: {} });
  const slash = runContent(page(THREAD), { pathname: `${PAGE}/`, state: on(), labels: {} });
  const others = ['/quotes', '/photo/1'].map((s) => runContent(page(THREAD), { pathname: `${PAGE}${s}`, state: on(), labels: {} }));
  await settle();
  assert.deepEqual(barIds(t), ['0', '1', '2', '3', '5']);
  assert.deepEqual(barIds(slash), ['1', '2', '3'], 'a trailing slash');
  for (const o of others) assert.deepEqual(barIds(o), ['1', '2', '3'], o.location.pathname);
});

test("the user's own posts get no button, and one drawn before the sidebar shows who is logged in goes then", async () => {
  const mine = post({ author: ME, status: '8', head: 'grok' });
  const known = runContent(page([meLink('Me_User'), mine, ...THREAD]), { pathname: '/home', state: on(), labels: {} });
  const late = runContent(bare([mine, ...THREAD]), { pathname: '/home', state: on(), labels: {} });
  await settle();
  assert.deepEqual(barIds(known), ['1', '2', '3']);
  assert.deepEqual(barIds(late), ['8', '1', '2', '3'], 'not known yet: every post has one');
  const nav = cellFrom(late, meLink(ME));
  late.document.body.appendChild(nav);
  late.deliverMutations([added(late.document.body, [nav])]);
  await settle();
  assert.deepEqual(barIds(late), ['1', '2', '3'], 'known now: off the own post');
  assert.equal(late.document.querySelector('[data-fixture="8"] [data-icons]').children.length, 2, 'Grok and More, as X drew them');
});

test("a click made before the sidebar shows who is logged in is refused, since the post may be the user's own; once it shows, the click works", async () => {
  const mine = post({ author: ME, status: '8' });
  const t = runContent(bare([mine, ...THREAD]), { pathname: '/home', state: on(), labels: {}, clock: true });
  await settle();
  click(t, button(t, '8', 'slop'));
  await settle();
  assert.match(toastText(t), /^Not saved: x\.com has not shown who is logged in yet/);
  assert.equal(undoBtn(t).hasAttribute('hidden'), true, 'nothing to undo');
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, [], 'nothing saved');
  assert.equal(t.document.querySelector('[data-xsh-hidden]'), null, 'nothing hid');
  assert.deepEqual(pressed(t, '8'), [], 'the button is not pressed');
  const nav = cellFrom(t, meLink(ME));
  t.document.body.appendChild(nav);
  t.deliverMutations([added(t.document.body, [nav])]);
  await settle();
  assert.deepEqual(barIds(t), ['1', '2', '3'], 'the own post loses its button');
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.map((m) => [m.label, m.handle]), [['slop', 'reply_a']]);
});

test("on another page every post keeps or gets its button, the new page's author's and the last one's alike", async () => {
  const t = runContent(page([UP, ...THREAD]), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.deepEqual(barIds(t), ['0', '1', '2', '3']);
  // X replaces the page with post 7's, where post 0 and the last page's post are replies.
  for (const c of [...timeline(t).children]) c.remove();
  const cells = [post({ author: 'other', status: '7' }), UP, THREAD[0]].map((h) => cellFrom(t, h));
  for (const c of cells) timeline(t).appendChild(c);
  t.location.pathname = '/other/status/7';
  t.deliverMutations([added(timeline(t), cells)]);
  await settle();
  assert.deepEqual(barIds(t), ['7', '0', '1']);
  // To the profile of the account that wrote post 0: its post keeps the button.
  t.location.pathname = '/parent';
  t.deliverMutations([]);
  await settle();
  assert.deepEqual(barIds(t), ['7', '0', '1']);
});

test('a click on the home feed saves the post with the page it was on, as on a reply', async () => {
  const t = runContent(page(THREAD), { pathname: '/home', state: on(), labels: {}, clock: true });
  await settle();
  click(t, button(t, '1', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, [{ label: 'slop', handle: 'op', url: '/op/status/1', page: '/home', text: 'hello' }]);
  assert.deepEqual(pressed(t, '1'), ['slop']);
});

test("a click on the post the page is about labels it and adds its author to Also hide; its posts still show on its own pages, as the notice says, and hide elsewhere", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { worker: true }, clock: true });
  await settle();
  click(t, button(t, '1', 'slop'));
  await settle();
  assert.equal(toastText(t), 'Labelled @op as slop and added it to Also hide. Its posts still show on its own pages.');
  assert.deepEqual(pressed(t, '1'), ['slop']);
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, [{ label: 'slop', handle: 'op', url: '/op/status/1', page: PAGE, text: 'hello' }]);
  assert.equal(absent(t.document.querySelector('[data-xsh-hidden]')), true, 'nothing hid on its own page');
  assert.deepEqual(pressed(t, '1'), ['slop']);
  // The same cells on the home timeline: the account's post hides there.
  t.location.pathname = '/home';
  t.deliverMutations([]);
  await settle();
  assert.equal(t.document.querySelector('[data-fixture="1"]').getAttribute('data-xsh-hidden'), 'op');
  // On the account's profile, the notice says the same; on a reply by someone else, it does not.
  const profile = runContent(page(THREAD), { pathname: '/op', state: on(), labels: {}, clock: true });
  await settle();
  click(profile, button(profile, '1', 'slop'));
  await settle();
  assert.equal(toastText(profile), 'Labelled @op as slop and added it to Also hide. Its posts still show on its own pages.');
  click(profile, button(profile, '2', 'slop'));
  await settle();
  assert.equal(toastText(profile), 'Hid @reply_a and added it to Also hide.');
});

test("a click saves the reply's author, link, page and own text when its window ends, and a second click clears the label", async () => {
  const emoji = post({ author: 'reply_c', status: '4' }).replace('<span>hello </span>', '<span>Great insight </span><img alt="🚀" src="e.svg">');
  const t = runContent(page([...THREAD, emoji]), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, [{ label: 'slop', handle: 'reply_a', url: '/reply_a/status/2', page: PAGE, text: 'hello' }]);
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.deepEqual(pressed(t, '3'), [], 'only the clicked reply');
  assert.equal(tip(t, '2'), 'Labelled slop: click to remove the label');
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.equal(t.saves[1].label, null);
  assert.deepEqual(pressed(t, '2'), []);
  assert.equal(tip(t, '2'), 'Hide as slop');
  // A quoted post's text is not the reply's; emoji come from their alt text.
  click(t, button(t, '3', 'slop'));
  click(t, button(t, '4', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.slice(2).map((s) => s.text), ['hello', 'Great insight 🚀']);
});

test('a reply labelled Not slop by an older version shows the button unfilled, and a click labels it slop rather than clearing it', async () => {
  // A Not slop click also put the account in Always show, and Always show
  // wins, so the slop label hides nothing and the notice says why.
  const t = runContent(page(THREAD), { pathname: PAGE, state: on({ allowlist: 'reply_a' }), labels: { stored: { 2: 'not_slop' } }, clock: true });
  await settle();
  assert.deepEqual(pressed(t, '2'), []);
  assert.equal(tip(t, '2'), 'Hide as slop (in Always show)');
  click(t, button(t, '2', 'slop'));
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.equal(t.hidden('2'), false, 'Always show wins');
  assert.equal(toastText(t), 'Labelled @reply_a as slop and added it to Also hide. It still shows: it is in Always show.');
  assert.equal(tip(t, '2'), 'Labelled slop: click to remove the label (in Always show)');
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.map((x) => x.label), ['slop']);
  // Without Always show (the box edited since), the same click hides it.
  const u = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 2: 'not_slop' } }, clock: true });
  await settle();
  click(u, button(u, '2', 'slop'));
  assert.equal(u.hidden('2'), true);
  assert.equal(toastText(u), 'Hid @reply_a and added it to Also hide.');
});

test("nothing done on the button reaches X's handlers, and a click made by the page's own script is ignored", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  const types = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup'];
  const reached = [];
  const article = t.document.querySelector('[data-fixture="2"] article');
  for (const type of types) {
    article.addEventListener(type, () => reached.push(type));
    t.document.addEventListener(type, () => reached.push(`document ${type}`));
  }
  // The listeners work: a click on the reply's text reaches both.
  article.querySelector('[data-testid="tweetText"]').dispatchEvent(new t.window.Event('click', { bubbles: true }));
  assert.deepEqual(reached, ['click', 'document click']);
  reached.length = 0;
  for (const type of types) {
    const e = new t.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'isTrusted', { value: false });
    button(t, '2', 'slop').dispatchEvent(e);
  }
  await settle();
  assert.deepEqual(reached, []);
  assert.deepEqual(t.saves, [], 'a scripted click saves nothing');
  const e = click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(reached, []);
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.saves.length, 1);
});

test('a cell X reuses for another post moves its button to that post, the post the page is about included', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 9: 'slop' } }, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  // X rewrites the cell's links in place for post 9 by @reply_c.
  const article = t.document.querySelector('[data-fixture="2"] article');
  for (const a of article.querySelectorAll('a')) a.setAttribute('href', a.getAttribute('href').replace('reply_a', 'reply_c').replace('/status/2', '/status/9'));
  const link = article.querySelector('time').closest('a');
  t.deliverMutations([{ type: 'attributes', target: link, attributeName: 'href', addedNodes: [], removedNodes: [] }]);
  await settle();
  assert.equal(article.querySelectorAll('[data-xsh-bar]').length, 1, 'one button per post');
  assert.equal(bar(t, '2').getAttribute('data-xsh-bar'), '9');
  assert.equal(bar(t, '2').getAttribute('data-xsh-author'), 'reply_c');
  assert.deepEqual(pressed(t, '2'), ['slop'], "post 9's saved label, not post 2's");
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.at(-1), { label: null, handle: 'reply_c', url: '/reply_c/status/9', page: PAGE, text: 'hello' });
  // Reused for the post the page is about.
  const other = t.document.querySelector('[data-fixture="3"] article');
  for (const a of other.querySelectorAll('[data-testid="User-Name"] a')) {
    if (!a.closest('[role="link"][tabindex="0"]')) a.setAttribute('href', a.getAttribute('href').replace('reply_b', 'op').replace('/status/3', '/status/1'));
  }
  t.deliverMutations([{ type: 'attributes', target: other.querySelector('time').closest('a'), attributeName: 'href', addedNodes: [], removedNodes: [] }]);
  await settle();
  assert.equal(other.querySelectorAll('[data-xsh-bar]').length, 1, 'one button per post');
  assert.equal(bar(t, '3').getAttribute('data-xsh-bar'), '1');
  assert.equal(bar(t, '3').getAttribute('data-xsh-author'), 'op');
});

test('saved labels show when a button appears, and a change made in another tab shows at once', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 2: 'slop' } } });
  await settle();
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.deepEqual(pressed(t, '3'), []);
  t.labelChange('3', 'slop');
  assert.deepEqual(pressed(t, '3'), ['slop']);
  t.labelChange('3', 'not_slop');
  assert.deepEqual(pressed(t, '3'), [], 'Not slop draws the button unfilled');
  t.labelChange('2', null);
  assert.deepEqual(pressed(t, '2'), []);
});

test('a refused save puts the reply back and says why in the tooltip and the notice; the tooltip says when the list or a box already has the account', async () => {
  const cells = [...THREAD, post({ author: 'slop_x', status: '4' }), post({ author: 'pal', status: '5' })];
  const t = runContent(page(cells), {
    pathname: PAGE,
    state: on({ allowlist: 'pal', extraList: 'reply_b' }, ['slop_x']),
    labels: { answer: () => ({ ok: false, reason: 'labels are off' }) },
    clock: true,
  });
  await settle();
  assert.deepEqual(['2', '3', '4', '5'].map((s) => note(t, s)), ['', 'in Also hide', 'on the list', 'in Always show']);
  assert.deepEqual(['2', '4'].map((s) => tip(t, s)), ['Hide as slop', 'Hide as slop (on the list)']);
  assert.equal(t.hidden('4'), true, 'a hidden reply keeps its button, for when hiding is paused');
  click(t, button(t, '2', 'slop'));
  assert.equal(t.hidden('2'), true, 'hidden at once');
  t.advance(UNDO_MS);
  await settle();
  assert.equal(t.hidden('2'), false, 'shown again');
  assert.equal(note(t, '2'), 'not saved: labels are off');
  assert.equal(tip(t, '2'), 'Hide as slop (not saved: labels are off)');
  assert.deepEqual(pressed(t, '2'), []);
  assert.equal(toastText(t), 'Not saved: labels are off');
  assert.equal(undoBtn(t).hasAttribute('hidden'), true, 'nothing to undo');
});

test("a tab says it is the user's own x.com tab only when it was given no job, and waits for that answer", async () => {
  let give;
  const later = new Promise((r) => (give = r));
  const t = runContent(page(THREAD), { state: stateWith([]), job: later, present: true });
  let answer = 'none yet';
  t.present().then((v) => (answer = v));
  await settle();
  assert.equal(answer, 'none yet', 'still waiting to hear whether this tab has a job');
  give(null);
  await settle();
  assert.equal(answer, true);
  // A job tab (here one logged in as another account, which stops at once).
  const jobTab = runContent(page([meLink('other'), post({ author: 'slop_a', status: '1' })]), {
    pathname: '/slop_a',
    state: stateWith(['slop_a'], { muteEnabled: true, muteAccount: 'startupbros' }),
    job: { id: 'j1', kind: 'mute', handle: 'slop_a', account: 'startupbros', waitMs: 400 },
    present: true,
  });
  assert.equal(await jobTab.present(), false);
  assert.equal((await jobTab.done).status, 'wrong-account');
});

// ------------------------------------------------- the 6-second Undo window

// Two replies by @reply_a (2 and 4) and one by @reply_b (3).
const UNDO_THREAD = [...THREAD, post({ author: 'reply_a', status: '4' })];
const snapshot = (t) => JSON.parse(JSON.stringify(t.content.stats()));

// Every removal of the hide attribute from a post's cell, so a test can show
// the reply was never shown for a moment.
function watchShown(t, status) {
  const cell = t.document.querySelector(`[data-fixture="${status}"]`);
  const shown = [];
  const remove = cell.removeAttribute.bind(cell);
  cell.removeAttribute = (name) => {
    if (name === 'data-xsh-hidden') shown.push(name);
    return remove(name);
  };
  return shown;
}

test('Slop hides the account at once; nothing is saved, counted or sighted until its 6 s end; then it is saved as before and sighted once', async () => {
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ muteEnabled: true, muteAccount: 'startupbros' }), labels: { worker: true }, clock: true });
  await settle();
  const before = snapshot(t);
  click(t, button(t, '2', 'slop'));
  // In the same pass as the click, with no wait for storage.
  assert.deepEqual(['2', '3', '4'].map((s) => t.hidden(s)), [true, false, true], "all of @reply_a's posts on the page, as Also hide does");
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.equal(note(t, '2'), 'in Also hide');
  assert.equal(toastOpen(t), true);
  assert.equal(toastText(t), 'Hid @reply_a and added it to Also hide.');
  assert.equal(undoBtn(t).hasAttribute('hidden'), false);
  assert.deepEqual(t.saves, []);
  assert.deepEqual(t.sightings, [], 'muting is not told inside the window');
  const during = snapshot(t);
  assert.deepEqual(during.hiddenAuthors, before.hiddenAuthors, 'not counted inside the window');
  assert.equal(during.hiddenPosts, before.hiddenPosts);
  t.advance(UNDO_MS - 1);
  await settle();
  assert.deepEqual(t.saves, [], 'not before 6 s');
  const shown = watchShown(t, '2');
  t.advance(1);
  assert.deepEqual(t.saves, [{ label: 'slop', handle: 'reply_a', url: '/reply_a/status/2', page: PAGE, text: 'hello' }]);
  assert.equal(toastOpen(t), false, 'the notice closes when the window ends');
  await settle();
  // The worker's save is read back before the click's own change is dropped.
  assert.deepEqual(t.sightings, ['reply_a']);
  assert.deepEqual(snapshot(t).hiddenAuthors, ['reply_a']);
  // The storage change arrives after the answer.
  t.notify();
  await settle();
  assert.deepEqual(['2', '3', '4'].map((s) => t.hidden(s)), [true, false, true]);
  assert.deepEqual(shown, [], 'never shown between the click and the stored state');
  assert.deepEqual(t.sightings, ['reply_a'], 'sighted once');
});

test("the storage change may arrive before the worker's answer: the reply stays hidden and is sighted once", async () => {
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ muteEnabled: true, muteAccount: 'startupbros' }), labels: { worker: true }, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  const shown = watchShown(t, '2');
  t.advance(UNDO_MS);
  // Before the answer's promise settles.
  t.notify();
  assert.equal(t.hidden('2'), true);
  await settle();
  assert.equal(t.hidden('2'), true);
  assert.deepEqual(shown, []);
  assert.deepEqual(t.sightings, ['reply_a']);
  assert.equal(t.state().settings.extraList, 'reply_a');
});

test('Undo puts the page back as it was, and nothing is ever saved or sighted; a scripted click on Undo is ignored and nothing in the notice reaches X', async () => {
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ muteEnabled: true, muteAccount: 'startupbros' }), labels: { worker: true }, clock: true });
  await settle();
  const before = snapshot(t);
  const types = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup'];
  const reached = [];
  for (const type of types) t.document.addEventListener(type, () => reached.push(type));
  click(t, button(t, '2', 'slop'));
  for (const type of types.filter((x) => x !== 'click')) {
    const e = new t.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'isTrusted', { value: true });
    undoBtn(t).dispatchEvent(e);
  }
  assert.equal(t.hidden('2'), true, 'only a click undoes');
  click(t, undoBtn(t), false);
  assert.equal(t.hidden('2'), true, "a page script's click on Undo is ignored");
  click(t, undoBtn(t));
  assert.deepEqual(reached, [], "nothing done in the notice reaches X's handlers");
  assert.deepEqual(['2', '3', '4'].map((s) => t.hidden(s)), [false, false, false]);
  assert.deepEqual(pressed(t, '2'), []);
  assert.equal(note(t, '2'), '');
  assert.equal(toastText(t), 'Undone.');
  assert.equal(undoBtn(t).hasAttribute('hidden'), true);
  assert.deepEqual(snapshot(t), before);
  t.advance(60000);
  await settle();
  assert.deepEqual(t.saves, [], 'never saved');
  assert.deepEqual(t.sightings, []);
  assert.equal(t.state().settings.extraList, undefined, 'Also hide unchanged');
  assert.equal(toastOpen(t), false, '"Undone." closes after a while');
  // Undoing a clear brings the label back.
  const u = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 2: 'slop' } }, clock: true });
  await settle();
  click(u, button(u, '2', 'slop'));
  assert.deepEqual(pressed(u, '2'), []);
  assert.equal(toastText(u), 'Slop label removed.');
  click(u, undoBtn(u));
  assert.deepEqual(pressed(u, '2'), ['slop']);
  u.advance(UNDO_MS);
  await settle();
  assert.deepEqual(u.saves, []);
});

test('a click while hiding is paused labels the reply and says so, without claiming it hid', async () => {
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ paused: true }, ['reply_a']), labels: { worker: true }, clock: true });
  await settle();
  assert.equal(t.hidden('2'), false, 'paused');
  assert.equal(tip(t, '2'), 'Hide as slop (on the list)');
  click(t, button(t, '2', 'slop'));
  assert.equal(t.hidden('2'), false, 'still paused');
  assert.equal(toastText(t), 'Labelled @reply_a as slop and added it to Also hide.', 'not "Hid": nothing hid');
  assert.deepEqual(pressed(t, '2'), ['slop']);
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.map((x) => x.label), ['slop']);
  assert.equal(t.state().settings.extraList, 'reply_a', 'in Also hide too, so it stays hidden if the list drops it');
  // Already in Also hide: the notice says so by not adding it.
  click(t, button(t, '4', 'slop'));
  assert.equal(toastText(t), 'Labelled @reply_a as slop.');
});

test('a click saves the one before it at once, and so does leaving the page or switching away from the tab', async () => {
  const cells = [...THREAD, post({ author: 'reply_c', status: '4' }), post({ author: 'reply_d', status: '5' }), post({ author: 'reply_e', status: '6' })];
  const t = runContent(page(cells), { pathname: PAGE, state: on(), labels: { worker: true }, clock: true });
  await settle();
  const handles = () => t.saves.map((s) => s.handle);
  click(t, button(t, '2', 'slop'));
  click(t, button(t, '3', 'slop'));
  assert.deepEqual(handles(), ['reply_a'], 'the first, when the second is clicked');
  t.window.dispatchEvent(new t.window.Event('pagehide'));
  assert.deepEqual(handles(), ['reply_a', 'reply_b'], 'pagehide');
  t.window.dispatchEvent(new t.window.Event('pagehide'));
  assert.equal(t.saves.length, 2, 'saved once');
  click(t, button(t, '4', 'slop'));
  Object.defineProperty(t.document, 'visibilityState', { value: 'visible', configurable: true });
  t.document.dispatchEvent(new t.window.Event('visibilitychange'));
  assert.equal(t.saves.length, 2, 'coming back to the tab saves nothing');
  Object.defineProperty(t.document, 'visibilityState', { value: 'hidden', configurable: true });
  t.document.dispatchEvent(new t.window.Event('visibilitychange'));
  assert.deepEqual(handles(), ['reply_a', 'reply_b', 'reply_c'], 'the tab hidden');
  Object.defineProperty(t.document, 'visibilityState', { value: 'visible', configurable: true });
  click(t, button(t, '5', 'slop'));
  // X moves to another post's page.
  t.location.pathname = '/other/status/7';
  t.deliverMutations([]);
  assert.deepEqual(handles(), ['reply_a', 'reply_b', 'reply_c', 'reply_d'], 'another page');
  t.advance(60000);
  await settle();
  assert.equal(t.saves.length, 4);
  assert.equal(t.state().settings.extraList, 'reply_a\nreply_b\nreply_c\nreply_d');
});

test("turning labels off inside a click's window drops the click and the notice", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { worker: true }, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  assert.equal(t.hidden('2'), true);
  t.push(stateWith([], { labeling: false }));
  await settle();
  assert.equal(t.hidden('2'), false);
  assert.equal(absent(toast(t)), true);
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, []);
});

test("the notice is a polite status kept outside X's cells, empty between clicks, and is not X's own toast", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  const el = toast(t);
  assert.equal(el.parentNode, t.document.body);
  assert.equal(el.getAttribute('role'), 'status');
  assert.equal(el.getAttribute('aria-live'), 'polite');
  assert.equal(el.hasAttribute('data-testid'), false, "X's toast is what a mute visit reads");
  assert.equal(absent(t.document.querySelector('[data-testid="toast"]')), true);
  assert.equal(toastOpen(t), false);
  assert.equal(toastText(t), '');
  assert.equal(t.document.querySelectorAll('[data-xsh-toast]').length, 1);
  t.push(on());
  await settle();
  assert.equal(t.document.querySelectorAll('[data-xsh-toast]').length, 1, 'one notice, however often the settings change');
  click(t, button(t, '2', 'slop'));
  assert.equal(absent(el.closest('[data-testid="cellInnerDiv"]')), true);
  assert.equal(toastOpen(t), true);
});

test("a refusal of the click before keeps the Undo of the click still in its window, and puts the refused reply back", async () => {
  const answer = (m) => (m.handle === 'reply_a' ? { ok: false, reason: 'too many labels' } : { ok: true, label: m.label });
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on(), labels: { worker: true, answer }, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  click(t, button(t, '3', 'slop'));
  await settle();
  assert.deepEqual(['2', '4'].map((s) => t.hidden(s)), [false, false], 'the refused click is put back');
  assert.deepEqual(pressed(t, '2'), [], 'the stored label, read again');
  assert.equal(note(t, '2'), 'not saved: too many labels');
  assert.equal(toastText(t), 'Hid @reply_b and added it to Also hide.');
  assert.equal(undoBtn(t).hasAttribute('hidden'), false, 'the waiting click can still be undone');
  assert.equal(t.hidden('3'), true);
  click(t, undoBtn(t));
  assert.equal(t.hidden('3'), false);
  t.advance(60000);
  await settle();
  assert.deepEqual(t.saves.map((s) => s.handle), ['reply_a']);
});

test('a refused click under a newer click on the same post: Undo goes back to the stored label and says why, and a save leaves no stale note', async () => {
  const answer = (m) => (m.label === 'slop' ? { ok: false, reason: 'too many labels' } : { ok: true, label: m.label });
  const t = runContent(page(THREAD), { pathname: PAGE, state: on({ paused: true }), labels: { worker: true, answer }, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  click(t, button(t, '2', 'slop'));
  await settle();
  assert.deepEqual(pressed(t, '2'), [], 'the newer click, a clear, still shows');
  assert.equal(toastText(t), 'Slop label removed.');
  assert.equal(undoBtn(t).hasAttribute('hidden'), false);
  click(t, undoBtn(t));
  await settle();
  assert.deepEqual(pressed(t, '2'), [], 'Slop was never stored');
  assert.equal(note(t, '2'), 'not saved: too many labels');
  // The same two clicks, with the newer one saved.
  const u = runContent(page(THREAD), { pathname: PAGE, state: on({ paused: true }), labels: { worker: true, answer }, clock: true });
  await settle();
  click(u, button(u, '2', 'slop'));
  click(u, button(u, '2', 'slop'));
  u.advance(UNDO_MS);
  await settle();
  assert.deepEqual(pressed(u, '2'), []);
  assert.equal(note(u, '2'), '');
});

test('a label stored from elsewhere while a click on the same post waits leaves the click shown, and Undo goes back to the stored label', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 2: 'slop' } }, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  assert.deepEqual(pressed(t, '2'), [], 'a clear');
  // Another tab stores Slop for the same post.
  t.labelChange('2', 'slop');
  await settle();
  assert.deepEqual(pressed(t, '2'), []);
  click(t, undoBtn(t));
  assert.deepEqual(pressed(t, '2'), ['slop']);
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, []);
});

test('a refused click goes back to the stored label, not to an earlier click that was never saved', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { answer: () => ({ ok: false, reason: 'labels are off' }) }, clock: true });
  await settle();
  // Each click sends the one before it; every save is refused.
  click(t, button(t, '2', 'slop'));
  click(t, button(t, '2', 'slop'));
  click(t, button(t, '3', 'slop'));
  await settle();
  assert.deepEqual(pressed(t, '2'), [], 'nothing was stored for the post');
  assert.equal(note(t, '2'), 'not saved: labels are off');
  assert.equal(toastText(t), 'Hid @reply_b and added it to Also hide.', 'the waiting click keeps its notice');
});
