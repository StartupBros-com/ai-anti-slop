// Runs the real src/content.js job mode against linkedom pages shaped like
// x.com's profile and settings/muted/all pages, with X's ⋯ menu faked from
// the item labels seen live on 2026-11-06.
import test from 'node:test';
import assert from 'node:assert/strict';
import { post, page, postWithCaret, meLink, wireMenu, runContent, stateWith, tick } from './helpers.mjs';

const ME = 'startupbros';
const H = 'slop_a';
const MENU = ['Not interested in this post', `Follow @${H}`, `Add/remove @${H} from Lists`, 'Mute', `Block @${H}`, 'Report post'];
const job = (over = {}) => ({ id: 'j1', kind: 'mute', handle: H, account: ME, waitMs: 400, ...over });
const muting = stateWith([H], { muteEnabled: true, muteAccount: ME });

function profile(cells, { me = ME } = {}) {
  return page([me ? meLink(me) : '<button data-testid="loginButton">Log in</button>', ...cells]);
}

function muteRun({ items = MENU, cells = [postWithCaret({ author: H })], me = ME, confirmSheet = false, j = job(), confirm = true } = {}) {
  const t = runContent(profile(cells, { me }), { pathname: `/${H}`, state: muting, job: j, confirm });
  const clicks = wireMenu(t.document, { items, handle: H, confirmSheet });
  return { t, clicks };
}

test('mute job: clicks the one exact Mute item and reports X\'s toast', async () => {
  const { t, clicks } = muteRun({ items: [...MENU, 'Mute this conversation'] });
  const r = await t.done;
  assert.deepEqual(clicks, ['Mute']);
  assert.deepEqual(r, { id: 'j1', status: 'muted', toast: `@${H} has been muted.Undo` });
  assert.deepEqual(t.confirms, ['j1'], 'the worker was asked once, just before the click');
});

// Planted negative: settings changed after the tab claimed the job, so the
// worker says no; nothing is clicked and the open menu is left to the worker.
test('mute job: no click when the worker does not confirm', async () => {
  const { t, clicks } = muteRun({ confirm: false });
  const r = await t.done;
  assert.deepEqual(clicks, []);
  assert.equal(r.status, 'error');
  assert.match(r.reason, /did not confirm/);
  assert.deepEqual(t.confirms, ['j1']);
});

test('mute job: "Mute @handle" is the same item', async () => {
  const { t, clicks } = muteRun({ items: [`Follow @${H}`, `Mute @${H}`, `Block @${H}`] });
  assert.equal((await t.done).status, 'muted');
  assert.deepEqual(clicks, [`Mute @${H}`]);
});

test('mute job: an Unmute item means already muted, and nothing is clicked', async () => {
  const { t, clicks } = muteRun({ items: [`Follow @${H}`, 'Unmute', `Block @${H}`] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'already' });
  assert.deepEqual(clicks, []);
  assert.deepEqual(t.confirms, [], 'nothing to click, nothing to ask');
});

test('mute job: an account the user follows is left alone', async () => {
  const { t, clicks } = muteRun({ items: [`Unfollow @${H}`, 'Mute', `Block @${H}`] });
  const r = await t.done;
  assert.equal(r.status, 'followed');
  assert.deepEqual(clicks, []);
});

// Planted negatives: a menu we do not recognise is refused, never guessed at.
test('mute job: no Mute item, or two, is refused without a click', async () => {
  for (const items of [[`Follow @${H}`, 'Mute this conversation', `Block @${H}`], ['Mute', `Mute @${H}`]]) {
    const { t, clicks } = muteRun({ items });
    const r = await t.done;
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /exact Mute items/);
    assert.deepEqual(clicks, []);
  }
});

test('mute job: a confirmation sheet after the click is left unanswered and refused', async () => {
  const { t, clicks } = muteRun({ confirmSheet: true });
  const r = await t.done;
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /confirmation/);
  assert.deepEqual(clicks, ['Mute']);
});

test('mute job: another logged-in account, or none, stops before any click', async () => {
  let run = muteRun({ me: 'someone_else' });
  assert.deepEqual(await run.t.done, { id: 'j1', status: 'wrong-account', reason: `logged in as @someone_else, not @${ME}` });
  assert.deepEqual(run.clicks, []);
  run = muteRun({ me: null });
  assert.equal((await run.t.done).status, 'login');
  assert.deepEqual(run.clicks, []);
});

