# Testing

How AI Anti-Slop (formerly Human Replies Only and x-slop-hide) has been
tested, run by run. The
README's [Development](../README.md#development) section covers the
automated tests.

On 2026-11-03, the real `lib.js` and `content.js` were injected into a logged-in
x.com tab through the DevTools protocol, with a stub in place of extension
storage. A separate oracle read each post's visible `@handle` text (not the
script's own href matcher) and compared it with what was hidden.

| Page | Distinct posts | Should hide | Hidden | Mismatches |
|---|---|---|---|---|
| A listed account's `/with_replies` | 47 | 6 | 6 | 0 |
| Reply thread, 251 replies (reached by in-app navigation) | 118 | 12 | 12 | 0 |
| Reply thread, 105 replies | 106 | 13 | 13 | 0 |
| Home timeline | 25 | 0 | 0 | 0 |

The listed account's own posts stayed visible on its profile and were hidden on
other threads. Frame-time p95 was 20.3 and 19.9 ms before injection, 20.3 and
19.6 ms injected with hiding paused, and 30-41 ms with hiding on.

Frame times were measured on the listed account's `/with_replies` page.

The unpacked extension was also run in Chromium 156 (headless, through
Playwright) with x.com URLs answered by fixture pages: the service worker
fetched the real feed on install and scheduled the 360-minute alarm; the
content script hid exactly the listed authors and skipped the own profile;
the popup showed the list, read the active tab's counts, and its pause,
allowlist and refresh controls took effect. The only requests outside the
fixtures were the feed URL, once at install and once on refresh.

On 2026-11-06, the same setup passed 22 of 22 checks: 20 page-change scenarios,
including X removing, recycling and reinserting post cells, plus 2 setup
checks. Each scenario ended with exactly the listed authors hidden.

Also on 2026-11-06, version 0.2.0 ran in Chromium 156 the same way, twice:

- The userscript, in Violentmonkey 2.50.0. Opening a `.user.js` URL on a
  local web server brought up Violentmonkey's install page, which showed
  version 0.2.0 and `@connect clankwall.vogel.dev`. After install, the script
  fetched the real list (767 handles) through the manager, hid @grok and a
  listed author, and left an unlisted account showing. After a reload it hid
  them again from the stored list without fetching it again. Violentmonkey's
  menu showed all four commands, and **Show / hide @grok** showed @grok's post
  while the listed author stayed hidden. 10 of 10 checks passed: 8 on the
  script and 2 setup checks.
- The extension. The popup's **Show @grok's replies** box started unticked.
  Ticking it showed @grok's post in an open x.com tab while the listed author
  stayed hidden; the box was still ticked when the popup reopened; unticking
  it hid @grok again. On @grok's own profile its posts showed with the switch
  off. 9 of 9 checks passed: 8 on the extension and 1 setup check. Version
  0.4.0 replaced that box with @grok's row under [Bots](../README.md#bots).

Muting was tested on 2026-11-06 in two ways.

On real x.com, logged in, the real `lib.js` and `content.js` were injected into
a background tab through the DevTools protocol, as in the extension's own visit
tab, and given a job shaped the way the background worker builds one. The job
muted one listed account in 9.6 s, and X showed "@… has been muted.Undo". A
check job then read 7 rows of `x.com/settings/muted/all`, with the new mute
first. On 3 of 4 profiles, the first post appeared 2 to 3 s before its ⋯
button, so the job waits for the button.

Unmuting was tested the same way on 2026-11-18 (UTC), with the code of commit
d329f56 (0.8.0, not yet released), on the maintainer's own X account. A
stand-in for the worker gave the page an unmute job for one listed account on
that account's muted list, with the account in **Always show**, and said yes
when the page asked to confirm. On the account's profile, X's post menu offered
"Unmute" and no Mute item. The page asked to confirm once and clicked it, and
6.8 s after the job started X showed "@… has been unmuted.", with no Undo and
no confirmation sheet. A check job then read 7 rows of
`x.com/settings/muted/all` without the account. A mute job then muted it again
("@… has been muted.Undo", 6.3 s), so it was unmuted for about 16 s, and a last
check found it on the list. It was second there, under an account muted
between the first two checks (not by this run), although the re-mute was the
newer of the two: a re-mute 16 s after an unmute did not move the account to
the top of the list.

