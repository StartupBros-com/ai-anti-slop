# Privacy policy

AI Anti-Slop (formerly Human Replies Only and x-slop-hide) hides posts on x.com
by accounts on a public list of AI-reply spam accounts. The browser extension
can also mute those accounts on X, and can save labels you give to posts.
This policy covers the extension and the userscript, version 0.9.0 and the
changes after it on the main branch, which add the choice of lists, the
Recommended list and sharing labels. Last updated 2026-11-21.

## In short

- AI Anti-Slop has no account, no analytics and no telemetry. Its developers
  receive data only if you turn on **Share your labels** on the settings page,
  which is off unless you turn it on: then reports of your labels, which never
  hold a post's words, go to AI Anti-Slop's server (see
  [Sharing labels](#sharing-labels)). Version 0.9.0 and earlier cannot share.
- The extension's own code makes two kinds of network request. It downloads
  the lists you have switched on, without cookies: clankwall's lists from
  `clankwall.vogel.dev`, levelsio's lists from `blockedforaireply.levels.io`,
  the Recommended list (on unless you switch it off), which is made from one
  file at each of those two hosts and the readers' list from
  `ai-anti-slop.startupbros.com`, and any list you add yourself from the
  address you give. Only while sharing is on, it also sends your labels'
  reports to `ai-anti-slop.startupbros.com`.
- Everything it keeps is in your browser profile's extension storage, on your
  computer.
- If you turn muting on (it is off by default), the extension opens x.com pages
  in background tabs with your x.com login and clicks X's own Mute item. X sees
  those visits and mutes as your activity.
- Labels leave your browser as a file when you click **Export labels**, and,
  only while sharing is on, as reports without the post's words.
  Your account lists and bot choices leave it only as a file, when you click
  **Export settings** or **Export list** (Also hide as a list).

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

None of this is sent anywhere, except the parts of a label that sharing
sends while it is on ([Sharing labels](#sharing-labels)). What is kept is
listed below.

## What it stores

The extension stores data in `chrome.storage.local` for this browser profile. Chrome
Sync does not copy it to other devices.

| Storage key | What it holds | When |
|---|---|---|
| `xsh:list` | clankwall's AI flags list: its handles, when it was fetched and last tried, the address it was fetched from, and the last error, if any. | Once that list has been fetched. It is on unless you switch it off. |
| `xsh:list:<id>` | The same for each other list: the Recommended list (`xsh:list:recommended`, which also keeps the handles from each of its three files apart, under the file's address), clankwall's All flags list (`xsh:list:clankwall-all`), levelsio's list (`xsh:list:levelsio`) and each list you add. | Once that list has been switched on and fetched. The Recommended list is on unless you switch it off. A list you remove has its key removed. |
| `xsh:settings` | Your settings: paused or not, your **Always show** and **Also hide** accounts, your choice for each bot, whether to hide posts that tag a bot, muting on or off, the daily mute cap, labels on or off, which built-in lists are switched on, the address of each list you add and whether it is on, and an optional address for the AI flags list (no page has a setting for it; it is empty unless set by hand). While muting is on, also the x.com handle muting runs as. | Always; the muting handle only while muting is on. Turning muting off removes it. |
| `xsh:mutes` | The muting record. For each account muted or tried: the outcome, the time, the handle it was muted as, X's notice text (up to 120 characters), the reason it failed (up to 200 characters), whether a later check found it on your muted list and when that check ran, and the number of attempts; once it is unmuted or tried for that, when it was muted and the number of unmute attempts. The accounts muted since the last check of your muted list. For each UTC day: the number of mutes, unmutes and visits, and why muting stopped, which can name an account and the handle you were logged in as. Up to 50 accounts muting may visit whose posts were hidden on your screen, to be muted first. The time of the next visit. | Only once you turn muting on. |
| `xsh:visit` | While a mute, unmute or check visit runs: the ids of the background tab the extension opened for it and of that tab's window, and the time the visit started. | Removed when the visit ends or is dropped, and at browser start. After an extension update it is used once to close that tab, if the visit is under 90 seconds old and the tab is still in that window and not the tab you are looking at, then removed. |
| `xsh:label:<post id>` | One saved label: the time, the label, the author's handle, the post's address, up to 1,000 characters of the post's own text, the address of the post page you labelled it on (none when it was another page, such as the home timeline), whether the author was on a list that was switched on (the list's host, and, when a list other than clankwall's AI flags was on, which of those lists held the author), in **Also hide** or in **Always show**, and whether the post was hidden. At most 2,000 labels. | Only when labels are on and you click **Hide as slop** on a post. Labels are on unless you turn them off; nothing is saved until you click. |
| `xsh:labelCount` | The number of saved labels. | Same as above. |
| `xsh:share` | Sharing's record: whether sharing is on, the random code made for this browser when sharing is first turned on, the reports and retractions waiting to be sent (each the label, the author's handle, the post's id, the id of the post page it was labelled on and the hash of its words; at most 4,000), how many reports were sent, when a send last went through, the last error and when sending tries again. | Once you turn sharing on. Turning it off empties what is waiting and keeps the code; **Delete what I shared** removes the code once the server confirms the delete. |

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

- The Recommended list is on unless you switch it off (0.9.0 and earlier do
  not have it). Each download fetches three files:
  `https://clankwall.vogel.dev/api/usernames.txt`,
  `https://blockedforaireply.levels.io/api/accounts.ndjson` (about 1 MB on
  2026-11-21) and `https://ai-anti-slop.startupbros.com/v1/list.ndjson`, the
  readers' list (see [Sharing labels](#sharing-labels)). From each row of
  levelsio's file it reads the handle, the `levelsio` field and whether the
  row lists any evidence, and keeps only the handles of accounts marked
  `confirmed` with evidence. From the readers' list it keeps only the handles.
  Nothing else in either file is kept. The readers' list is downloaded whether
  or not you share, and AI Anti-Slop's server keeps nothing about a download.
- clankwall's AI flags list, `https://clankwall.vogel.dev/api/usernames.txt`,
  is on unless you switch it off, and stays on while muting is on.
- clankwall's All flags list, `https://clankwall.vogel.dev/api/accounts.ndjson`,
  is off unless you switch it on.
- levelsio's Blocked for AI reply list,
  `https://blockedforaireply.levels.io/api/usernames.txt`, is off unless you
  switch it on (0.9.0 and earlier do not have it).
- A list you add on the settings page is downloaded from the address you typed.

Each list download carries no cookies, no identifiers and no body. Like any
web request, it reaches that server with your IP address and your browser's
standard request headers. Adding a list sends nothing anywhere until that
download.

If an address for the AI flags list was set by hand in `xsh:settings`, that
list is downloaded from that address instead, the same way; the Recommended
list still fetches clankwall's own address. clankwall and levelsio's site are
run by third parties, not by AI Anti-Slop's developers; see each site for how
it handles requests. So is any list you add, and the extension cannot know what
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

**Sharing labels, only if you turn it on.** See
[Sharing labels](#sharing-labels).

**Export labels** saves your labels as a `.jsonl` file through your browser's
download. Nothing is uploaded.

**Export settings** saves your **Always show** and **Also hide** accounts, your
choice for each bot and whether to hide posts that tag a bot, as a `.json` file
through your browser's download. **Export list** saves the
**Also hide** accounts alone as a `.txt` file. Neither file holds muting on or
off, the daily mute cap, the X handle muting runs as, which lists are switched
on, the addresses of lists you added, pause or labels. **Import a file** reads only the file you pick, inside the extension's own
page, and changes those same settings only after you confirm what it shows.
Nothing is uploaded or fetched.

**Links in the popup** (X's muted-words settings, an account's profile, this
project's page) open only when you click them.

**Report a problem or suggest something**, in the popup and on the settings
page, opens GitHub's new-issue page in a new tab when you click it. Its address
holds the extension's version and your browser's name, major version and
system, such as `Brave 158 on Windows`, so the click sends GitHub those two
along with whatever your browser sends with any visit to GitHub. They fill two
fields of the **Report a problem** form, which you can change or clear. Nothing
else from the extension is in the address, and a report reaches GitHub only if
you submit it there. Version 0.9.0 and earlier have no such link.

Nothing else is collected or sent. There is no analytics, no crash reporting and
no remotely hosted code.

## Sharing labels

Sharing is in the extension only, in the changes after 0.9.0; the userscript
has no labels. It is off unless you turn it on under **Share your labels** on
the settings page, which lists what is sent before the button. The popup says
whether it is on.

**What is sent.** While sharing is on, each label you save is sent as a report
of five fields:

- the label: `slop`, or `not_slop` for a label saved before 0.9.0;
- the author's handle;
- the post's id, the number at the end of its address;
- the id of the post whose page you labelled it on, which tells the server
  which post page you were reading; none when you labelled it on another page,
  such as the home timeline, and the server then counts the post as its own
  thread;
- a hash of the post's words: the first 16 hexadecimal characters of the
  SHA-256 of the text, put in lower case, with links, @handles and extra spaces
  taken out. The same words give the same hash, so copies of one reply can be
  matched without their words; the server keeps it for that, and its listing
  rule does not use it today. A hash cannot be turned back into the words,
  but someone who guesses a short or common reply can check the guess against
  it.

With them goes a random code, 32 hexadecimal characters made in your browser
when you first turn sharing on, so that your reports count as one reader's and
can be deleted together. The code is not your X handle and is made without it.
A report can still point to you: labelling replies under a post of your own
sends that post's id as the page you were on, and the post pages you label on
say which threads you read.

**What is never sent:** the post's words, its address or the page's address
(beyond the two ids), your X handle, the label's other fields (which lists or
boxes had the account, whether it was hidden), your settings, your lists and
the muting record.

**When.** A label is sent about 30 seconds or more after it is saved, so labels
made close together go in one request of up to 50. When you turn sharing on,
the labels already saved are sent too only if you tick **Also share the N
labels already saved**. While sharing is on, clearing a label sends a
retraction for its post, and **Delete all labels** sends one for every label.
With sharing off neither does, so a report already sent stays until it is 90
days old or you click **Delete what I shared**. A request goes to
`https://ai-anti-slop.startupbros.com/v1/reports` (`/v1/retract` for a
retraction), as plain text with no cookies. If the server cannot be reached,
the request is tried again 30 minutes later; if it asks to wait, as it does
past a browser's 100 reports in a UTC day, it is tried again at the time it
gives, at most 26 hours later.

**The server.** `ai-anti-slop.startupbros.com` is AI Anti-Slop's own server, a
Cloudflare Worker with a Cloudflare D1 database; its code is in this
repository's `server/` folder. Cloudflare runs the machines, so each request
reaches Cloudflare with your IP address and your browser's standard headers;
see Cloudflare's privacy policy for what it does with them. The Worker keeps:

- each report's five fields, the hour it arrived (not the minute), a keyed hash
  (HMAC) of your browser's code and a keyed hash of the first part of your IP
  address (the first three numbers of an IPv4 address, the first three groups
  of an IPv6 one), so that one network cannot count as many readers;
- the hour it first heard from your browser's code, under the same keyed hash,
  deleted once none of its reports are left and that hour is more than 90 days
  ago;
- per keyed hash of your browser's code, how many reports arrived each UTC
  day; per keyed hash of your network, how many new browser codes and removal
  requests arrived each UTC day; and how many reports all browsers sent each
  UTC day. These counts are deleted after three days.

It never stores the code itself, your IP address, your browser's headers or a
request's body as sent. Its request logs (Workers Logs) are off. A report is
deleted 90 days after it arrives.

**What is published.** The readers' list at
`https://ai-anti-slop.startupbros.com/v1/list.ndjson`: each listed account's
handle, how many browsers reported it and the day it was first listed; at
`/v1/changes`, which accounts each rebuild added or removed; and at
`/v1/status`, the number of listed accounts and of browser codes it keeps,
with the time of the last build. An account is listed once three or more
browsers on two or more networks have reported it as slop in two or more
threads, and at least three times as many browsers reported it as slop as
reported it as not slop, counting, for slop and not slop alike, only reports a
day old or more from browsers the server first heard from a week or more
before. Reports are not checked against anything, so a list entry means
browsers agreed, not that the account posts AI replies. The page at
`https://ai-anti-slop.startupbros.com/` states the rule. No report, code or
network appears in anything published. AI Anti-Slop's operator can read, with
a token, the accounts near the bar with their counts, and can add an account to
the list or take one off by hand; a rebuild's additions and removals are
public either way.

**Removal requests.** The readers' list page has a form for asking that an
account be taken off. A request keeps the handle, the reason and contact you
type (both optional), the hour and a keyed hash of your network, for the
operator to read. Once the operator has closed it, it is deleted 90 days after
it arrived; until then it is kept. It is sent from that web page, never by the
extension.

**Turning it off and deleting.** **Turn off sharing** stops sending and drops
what is waiting; what was sent stays on the server until it is 90 days old or
you delete it. **Delete what I shared** turns sharing off, asks the server to
delete every report from your browser's code, the hour it first heard from it
and its daily counts, and then deletes the code from your browser. If the
server does not confirm, the code is kept so you can try again. Turning
sharing on again makes a new code, which counts as a new reader.

## Other people's posts

Labels keep the text of posts written by other people, so you can review or
share your own record of what you marked. Sharing never sends that text. It
stays in your browser profile until you delete its label (pause hiding, then click the post's
filled **Hide as slop** button), click
**Delete all labels** (it asks for a second click), or remove the extension. A
file you exported stays where you saved it.

## Selling and sharing

AI Anti-Slop does not sell or transfer user data. Its developers receive only
the reports sharing sends, which you turn on, and use them only to build the
readers' list; what is published from them is the list of accounts with their
counts. The use of information received from the extension's handling of
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
- **Turn off sharing** stops sending and drops what is waiting. **Delete what
  I shared** deletes, on the server, every report from this browser, then the
  browser's code. While sharing is on, clearing one label takes its report
  back.
- Removing the extension deletes everything it stored in the browser. It does
  not delete reports already shared; use **Delete what I shared** first.

## Changes and contact

This policy lives in the project's repository, and every change to it is in the
repository's history. Questions and requests go to
[GitHub issues](https://github.com/StartupBros-com/ai-anti-slop/issues/new/choose).
