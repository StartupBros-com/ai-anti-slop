import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const src = (p) => readFileSync(join(root, p), 'utf8');
export const lib = createRequire(import.meta.url)('../src/lib.js');

export const tick = () => new Promise((r) => setTimeout(r, 0));

// A post shaped like x.com's markup as observed live on 2026-11-03: the
// author's links sit in the first [data-testid="User-Name"]; a quoted post is a
// [role="link"] card inside the article carrying its own User-Name block.
// `mention` tags an account in the post's own text; `quoteMention` tags one in
// the quoted post's text only (an "@grok is this true?" seen through a quote).
//
// `head` adds the icons at the post's top right beside its User-Name block, as
// observed live on 2026-11-18 (headIcons). `actions` adds the row of action
// icons under it.
export function post({ author, quote = null, mention = null, quoteMention = null, status = '1', authorBlock = true, actions = false, head = null }) {
  const names = authorBlock
    ? `<div data-testid="User-Name"><div><a href="/${author}" role="link"><span>Name</span></a></div>` +
      `<div><a href="/${author}" role="link" tabindex="-1"><span>@${author}</span></a>` +
      `<a href="/${author}/status/${status}" role="link"><time datetime="2026-11-03T00:00:00.000Z">1h</time></a></div></div>`
    : '';
  // A button among the names too (a badge, say), so only their links tell them from the icons.
  const badge = '<span role="button" aria-label="Badge"><svg viewBox="0 0 24 24"></svg></span>';
  const userName = head ? `<div data-head-row><div>${names}${badge}</div>${headIcons(head)}</div>` : names;
  const text = `<div data-testid="tweetText"><span>hello </span>${mention ? `<a href="/${mention}" role="link">@${mention}</a>` : ''}</div>`;
  const quoteCard = quote
    ? `<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/${quote}"><span>@${quote}</span></a></div>` +
      `<div data-testid="tweetText">quoted text${quoteMention ? ` <a href="/${quoteMention}" role="link">@${quoteMention}</a>` : ''}</div></div>`
    : '';
  // The row of action icons X draws under a post, with `actions`.
  const row = actions
    ? `<div role="group" aria-label="Post actions"><div><button data-testid="reply" type="button"><div><svg viewBox="0 0 24 24"></svg></div></button></div>` +
      `<div><button data-testid="like" type="button"><div><svg viewBox="0 0 24 24"></svg></div></button></div></div>`
    : '';
  return (
    `<div data-testid="cellInnerDiv" data-fixture="${status}"><div><article data-testid="tweet" role="article" tabindex="0">` +
    `${userName}${text}${quoteCard}${row}</article></div></div>`
  );
}

// The icons at a post's top right, nested as on x.com on 2026-11-18: a group
// ([data-icons] here) holding Grok's button ('grok') and then More (⋯), or
// More alone ('more'). The group is the right end of the header row.
// 'follow' is the post a page is about as x.com drew it at 420 px on
// 2026-11-23: X's Follow button and an empty box in the same group, left of
// Grok and More.
export function headIcons(kind) {
  const grok = '<div><button aria-label="Grok actions" type="button"><svg viewBox="0 0 24 24"></svg></button></div>';
  const more = '<div><div><div><button data-testid="caret" aria-label="More" type="button"><svg viewBox="0 0 24 24"></svg></button></div></div></div>';
  const follow = '<div><button data-testid="100-follow" aria-label="Follow" type="button"><span>Follow</span></button></div><div></div>';
  const before = kind === 'grok' ? grok : kind === 'follow' ? follow + grok : '';
  return `<div><div data-icons>${before}${more}</div></div>`;
}

export function page(cells) {
  return `<!doctype html><html><head></head><body><main><div aria-label="Timeline">${cells.join('')}</div></main></body></html>`;
}