The unpacked extension was run in Chromium 156 (headless, through Playwright)
with x.com answered by a local HTTPS server of fixture pages; Playwright's own
request routing did not reach the tabs the extension opened. The 6 most recent
runs, the last at version 0.3.0, passed 24 of 24 checks:

- With muting off there is no mute alarm and no sightings. Turning it on
  creates a 1-minute alarm; turning it off clears it.
- A listed author hidden in the user's tab is visited first.
- The alarm starts each visit by itself, in a background tab, while the user's
  tab stays active and gets no click.
- A mute waits for a ⋯ button that appears 2.5 s after the post, clicks Mute
  once, keeps X's notice, and closes the tab.
- Visits are 1 to 3 minutes apart.
- An already-muted account and a followed one are recorded without a Mute
  click. @grok and an Always-show account are never visited.
- The check runs when nothing is left to visit, confirms two mutes, and stops
  the day on a third that the fixture muted list leaves out.
- A stopped day opens no tabs.

One run before those 6 failed a check. The likely cause is the test harness,
which changed the worker's stored state outside the worker's own queue; it now
goes through that queue. In an earlier run of the same setup, a visit tab that
never answered was closed after 90 s and recorded as a failed visit.

Version 0.4.0 ran the same way on 2026-11-06 and passed 35 of 35 checks on
each of three runs, the last after the review fixes (each Mute click now waits
for the worker's go-ahead). Besides the muting checks above (now 5 mutes and 7
visits, with the check after the 5th mute), it checked:

- The popup, opened as a page: six bot rows, @grok at **Hide here** and the
  other five at **Show**, and no settings written by opening it. **Save** wrote
  both boxes; a bot in Always show was locked to **Show**; picking **Mute on
  X** for @AskPerplexity saved only that row; ticking the tag box saved it.
- The user's timeline, with the tag box ticked: posts by a listed author and
  by @grok were hidden, and so were a post tagging @grok and one tagging
  @AskPerplexity in their own text. A post quoting a post that tagged @grok,
  the user's own post tagging @grok, and a post tagging @pangramlabs (at
  **Show**) stayed visible. The tab's count had the 2 tag posts apart from the
  2 listed posts.
- With muting on, only the listed author went to the front of the queue, not
  @grok or the taggers. Visits went through the list, then the extra account,
  then @AskPerplexity, each muted with one click. @grok, the bots at **Show**
  or in Always show, the Always-show account and the taggers were never
  visited.

Version 0.4.1 changed the Pangram row from @pangramlabs, which is not an X
account, to @pangram.

Version 0.4.1 also redesigned the popup and added the toolbar icon. On
2026-11-08 the popup page was rendered in Chromium 156 with a stub in place of
the extension APIs, in light and dark, for three states: muting on, a new
install, and muting stopped with a failed refresh. With the folded sections
closed, each was 400 pixels wide and 483 to 595 tall, so none scrolls (a popup
scrolls past 600); opening all three folds makes it scroll again. Before the
change the same states were 1,259 to 1,380 pixels tall. The wiring tests check
what each part of the popup says.

