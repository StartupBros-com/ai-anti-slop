// Runs the real src/content.js label pairs against a linkedom post page shaped
// like x.com's: the post the page is about first, replies under it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { post, page, meLink, runContent, stateWith, tick } from './helpers.mjs';

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

const PAGE = '/op/status/1';
const THREAD = [post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2' }), post({ author: 'reply_b', quote: 'someone', status: '3' })];
const on = (settings = {}, handles = []) => stateWith(handles, { labeling: true, ...settings });

// A failing assertion prints its values, and printing a linkedom node walks
// the whole document, which hangs the run: check a node's absence as a boolean.
const absent = (el) => el === null;
const bar = (t, status) => t.document.querySelector(`[data-fixture="${status}"] [data-xsh-bar]`);
const bars = (t) => t.document.querySelectorAll('[data-xsh-bar]').length;
const button = (t, status, label) => bar(t, status).querySelector(`[data-xsh-label="${label}"]`);
const note = (t, status) => bar(t, status).querySelector('[data-xsh-note]').textContent;
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

test("with labelling on, a post's page gets a Slop / Not slop pair under each reply and none under the post itself", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.equal(absent(bar(t, '1')), true, 'the post the page is about');
  assert.deepEqual(['2', '3'].map((s) => bar(t, s).getAttribute('data-xsh-bar')), ['2', '3']);
  assert.deepEqual(['2', '3'].map((s) => bar(t, s).getAttribute('data-xsh-author')), ['reply_a', 'reply_b']);
  assert.deepEqual([...bar(t, '2').querySelectorAll('button')].map((b) => b.textContent), ['Slop', 'Not slop']);
  assert.deepEqual(pressed(t, '2'), []);
  assert.equal(bars(t), 2);
  assert.ok(t.document.getElementById('xsh-bar-style'), 'the pair has its look');
  assert.equal(t.document.getElementById('xsh-style').textContent, '[data-xsh-hidden]{display:none!important}', 'the hide rule is unchanged');
});