// Run lib.js + content.js in a VM whose globals are a linkedom window, with a
// test adapter standing in for chrome.storage. Returns handles for the test.
//
// With `job`, the adapter also hands that job to the content script and
// collects what it reports (`done` resolves with the report), answers its
// confirmJob with `confirm` and records the asks in `confirms`; `sightings`
// collects noteSighting calls. A `job` may be a promise, for a worker that
// answers late.
//
// With `labels`, the adapter can save and read labels as the extension's
// does: `labels.stored` maps post ids to labels already saved, `labels.answer`
// gives the worker's reply to a save (default: saved), `labels.read` can hold or
// reject a read, `saves` records each
// save and `labelChange(id, label)` stands in for a change in another tab.
// With `labels.worker`, a save that is answered ok also stores the box change
// the worker's would (lib.labelPatch) without telling the page: `notify()`
// delivers that storage change when the test chooses, and `state()` reads it.
// With `present`, `present()` asks the tab what the worker's x.com check asks.
//
// With `clock`, timers longer than 0 ms wait for `advance(ms)` instead of
// real time; 0 ms timers (the label read batch) still run on their own.
//
// With `styles`, the page has a getComputedStyle (linkedom has none):
// `styles(el)` returns the computed style to report for that element.
export function runContent(html, { pathname = '/home', state = {}, job = null, confirm = true, labels = null, present = false, chrome = null, clock = false, styles = null } = {}) {
  const { window, document, MutationObserver } = parseHTML(html);
  const fake = clock ? fakeClock() : null;
  const location = { pathname };
  let subscriber = null;
  let current = state;
  let deliverMutations = null;
  let observed = null;
  // linkedom v0.18.15 reports the observed root, not the mutated parent, as
  // childList target. Tests may deliver a native-shaped record explicitly.
  // https://github.com/WebReflection/linkedom/blob/v0.18.15/esm/interface/mutation-observer.js#L85-L107
  class TestObserver extends MutationObserver {
    constructor(cb) {
      super(cb);
      deliverMutations = cb;
    }
    observe(target, options) {
      observed = { target, options };
      super.observe(target, options);
    }
  }
  const sightings = [];
  let finish;
  const done = new Promise((r) => (finish = r));
  const adapter = {
    load: () => Promise.resolve(current),
    subscribe(cb) {
      subscriber = cb;
    },
    noteSighting: (h) => sightings.push(h),
  };
  const confirms = [];
  const saves = [];
  const consents = [];
  const opened = [];
  let labelSub = null;
  let presentFn = null;
  if (labels) {
    const stored = labels.stored || {};
    adapter.saveLabel = (m) => {
      saves.push(JSON.parse(JSON.stringify(m)));
      const res = labels.answer ? labels.answer(m) : { ok: true, label: m.label };
      if (labels.worker && res && res.ok) {
        const s = (current && current.settings) || {};
        const patch = lib.labelPatch(s, m.handle, m.label);
        if (patch) current = { ...current, settings: { ...s, ...patch } };
      }
      return Promise.resolve(res);
    };
    adapter.getLabels = labels.read || ((ids) => Promise.resolve(Object.fromEntries(ids.map((id) => [id, stored[id] || null]))));
    adapter.subscribeLabels = (cb) => {
      labelSub = cb;
    };
    // The extension's own adapter has these two too; the userscript's has neither.
    adapter.shareConsent = (choice) => {
      consents.push(choice);
      return Promise.resolve(labels.consent ? labels.consent(choice) : { ok: true });
    };
    adapter.openSettings = () => {
      opened.push('settings');
      return Promise.resolve({ ok: true });
    };
  }
  if (present) {
    adapter.answerPresent = (fn) => {
      presentFn = fn;
    };
  }
  if (job) {
    adapter.getJob = () => Promise.resolve(job);
    adapter.reportJob = (r) => finish(JSON.parse(JSON.stringify(r)));
    // The worker's answer to "may I click Mute now?" (`confirm`).
    adapter.confirmJob = (j) => {
      confirms.push(j.id);
      return Promise.resolve(confirm);
    };
  }
  const ctx = vm.createContext({
    window,
    document,
    location,
    MutationObserver: TestObserver,
    ...(chrome ? { chrome } : { XSlopHideAdapter: adapter }),
    console,
    // Every page has URL; lib.js needs it to read a list added by address.
    URL,
    setTimeout: fake ? fake.setTimeout : setTimeout,
    clearTimeout: fake ? fake.clearTimeout : clearTimeout,
    ...(styles ? { getComputedStyle: styles } : {}),
  });
  vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  vm.runInContext(src('src/content.js'), ctx, { filename: 'src/content.js' });
  const cell = (status) => document.querySelector(`[data-fixture="${status}"]`);
  return {
    document,
    location,
    hidden: (status) => cell(status).hasAttribute('data-xsh-hidden'),
    push(next) {
      current = next;
      subscriber(next);
    },
    state: () => current,
    notify: () => subscriber(current),
    advance: (ms) => fake.advance(ms),
    content: ctx.XSlopHideContent,
    deliverMutations(records) { deliverMutations(records); },
    observed() { return observed; },
    sightings,
    confirms,
    done,
    saves,
    consents,
    opened,
    labelChange: (id, label) => labelSub(id, label),
    present: () => presentFn(),
    window,
  };
}

