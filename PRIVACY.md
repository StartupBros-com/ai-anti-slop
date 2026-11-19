# Privacy policy

AI Anti-Slop (formerly Human Replies Only and x-slop-hide) hides posts on x.com
by accounts on a public list of AI-reply spam accounts. The browser extension
can also mute those accounts on X, and can save labels you give to posts.
This policy covers the extension and the userscript, version 0.9.0 and the
changes after it on the main branch, which add the choice of lists. Last
updated 2026-11-19.

## In short

- AI Anti-Slop has no account, no server, no analytics and no telemetry. Its
  developers receive none of the data described here.
- The extension's own code makes one kind of network request: it downloads the
  lists you have switched on, without cookies. These are clankwall's lists from
  `clankwall.vogel.dev`, levelsio's list from `blockedforaireply.levels.io`,
  and any list you add yourself from the address you give.
- Everything it keeps is in your browser profile's extension storage, on your
  computer.
- If you turn muting on (it is off by default), the extension opens x.com pages
  in background tabs with your x.com login and clicks X's own Mute item. X sees
  those visits and mutes as your activity.
- Labels leave your browser only as a file, when you click **Export labels**.
  Your account lists and bot choices leave it only as a file, when you click
  **Export settings** or **Export Also hide as a list**.

## What it reads on x.com

On x.com and twitter.com pages (and their `mobile.` hosts) the extension reads,
in the page:

- the author's handle on each post, to decide whether to hide it;
- your own handle, from X's profile link in the navigation bar, so that hiding
  posts which tag a hidden bot never hides your own posts, and so that muting
  runs only as the account you turned it on from;
- with hiding posts that tag a bot turned on, the @-links in each post's own
  text, to see whether it tags a bot set to Hide or Mute;
- with labels on (they are unless you turn them off), the text of a post
  when you click **Hide as slop** on it.

None of this is sent anywhere. What is kept is listed below.

## What it stores

The extension stores data in `chrome.storage.local` for this browser profile. Chrome
Sync does not copy it to other devices.

| Storage key | What it holds | When |
|---|---|---|
| `xsh:list` | clankwall's AI flags list: its handles, when it was fetched and last tried, the address it was fetched from, and the last error, if any. | Once that list has been fetched. It is on unless you switch it off. |
| `xsh:list:<id>` | The same for each other list: clankwall's All flags list (`xsh:list:clankwall-all`), levelsio's list (`xsh:list:levelsio`) and each list you add. | Once that list has been switched on and fetched. A list you remove has its key removed. |
| `xsh:settings` | Your settings: paused or not, your **Always show** and **Also hide** accounts, your choice for each bot, whether to hide posts that tag a bot, muting on or off, the daily mute cap, labels on or off, which of clankwall's lists are switched on, the address of each list you add and whether it is on, and an optional address for the AI flags list (no page has a setting for it; it is empty unless set by hand). While muting is on, also the x.com handle muting runs as. | Always; the muting handle only while muting is on. Turning muting off removes it. |
| `xsh:mutes` | The muting record. For each account muted or tried: the outcome, the time, the handle it was muted as, X's notice text (up to 120 characters), the reason it failed (up to 200 characters), whether a later check found it on your muted list and when that check ran, and the number of attempts; once it is unmuted or tried for that, when it was muted and the number of unmute attempts. The accounts muted since the last check of your muted list. For each UTC day: the number of mutes, unmutes and visits, and why muting stopped, which can name an account and the handle you were logged in as. Up to 50 accounts muting may visit whose posts were hidden on your screen, to be muted first. The time of the next visit. | Only once you turn muting on. |
| `xsh:visit` | While a mute, unmute or check visit runs: the ids of the background tab the extension opened for it and of that tab's window, and the time the visit started. | Removed when the visit ends or is dropped, and at browser start. After an extension update it is used once to close that tab, if the visit is under 90 seconds old and the tab is still in that window and not the tab you are looking at, then removed. |
| `xsh:label:<post id>` | One saved label: the time, the label, the author's handle, the post's address, up to 1,000 characters of the post's own text, the address of the post page you labelled it on (none when it was another page, such as the home timeline), whether the author was on a list that was switched on (the list's host, and, when a list other than clankwall's AI flags was on, which of those lists held the author), in **Also hide** or in **Always show**, and whether the post was hidden. At most 2,000 labels. | Only when labels are on and you click **Hide as slop** on a post. Labels are on unless you turn them off; nothing is saved until you click. |
| `xsh:labelCount` | The number of saved labels. | Same as above. |

While a mute visit is running, the extension also keeps, in `chrome.storage.session`,
the account being visited, the handle muting runs as, and the id of the tab it
opened (`xsh:job`), plus the ids of tabs it opened for visits that are still open
(`xsh:jobTabs`). While a **Run now** is going, it keeps there the time the run
started, the handle muting runs as and how many visits in a row did nothing
(`xsh:run`). Chrome clears session
storage when the browser closes and when the extension is reloaded or updated,
which ends a run.