The same day, 0.4.1 ran in the 0.4.0 setup above and passed 40 of 40 checks:
the 35 above, with @pangram in place of @pangramlabs, and 5 on the popup's
folded sections. Both folds started closed and showed their counts ("Show 5 ·
Hide here 1 · Mute on X 0"), the popup was 483 pixels tall, clicking each
summary opened it, and both counts followed **Save** and the bot rows. The
runner's first wait now accepts a bot row hidden in a closed fold. Later on
2026-11-08 the maintainer reloaded 0.4.1 in Brave and reported that the popup
looked right. A bot row set to **Mute on X** has not run in Brave yet.

Version 0.5.0 ran the same way on 2026-11-09 (UTC) and passed 62 of 62 checks.
The local server also answered for the list's host, so the install refresh
read a 3-account fixture list and nothing reached the real one. The checks:

- Labels are off on a new install: the popup said "Off · 0 saved" with Export
  and Delete disabled, and a post page had no Slop / Not slop pair. Once the
  switch was ticked, each reply got a pair, and the post the page is about and
  the post above it, which it replies to, got none. The pair of a reply hidden
  by the list was hidden with it.
- **Slop** saved a record with every documented field and added the account
  to Also hide, which hid the reply at once. **Not slop** added its account to
  Always show. Clicking a pressed button again cleared the label and left the
  box as it was.
- A click sent by the page's own script saved nothing. Enter on a focused
  button saved, with the reply's own text and not the quoted post's. None of
  the pair's click, pointer, mouse or key events reached the page's own
  document or post listeners (a capture-phase listener saw 5 clicks happen),
  and the page did not navigate.
- With hiding paused, the listed reply showed with its pair, and its record
  named the list's host (`clankwall.vogel.dev`) and said `hidden: true`.
- When the page reused a reply's element for another post, as X does when it
  scrolls, the pair moved to the new post, unpressed and not doubled. The home
  timeline, a profile and the post's quotes page had no pairs.
- The popup said "On · 3 saved". **Export** downloaded
  `x-slop-hide-labels-2026-11-09.jsonl`: 3 records, oldest first, each with
  exactly the documented fields. **Delete** asked "Click again to delete 3
  labels"; the second click deleted the 3 labels and the count, left both boxes
  as they were, and the open page dropped its pressed buttons. Unticking the
  switch removed every pair.
- The daily mute setting started at 25. Picking 100 saved it, and the popup
  said why nothing goes above 100 and that the 3 accounts left take 1 day.
- Without the "tabs" permission, the worker listed every tab but saw an
  address and title only for its own popup page, never for the x.com tab. Its
  check for an x.com tab said no with none open, yes with the user's
  `x.com/home` tab open, no when that tab was counted as a visit tab or
  discarded by the browser, and no once it was closed.
- At 100 with no x.com tab of the user's, a tick started no visit. With the
  user's tab open, the 1-minute alarm started a visit 58 s later, in a
  background tab, which clicked Mute once. A due check of the muted list still
  ran with no x.com tab and confirmed that mute.
- At 25, a tick started a visit with no x.com tab open. The visit's own tab did
  not count as the user's: the check said no, and the tab itself answered no.
  That visit waited 20 s for a late ⋯ button and muted the second account.
  Turning muting off cleared the alarm. Nothing threw an uncaught error.

The runner took three shortcuts: it turned muting on by writing the setting to
storage, ran most ticks by calling the function the worker's alarm calls (one
visit started from the real alarm), and skipped the wait between visits
through the worker's queue.

Four earlier runs that day failed. Two could not save the export download,
which was the runner's download folder. One found a defect: the worker refused
**Delete** from the popup page opened in a tab, because it refused every
sender in a tab. It now accepts **Delete** only from a page at the extension's
own address, and a wiring test covers the popup opened in a tab. The fourth
asked for the tab list before any x.com tab was open; that check now runs with
one open.

A fifth run passed, and a review of the branch after it found two more
defects. The worker asked for an x.com tab from inside its own queue, so a tab
that had just loaded, whose answer waits on its own question to the worker,
could not answer within the 1.5 s timeout and counted as no tab; the worker now
asks between two passes of its queue. And the pairs also appeared on the posts
above the page's post and on its quotes, likes and photo pages; they now appear
only below the post, on its own page. Wiring and DOM tests cover both, and the
run above adds a post above the page's post and a quotes page to the fixture.
The first run after those fixes passed all it ran but skipped the
background-tab check, because the visit had ended before the runner read its
tab; the runner now reads the tab while the visit runs and fails if it cannot.