// Timers for runContent's `clock`: a timer longer than 0 ms runs only when
// advance() reaches its time, in time order; a 0 ms one is a real timer.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    setTimeout(fn, ms, ...args) {
      if (!(ms > 0)) return setTimeout(fn, 0, ...args);
      const id = { fake: ++seq };
      due.set(id, { at: now + ms, seq, fn, args });
      return id;
    },
    clearTimeout(id) {
      if (id && id.fake) due.delete(id);
      else clearTimeout(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of due) {
          if (t.at <= end && (!next || t.at < due.get(next).at || (t.at === due.get(next).at && t.seq < due.get(next).seq))) next = id;
        }
        if (!next) break;
        const t = due.get(next);
        due.delete(next);
        now = t.at;
        t.fn(...t.args);
      }
      now = end;
    },
  };
}

// The sidebar link x.com renders for the logged-in account.
export const meLink = (me) => `<nav><a data-testid="AppTabBar_Profile_Link" href="/${me}">Profile</a></nav>`;

// A post's ⋯ button. Clicking it opens a [role=menu] with `items`, as X's
// menu did on 2026-11-06; clicking the item labelled "Mute" (or "Mute @h")
// shows X's toast, or a confirmation sheet when `confirmSheet` is set.
// `clicks` records each menu item clicked, by label.
export function wireMenu(document, { items, handle, confirmSheet = false, clicks = [], toastText = `@${handle} has been muted.Undo` }) {
  for (const caret of document.querySelectorAll('[data-testid="caret"]')) {
    caret.addEventListener('click', () => {
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      for (const label of items) {
        const it = document.createElement('div');
        it.setAttribute('role', 'menuitem');
        it.innerHTML = `<span>${label}</span>`;
        it.addEventListener('click', () => {
          clicks.push(label);
          const out = document.createElement('div');
          if (confirmSheet) {
            out.setAttribute('data-testid', 'confirmationSheetDialog');
          } else {
            out.setAttribute('data-testid', 'toast');
            out.textContent = toastText;
          }
          document.body.appendChild(out);
        });
        menu.appendChild(it);
      }
      document.body.appendChild(menu);
    });
  }
  return clicks;
}

// A post by `author` with X's ⋯ button inside it.
export function postWithCaret(opts) {
  return post(opts).replace('</article>', '<button data-testid="caret" aria-label="More">⋯</button></article>');
}

// `names` maps a handle to the name of the list holding it, as the extension's
// own adapter reads it (list.names).
export function stateWith(handles, settings = {}, names = null) {
  return { list: { handles, fetchedAt: 1, ...(names ? { names } : {}) }, settings };
}