test('no pair off a post page, with labelling off, or without a way to save (the userscript)', async () => {
  const home = runContent(page(THREAD), { pathname: '/home', state: on(), labels: {} });
  const profile = runContent(page(THREAD), { pathname: '/op', state: on(), labels: {} });
  const off = runContent(page(THREAD), { pathname: PAGE, state: stateWith([]), labels: {} });
  const truthy = runContent(page(THREAD), { pathname: PAGE, state: stateWith([], { labeling: 'true' }), labels: {} });
  const noSave = runContent(page(THREAD), { pathname: PAGE, state: on() });
  await settle();
  for (const t of [home, profile, off, truthy, noSave]) assert.equal(bars(t), 0);
  for (const t of [off, truthy, noSave]) assert.equal(absent(t.document.getElementById('xsh-bar-style')), true, 'no CSS while labelling is off');
  for (const t of [off, truthy, noSave]) assert.equal(absent(toast(t)), true, 'no notice while labelling is off');
  // Turned on, the pairs appear; turned off, they go.
  off.push(on());
  await settle();
  assert.equal(bars(off), 2);
  off.push(stateWith([], { labeling: false }));
  await settle();
  assert.equal(bars(off), 0);
  assert.equal(absent(toast(off)), true, 'the notice goes with the pairs');
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

test("no pair on the posts above the page's post, nor on its quotes, likes or photo pages", async () => {
  const t = runContent(page([UP, ...THREAD]), { pathname: PAGE, state: on(), labels: {} });
  const slash = runContent(page(THREAD), { pathname: `${PAGE}/`, state: on(), labels: {} });
  const others = ['/quotes', '/likes', '/retweets', '/photo/1'].map((s) => runContent(page(THREAD), { pathname: `${PAGE}${s}`, state: on(), labels: {} }));
  await settle();
  assert.deepEqual(barIds(t), ['2', '3']);
  assert.deepEqual(barIds(slash), ['2', '3'], 'a trailing slash is the same page');
  for (const o of others) assert.deepEqual(barIds(o), [], o.location.pathname);
});

test("a post above the page's post loses its pair when that post mounts after it, and stays without one while that post is unmounted", async () => {
  const t = runContent(page([UP, ...THREAD.slice(1)]), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.deepEqual(barIds(t), ['0', '2', '3'], "with the page's post not mounted, no post is known to be above it");
  const focal = cellFrom(t, THREAD[0]);
  timeline(t).insertBefore(focal, t.document.querySelector('[data-fixture="2"]'));
  t.deliverMutations([added(timeline(t), [focal])]);
  await settle();
  assert.deepEqual(barIds(t), ['2', '3']);
  // Deep in the replies X unmounts the page's post; a settings change then rescans every post.
  focal.remove();
  t.deliverMutations([removed(timeline(t), [focal])]);
  t.push(on());
  await settle();
  assert.deepEqual(barIds(t), ['2', '3'], 'the post above is remembered');
  // X mounts the post above again, in a new node.
  const old = t.document.querySelector('[data-fixture="0"]');
  old.remove();
  const again = cellFrom(t, UP);
  timeline(t).insertBefore(again, timeline(t).firstChild);
  t.deliverMutations([removed(timeline(t), [old]), added(timeline(t), [again])]);
  await settle();
  assert.deepEqual(barIds(t), ['2', '3']);
});

test("on another post's page, a post that was above the last page's post gets a pair again", async () => {
  const t = runContent(page([UP, ...THREAD]), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.deepEqual(barIds(t), ['2', '3']);
  // X replaces the page with post 7's, where post 0 is a reply.
  for (const c of [...timeline(t).children]) c.remove();
  const cells = [post({ author: 'other', status: '7' }), UP].map((h) => cellFrom(t, h));
  for (const c of cells) timeline(t).appendChild(c);
  t.location.pathname = '/other/status/7';
  t.deliverMutations([added(timeline(t), cells)]);
  await settle();
  assert.deepEqual(barIds(t), ['0']);
});

test("a click saves the reply's author, link, page and own text when its window ends; the other button switches; a second click clears", async () => {
  const emoji = post({ author: 'reply_c', status: '4' }).replace('<span>hello </span>', '<span>Great insight </span><img alt="🚀" src="e.svg">');
  const t = runContent(page([...THREAD, emoji]), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, [{ label: 'slop', handle: 'reply_a', url: '/reply_a/status/2', page: PAGE, text: 'hello' }]);
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.deepEqual(pressed(t, '3'), [], 'only the clicked reply');
  click(t, button(t, '2', 'not_slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.equal(t.saves[1].label, 'not_slop');
  assert.deepEqual(pressed(t, '2'), ['not_slop']);
  click(t, button(t, '2', 'not_slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.equal(t.saves[2].label, null);
  assert.deepEqual(pressed(t, '2'), []);
  // A quoted post's text is not the reply's; emoji come from their alt text.
  click(t, button(t, '3', 'slop'));
  click(t, button(t, '4', 'slop'));
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves.slice(3).map((s) => s.text), ['hello', 'Great insight 🚀']);
});

test("nothing done in a pair reaches X's handlers, and a click made by the page's own script is ignored", async () => {
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

test('a cell X reuses for another post moves its pair to that post; one for the post the page is about loses it', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 9: 'slop' } }, clock: true });
  await settle();
  click(t, button(t, '2', 'not_slop'));
  t.advance(UNDO_MS);
  await settle();
  // X rewrites the cell's links in place for post 9 by @reply_c.
  const article = t.document.querySelector('[data-fixture="2"] article');
  for (const a of article.querySelectorAll('a')) a.setAttribute('href', a.getAttribute('href').replace('reply_a', 'reply_c').replace('/status/2', '/status/9'));
  const link = article.querySelector('time').closest('a');
  t.deliverMutations([{ type: 'attributes', target: link, attributeName: 'href', addedNodes: [], removedNodes: [] }]);
  await settle();
  assert.equal(article.querySelectorAll('[data-xsh-bar]').length, 1, 'one pair per post');
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
  assert.equal(absent(bar(t, '3')), true);
});

test('saved labels show when a pair appears, and a change made in another tab shows at once', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 2: 'slop' } } });
  await settle();
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.deepEqual(pressed(t, '3'), []);
  t.labelChange('3', 'not_slop');
  assert.deepEqual(pressed(t, '3'), ['not_slop']);
  t.labelChange('2', null);
  assert.deepEqual(pressed(t, '2'), []);
});