test('mute job: a profile with no post the account wrote is skipped; a quote of it does not count', async () => {
  const { t, clicks } = muteRun({ cells: [postWithCaret({ author: 'realhuman', quote: H, status: '2' })] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'no-post', reason: 'no post by the account on its profile' });
  assert.deepEqual(clicks, []);
});

// Seen live on 2026-11-06: a profile's first post rendered 2-3 s before its ⋯ button.
test('mute job: waits for a post that has its ⋯ button, then mutes', async () => {
  const { t, clicks } = muteRun({ cells: [post({ author: H, status: '9' })], j: job({ waitMs: 3000 }) });
  setTimeout(() => {
    const art = t.document.querySelector('article[data-testid="tweet"]');
    art.insertAdjacentHTML('beforeend', '<button data-testid="caret" aria-label="More">⋯</button>');
    wireMenu(t.document, { items: MENU, handle: H, clicks });
  }, 700);
  const r = await t.done;
  assert.equal(r.status, 'muted');
  assert.deepEqual(clicks, ['Mute']);
});

test('mute job: posts that never get a ⋯ button are reported as such', async () => {
  const { t, clicks } = muteRun({ cells: [post({ author: H, status: '9' })] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'no-post', reason: 'its posts have no ⋯ button' });
  assert.deepEqual(clicks, []);
});

test('mute job: a menu that never opens reports an error', async () => {
  // A caret with no menu wired to it.
  const t = runContent(profile([postWithCaret({ author: H })]), { pathname: `/${H}`, state: muting, job: job() });
  const r = await t.done;
  assert.deepEqual(r, { id: 'j1', status: 'error', reason: 'the ⋯ menu did not open' });
});

test('mute job: the page timeout reports an error instead of hanging', async () => {
  const { t } = muteRun({ cells: [], j: job({ waitMs: 5000, pageTimeoutMs: 300 }) });
  assert.deepEqual(await t.done, { id: 'j1', status: 'error', reason: 'timed out in the page' });
});

// The same profile visit, for an account AI Anti-Slop muted that muting no
// longer picks. X's menu on a muted account's post offered "Unmute" on
// 2026-11-06; no unmute had been clicked live when these were written, so the
// toast text here is a stand-in.
const UNMUTE_MENU = ['Not interested in this post', `Follow @${H}`, `Add/remove @${H} from Lists`, 'Unmute', `Block @${H}`, 'Report post'];
const delisted = stateWith(['other'], { muteEnabled: true, muteAccount: ME });

function unmuteRun({ items = UNMUTE_MENU, cells = [postWithCaret({ author: H })], me = ME, confirmSheet = false, confirm = true } = {}) {
  const t = runContent(profile(cells, { me }), { pathname: `/${H}`, state: delisted, job: job({ kind: 'unmute' }), confirm });
  const clicks = wireMenu(t.document, { items, handle: H, confirmSheet, toastText: `@${H} has been unmuted.` });
  return { t, clicks };
}

test('unmute job: clicks the one exact Unmute item, never "Unmute this conversation", and reports the toast', async () => {
  const { t, clicks } = unmuteRun({ items: [...UNMUTE_MENU, 'Unmute this conversation'] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'unmuted', toast: `@${H} has been unmuted.` });
  assert.deepEqual(clicks, ['Unmute']);
  assert.deepEqual(t.confirms, ['j1'], 'the worker was asked once, just before the click');
});

test('unmute job: "Unmute @handle" is the same item', async () => {
  const { t, clicks } = unmuteRun({ items: [`Follow @${H}`, `Unmute @${H}`, `Block @${H}`] });
  assert.equal((await t.done).status, 'unmuted');
  assert.deepEqual(clicks, [`Unmute @${H}`]);
});

test('unmute job: a menu that offers Mute means it is no longer muted; nothing is clicked or asked', async () => {
  const { t, clicks } = unmuteRun({ items: [`Follow @${H}`, 'Mute', `Block @${H}`] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'not-muted' });
  assert.deepEqual(clicks, []);
  assert.deepEqual(t.confirms, []);
});

// Planted negatives: a menu we do not recognise is refused, never guessed at.
test('unmute job: no Unmute item, two of them, or Unmute beside Mute is refused without a click', async () => {
  for (const items of [[`Follow @${H}`, 'Unmute this conversation'], ['Unmute', `Unmute @${H}`], ['Unmute', 'Mute']]) {
    const { t, clicks } = unmuteRun({ items });
    const r = await t.done;
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /exact Unmute items/);
    assert.deepEqual(clicks, []);
  }
});