The userscript stores only clankwall's lists and your settings, in your
userscript manager's storage. It does not mute, has no labels and cannot add
other lists.

## What it sends, and where

**The lists.** The extension downloads each list that is switched on. It does
so when the extension is installed, at browser start when a refresh is due,
every 6 hours, when you click **Refresh list now** in the popup, when you add
a list, and when you switch one on that has no stored copy or one 6 hours old
or more, unless its last try failed less than 30 minutes ago. A list that is
off is not downloaded.

- clankwall's AI flags list, `https://clankwall.vogel.dev/api/usernames.txt`,
  is on unless you switch it off, and stays on while muting is on.
- clankwall's All flags list, `https://clankwall.vogel.dev/api/accounts.ndjson`,
  is off unless you switch it on.
- levelsio's Blocked for AI reply list,
  `https://blockedforaireply.levels.io/api/usernames.txt`, is off unless you
  switch it on (0.9.0 and earlier do not have it).
- A list you add on the settings page is downloaded from the address you typed.

Each request carries no cookies, no identifiers and no body. Like any web
request, it reaches that server with your IP address and your browser's
standard request headers. Adding a list sends nothing anywhere until that
download.

If an address for the AI flags list was set by hand in `xsh:settings`, that
list is downloaded from that address instead, the same way. clankwall is run by
a third party, not by AI Anti-Slop's developers; see its site for how it
handles requests. So is any list you add, and the extension cannot know what
its host does with a request.

The userscript downloads clankwall's lists the same way through your userscript
manager, marked anonymous so no cookies are sent.

**Muting, only if you turn it on.** The extension opens two kinds of x.com page
in background tabs: the profile of a listed account (`https://x.com/<handle>`),
where it clicks X's own Mute menu item, and your muted-accounts page
(`https://x.com/settings/muted/all`), which it reads to check earlier mutes. Your
browser loads these pages with your x.com login, the same as if you opened them,
so X receives the visits and the mutes as your activity. The extension sends
nothing else to X. At a daily cap of 50 or 100, before a visit outside
**Run now** once the day has had 25 mutes and unmutes or 50 visits (in 0.9.0
and earlier, before every visit outside **Run now**), it asks your open tabs
whether one of them is an x.com tab. It uses only each tab's id and whether
the browser has unloaded it; it does not read tab addresses or titles.

A slop label, made with **Hide as slop**, adds the account to **Also hide**.
Versions before 0.9.0 also had **Not slop**, which added it to **Always
show**. With muting on, an account in **Also hide** can be visited
and muted like a listed one.

**Export labels** saves your labels as a `.jsonl` file through your browser's
download. Nothing is uploaded.

**Export settings** saves your **Always show** and **Also hide** accounts, your
choice for each bot and whether to hide posts that tag a bot, as a `.json` file
through your browser's download. **Export Also hide as a list** saves the
**Also hide** accounts alone as a `.txt` file. Neither file holds muting on or
off, the daily mute cap, the X handle muting runs as, which lists are switched
on, the addresses of lists you added, pause or labels. **Import** reads only the file you pick, inside the extension's own
page, and changes those same settings only after you confirm what it shows.
Nothing is uploaded or fetched.

**Links in the popup** (X's muted-words settings, an account's profile, this
project's page) open only when you click them.

Nothing else is collected or sent. There is no analytics, no crash reporting and
no remotely hosted code.

## Other people's posts

Labels keep the text of posts written by other people, so you can review or
share your own record of what you marked. That text stays in your browser
profile until you delete its label (pause hiding, then click the post's
filled **Hide as slop** button), click
**Delete all labels** (it asks for a second click), or remove the extension. A
file you exported stays where you saved it.

## Selling and sharing

AI Anti-Slop does not sell, transfer or share user data. Its developers do not
receive any. The use of information received from the extension's handling of
user data complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies),
including the Limited Use requirements.

## Your controls

- **Pause hiding** shows every post again, on every tab. It does not stop
  muting.
- Turning muting off stops visits, mutes and unmutes, and removes the handle
  muting ran as from your settings. It keeps the muting record (`xsh:mutes`),
  which names that handle on each mute it made, until you remove the extension.
  Mutes already made stay on your X account; undo them at
  `https://x.com/settings/muted/all`.
- Turning labels off removes the buttons. Clicking a post's filled **Hide as
  slop** button deletes that one label. **Delete all labels** deletes every saved label and
  the label count. Accounts a label added to **Also hide** or
  **Always show** stay there; remove them in the popup.
- Removing the extension deletes everything it stored in the browser.

## Changes and contact

This policy lives in the project's repository, and every change to it is in the
repository's history. Questions and requests go to
[GitHub issues](https://github.com/StartupBros-com/ai-anti-slop/issues).