test('a refused save puts the reply back and says why on the pair and in the notice; the pair says when the list or a box already has the account', async () => {
  const cells = [...THREAD, post({ author: 'slop_x', status: '4' }), post({ author: 'pal', status: '5' })];
  const t = runContent(page(cells), {
    pathname: PAGE,
    state: on({ allowlist: 'pal', extraList: 'reply_b' }, ['slop_x']),
    labels: { answer: () => ({ ok: false, reason: 'labels are off' }) },
    clock: true,
  });
  await settle();
  assert.deepEqual(['2', '3', '4', '5'].map((s) => note(t, s)), ['', 'in Also hide', 'on the list', 'in Always show']);
  assert.equal(t.hidden('4'), true, 'a hidden reply keeps its pair, for when hiding is paused');
  click(t, button(t, '2', 'slop'));
  assert.equal(t.hidden('2'), true, 'hidden at once');
  t.advance(UNDO_MS);
  await settle();
  assert.equal(t.hidden('2'), false, 'shown again');
  assert.equal(note(t, '2'), 'not saved: labels are off');
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
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ muteEnabled: true }), labels: { worker: true }, clock: true });
  await settle();
  const before = snapshot(t);
  click(t, button(t, '2', 'slop'));
  // In the same pass as the click, with no wait for storage.
  assert.deepEqual(['2', '3', '4'].map((s) => t.hidden(s)), [true, false, true], "all of @reply_a's posts on the page, as Also hide does");
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.equal(note(t, '2'), 'in Also hide');
  assert.equal(toastOpen(t), true);
  assert.equal(toastText(t), 'Labelled Slop. @reply_a added to Also hide.');
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
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ muteEnabled: true }), labels: { worker: true }, clock: true });
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
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ muteEnabled: true }), labels: { worker: true }, clock: true });
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
  assert.equal(toastText(u), 'Label removed.');
  click(u, undoBtn(u));
  assert.deepEqual(pressed(u, '2'), ['slop']);
  u.advance(UNDO_MS);
  await settle();
  assert.deepEqual(u.saves, []);
});

test("Not slop shows a listed account's replies at once, and Undo hides them again", async () => {
  const t = runContent(page(UNDO_THREAD), { pathname: PAGE, state: on({ paused: true }, ['reply_a']), labels: { worker: true }, clock: true });
  await settle();
  assert.equal(t.hidden('2'), false, 'paused');
  click(t, button(t, '2', 'not_slop'));
  assert.equal(toastText(t), 'Labelled Not slop. @reply_a added to Always show.');
  assert.equal(note(t, '2'), 'in Always show');
  t.push(on({}, ['reply_a']));
  await settle();
  assert.deepEqual(['2', '4'].map((s) => t.hidden(s)), [false, false], 'unpaused inside the window: Always show already applies');
  click(t, undoBtn(t));
  assert.deepEqual(['2', '4'].map((s) => t.hidden(s)), [true, true]);
  t.advance(UNDO_MS);
  await settle();
  assert.deepEqual(t.saves, []);
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
  assert.equal(toastText(t), 'Labelled Slop. @reply_b added to Also hide.');
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
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { worker: true, answer }, clock: true });
  await settle();
  click(t, button(t, '2', 'slop'));
  click(t, button(t, '2', 'not_slop'));
  await settle();
  assert.deepEqual(pressed(t, '2'), ['not_slop'], 'the newer click still shows');
  assert.equal(note(t, '2'), 'in Always show');
  assert.equal(toastText(t), 'Labelled Not slop. @reply_a added to Always show.');
  click(t, undoBtn(t));
  await settle();
  assert.deepEqual(pressed(t, '2'), [], 'Slop was never stored');
  assert.equal(note(t, '2'), 'not saved: too many labels');
  // The same two clicks, with the newer one saved.
  const u = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { worker: true, answer }, clock: true });
  await settle();
  click(u, button(u, '2', 'slop'));
  click(u, button(u, '2', 'not_slop'));
  u.advance(UNDO_MS);
  await settle();
  assert.deepEqual(pressed(u, '2'), ['not_slop']);
  assert.equal(note(u, '2'), 'in Always show');
});

test('a label stored from elsewhere while a click on the same post waits leaves the click shown, and Undo goes back to the stored label', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {}, clock: true });
  await settle();
  click(t, button(t, '2', 'not_slop'));
  // Another tab stores Slop for the same post.
  t.labelChange('2', 'slop');
  await settle();
  assert.deepEqual(pressed(t, '2'), ['not_slop']);
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
  click(t, button(t, '2', 'not_slop'));
  click(t, button(t, '3', 'slop'));
  await settle();
  assert.deepEqual(pressed(t, '2'), [], 'nothing was stored for the post');
  assert.equal(note(t, '2'), 'not saved: labels are off');
  assert.equal(toastText(t), 'Labelled Slop. @reply_b added to Also hide.', 'the waiting click keeps its notice');
});
