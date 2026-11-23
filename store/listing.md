# Chrome Web Store listing

The live listing is
<https://chromewebstore.google.com/detail/apchbmongdogokfagedphbkempkhccha>
(item id `apchbmongdogokfagedphbkempkhccha`). AI Anti-Slop 0.7.1 passed review
and was published automatically on 2026-11-17. That day the live page showed
version 0.7.1, the description below word for word except for one line that
0.8.0 changes (0.7.1's muting section said "It never blocks, never unmutes,
and does not use the X API."), the category Social
Networking, and the three data types ticked under **Data usage**. The package
it served was byte for byte the v0.7.1 release's extension files, except that
the store added an `update_url` to `manifest.json` and a
`_metadata/verified_contents.json`. The release zip also carries `PRIVACY.md`,
`README.md` and `src/userscript-adapter.js`, which the store zip leaves out.

What to enter in the Chrome Web Store developer dashboard for AI Anti-Slop 0.10.0,
field by field. 0.10.0 was submitted on 2026-11-21 with this text, in place of
0.9.0, whose review (since 2026-11-19) was cancelled; the store still served
0.8.0 that day. Sharing labels is new
in 0.10.0, so these were written for the first submit that carries it: the
readers' list in the first paragraph, the sharing line under LABELS, the
PRIVACY section, the single purpose, the storage justification, the readers'
list under Remote code, the data-usage reasons and the certification line. So
was the Report a problem line at the end of the description. Field names and rules are from Google's developer documentation
at developer.chrome.com/docs/webstore, read on 2026-11-09. Where the docs show a
dashboard label only in a screenshot, this file says so; match it to the
dashboard itself.

## Package

Build the zip from a commit, never from a working tree:

```
git fetch origin
node scripts/package-store.mjs --ref origin/main
```

Build from `main`, or from a tag from `v0.6.0` on. The `v0.5.0` tag predates
the store icon: its `icons/icon-128.png` fills the whole 128x128 square, where
later commits have the 16 px padding the store asks for. Tags before `v0.7.1`
build an old name: `v0.7.0` builds Human Replies Only, earlier tags x-slop-hide.

It writes `build/ai-anti-slop-<version>-chrome-web-store.zip` and refuses a
manifest with a `key`, a name over 75 or a description over 132 characters, a
version that differs from `package.json`, and a missing or unparseable file.
Upload that zip under **Package**.

## Store listing tab

**Name** and **Summary** come from `manifest.json` (`name`, `description`), so
changing either takes a new upload:

- Name: `AI Anti-Slop – Hide AI spam accounts on X`
- Summary: `Hides x.com posts by accounts on a self-updating AI-reply spam list, and can mute them on X, daily or all at once. No X API.`

**Description** (plain text; the store shows line breaks but no formatting):

```
AI Anti-Slop hides posts on x.com by accounts on its Recommended list: clankwall's public list of AI-reply spam accounts (clankwall.vogel.dev), plus the accounts @levelsio blocked with a public "Blocked for AI reply" (blockedforaireply.levels.io), plus the readers' list, the accounts that three or more AI Anti-Slop readers who share their labels reported as slop. The lists refresh every 6 hours. On the settings page you can switch Recommended off, switch on clankwall's wider All flags list, which adds accounts it flagged for spam, or the whole of levelsio's Blocked for AI reply list, or add a list of handles by its address. You can add accounts of your own, keep accounts you always want to see, and choose Show, Hide or Mute for six bots that answer when tagged, such as @grok and @AskPerplexity. A reply by any other account stays, however it was written, unless you turn on hiding posts that tag a bot set to Hide or Mute.

HIDING
- A post is hidden when its author is on a list you have switched on, in your Also hide box or a bot set to Hide or Mute, unless the author is in Always show or you opened that account's own page. Quotes and mentions stay visible, except that an optional setting hides posts that tag a bot set to Hide or Mute.
- A post hidden because its author is on a list leaves a one-line note, "Hidden: on" and the list's name, with Show (that post, this page only, nothing stored) and Not slop (labels it not slop and adds the account to Always show, with 6 seconds to undo). Posts you hid yourself, and posts that tag a hidden bot, are hidden completely. A setting on the settings page hides listed posts completely, with no note.
- On an x.com tab, the popup counts what that tab hid. Pause hiding shows every post again.
- Hiding works in this browser profile only. In your own tabs the extension never clicks anything on X's page and makes no network request.

LABELS
- A Hide as slop icon sits in the header of each post, beside X's More menu, on the home timeline, search, profiles, lists and post pages. Posts by the account whose page is open have none, nor do your own once X shows who is logged in. The icon is on by default; turn it off in the popup under Label posts.
- A click hides the post and adds the account to Also hide, with 6 seconds to undo. An undone click is never saved. A click on a filled icon removes the label.
- A saved label keeps the post's text and link in this browser. Export labels saves them to a file.
- Sharing is off until you turn it on in settings, or press Share on the card that appears once after your first saved Hide as slop. The card turns it on for labels you make from then on only. While it is on, each label is sent to AI Anti-Slop's server as the author's handle, the post's id, the id of the post page it was on and the day it was made, never the words. Labels that agree across several readers put an account on the readers' list. Delete what I shared deletes them from the server.

SETTINGS FILES
- Export your Always show and Also hide accounts, bot choices and tag setting to a file, or Also hide alone as a list of handles to share.
- Import a settings file or a shared list. Import adds accounts and never removes any, shows what will change before it changes anything, and never turns muting on.

MUTING (optional, off until you turn it on)
- When you turn it on, AI Anti-Slop mutes the accounts on clankwall's AI list, the accounts in your Also hide box and any bot you set to Mute on X, on your X account. It clicks X's own Mute item on x.com, in background tabs it opens and closes, one visit about every 1 to 4 minutes. You pick 25, 50 or 100 mutes a day: the first 25 run whenever the browser is open, and at 50 or 100 the rest run only while you have an x.com tab open. Run now visits every account waiting, one after another and 2 to 5 seconds apart, past the daily number, until none are left, you press Stop or muting stops for the day.
- Muting uses clankwall's AI list alone, never the accounts Recommended adds from levelsio, All flags, levelsio's list or a list you add, and that list stays on while muting is on. It skips accounts you follow and accounts in Always show. If an account it muted leaves that list or moves to Always show, it unmutes it the same way. It never blocks and does not use the X API.
- X's rules forbid "scripting the X website" and say: "The use of these techniques may result in the permanent suspension of your account." Muting scripts x.com. Read the Muting section on the project page before you turn it on.

PRIVACY
- No account, no analytics. The extension's own code downloads the lists you have switched on, clankwall's, levelsio's, the readers' list and any you add, without cookies. Only if you turn on sharing does it send anything else: your labels' reports, without the post's words, to AI Anti-Slop's server. Everything else it keeps stays in your browser's extension storage. Report a problem, in the popup and settings, opens GitHub with the extension's version and your browser's name in the address, and only when you click it.
- Privacy policy: https://github.com/StartupBros-com/ai-anti-slop/blob/main/PRIVACY.md

Free and open source under the MIT license: https://github.com/StartupBros-com/ai-anti-slop
Report a problem or suggest something (with a GitHub account): https://github.com/StartupBros-com/ai-anti-slop/issues/new/choose

AI Anti-Slop is not affiliated with, endorsed by or sponsored by X Corp. It does not run or maintain the clankwall or levelsio lists.
```

The MUTING paragraph is the one to cut, with the muting UI, if a hide-only
store build is ever made. It has no such build today: the store zip is the
same extension as the GitHub release.

**Category:** Social Networking, as the dashboard and the live listing name it.
Google's category list calls it Social Media & Networking ("extensions designed
to enhance social media platforms").

**Language:** English.

**Graphics** (all in `store/images/`):

| Field | File | Size |
|---|---|---|
| Store icon | `icons/icon-128.png` (also in the zip) | 128x128, 96x96 artwork with 16 px transparent padding |
| Screenshot 1 | `screenshot-1-hide.png` | 1280x800 |
| Screenshot 2 | `screenshot-2-popup.png` | 1280x800 |
| Screenshot 3 | `screenshot-3-muting.png` | 1280x800 |
| Screenshot 4 | `screenshot-4-labels.png` | 1280x800 |
| Small promo tile | `promo-small-440x280.png` | 440x280 |

The screenshots and tile are 24-bit PNGs with no alpha channel. The marquee
tile (1400x560) is optional and not made.

The screenshots show the real extension on a local example page, not on x.com:
the threads use made-up `xsh_demo_` accounts, three of them put in **Also
hide** to stand in for listed spam, and the list counts are the live
clankwall list at render time. Regenerate them, and the tile, with:

```
pnpm install
node scripts/store-screenshots.mjs --chrome <path to a Chromium binary>
```

`--icon` also redraws `icons/icon-128.png` from `icons/icon.svg`. With snap
Chromium, pass `--stage-root` a directory under `~/snap/chromium/common`: snap
Chromium has its own private `/tmp` and cannot load an extension staged in the
system one.

**Official URL / homepage:** `https://github.com/StartupBros-com/ai-anti-slop`
(the manifest's `homepage_url`).

**Support URL:** `https://github.com/StartupBros-com/ai-anti-slop/issues`

## Privacy tab

**Single purpose:**

```
Hide posts on x.com by accounts on public lists of AI-reply spam accounts, among them one built from the slop labels users choose to share, or on lists the user keeps, with an optional mute of the same accounts on the user's X account that is off until the user turns it on.
```

**Permission justifications:** the dashboard takes all host access, the
clankwall host and the x.com content scripts, in a single **Host permission
justification** field, which holds the last two rows of this table joined
(985 of the field's 1,000 characters: the host row below is 4 characters shorter than the one measured at 989).

| Permission | Justification |
|---|---|
| `storage` | Keeps the downloaded lists and the user's settings and account lists. Keeps a label (the post's text and link, with the author's handle and the time) only from a Hide as slop click the user does not undo; the click is saved when its 6-second Undo window ends, or sooner if the user clicks another post's icon, opens another page, or switches away from or closes the tab. The icon is on by default, but nothing is saved without a click. Keeps the muting record only if the user turns muting on, and sharing's queue only if the user turns sharing on. All of it stays in the browser's extension storage; while sharing is on, a label's report (handle, post id, page post id, hash of the words) is also sent to AI Anti-Slop's server. |
| `alarms` | Refreshes the lists every 6 hours. When muting is on, a once-a-minute alarm checks whether a mute visit is due, and a 90-second alarm closes a visit tab that stalls. |
| Host permission `https://clankwall.vogel.dev/*` | The service worker downloads clankwall's public lists from `https://clankwall.vogel.dev/api/`, without cookies. No other data is sent there. |
| Content scripts on `x.com`, `twitter.com`, `mobile.x.com`, `mobile.twitter.com` | The content script reads each post's author handle to hide posts by listed accounts. X serves the same pages on all four hosts. It reads the user's own handle from X's navigation bar, so a post by the user is never hidden for tagging a bot and muting runs only as the account that turned it on. With labels on (the default), it adds a Hide as slop icon to each post's header, except on posts by the account whose page is open and, once X shows who is logged in, the user's own, and reads a post's text only when the user clicks it. With muting on, it clicks X's own Mute item only in a background tab the extension opened for one account, and reads the user's muted-accounts page in another tab the extension opened, to confirm earlier mutes. |

**Remote code:** the dashboard asked no remote-code question when 0.7.1 was
submitted, so nothing was entered. If it asks, the answer is No: all
JavaScript ships in the package, and the lists it downloads are data, read and
never run: plain text with one handle per line, or JSON lines. Of clankwall's
JSON lines only the `username` field is read; of levelsio's, which the
Recommended list uses, the `username`, `levelsio` and `evidence` fields, to
keep only the handles of accounts marked `confirmed` with evidence; of the
readers' list (`https://ai-anti-slop.startupbros.com/v1/list.ndjson`), the
`username` field. levelsio's files, the readers' list and a list the user adds
by address are fetched without any host permission, so only a host that lets other sites read the file (an
`Access-Control-Allow-Origin` header) can serve one.

**Data usage.** The docs show the checkbox labels only in a screenshot, so the
names below may differ from the dashboard's; tick the dashboard's nearest box
for each row. The stored fields are named by their keys in `PRIVACY.md`.

| Box | Tick | Why |
|---|---|---|
| Personally identifiable information | Yes | X handles: the user's own handle, in `xsh:settings` while muting is on and in the muting record (`xsh:mutes`) on each mute it made, which stays after muting is turned off; and other people's handles in the user's lists, the muting record and labels (`xsh:label:<post id>`). |
| Website content | Yes | A label keeps up to 1,000 characters of the labelled post's text. A label is saved only from a Hide as slop click the user does not undo. With sharing on, the text is not sent. |
| Web history (the FAQ's "web browsing activity": the sites and URLs a user visits) | Yes | Each label keeps the address of the post and of the page it was labelled on, with the time. With sharing on, the two post ids are sent, with the hour, which says which post page the user was reading. |
| User activity | No | Nothing records keystrokes or mouse movement. With muting on, the muting record keeps up to 50 accounts (listed, in Also hide, or a bot set to Mute on X) whose posts were hidden on the user's screen, so they are muted first. Labels record the user's own Hide as slop clicks, covered under Website content and Web history. This is the extension's own function, not monitoring; if the dashboard's wording for this box reads as covering it, tick it. |
| Authentication information | No | The extension never reads passwords, cookies or tokens. Mute visits use the browser's own x.com login, as any page load does. |
| Personal communications | No | Public posts only; no messages or email. |
| Health, financial and payment, location | No | None handled. |

The boxes would be ticked even with nothing leaving the browser, because
Google's User Data FAQ asks "Does an extension need to disclose user data
handling if the data is only processed or stored locally on a user's device?"
and answers "Yes". With sharing on, the handle, the two post ids and the day
leave it, for AI Anti-Slop's server, which Cloudflare hosts.

**Certifications:** tick every one. The docs show their wording only in a
screenshot; they certify compliance with the Limited Use policy. All of it
holds for AI Anti-Slop: it does not sell user data or transfer it to third
parties, does not use it for anything outside its single purpose, and does not
use it for advertising or for creditworthiness or lending. Shared reports are
used only to build the readers' list; no person reads them one by one, and
the maintainers see only counts per account across installs.

**Privacy policy URL:**
`https://github.com/StartupBros-com/ai-anti-slop/blob/main/PRIVACY.md`. It
carries the Limited Use statement on the project's own page.

## Distribution tab

- Payment: free.
- Visibility: **Public** lists the item in the store. **Unlisted** creates no
  listing, but anyone with the item's store URL can install it. **Private**
  limits installs to named testers or groups. Google: "All visibility settings
  have the same policy requirements and will go through the same review
  process."
- Regions: all.
- **Submit for review** opens a dialog with one checkbox, ticked by default,
  that publishes the item automatically once it passes review. Untick it to
  publish by hand after approval; an approved item not published within 30
  days goes back to draft and needs resubmitting. AI Anti-Slop leaves it
  ticked.
- Decide before submitting. As the dashboard stood on 2026-11-17: while a
  review was pending with automatic publishing on, the item's ⋮ menu (in the
  header of its Store listing page; the Status page has none) offered **Defer
  publish**. With automatic publishing off, that menu had no way to turn it
  back on, so the only route was **Cancel review** and a new submit. After
  **Cancel review**, the **Submit for review** button stayed greyed out until
  the page was reloaded.
- A pending review locks the draft. As the dashboard stood on 2026-11-21, every
  field, and **Save draft** and **Submit for review**, were greyed out while a
  review was pending, so a new package or new text first needs **Cancel
  review** from the same ⋮ menu. It asks to confirm, and the submission goes
  back to being a draft; the published version stays live. Each screenshot has
  Remove, Move left and Move right buttons, and each Remove asks to confirm.
  That submit removed all four and added the new ones one by one, in order,
  which kept them in that order.

## Test instructions tab

Optional. Google says the tab is useful when an item needs restricted
credentials for full access; seeing AI Anti-Slop work needs an X login, so fill
in Additional instructions (no credentials are given; the box takes at most
500 characters):

```
Needs an X login only. Hiding: open a reply thread on x.com, open the popup, add one replier's handle under Your accounts > Also hide these accounts, then Save. That reply disappears and the popup counts it; Pause hiding brings it back. Muting is off by default and mutes real accounts: on a logged-in x.com tab, turn on "Mute listed accounts on X" (25, 50 or 100 a day; Run now ignores that number, so skip it). It uses X's own Mute item, no X API; unmute at x.com/settings/muted/all.
```
