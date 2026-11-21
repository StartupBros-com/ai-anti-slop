// Report a problem or suggest something: the link the popup and settings page
// build, and the GitHub issue forms it fills in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { src, lib } from './helpers.mjs';

const CHOOSER = 'https://github.com/StartupBros-com/ai-anti-slop/issues/new/choose';

// What Brave 158 on Windows reported on 2026-11-21.
const BRAVE = {
  userAgentData: {
    brands: [
      { brand: 'Chromium', version: '158' },
      { brand: 'Not.A/Brand', version: '24' },
      { brand: 'Brave', version: '158' },
    ],
    platform: 'Windows',
  },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
};

test('browserName: the brand, major version and platform, never the whole user agent', () => {
  assert.equal(lib.browserName(BRAVE), 'Brave 158 on Windows', 'the brand beats Chromium and the made-up brand, and beats the user agent');
  const chrome = {
    userAgentData: {
      brands: [
        { brand: 'Google Chrome', version: '142' },
        { brand: 'Not_A Brand', version: '99' },
        { brand: 'Chromium', version: '142' },
      ],
      platform: 'macOS',
    },
  };
  assert.equal(lib.browserName(chrome), 'Google Chrome 142 on macOS');
  const edge = { userAgentData: { brands: [{ brand: 'Not)A;Brand', version: '8' }, { brand: 'Chromium', version: '142' }, { brand: 'Microsoft Edge', version: '142' }], platform: 'Windows' } };
  assert.equal(lib.browserName(edge), 'Microsoft Edge 142 on Windows');
  const chromium = { userAgentData: { brands: [{ brand: 'Chromium', version: '142' }, { brand: 'Not/A)Brand', version: '24' }], platform: 'Linux' } };
  assert.equal(lib.browserName(chromium), 'Chromium 142 on Linux', 'Chromium alone names itself');
});

test('browserName: falls back to the user agent string, and gives nothing when neither says', () => {
  const ua = (s) => ({ userAgent: s });
  assert.equal(lib.browserName(ua(BRAVE.userAgent)), 'Chrome 158 on Windows', 'without brands the user agent says Chrome');
  assert.equal(
    lib.browserName(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0')),
    'Microsoft Edge 142 on Windows',
  );
  assert.equal(lib.browserName(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')), 'Chrome 142 on macOS');
  assert.equal(lib.browserName({ userAgentData: { brands: 'Brave' }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0' }), 'Chrome 141 on Linux');
  assert.equal(lib.browserName({ userAgentData: { brands: [{ brand: 'Not.A/Brand', version: '24' }] }, userAgent: 'x' }), '');
  assert.equal(lib.browserName(undefined), '');
  assert.equal(lib.browserName({}), '');
  assert.ok(lib.browserName({ userAgentData: { brands: [{ brand: 'B'.repeat(200), version: '1' }], platform: 'Windows' } }).length <= 80);
});

test('feedbackUrl: the issue chooser with the version and browser, and nothing else', () => {
  const url = lib.feedbackUrl('0.9.0', 'Brave 158 on Windows');
  assert.equal(url, `${CHOOSER}?version=0.9.0&browser=Brave%20158%20on%20Windows`);
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, CHOOSER, 'the chooser, not a template file, so a renamed form keeps old links working');
  assert.deepEqual([...u.searchParams.keys()], ['version', 'browser'], 'no template, labels, handle or other setting');
  assert.equal(u.searchParams.get('browser'), 'Brave 158 on Windows');
  assert.equal(lib.feedbackUrl('0.9.0', ''), `${CHOOSER}?version=0.9.0`);
  assert.equal(lib.feedbackUrl(undefined, 'Chrome 142 on Linux'), `${CHOOSER}?browser=Chrome%20142%20on%20Linux`);
  assert.equal(lib.feedbackUrl(), CHOOSER);
  assert.equal(lib.feedbackUrl('1&labels=x', 'a#b'), `${CHOOSER}?version=1%26labels%3Dx&browser=a%23b`, 'values are encoded, so they cannot add a parameter');
});

test('feedbackUrl: the repository is the one the manifest names', () => {
  assert.equal(lib.REPO_URL, JSON.parse(src('manifest.json')).homepage_url);
});

// GitHub fills a form field from the parameter named by its id, and ignores a
// parameter no field has. A renamed id would leave every install's link
// filling nothing, so the form must keep a field for each one the link sends.
test('the Report a problem form has a field for each parameter the link sends', () => {
  const form = src('.github/ISSUE_TEMPLATE/bug.yml');
  const ids = [...form.matchAll(/^ {4}id: ([a-z_-]+)$/gm)].map((m) => m[1]);
  assert.deepEqual([...lib.FEEDBACK_FIELDS], ['version', 'browser']);
  for (const field of lib.FEEDBACK_FIELDS) assert.ok(ids.includes(field), `bug.yml has no field with id ${field}`);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('the popup and settings page link to the chooser even before their scripts run', () => {
  // The popup's footer is one line, so its link is short and its title says it opens GitHub.
  const links = {
    'src/popup.html': `<a id="feedback" href="${CHOOSER}" target="_blank" rel="noopener" title="Opens GitHub's issue page. Posting needs a free GitHub account.">Report a problem</a>`,
    'src/settings.html': `<a id="feedback" href="${CHOOSER}" target="_blank" rel="noopener">Report a problem or suggest something</a>`,
  };
  for (const [page, link] of Object.entries(links)) {
    const html = src(page);
    assert.ok(html.includes(link), page);
    assert.match(html, /open source/, `${page} says it is open source`);
  }
});