test('unmute job: no click when the worker does not confirm', async () => {
  const { t, clicks } = unmuteRun({ confirm: false });
  const r = await t.done;
  assert.deepEqual(clicks, []);
  assert.deepEqual(r, { id: 'j1', status: 'error', reason: 'the worker did not confirm the unmute' });
});

test('unmute job: a confirmation sheet is left unanswered; another account or no post stops before any click', async () => {
  let run = unmuteRun({ confirmSheet: true });
  assert.equal((await run.t.done).status, 'refused');
  run = unmuteRun({ me: 'someone_else' });
  assert.equal((await run.t.done).status, 'wrong-account');
  assert.deepEqual(run.clicks, []);
  run = unmuteRun({ cells: [] });
  assert.deepEqual(await run.t.done, { id: 'j1', status: 'no-post', reason: 'no post by the account on its profile' });
  assert.deepEqual(run.clicks, []);
});

test('check job: reports the muted-list rows the page renders, newest first', async () => {
  const rows = ['Slop_A', 'slop_b', 'other'].map(
    (h) => `<div data-testid="UserCell"><a href="/${h}"><img alt=""></a><a href="/${h}">@${h}</a></div>`,
  );
  const t = runContent(page([meLink(ME), ...rows]), { pathname: '/settings/muted/all', state: muting, job: job({ kind: 'check', handle: null }) });
  assert.deepEqual(await t.done, { id: 'j1', status: 'checked', rows: ['slop_a', 'slop_b', 'other'] });
});

test("the user's own tabs get no job and no click, even with muting on", async () => {
  const t = runContent(profile([postWithCaret({ author: H })]), { pathname: '/home', state: muting });
  const clicks = wireMenu(t.document, { items: MENU, handle: H });
  for (let i = 0; i < 10; i++) await tick();
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(clicks, []);
  assert.equal(t.document.querySelector('[role="menu"]') === null, true, 'compared as a boolean: printing a node hangs the run');
});

test('a listed post seen while browsing is sent once as a sighting, only while muting is on', async () => {
  let t = runContent(page([post({ author: H, status: '1' }), post({ author: H, status: '2' })]), { state: muting });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(t.hidden('1'), true);
  assert.deepEqual(t.sightings, [H]);
  t = runContent(page([post({ author: H, status: '1' })]), { state: stateWith([H]) });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(t.hidden('1'), true);
  assert.deepEqual(t.sightings, []);
});

test('stats report the logged-in account the popup binds muting to', async () => {
  const t = runContent(page([meLink('StartupBros')]), { state: stateWith([]) });
  await tick();
  assert.equal(t.content.stats().me, 'startupbros');
});