Not tested: real x.com's own handlers (the fixture page has plain listeners),
Brave, whether 50 or 100 mutes a day is safe for an account, and the
userscript, whose missing pair is covered only by the unit tests. Nor whether
x.com keeps its posts in page order, which the check for posts above the
page's post relies on. A post above the page's post that first appears after
x.com has unmounted the page's post (a long chain scrolled far up) gets a pair.

On 2026-11-09, version 0.6.0's export and import page ran in Chromium 156
(headless, through Playwright) with the unpacked extension, the browser's own
downloads and the page's own file input. The real list (772 handles)
downloaded, and x.com was made unresolvable. The profile started with one
account in each box, @grok set to Hide here, and muting on at 50 a day as a
made-up account, with no x.com tab open. All 47 checks passed:

- **Export settings** saved `x-slop-hide-settings-2026-11-09.json` with exactly
  its seven keys. The file held no muting setting, muting handle, list address,
  pause or labels. **Export Also hide as a list** saved one handle per line.
- A shared list with a `#` note line, a blank line, an upper-case handle with
  `@`, a listed account and an Always show account brought up a preview. It
  named each account Also hide would gain, the Always show account that stays
  shown, the account muting runs as and the two accounts muting could newly
  reach. Nothing was stored until **Import these changes**.
- A settings file that also set muting off, a cap of 100, another muting
  account, a list address, pause and labels changed only Also hide, one bot
  choice and the tag setting. The other six stayed as they were, and the
  preview named @AskPerplexity, set to Mute on X, among the new mute targets.
- A shared list of 30 new handles named the first 12, then "and 18 more", in
  the Also hide line and in the muting note, each with **Show all 30
  accounts** under it. The muting note's fold started closed and opened to all
  30; **Cancel** then stored nothing.
- **Cancel**, and a list whose second line had a note after the handle
  ("Not imported: line 2 is not an X handle."), stored nothing.
- With the settings changed after the preview, the first click on **Import
  these changes** showed a new preview with a notice and stored nothing; the
  second stored the new preview.
- Importing the first export into empty settings and exporting again gave the
  same file apart from its date.
- The page made no request outside the extension and logged no error. The
  popup's **Export or import** link, under **Your accounts**, opened the page
  in a new tab.

## Run now in Chromium, without X

On 2026-11-18 the unpacked 0.9.0 ran in headless Chromium 157 (through
Playwright) with x.com and clankwall.vogel.dev resolved to nowhere, so no
request reached X and every visit tab was an error page whose script never
answered. The real background worker and popup ran; storage was seeded with 10
listed accounts and a day already at 25 of 25 mutes.

- The popup offered **Run now** for the 10 accounts waiting. Clicking it stored
  the run in `chrome.storage.session` and opened a visit tab for the first
  account 60 ms later; the open popup switched to **Stop** and showed the new
  visit in today's line without being reopened.
- Closing that tab recorded the account as a failed try ("the tab was closed
  before it finished"), and the next visit started 4.84 s later, from the run's
  own timer rather than the once-a-minute alarm.
- **Stop** removed the run. Closing the visit tab still open then opened
  nothing in the next 8 s, and the next visit was set 148 s away, back at the
  daily pace.
- Writing and removing the run in session storage from the worker's side
  turned the open popup's button to **Stop** and back.

A second run the same day, with 6 accounts waiting, closed nothing by hand, so
each visit waited out the worker's 90 s limit. Visits started 92.2 to 93.3 s
apart. After the fifth, the run stopped muting for the day with "Run now: 5
visits in a row did nothing, the last @listed_4: error (no answer from the tab
in 90 s)", 461 s after the click. Each of the 5 accounts it visited had one
failed try and none was given up on; the sixth was not visited, and nothing
opened in the next 10 s. The open popup showed the stop and hid **Run now**.

## Label Undo in Chromium, without X

On 2026-11-18 the unpacked extension with the 6-second Undo window (its
manifest still says 0.9.0) ran in headless Chromium 157 (through Playwright).
A local server answered for x.com, with a thread of 9 replies, and for the
list's host, with a list of one account, so nothing reached either. Labels
were turned on in storage and every click was a real Playwright click or key
press. 27 of 28 checks passed; the 28th could not run (below).

- **Slop** on a reply hid it before the first paint after the click: the click
  handler finished 3.6 ms after the first click and 0.6 ms after a later one.
  The same account's other reply hid too. The notice at the bottom of the
  window said "Labelled Slop. @xsh_demo_a added to Also hide." with **Undo**.
- Until the 6 seconds ended nothing was stored: no label, nothing in Also hide,
  and the tab's count of hidden accounts was unchanged. Then the record was
  stored with the documented fields, the account was in Also hide, the notice
  closed and the count included the account. A MutationObserver saw the
  reply's hide attribute set once and never removed, so the reply did not show
  for a moment between the click and the stored state.
- **Undo** showed the reply again and the notice said "Undone." with no
  button, then closed by itself. 6.6 s later nothing had been stored.
- With the keyboard, Enter on **Slop** moved focus to **Undo**, and Enter on
  **Undo** showed the reply and put focus back on its **Slop**. When the window
  ended with focus on **Undo**, focus moved to **Slop** on the next reply shown.
  None of the key or click events in the pair or the notice reached the page's
  own document listeners.
- A click was still stored when the tab was reloaded 1 s into its window, and
  when the tab was closed 1 s into it. A page change made the way X makes it
  (`history.pushState`) stored the click at once.
- No request left the two local hosts.

The check that could not run: storing a click when its tab is hidden without
being closed. Headless Chromium kept the tab visible with another tab in
front, with its window minimised and with the page frozen, so that save has
run only in the unit tests.

## Hide as slop icon in Chromium, without X

On 2026-11-18 the unpacked extension with the one-icon label button (its
manifest still says 0.9.0) ran in headless Chromium 157 through Playwright,
against a local server answering for x.com and for the list's host, as in the
run above. The stand-in thread draws a row of action icons under each reply,
laid out the way X lays out its own (four wide items, then two narrow ones) and
styled plainly; one reply has no row. Labels were never switched on: the
settings had no `labeling` key. 30 of 30 checks passed.

- All 9 replies got one button, named "Hide as slop" with no text, and the
  post the page is about got none. On the 8 replies with a row it was the
  row's last child; the reply without one got it on a line of its own.
- On the shown replies the button measured 19 by 20 pixels, level with the
  row's first icon, with a 35 by 36 pixel hit area (its `::before`). It took
  the row's own icon colour: rgb(83, 100, 113) on the light page and
  rgb(113, 118, 123) on the dark one.
- Hovering turned it rgb(244, 33, 46) over a circle of the same red at 10%
  opacity. Tab from Share landed on it and drew a 2-pixel ring of
  rgb(29, 155, 240).
- A click hid the reply and the account's other reply, and the notice said
  "Hid @xsh_demo_a and added it to Also hide." with **Undo**. Once the 6
  seconds ended the label was saved as slop and the account was in Also hide.
- With hiding paused, the labelled reply showed with its icon filled red and
  pressed, the × cut out of it, and a tooltip starting "Labelled slop: click
  to remove the label". Clicking it said "Slop label removed."; when the window
  ended the label was gone, the icon was empty again and Also hide was
  unchanged.
- A label saved as `not_slop` straight into storage, with its account in
  Always show as a Not slop click left it, drew the icon empty. A click on it
  saved slop over it; the reply kept showing, and the notice said "Labelled
  @xsh_demo_d as slop and added it to Also hide. It still shows: it is in
  Always show."
- Turning labels off in storage removed every button.
- No request left the two local hosts.

The Undo run above was repeated on the same build, with its expected notice
changed to the new wording: 27 of 28 passed, and the hidden-tab check again
could not run. The first click's handler finished 7.5 ms after the click and a
later one 0.6 ms after, both before the next paint.

Before the code was written, the icon was injected by hand into one live x.com
thread, in X's dark theme, for a screenshot. That page is where the 8-pixel
margin before the button comes from: X's row has a 4-pixel gap, and Bookmark
and Share sit 12 pixels apart. The code itself on x.com is the next entry.

## Hide as slop icon on x.com

On 2026-11-18 `src/lib.js` and `src/content.js` ran on one live public x.com
thread in Brave on Windows (Chromium 157), in X's dark theme and in English,
injected into the page with a stand-in for the extension's storage: its list
was empty, so nothing hid, and it saved nothing. Nothing was clicked. The
loaded extension's own injection was not part of these runs.

- The icon at the end of each reply's row of action icons, as merged in #60:
  in a first run all 8 replies got it and the post the page is about did not,
  each named "Hide as slop" with no text, 19 by 20 pixels, in the row's grey,
  rgb(113, 118, 123), with no exceptions. A second run measured the row before
  and after the icon went in: on both replies, X's icons moved left by 4 pixels
  (Reply), 11 (Repost), 19 (Like), 27 (Views) and 31 (Bookmark and Share), and
  the icon sat where Share had been. With the extension loaded in Brave, the
  owner saw the icon there on replies, and its place in the row is why it
  moved.
- The icon in each reply's header, as it is now, at 1,024 pixels wide: 3 of 3
  replies got it, first in the group of icons at the top right, just left of
  Grok's and More's, and the post the page is about got none. The space after
  it measured 8.1 pixels, as between Grok and More (8.0): X spaces that group
  with an 8-pixel column gap, so the icon adds no margin of its own there. It
  was level with Grok and More, in More's grey, rgb(113, 118, 123), and clear
  of the date. Grok, More and the 6 icons of each action row moved 0 pixels. A
  click at the icon's centre or right edge would land on it; one in the gap or
  just left of Grok, on Grok.
- The same page at 420 pixels wide: X drew no Grok icon on the replies, and 9
  of 9 got the icon just left of More, 8.1 pixels from it. More and the action
  rows moved 0 pixels between the icons shown and hidden.
- The page loaded at 420 pixels and then widened to 1,024: the 2 replies X
  kept drawn gained Grok, and both icons moved first in the group, 8.1 pixels
  before Grok. A first draft of this placement, which counted the icon among
  X's own nodes, left both between Grok and More in the same run.
- No exceptions, and nothing hid.

## Popup layout in Chromium

On 2026-11-18 `src/popup.html` was opened at 400 pixels wide in headless
Chromium 157, before and after the popup was made shorter, with `popup.js`
running against a stand-in for the extension's storage and tabs (no worker ran
and nothing reached x.com). Each state ran in the light and dark themes. The
figures are from the light theme, counting only text and controls that showed,
with every fold closed. Muting on means 9 mutes today and 759 accounts waiting;
the tab line is "From 5 accounts. 4 on screen now." except in the last row,
where it is "From 9 accounts. Plus 2 posts that tag a bot. 3 on screen now."
across two lines.