// Once an update or reload invalidates the extension, chrome.runtime.sendMessage
// throws synchronously. The page must neither raise an unhandled rejection nor
// click or report anything.
test('content: sendMessage throwing synchronously raises no rejection, clicks nothing, reports nothing', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const sent = [];
    const chrome = {
      id: 'xshtest',
      storage: { local: { get: async () => ({ 'xsh:list': { handles: [H], fetchedAt: 1 }, 'xsh:settings': { muteEnabled: true, muteAccount: ME } }) }, onChanged: { addListener() {} } },
      runtime: {
        id: 'xshtest',
        onMessage: { addListener() {} },
        sendMessage(msg) {
          sent.push(msg.type);
          throw new Error('Extension context invalidated.');
        },
      },
    };
    const t = runContent(page([meLink(ME), postWithCaret({ author: H })]), { pathname: '/home', chrome });
    const clicks = wireMenu(t.document, { items: MENU, handle: H });
    for (let i = 0; i < 8; i++) await tick();
    // The sighting and the job ask both threw; the page is still fine.
    assert.ok(sent.includes('xsh:job'), 'the job ask was tried');
    assert.ok(sent.includes('xsh:sighting'), 'the sighting was tried');
    // A job handed to the page directly: the confirmation fails, so no click, and the report is swallowed.
    await t.content.runJob(job());
    for (let i = 0; i < 8; i++) await tick();
    assert.ok(sent.includes('xsh:job-go'), 'the confirmation was tried');
    assert.ok(sent.includes('xsh:job-result'), 'the report was tried');
    assert.deepEqual(clicks, [], 'no click without the worker\'s yes');
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// chrome.storage throws the same way. The label read runs from a timer, where
// a throw is an uncaught exception, not a rejection.
test('content: a label read throwing synchronously after an update raises nothing', async () => {
  const thrown = [];
  const onThrown = (e) => thrown.push(e);
  process.on('uncaughtException', onThrown);
  process.on('unhandledRejection', onThrown);
  try {
    const labelReads = [];
    const chrome = {
      id: 'xshtest',
      storage: {
        local: {
          // The page loaded while the extension was there; the label read comes after it was cut off.
          get(keys) {
            if (keys.includes('xsh:list')) return Promise.resolve({ 'xsh:list': { handles: [], fetchedAt: 1 }, 'xsh:settings': { labeling: true } });
            labelReads.push(keys);
            throw new Error('Extension context invalidated.');
          },
        },
        onChanged: { addListener() {} },
      },
      runtime: { id: 'xshtest', onMessage: { addListener() {} }, sendMessage: async () => null },
    };
    const t = runContent(page([post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2' })]), { pathname: '/op/status/1', chrome });
    for (let i = 0; i < 8; i++) await tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.document.querySelector('[data-xsh-bar="2"]'), 'the label pair rendered, so labels were read');
    assert.equal(labelReads.length, 1, 'the label read was tried and threw');
    assert.deepEqual(thrown, [], 'nothing uncaught');
  } finally {
    process.off('uncaughtException', onThrown);
    process.off('unhandledRejection', onThrown);
  }
});

// A profile as x.com showed a deleted or suspended account on 2026-11-19.
const goneBox = (heading) =>
  `<div data-testid="emptyState"><div data-testid="empty_state_header_text">${heading}</div>` +
  '<div data-testid="empty_state_body_text">Try searching for another.</div></div>';
const titled = (html, title) => html.replace('<head></head>', `<head><title>${title}</title></head>`);

test('mute job: a deleted or suspended profile is reported gone at once, with no click', async () => {
  for (const heading of ['This account doesn’t exist', 'Account suspended']) {
    const started = Date.now();
    const t = runContent(titled(profile([goneBox(heading)]), 'Profile / X'), { pathname: `/${H}`, state: muting, job: job({ waitMs: 20000 }) });
    const clicks = wireMenu(t.document, { items: MENU, handle: H });
    assert.deepEqual(await t.done, { id: 'j1', status: 'gone', reason: heading });
    assert.ok(Date.now() - started < 5000, 'without the 20 s wait for a post');
    assert.deepEqual(clicks, []);
  }
});

// Planted negative: X's caution page in front of a live account is not gone;
// nothing on it is clicked, and it is handled as a profile with no post.
test("mute job: a profile behind X's caution page is not reported gone", async () => {
  const cells = ['<button data-testid="userActions" aria-label="More">⋯</button>', goneBox('Caution: This account is temporarily restricted')];
  const t = runContent(titled(profile(cells), `Some One (@${H}) / X`), { pathname: `/${H}`, state: muting, job: job() });
  const clicks = wireMenu(t.document, { items: MENU, handle: H });
  assert.deepEqual(await t.done, { id: 'j1', status: 'no-post', reason: 'no post by the account on its profile' });
  assert.deepEqual(clicks, []);
});

test('unmute job: a deleted or suspended profile is reported gone, with no click', async () => {
  const { t, clicks } = unmuteRun({ cells: [goneBox('Account suspended')] });
  t.document.title = 'Profile / X';
  assert.deepEqual(await t.done, { id: 'j1', status: 'gone', reason: 'Account suspended' });
  assert.deepEqual(clicks, []);
});

// Planted negative: a page that looks gone for one poll and then draws the
// live profile is muted, not settled as gone for good.
test('mute job: a gone-looking page that turns into the live profile is muted, not reported gone', async () => {
  const t = runContent(titled(profile([goneBox('This account doesn’t exist')]), 'Profile / X'), { pathname: `/${H}`, state: muting, job: job({ waitMs: 3000 }) });
  const clicks = [];
  setTimeout(() => {
    t.document.querySelector('[data-testid="emptyState"]').remove();
    t.document.title = `Some One (@${H}) / X`;
    t.document.querySelector('[aria-label="Timeline"]').insertAdjacentHTML('beforeend', postWithCaret({ author: H }));
    wireMenu(t.document, { items: MENU, handle: H, clicks });
  }, 200);
  const r = await t.done;
  assert.equal(r.status, 'muted');
  assert.deepEqual(clicks, ['Mute']);
});