| State | Words before | Words after | Pixels tall before | Pixels tall after | Controls in view before | Controls in view after |
|---|---|---|---|---|---|---|
| Muting off, 25 a day | 195 | 116 | 823 | 565 | 5 of 9 | 9 of 9 |
| Muting on, 25 a day | 258 | 161 | 1,033 | 725 | 4 of 10 | 6 of 10 |
| Hiding paused | 193 | 114 | 809 | 552 | 5 of 9 | 9 of 9 |
| A tab that is not x.com | 200 | 121 | 831 | 573 | 4 of 9 | 9 of 9 |
| Muting on, 100 a day | 258 | 170 | 1,033 | 736 | 4 of 10 | 6 of 10 |
| Not x.com, 100 a day | 200 | 130 | 831 | 585 | 4 of 9 | 9 of 9 |
| Muting off, 100 a day, two-line tab line | 202 | 132 | 841 | 596 | 4 of 9 | 9 of 9 |

Controls in view are those showing at open that end inside the first 600
pixels, so they can be used without scrolling. Heights varied by 1 pixel
between runs.

A popup scrolls past 600 pixels. With muting off it now fits in every state
measured; with muting on it still scrolls, by 125 to 136 pixels, because X's
rules warning stays in full there too. In every state, before and after, 9 or
10 controls showed when the popup opened and 21 were one click away, inside a
closed fold; the other 1 or 2 were hidden messages and buttons that the state
did not call for. X's rules warning showed in every state, and no page error
was thrown.

`test/wiring.test.mjs` passed with each of eight faults planted one at a time in
`popup.js` or `popup.html`, and each failed one test: the x.com note never
showing, the note moved back under the row, the note beside the select instead
of under its label, the select not described by the note, the Run now caution
staying when the button hides, the refresh button writing text over its icon,
the totals showing while muting is off, and the Always-show hint moved out of
How muting works.

The store screenshots were then made again with `scripts/store-screenshots.mjs`,
which runs the unpacked extension with its worker against the real list (787
accounts), and the popup in them was looked at by eye.

## In daily use

Since 2026-11-07 (UTC) the extension has run in Brave on Windows, on the
maintainer's own X account, with muting on. These mutes came from the
extension's own background visit tabs on real x.com; the runs above injected
the scripts through the DevTools protocol instead. The counts below were read
from `x.com/settings/muted/all`.

- By 23:22 UTC on 2026-11-07 it had made 25 mutes that UTC day, the daily cap,
  with 0.3.0 and then 0.4.0 after a reload.
- By 00:12 UTC on 2026-11-08, 0.4.0 had made 4 more.

## Not tested

Hiding in Brave (muting has run there, above), a real extension update in the middle of a visit (the closing of the stranded tab has only run against fakes), Tampermonkey, Violentmonkey in
Firefox, the 6-hour refresh actually firing, reposts, and the notifications
page. For the 0.7.0 and 0.7.1 renames: whether a userscript manager updates an
installed 0.6.x or 0.7.0 script in place (the script keeps its `@name` and
`@namespace` for that) and shows the `@name:en` name. For muting: a bot row set to **Mute on X** and accounts from **Also hide
these accounts** on real x.com, more than two days in a row, how X responds to
this pace over weeks, and X in other languages. For unmuting (0.8.0): an
unmute started by the extension's own worker in its visit tab (the run above
used a stand-in for the worker), and whether X ever asks to confirm an unmute
(it did not, once). For Run now (0.9.0): any run on real x.com (it has run
only against the fakes in `test/wiring.test.mjs` and the Chromium run above,
where X could not be reached), so how X responds to visits a few seconds apart,
and how long a run of hundreds of accounts takes, are not known.
For the Hide as slop icon (0.9.0): the loaded extension drawing it in the
header on x.com, in Brave or any browser (the runs above injected its scripts),
X's light and dim themes, a theme switched with a thread open (the icon keeps
the grey it read when placed, as the one in the row did), X in other languages
(Grok's button is found by its shape, not its name), widths other than 1,024
and 420 pixels, how X nests More when it draws no Grok (only where the icon
landed was read), the line of its own under a post without More, and a long
name or handle, which the icon's 27 pixels now cut short sooner. For the shorter popup (0.9.0):
its heights in Brave on Windows, whose system font is not the Linux one
measured above. For the label Undo window: the save when a tab is
hidden without being closed, in a real browser (see above), and any of it on
real x.com or in Brave. For export and import: Brave
and branded Chrome, a file picked from a desktop file dialog (the run above set
the file input directly), and whether a file picker opened from the popup
would close it, which is why import has a page of its own.
