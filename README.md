![AI Anti-Slop: hide, don't block. The same reply thread twice: on x.com with the posts by listed accounts marked, and with AI Anti-Slop, where those posts are gone.](gh_og_share_image.png)

# AI Anti-Slop

Formerly Human Replies Only (0.7.0) and x-slop-hide (0.6.2 and earlier). Links
to both old repositories redirect here.

AI Anti-Slop hides posts on x.com whose author is on
[clankwall](https://clankwall.vogel.dev/)'s public list of AI-reply spam
accounts (in the extension, also on @levelsio's list of accounts it marks
confirmed), and can also mute the accounts on clankwall's list on
your X account. You can add
accounts of your own, choose Show, Hide or Mute for each of six answer bots
such as @grok and @AskPerplexity, and hide posts that tag one of those bots.
In the extension, a button on each post [hides it as slop](#labels) and adds
its account to your own Also hide list; if you turn on
[sharing](#sharing-labels), those labels help build the readers' list, one of
Recommended's sources.

Hiding works on the page in your desktop browser, in this browser profile
only, and the Pause switch shows the posts again. Muting is off until you turn
it on in the extension's popup. It then mutes up to 25 accounts a day (or 50 or
100, whose mutes past 25 run only while you have x.com open), or every account waiting when
you press **Run now**, by clicking X's own Mute on x.com, so the mutes apply in
the X app too. It unmutes an account it muted
once the account leaves the list. It never blocks anyone and does not use the
X API. It is free and MIT-licensed.

Muting is automation of the X website, which X's rules say "may result in the
permanent suspension of your account". Read [Muting](#muting) before you turn
it on.

AI Anti-Slop is open source. To report a problem or suggest something,
[open an issue](https://github.com/StartupBros-com/ai-anti-slop/issues/new/choose);
to help build it, see [Contributing](#contributing).

The list is read from `https://clankwall.vogel.dev/api/usernames.txt`, the
"Plain text" link under clankwall's "AI flags" heading. It held 369 handles on
2026-11-03, 767 on 2026-11-06, 773 on 2026-11-08 and 787 on 2026-11-19. In the
extension the list that starts on is **Recommended**: that list plus the
accounts levelsio's list marks confirmed, 1,306 accounts on 2026-11-21 and
2,270 on 2026-11-24, plus the readers' list, which AI Anti-Slop builds from the labels readers
share and which starts empty.
You can also switch on clankwall's wider "All flags" list (2,811
accounts on 2026-11-19, AI and spam), the whole of levelsio's "Blocked for AI reply" list
(3,734 accounts on 2026-11-19), or add a list of handles by its address;
see [Lists](#lists). Muting uses the AI flags list alone. Of these lists
AI Anti-Slop runs only the readers' list; see
[Whose list is it?](#whose-list-is-it).

To install, open the
[userscript](https://raw.githubusercontent.com/StartupBros-com/ai-anti-slop/main/dist/x-slop-hide.user.js)
in a userscript manager (tested with Violentmonkey; Tampermonkey is untested),
or load the Chrome extension unpacked. Both are under [Install](#install). Only
the extension mutes; the userscript hides.

## On a real thread

On 2026-11-03, on a reply thread with 251 replies, AI Anti-Slop hid 12 of the
118 distinct posts that loaded. All 12 were by listed authors, and no post by a
listed author was left showing. [docs/TESTING.md](docs/TESTING.md) has the
method and three more pages.

## Hide, mute or block

Hiding acts only on the page in your browser. The extension's muting, and X's
own Mute and Block, act on your X account.

| | Hiding | Muting with AI Anti-Slop | Mute on X | Block on X |
|---|---|---|---|---|
| Changes your X account | No | Yes: it is X's Mute | Yes | Yes |
| Applies in the X app | No | Yes | Yes | Yes |
| Covering a list of hundreds | Install once; the list refreshes itself | 25 accounts a day by default, so the 773 listed on 2026-11-08 take about a month; 8 days at 100 a day; **Run now** visits them one after another, with no daily number | Mute each account from its post or profile | Block each account from its post or profile |
| The account can find out | No | No, as with Mute on X | No: "Muted accounts will not know that you've muted them" | Yes: if it visits your profile, "they will see they have been blocked" |
| Undo | Pause, or add the handle to Always show | Add the handle to Always show while muting is on, or unmute it on X; an account that leaves the list is unmuted by itself | Unmute each account | Unblock each account |

The Mute and Block columns come from X's help pages on
[muting](https://help.x.com/en/using-x/x-mute) and
[blocking](https://help.x.com/en/using-x/blocking-and-unblocking-accounts),
read on 2026-11-06. Hiding cannot reach the X app on your phone; muting can,
because the mutes are X's own.

## Install

### Extension (Chrome or another Chromium browser, desktop)

Install it from the Chrome Web Store:
<https://chromewebstore.google.com/detail/apchbmongdogokfagedphbkempkhccha>.
The store updates it by itself.

Then open x.com and click the extension's icon: a red square with a
crossed-out speech bubble. If it is not on the toolbar, open the puzzle-piece
**Extensions** button and click the pin next to AI Anti-Slop. The popup shows
how many accounts are listed and when the list was last updated.

#### Unpacked

To run the code on `main`, which can be ahead of the store copy, or a release
from GitHub instead of the store, load the extension unpacked:

1. Download the `.zip` from the
   [latest release](https://github.com/StartupBros-com/ai-anti-slop/releases/latest)
   and unzip it. Or `git clone https://github.com/StartupBros-com/ai-anti-slop`
   for the code on `main`.
2. Open `chrome://extensions` (`brave://extensions` in Brave) and turn on
   **Developer mode**.
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Open x.com and click the extension's icon, as above.

An unpacked extension does not update itself. To get a new version, copy its
files into the folder you loaded before, replacing the old ones (or `git pull`
in a clone), then click the reload arrow on the extension's card. Your
settings, lists and mute record stay. The browser keys an unpacked extension's
storage to its folder, so loading a new version from a different folder adds a
second copy that has none of them, and leaves both running. That holds across
the renames too: copy the new version into the folder you loaded x-slop-hide or
Human Replies Only from. The list
itself refreshes without any of this: on install, on browser start when it is due,
and every 6 hours.

#### Moving from an unpacked copy to the store copy

The [store copy](https://chromewebstore.google.com/detail/apchbmongdogokfagedphbkempkhccha)
is a different extension to the browser, with its own id and its own storage,
so nothing carries over from an unpacked copy: not your settings, your
**Always show** and **Also hide** boxes, the mute record or your labels. Both
copies run until you remove one, and with muting on in both, both mute. To
switch:

1. In the unpacked copy's popup, open **Your accounts**, click **Export or
   import**, then **Export settings** (0.6.0 or later; in an older copy, copy
   the two boxes somewhere instead). Click **Export labels** too if you keep
   labels. There is no label import, so that file is your record of them, not
   a way to move them.
2. Remove the unpacked copy in `chrome://extensions`. This deletes its labels.
3. Install the store copy and import the settings file the same way (see
   [Export and import](#export-and-import)). Then set **Mutes a day** and, if
   you used it, muting again: a settings file carries neither.

The store copy starts a new mute record. Accounts the unpacked copy already
muted are visited again and found already muted, without a click, so the
store copy never unmutes them, even if they leave the list. Each of
those visits counts against the day's visit cap (twice your **Mutes a day**),
so with a long list it can take several days to reach accounts that are not
muted yet. Mutes already made stay on your X account either way.

### Userscript (Violentmonkey or Tampermonkey)

Install a userscript manager (the script was tested in Violentmonkey 2.50.0;
Tampermonkey is untested), then open
<https://raw.githubusercontent.com/StartupBros-com/ai-anti-slop/main/dist/x-slop-hide.user.js>.
The manager offers to install it. Inside the manager the script keeps its old
name, x-slop-hide, and its old namespace: managers know a script by those two,
and a renamed script can install as a second copy instead of updating. In Chrome and other Chromium browsers, the
manager also needs **Allow User Scripts** turned on under **Details** on its
card in `chrome://extensions`; it is off in a new profile.

The manager checks that URL for updates and installs one when its version
number goes up. The script fetches the list when an x.com page opens and the
stored copy is more than 6 hours old, and checks again every 15 minutes and
whenever the tab comes back into view. The userscript does not mute.

## Controls

| To | In the extension popup | In the userscript menu |
|---|---|---|
| Show everything for a while | Tick **Pause hiding** | **Pause / resume hiding** |
| Always see an account | Under **Your accounts**, add its handle to **Always show these accounts**, then click **Save** | **Edit always-show list** |
| Hide an account that is not on the list | Under **Your accounts**, add its handle to **Also hide these accounts, and mute them when muting is on**, then click **Save** | **Edit extra accounts to hide** |
| Show, hide or mute an answer bot | Pick **Show**, **Hide here** or **Mute on X** in its row under **Bots like @grok** (see [Bots](#bots)) | **Show / hide @grok**, or **Show or hide a bot** for any of the six; there is no Mute |
| Hide posts that tag a bot | Under **Bots like @grok**, tick **Also hide posts that tag a bot set to Hide or Mute** | **Hide / show posts that tag a hidden bot** |
| Fetch the list now | The circular arrow beside the list's count (**Refresh list now**), which fetches every list that is on | **Refresh list now** |
| Choose lists, or add one | **Choose lists**, under the list's count, opens the settings page (see [Lists](#lists)) | **Hide every account clankwall flagged / AI flags only**; no lists of your own |
| Mute listed accounts on your X account | Tick **Mute listed accounts on X** (see [Muting](#muting)) | Not available |
| Mute more accounts a day | Pick 50 or 100 under **Mutes a day** (see [How many a day](#how-many-a-day)) | Not available |
| Mute every account waiting now | **Run now**, under the muting switch (see [Run now](#run-now)) | Not available |
| Hide a post as slop | Click **Hide as slop**, the speech bubble with an × at the post's top right, just left of Grok's icon and ⋯, on the home timeline or any other page of posts. It is there unless you untick **Show a Hide as slop button on posts on x.com** under **Label posts** (see [Labels](#labels)) | Not available |
| Back up or move your settings | Under **Your accounts**, click **Export or import**, then **Export settings**; import the file on the same page (see [Export and import](#export-and-import)) | Not available |
| Share Also hide, or add a list someone shared | Under **Your accounts**, click **Export or import**, then **Export list** under **Also hide as a list**, or pick their file with **Choose a file…** under **Import a file** | Not available |

**Bots like @grok**, **Your accounts** and **Label posts** start folded;
click a heading to open it. A folded heading shows its counts on the same line,
such as "Show 5 · Hide 1 · Mute 0", "Always show 2 · Also hide 0" or "On · 12
saved". **How muting works**, under the muting switch, folds the same way and
holds what muting does in detail, why no number goes above 100, and the totals
so far.

**Save** saves both boxes at once. On an x.com tab, the popup opens with the
count of what it hid there, "N posts hidden on this tab", and under it "From M
accounts." It adds "Plus N posts that tag a bot." when tag hiding hid any, then
"K on screen now.", which counts both. When tag hiding hid posts and the list
hid none, the count is of those posts, with "Each one tags a bot. K on screen
now." On a tab it cannot count, another site
or an x.com tab opened before the extension was installed or reloaded, it says
"Open x.com in this tab to see what was hidden. If it is already open, reload
the tab." While hiding is paused, an x.com tab says "Hiding is paused". The
userscript has no counter.

## What gets hidden

- A post is hidden when its own author is on a list you have switched on (see
  [Lists](#lists)) or in **Also hide these accounts**. The author is read from the post's name block,
  case-insensitively.
- A post that quotes a listed account, or @-mentions one, stays visible. Only
  the author counts, except for the bot tags described under [Bots](#bots).
- A repost carries the original author's name block, so it should be judged by
  the original author and hidden when that author is listed. This has not been
  checked against a live repost yet.
- On any page under a listed account's handle (its profile `/handle`,
  `/handle/with_replies`, one of its posts `/handle/status/...`, and so on),
  that account's posts stay visible, since you went there on purpose. Other
  listed accounts replying there are still hidden.
- Handles in **Always show these accounts** are never hidden, and
  **Pause hiding** shows every post until you untick it.
- In the extension, a post hidden because its author is on a list that is on
  leaves a one-line note in its place (see [The note](#the-note)). Posts you
  hid yourself with **Hide as slop**, accounts in **Also hide these accounts**
  and posts that tag a hidden bot are hidden completely. The userscript has no
  note; it hides completely.

### Bots

The popup has a row for each of six accounts that answer when someone tags
them: @grok (X's assistant), @AskPerplexity, @pangram (an AI-text
detector), @bot (xAI's Grok Bot), @threadreaderapp and @UnrollHelper (thread
unrollers). Each row links to the bot's profile, where you can block it, and
offers three choices:

| Choice | The bot's own posts | With muting on |
|---|---|---|
| **Show** | Shown | Not muted |
| **Hide here** | Hidden in this browser | Not muted |
| **Mute on X** | Hidden in this browser | Muted on your X account, like a listed account |

- A bot you have not set follows the list: **Hide here** if clankwall lists it
  or it is in **Also hide these accounts**, **Show** if not. On 2026-11-08 the
  list had 773 handles and @grok was the only one of the six on it, so @grok
  starts at **Hide here** and the other five at **Show**. A bot is never muted
  until you pick **Mute on X** in its row.
- A bot in **Always show these accounts** is shown and never muted; its row is
  locked to **Show**.
- If you ticked **Show @grok's replies** in an earlier version, @grok's row
  starts at **Show**.
- On a bot's own pages its posts show, as on any account's.

Ticking **Also hide posts that tag a bot set to Hide or Mute** also hides
posts whose own text links one of the bots set to **Hide here** or **Mute on
X**, such as a reply that reads "@grok is this true?". Then:

- A tag inside a quoted post does not count, and neither does the "Replying
  to" line above a post.
- Your own posts, posts by Always-show accounts, posts on the author's own
  pages, and posts on the pages of a bot set to **Hide here** or **Mute on X**
  stay visible.
- These posts are counted apart from the listed authors' posts, and their
  authors are never muted for the tag.

On 2026-11-06, in an X search for "@grok is this true", each of the 10 posts
read had the `/grok` link in its own text and none in its "Replying to" line,
which named the account being answered.

All of this applies in this browser only. To keep a bot's replies out of the
X apps as well, add its handle (such as @grok) as a
[muted word](https://x.com/settings/muted_keywords) on X; AI Anti-Slop does not
add muted words.

## Lists

The extension hides posts by accounts on every list you switch on, added
together. **Always show** beats every list, and an account's own pages still
show its posts. The lists are on the extension's settings page: click **Choose
lists** under the list count in the popup, or **Export or import** under **Your
accounts**. Each list there has a switch, its count and when it was last
updated. A list whose last download failed says what went wrong and what to
do, shows the reason as reported, and has **Try again**, which downloads every
list that is on again. A list you add has **Remove**, with **Undo** for 10
seconds after.

| List | Address | Starts |
|---|---|---|
| Recommended | `https://clankwall.vogel.dev/api/usernames.txt`, `https://blockedforaireply.levels.io/api/accounts.ndjson` and `https://ai-anti-slop.startupbros.com/v1/list.ndjson` | On |
| clankwall: AI flags | `https://clankwall.vogel.dev/api/usernames.txt` | On |
| clankwall: All flags | `https://clankwall.vogel.dev/api/accounts.ndjson` | Off |
| levelsio: Blocked for AI reply | `https://blockedforaireply.levels.io/api/usernames.txt` | Off |
| A list you add | The address you type | On, once added |

- **Recommended** is AI Anti-Slop's pick: every account on AI flags, plus the
  accounts levelsio's list marks confirmed, plus the readers' list. The
  extension builds it from the three files above: it keeps a row of levelsio's
  `accounts.ndjson` only when the row says `"status": "confirmed"` (until
  2026-11-24 the file said `"levelsio": "confirmed"`, which still counts) and
  has at least one item under `evidence`, and every row of the readers' list.
  The file's own rule reads "confirmed = AI or spam replies checked and saved
  as evidence" (2026-11-24). It held 1,306 accounts on 2026-11-21, 786 from AI
  flags and 521 from levelsio's file, with 1 on both, before the readers' list
  existed, and 2,270 on 2026-11-24, 785 and 1,486, with 1 on both. On
  2026-11-21 levelsio's confirmed accounts were the ones blocked with a public
  "Blocked for AI reply" reply. On 2026-11-24 about a third of the accounts
  levelsio's page showed as confirmed had one, and 881 of the 1,486 in the
  file were blocked on 2026-11-23 or later, each with the replies the check
  saved. levelsio's other accounts, blocked with no
  reply or flagged by an outside check, are left out. Each file is checked on
  its own, against its own part of the stored copy, and one that fails keeps
  its previous part while the others update
  ([How list updates stay safe](#how-list-updates-stay-safe)). It hides only,
  and only in the extension: the userscript cannot fetch levelsio's file or
  the readers' list. It is on after the update that adds it, as on a new
  install, until you switch it off. AI flags is on too, so its file is
  downloaded once for each list.
- **The readers' list** is the part of Recommended that AI Anti-Slop's server
  builds from the labels readers chose to [share](#sharing-labels). Each
  install counts once per account, by its newest label on any of the account's
  posts. An account is on it once three or more installs, on two or more
  networks, say slop about posts in two or more threads, and at least three
  times as many installs say slop as not slop, counting only installs that have
  said so for a day or more and whose first report reached the server a week or
  more before. It is empty until that first happens. It is not a list of its own on the settings page, so
  switching Recommended off stops its download too.
- **AI flags** is the list AI Anti-Slop has always used, with 787 accounts on
  2026-11-19. Muting uses it alone, so it stays switched on while muting is
  on. To switch it off, turn muting off first. Recommended includes it, so
  while Recommended is on, switching AI flags off hides no fewer posts.
- **All flags** is every account clankwall flagged, for AI replies or spam:
  2,811 accounts on 2026-11-19, 787 of them also on AI flags. clankwall's
  homepage shows the same two views under those names. Most of the 2,024 not on
  AI flags read as crypto spam, but 977 of them rest on a single spam flag and
  819 were sampled once, so expect some mistakes. It hides only: muting never
  visits an account for being on it.
- **levelsio: Blocked for AI reply** is the list @levelsio publishes at
  [blockedforaireply.levels.io](https://blockedforaireply.levels.io/): 3,734
  accounts on 2026-11-19, among them 754 of the 786 on AI flags at the same
  hour. The page sorts them: 505 blocked with a public "Blocked for AI reply"
  or "nuked" reply, 1,026 accounts made in 2023 or later blocked with no
  interaction, 2,059 older silent blocks not yet reviewed, and 144 from
  clankwall alone. It says "Flags are judgment calls, not proof." It hides
  only, and only in the extension: the userscript cannot fetch it.
- **A list you add** is a text file with one handle per line, like a file
  from **Export list** under **Also hide as a list**. Lines starting with `#` or `!` are
  skipped. You can add up to 5. The address must start with `https://` and
  hold no user name or password. A list you add hides only.
- The extension fetches a list you add without asking for a permission, so
  the host has to let other sites read the file. Raw GitHub
  (`raw.githubusercontent.com`) and Gist raw links do. An address that opens
  in a tab but shows `network error: Failed to fetch` on the settings page
  usually does not. Removing a list deletes its stored copy; **Undo** puts the
  list back where it was, and downloads it again if it was on.
- A list that is off is not fetched. Adding a list fetches it at once, and so
  does switching one on, unless its stored copy is less than 6 hours old or
  its last try failed less than 30 minutes ago. After that every list that is
  on refreshes every 6 hours, and the circular
  arrow in the popup refreshes them all.
- Each list is checked on its own (see [How list updates stay
  safe](#how-list-updates-stay-safe)). One that fails keeps its previous copy
  and leaves the others as they are.
- Export and import never carry the lists or their switches.
- The userscript has clankwall's two lists, not Recommended or levelsio's,
  and no lists of your own. **Hide every account clankwall flagged / AI flags only** in its
  menu switches All flags on or off.

## Muting

Muting is in the extension only, and it is off until you turn it on.

### Before you turn it on

Under "Don't!", X's
[automation rules](https://help.x.com/en/rules-and-policies/x-automation)
list: "Use non-API-based forms of automation, such as scripting the X website.
The use of these techniques may result in the permanent suspension of your
account." (read on 2026-11-06, unchanged on 2026-11-08). Muting with
AI Anti-Slop scripts the X website, and the popup says so under the switch.
Turn it on only if you accept that risk for the account you mute from.

A listing can be a mistake (clankwall's homepage says "Flags aren’t proof of
AI use."), and AI Anti-Slop mutes every listed account it reaches, including
one listed by mistake. Accounts you follow are skipped. Look through the
[list](https://clankwall.vogel.dev/api/usernames.txt) for accounts you know
and add them to **Always show** first. AI Anti-Slop unmutes an account it
muted once it leaves the list or you add it to Always show (see
[Unmuting](#unmuting)), but until then the mute is on your X account.

### Turning it on

1. Under **Your accounts**, add every listed account you never want muted to
   **Always show these accounts**, and click **Save**. Accounts there are
   never hidden and never muted. Everything under **Also hide these
   accounts** is muted too, so take out any account there that you only want
   hidden. The exception is one of the six bots under [Bots](#bots): it
   follows its row, so it is muted only when that row says **Mute on X**.
2. Open x.com in a tab, logged in as the account to mute from.
3. From that tab, open the popup and tick **Mute listed accounts on X**. The
   popup asks the tab which account is logged in and ties muting to that
   account. If it cannot tell, it leaves the box unticked and says "Open x.com
   in this tab, logged in as the account to mute from, then turn this on."

Unticking the box starts no new visits. A visit already under way either
finishes, and is recorded like any other, or is dropped when its 90 s are up
and its tab closed. So one more mute can land just after you untick.

### What it does

- Once a minute, the background worker checks whether a visit is due. When one
  is, it opens the account's profile in a new background tab. The tab shows in
  your tab strip but never takes focus. Leave it alone: closing it counts as a
  failed visit.
- In that tab, AI Anti-Slop waits for one of the account's own posts with a ⋯
  button, opens that menu, and clicks the item labelled exactly
  "Mute @handle" (or "Mute"). It waits for X's "has been muted" notice, then
  closes the tab.
- One tab at a time. The next one opens at the first once-a-minute check that
  comes 1 to 3 minutes (picked at random) after the last tab closed, so about
  1 to 4 minutes later. At most 25 mutes and 50 profile visits a day, or the
  number you pick under **Mutes a day** and twice that many visits (see
  [How many a day](#how-many-a-day)). Days are UTC days. **Run now** skips
  the gap and both caps (see [Run now](#run-now)).
- After every 5 mutes, and when the day's caps are reached or nothing is left
  to visit, it opens `x.com/settings/muted/all` the same way and checks that
  each new mute is listed there.
- Accounts it may mute whose posts it hid while you browsed go first (it keeps
  the latest 50), then the rest of the list in its order, then your extra
  accounts in alphabetical order, then bots set to **Mute on X**, then
  accounts being tried again.

It mutes only accounts on clankwall's AI flags list, accounts under **Also
hide these accounts**, and bots whose row says **Mute on X**. An account that
is only on All flags, on levelsio's list or on a list you added is hidden, never muted. It never mutes a bot left at
**Show** or **Hide here**, including @grok, which is on the list (muting it
account-wide is a much bigger step than hiding its replies); an account in
Always show; an account you follow; or someone whose post was hidden only for
tagging a bot. When X's menu offers "Unfollow @handle", AI Anti-Slop
records that you follow the account and moves on. An account that is already
muted is recorded without a click, and is never unmuted: that mute is yours.
AI Anti-Slop never blocks.

### Unmuting

While muting is on, AI Anti-Slop unmutes an account it muted once it would no
longer mute it: clankwall took it off its AI flags list (even if All flags,
levelsio's list or a list you added still has it), you added it to **Always show**, you took it out of **Also hide** and it is not listed, or you moved a
bot's row off **Mute on X**. It visits the account's profile, opens the ⋯ menu
of one of its posts and clicks X's own "Unmute @handle" item, the way it
mutes. If the menu offers Mute instead, the account was already unmuted, and
nothing is clicked.

- Unmutes go before new mutes and count against the same number a day. A run
  of **Run now** does them first too.
- It unmutes only mutes it made, as the account muting is on for. An account
  it found already muted (by you, in the X app or with another tool) is never
  unmuted, and neither is a mute made while muting was on for another account.
- It waits for nothing: an account a list update drops is unmuted at the daily
  pace, and muted again if a later update brings it back. An update that drops
  more than half the list is refused, and while no list has been fetched
  nothing is unmuted.
- A visit that fails (no post on the profile, or the ⋯ menu did not open) is
  tried once more. After a second failure the account is left muted; unmute
  it by hand at `x.com/settings/muted/all`.
- A profile X shows as deleted or suspended has nothing to click, so that
  account is left muted after the one visit.
- Turning muting off stops unmuting too. The mutes it made stay.
- Mutes recorded before 0.8.0 count as made by the account muting is on for
  the first time muting runs on 0.8.0.

### How many a day

Under **Mutes a day** the popup offers 25, 50 and 100.

- 25 is the default. It runs whenever the browser is open with the extension
  loaded, as in earlier versions.
- At 50 or 100, the day's first 25 mutes (and first 50 visits) run as at 25,
  with no x.com tab needed. Past that, a mute visit starts only while you have
  x.com open in a tab of your own. Before each such visit, the background worker
  asks your open tabs, and goes ahead only if the extension's script on an
  x.com page answers within 1.5 s. The tabs it opens for its own visits never
  count, nor do tabs the browser has discarded to save memory. Without such a
  tab it waits; a check of `x.com/settings/muted/all` that is due still runs.
  0.9.0 and earlier needed the tab for every visit at 50 or 100.
- After the extension is updated or reloaded, an x.com tab that was already
  open cannot answer until you refresh it (or open x.com in a new tab), so
  until then muting past 25 waits. This was seen in Chromium after a reload
  from the extensions page; an update from the Chrome Web Store is expected to
  do the same.
- The 1 to 3 minute gap between visits is the same at every setting, and visits
  stay capped at twice the mute number. So 100 mutes need about 2 to 7 hours,
  the 75 past 25 of them with x.com open.
- No setting goes above 100, and a stored value other than 25, 50 or 100 counts
  as 25. Hiding already covers this browser, so muting only adds the X apps;
  at 100 a day, the 773 accounts listed on 2026-11-08 take 8 days. The popup
  shows that figure, under **How muting works**, for the accounts it has left
  to mute. **Run now** visits them without waiting for the next day.
- At 50 or 100, **Mutes a day** has a line under it: "Mutes past 25 need an
  x.com tab open."

A lower number means less scripted clicking on your account each day. No
number makes it allowed: X's rules forbid scripting the X website at any rate
(see [Before you turn it on](#before-you-turn-it-on)). X publishes no limit for
mutes, so 50 and 100 are not known to be safe; the cap and the open-tab rule
are their only limits.

### Run now

While muting is on, the day has not stopped and something is waiting, the
popup shows **Run now** with the number of accounts waiting: the unmutes and
mutes the daily pace has not reached yet. Pressing it visits them all, one
after another:

- Unmutes first, then mutes, in the order above, with the same tabs, clicks
  and checks as the daily pace.
- 2 to 5 seconds (picked at random) after one tab closes, the next opens,
  instead of 1 to 4 minutes later. Neither daily cap applies, and at 50 or 100
  a day it does not wait for an x.com tab of yours. What it does still counts
  in today's figures, which the popup then gives as counts past the number,
  such as "Today (UTC): 40 mutes (over 25 a day), 44 visits".
- After every 5 mutes it still checks `x.com/settings/muted/all`, and
  everything under [When it stops for the day](#when-it-stops-for-the-day)
  still stops the day, which ends the run. If that page does not load, the run
  waits with the check: nothing is visited for 15 minutes, then the page is
  read again, and the run goes on if it loads.
- An account that fails twice is left alone, as under [Retries](#retries), so
  a run never keeps visiting one account.
- Five visits in a row that end in an error or find no post stop muting for
  the day. A profile X shows as deleted or suspended is not one of the five. A run tries every account once before it tries any again, so if
  x.com does not load, or X will not show profiles, it stops after five
  accounts that each keep their second try, instead of giving up on the whole
  queue in one sitting.
- It ends when nothing is left, when you press **Stop** (the same button), when
  muting is turned off or turned on for another account, and when the browser
  closes or the extension is reloaded or updated. It never starts again by
  itself. Muting then goes back to the number a day, which a run has usually
  used up for today.

A run is the most scripted clicking at once that AI Anti-Slop does. X
publishes no limit for mutes, so no pace, this one included, is known to be
safe (see [Before you turn it on](#before-you-turn-it-on)).

### When it stops for the day

Muting stops until the next UTC day, and the popup shows "Stopped for today:"
with the reason, when:

- the tab is logged out, or logged in as a different account from the one
  muting was turned on from;
- the ⋯ menu does not have exactly one Mute item (or, to unmute, exactly one
  Unmute item), or X asks for a confirmation (AI Anti-Slop leaves it
  unanswered);
- a check does not find a new mute on `x.com/settings/muted/all`, or cannot
  read that page twice in a row. After the first time, the mutes not yet
  checked stay waiting, nothing is visited for 15 minutes (one of X's
  rate-limit windows), and then the page is read again. Meanwhile the popup's
  line for today ends "your muted list did not load, next try in 15 min";
- during [Run now](#run-now), five visits in a row end in an error or find no
  post.

[Muting stopped for today](#muting-stopped-for-today) under Troubleshooting
lists each reason.

### Retries

- A failed visit (no answer from the tab within 90 s, the tab closed before it
  finished, or a ⋯ menu that did not open) is tried again after the accounts
  not yet tried. After 2 failures the account is left alone.
- A profile with no post by the account, or none with a ⋯ button, is tried once
  more, then left alone.
- A profile X shows as deleted or suspended ("This account doesn't exist",
  "Account suspended") is left alone from that visit on. The visit ends as soon
  as the page shows it, without waiting for a post. Hiding goes by the list,
  so if X brings the account back its replies are still hidden; it is just not
  muted. A profile behind X's "temporarily restricted" caution page counts as
  one with no post, and nothing on that page is clicked.
- An account whose menu stopped the day is tried again on a later day, after
  the untried ones. If X shows the same menu, it stops that day too; add the
  account to Always show to end that.

### What it records

The popup shows who muting runs as and today's counts, with a bar between them
that fills toward the day's number of mutes (25 here). The third line, the
totals so far, is under **How muting works**:

```
Muting as @you
Today (UTC): 3 of 25 mutes, 5 of 50 visits · next visit in 2 min
So far: 3 muted (3 seen on your muted list, 0 not found there), 1 already muted, 1 you follow, 0 skipped.
```

Past the day's number, after **Run now**, the line gives the counts without
"of", and during a run it leaves out the next visit.

Skipped means no post, or 2 failed visits. Once some accounts have turned out
to be deleted or suspended, the line ends with how many, such as ", 2 deleted
or suspended".

The record is `xsh:mutes` in the extension's local storage: one entry per
account visited, with its status, the time, X's notice text, whether a check
found it on your muted list, and, for a mute it made, the account it muted as.

## Labels

Labels are in the extension only, and on unless you untick **Show a Hide as
slop button on posts on x.com** under **Label posts** in the popup. Before
0.9.0 they were off until ticked; if you turned the switch off, it stays off.
Each post x.com lists gets one button, **Hide as slop**, on the home timeline,
search, lists, notifications, profiles and a post's own page alike: a speech
bubble with an ×, at the post's top right, just left of Grok's icon and ⋯
(More), or of ⋯ alone where X shows no Grok icon (in a narrow window, say).
None of X's icons moves to make room for it, but it takes room from the line
of names, so a long name or handle is cut short sooner. A post without ⋯ gets
the button on a line of its own under it. Only your own posts get none, once
x.com's sidebar shows who is logged in. A post's own page
(`x.com/handle/status/...`) gives the button to the post itself, its author's
replies and the posts above it alike, and a profile to every post on it. A
click on the account's own profile or post page labels the post and adds the
account to **Also hide** as anywhere else, but its posts still show on its own
pages (see [What gets hidden](#what-gets-hidden)), and the notice says so.

- **Hide as slop** labels the post slop and adds the account to **Also hide
  these accounts**, so its posts on the page hide at once and, with muting on,
  it is muted too once the label is saved (a bot follows its row, as under
  [Bots](#bots)).
- A notice at the bottom of the window says what the click did, with an
  **Undo** button for 6 seconds. **Undo** puts the label and the box back as
  they were. Nothing is saved until the 6 seconds end, so an undone click is
  never stored and never reaches muting. The click is saved sooner when you
  click another post's button, open another page, or switch away from or
  close the tab. If the save is refused, the page goes back and the button's
  tooltip says why ("not saved: ...").
- An account already in Also hide is not added again. The button's tooltip
  says when the account is "on the list", "in Also hide" or "in Always show".
  An account in both boxes is shown: Always show wins.
- A post labelled slop that still shows (hiding is paused, or the account is
  in Always show) has its button filled red, and clicking it removes the
  label. Removing a label, or deleting them all, leaves both boxes as they
  are. To take an account out of a box, edit it under **Your accounts**.
- A hidden post's button is hidden with it, so a click moves keyboard focus
  to **Undo**. To label a hidden post, or remove its label, tick **Pause
  hiding** first.
- Versions before 0.9.0 drew a **Not slop** button beside each post's
  **Hide as slop**. 0.11.0 brings **Not slop** back in one place only, on the
  note (see [The note](#the-note)). Labels saved as Not slop are kept, counted
  and exported; on such a post the **Hide as slop** button is drawn empty, and
  clicking it labels the post slop. The account stays in Always show, where
  the Not slop click put it, so the post still shows, and the notice says so,
  until you take it out of that box.
- Clicking the button does not open the post, and the button ignores clicks
  made by a page's own script.
- Until x.com's sidebar shows who is logged in, every post has the button,
  your own included, and a click on any of them saves nothing and says "Not
  saved: x.com has not shown who is logged in yet. Try again in a moment."
  That way your own handle never goes into Also hide.

### The note

A post by an account that is on a list you have switched on does not vanish.
In its place the extension draws one line, about 32 px high: **Hidden: on**
and the name of the first list that holds the account (for Recommended, the
file that does: clankwall's AI flags, levelsio's list or the readers' list),
then two buttons. A list you added by address is named "a list you added",
never by its address, since the note is part of x.com's page. The note never
says how many readers reported an account.

- **Show** shows that one post, on this page only. Nothing is stored: when you
  open another page, or reload, the post is hidden again.
- **Not slop** (only while labels are on) labels the post not slop and adds the
  account to **Always show these accounts**, so the post shows at once. It has
  the same notice and 6 seconds to **Undo** as **Hide as slop**; **Undo** puts
  the note back and saves nothing. With sharing on, a Not slop label is sent as
  a report like any other (see [Sharing labels](#sharing-labels)).
- Both are real buttons you can reach with the keyboard, and they ignore a
  click made by a page's own script. After either one, focus moves to the
  post's **Hide as slop** button, or to **Undo**.

A post gets no note, and is hidden completely, when you tick **Hide listed
posts completely, with no note** on the settings page, under **Lists** (it
stays on this browser and is not part of a settings file); when hiding is
paused (nothing is hidden then); in the userscript, which cannot save a label;
in the tab the extension opens to mute; and when the account is in **Also
hide** or its hide comes from a bot's row or a tag of a bot. The note changes
none of the counts in the popup.

### The first time you share

The first time you save a **Hide as slop** click while sharing is off and you
have not answered before, a card appears at the bottom right of the page. It
lists what sharing sends and what it never sends, with three buttons.
**Share** turns sharing on for labels you make from now on, and sends none of
the labels already saved. **Not now** keeps it off and does not ask again.
**Details** opens the sharing section of the settings page. **Esc** closes the
card without an answer. The card is not modal, shows once per tab, and never
appears in the userscript or in a tab opened to mute. Turning sharing on or off
on the settings page counts as an answer too.

Each post has one label record, keyed by its post id; the latest click wins.
A record holds:

| Field | What it holds |
|---|---|
| `at` | When it was saved, in milliseconds since 1970: when the click's 6-second Undo window ended, or sooner (see above) |
| `label` | `slop`, or `not_slop` from a version before 0.9.0 |
| `handle` | The post's author, in lower case |
| `url` | The post's link, `https://x.com/handle/status/id` |
| `text` | The first 1,000 characters of the post's own text (not a post it quotes), with its emoji |
| `page` | The post page it was labelled on, or `null` on any other page, such as the home timeline |
| `list` | The host of the first list that was on and had the account, such as `clankwall.vogel.dev`; otherwise `null`. For Recommended, the host of the first of its files that had it: `clankwall.vogel.dev`, `blockedforaireply.levels.io` or `ai-anti-slop.startupbros.com` |
| `lists` | Only when a list other than AI flags was on (Recommended starts on): the lists that were on and had the account, `recommended` (Recommended), `clankwall-ai` (AI flags), `clankwall-all` (All flags), `levelsio` (levelsio's list), or `u` and letters and digits for a list you added; empty when none of them had it. A label saved with only AI flags on, or before this field existed, has none |
| `extra`, `allow` | Whether the account was in Also hide or Always show before this click |
| `hidden` | Whether AI Anti-Slop hid the account's posts on that page then, leaving out Pause and tag hiding |

**Export labels** saves them all as a JSON Lines file, one record per line,
oldest first, named `ai-anti-slop-labels-YYYY-MM-DD.jsonl`. **Delete all
labels** deletes them on its second click. Up to 2,000 labels are kept; past
that, a new one is refused ("2000 labels saved: export and delete them to add
more") while saved ones can still be changed.

### Sharing labels

Sharing is off unless you turn it on under **Share your labels** on the
settings page, which the popup's **Share your labels** button opens, or by
pressing **Share** on the card that appears after your first saved **Hide as
slop** (see [The first time you share](#the-first-time-you-share)). While it
is on, each label you save is sent to AI Anti-Slop's server at
`ai-anti-slop.startupbros.com`, where enough agreeing labels put an account on
the [readers' list](#lists). Turning it on offers to send the labels already
saved too (**Also share the newest saved label for N accounts**), unticked.

- A report holds the label, the author's handle, the post's id, the id of the
  post page it was labelled on (none on other pages; the server then counts
  the post as its own thread) and the UTC day it was labelled. Version 0.10.0
  also sent a hash of the post's words; 0.11.0 does not. The words
  themselves, the label's other fields, your settings and your X handle are
  never sent. With them goes a random code made when you first turn sharing
  on, so the server can count one install once and delete its reports. The
  settings page lists all of it before the button.
- Labels go about 30 seconds after they are saved, up to 50 in a request,
  the newest day first. The server keeps one entry for each account you
  labelled, your newest label on it. Turning sharing on with **Also share**
  ticked sends one report for each account, its newest label, from the last 88
  days. While sharing is on, clearing a label takes back what the server keeps
  for that account and sends your newest remaining label on it, if there is
  one; **Delete all labels** takes back each account once. The extension
  remembers, for each account, the side and day the server last confirmed;
  when a label is about to go and the server may hold the other side, it takes
  the account back first, so the newest label is what the server keeps even
  after sharing was off while you changed a label. A code made by 0.10.0 kept
  no such record, so each account is taken back once before its first label
  from 0.11.0. With sharing off, reports already sent stay. When the server
  cannot be reached or answers with an error, the request waits 30 minutes,
  then twice as long for each failure in a row, up to 6 hours, each wait made
  up to 25% shorter or longer at random; when it asks to wait (past 100 reports
  from one install in a UTC day, say), it waits at least as long as it is told,
  up to 26 hours, plus up to an hour at random. At most 4,000 reports wait at
  once; past that the reports of the oldest days are dropped first.
- The popup says whether sharing is on and how many reports it has sent.
- **Turn off sharing** stops sending and drops what is waiting. **Delete what
  I shared** also deletes, on the server, every report from this install, and
  then the random code. What is left on the server about an account is
  deleted 90 days after this install's newest label on it.

The server's code is in [`server/`](server/), with its rules and what it
stores in [server/README.md](server/README.md). What it keeps is in
[PRIVACY.md](PRIVACY.md#sharing-labels).

## Export and import

Under **Your accounts** in the popup, **Export or import** opens a page of its
own, the extension's options page (a file picker opened from the popup can
close the popup). The userscript has no export or import.

- **Export settings** saves `ai-anti-slop-settings-YYYY-MM-DD.json`: your
  Always show and Also hide accounts, each bot's saved choice, and whether
  posts that tag a hidden bot are hidden. It never holds muting on or off,
  **Mutes a day**, the account muting runs as, which lists are on, the
  addresses of lists you added, **Pause hiding** or your labels.
- **Export list**, under **Also hide as a list**, saves
  `ai-anti-slop-also-hide-YYYY-MM-DD.txt`, one handle per line. Anyone can
  import it into their own Also hide. With Also hide empty it saves nothing and
  says so.
- **Choose a file…**, under **Import a file**, reads one file you pick: a settings file, or a text file of
  handles, one per line, `@` optional, with blank lines and lines starting
  with `#` skipped. A list file goes to Also hide.

Import adds accounts and never removes one. A settings file also sets the bot
choices and the tag setting it holds. It never turns muting on and never
changes **Mutes a day**.

Before anything changes, the page lists what the file adds and changes. While
muting is on, it says which account muting runs as and names the accounts
muting can newly reach, bots set to **Mute on X** included. While muting is
off, it names the accounts muting would add if you turned it on. A line with
more than 12 accounts names the first 12 and lists every one under **Show
all**. Nothing is written until you click **Import these changes**, and
**Cancel** writes nothing. If your settings change between the preview and the
click (in the popup, say), the page shows the new preview instead of
importing.

A file is refused whole, with the reason, when a line is not a handle, a bot
choice is not show, hide or mute, its format or version is unknown, or it
holds more than 50,000 accounts or 1 MB.

Read a shared list before you import it. Every account on it is hidden, and
muted while muting is on, including one put there by mistake. Add any you want
to keep seeing to **Always show** first; the preview says which accounts it
keeps shown.

## Whose list is it?

The AI flags and All flags lists are clankwall's, not this project's;
levelsio's list is @levelsio's; and a list you add is whoever publishes it.
Neither AI Anti-Slop nor its developers check a list you add.

Recommended is a rule over clankwall's and levelsio's lists, plus the
readers' list. The extension applies the rule to clankwall's and levelsio's
files as they are published, and AI Anti-Slop hosts no copy of either. An
account leaves Recommended once it is on none of the three: neither on AI
flags, nor among levelsio's confirmed accounts, nor on the readers' list.
The removal routes for the first two are those sites' own, below.

The readers' list is this project's. Its server builds it from shared labels
by the rule under [Lists](#lists), every six hours, and drops an account
once too few readers' labels on it are left: an install's say on an account is
deleted 90 days after its newest label there. Its maintainers can take an
account off by hand, nobody can add one by hand, and each build that adds or
removes an account is published at
`https://ai-anti-slop.startupbros.com/v1/changes`. If you think an account is
on it by mistake, the form on `https://ai-anti-slop.startupbros.com/` takes it
off at the next build, within six hours, with nobody reading the request; for
90 days after, only labels made on later days count for it, so it comes back
only if readers keep labelling its posts slop. An entry means readers reported
the account, not that it posts AI replies.

The AI flags list is clankwall's, not this project's. clankwall's homepage says "Flags
aren’t proof of AI use." and states no licence or uptime terms. AI Anti-Slop
fetches it at run time and does not copy it into this repository.

If you think an account is listed by mistake, clankwall's homepage has a
Request removal form (it says requests are "Logged for review, not removed
automatically.") and links dispute-spam@ryan.ceo (read on 2026-11-08).
AI Anti-Slop cannot remove anyone from clankwall's list. To see an account anyway, add
it to Always show; that also keeps it from being muted.

levelsio's page has an Appeal a listing form, which asks for a post from the
listed account and says "Appeals are reviewed by hand.", and a Request
removal form (read on 2026-11-19). Always show works the same for an account
on that list.

AI Anti-Slop is not affiliated with X Corp, with clankwall or with levelsio.

## How list updates stay safe

Each list is fetched and checked on its own, and an update replaces that
list's stored copy only if it looks like a list. If the fetch
fails, times out, returns HTML, is over 1 MB (8 MB for All flags and
levelsio's `accounts.ndjson`, whose lines are JSON) or 50,000 handles, is mostly lines
that are not handles, is empty, or has fewer than half as many handles as the
stored list (once that list has 20 or more), the previous list stays in place
and the popup shows why. A broken or truncated feed cannot empty your filter.
Recommended's three files are each checked this way, against that file's own
part of the stored copy, so levelsio's rows losing the field that marks them
confirmed counts as an empty file even while clankwall's part is fine. A
file that fails keeps its own previous part while the other files update,
and the popup names the file's host. Only when every file fails does all of
Recommended keep its previous copy. The readers' list may be empty, since it
starts that way: an empty file is taken while its stored part holds fewer
than 20 accounts, and refused like any other once it holds 20 or more.

## Permissions and privacy

The privacy policy, with what each storage key holds, is
[PRIVACY.md](PRIVACY.md).

- `storage` holds the lists, your settings, the mute record and your labels, in
  `chrome.storage.local`. During a mute visit it also holds the visit's
  account and tab ids in `chrome.storage.session`, which the browser clears
  when it closes, and during **Run now** the time the run started, the
  account it runs as and how many visits in a row did nothing. `alarms` schedules the list refreshes, muting's once-a-minute check, and the
  90 s limit on a visit. Opening and closing its own tabs needs no further permission.
- The content script runs on x.com, twitter.com and their `mobile.` hosts. In
  your own tabs it makes no network requests and clicks nothing: it reads the
  page, adds one style rule, and sets an attribute on the cells it hides. While
  muting is on, it also tells the background worker the handle of each
  account whose post it hid (once per account until the tab reloads), and
  the worker puts the ones
  muting may visit first in line. With labelling on, it adds a second style
  rule, the **Hide as slop** buttons and the notice that offers **Undo**, and
  hands each label you click, with the post's text, to the background worker
  to store once its Undo window ends.
- At 50 or 100 mutes a day, before each visit outside **Run now** once the day
  has had 25 mutes and unmutes or 50 visits (in 0.9.0 and earlier, before every
  visit outside **Run now**) the worker lists your open tabs and asks each one whether it is an x.com tab of yours. It uses only each
  tab's id and whether the browser has discarded it, never its address or
  title, and only the extension's script on an x.com page answers.
- It clicks only in a tab the background worker opened for a visit. The worker
  hands that tab its job once, so a reload of the tab does not click again.
- The extension's own code sends two kinds of network request, both from
  the background worker. The first is a list fetch for each list that is on:
  clankwall's at `clankwall.vogel.dev` (the only host permission), levelsio's
  at `blockedforaireply.levels.io`, and each list you add at its own address.
  Recommended, which starts on, fetches one file from each of those two hosts
  and the readers' list from `ai-anti-slop.startupbros.com`: about 9 KB from
  clankwall and about 1 MB from levelsio (2026-11-21), every 6 hours.
  The second, only while [sharing](#sharing-labels) is on, posts reports to
  `ai-anti-slop.startupbros.com`: labels, retractions, and **Delete what I
  shared**, as plain text.
  Every host but clankwall's is reached with no host permission, so the
  browser lets the extension read an answer only when its host allows other
  sites to (an `Access-Control-Allow-Origin` header; levelsio's and AI
  Anti-Slop's send `*`). Every request sends no cookies
  (`credentials: 'omit'`) and bypasses the cache. The userscript fetches
  clankwall's lists through its manager (`@connect clankwall.vogel.dev`,
  `anonymous: true`, so no cookies); the cache setting applies to the
  extension only.
- Muting sends no request of its own. A mute visit opens an x.com page in a
  tab, which the browser loads with your x.com login like any page you open,
  and the mute is the request x.com's page sends when its Mute item is
  clicked, as when you click it yourself.
- Labels, including the text of the posts you label, are stored in this
  browser profile's extension storage (an `xsh:label:<post id>` key for each,
  and a count, `xsh:labelCount`). They leave it as a file when you click
  **Export labels**, and, only while sharing is on, as reports without the
  post's text. Removing the extension deletes them, but not reports already
  shared; **Delete what I shared** does that. Sharing's own record (its random
  code, the reports waiting to go and the side the server confirmed for each
  account) is `xsh:share`.
- **Report a problem**, in the popup, and **Report a problem or suggest
  something**, on the settings page, open GitHub's new-issue page in a new tab
  when you click one, with the extension's version and your browser's name,
  major version and system in its address. The extension sends no request of
  its own for them; a report goes to GitHub only if you submit it there.
- Nothing else is collected or sent. There is no analytics.
- The AI flags list's address is a setting (`feedUrl` in `xsh:settings`)
  with no UI. To use another list, add it on the settings page instead. A
  `feedUrl` on another host also needs that host added to `host_permissions`
  in `manifest.json` (unless it serves CORS headers), or, for the userscript,
  an `@connect` line for it.

## Troubleshooting

### The userscript is installed but hides nothing

In Chrome and other Chromium browsers, open `chrome://extensions`, click
**Details** on the userscript manager's card, and turn on **Allow User
Scripts**. It is off in a new profile. Then reload x.com.

### On an x.com tab, the popup says "Open x.com in this tab to see what was hidden."

The popup could not reach the extension's script in that tab. The likely
cause is that the tab was already open when the extension was installed or
reloaded, because Chrome does not add an extension's scripts to tabs that are
already open. Reload the tab.

### Ticking "Mute listed accounts on X" says "Open x.com in this tab, logged in as the account to mute from, then turn this on."

The popup could not read which account is logged in from the tab it was opened
over. Open the popup from an x.com tab where you are logged in. If you already
are, reload the tab (it was probably open before the extension was installed or
reloaded) and tick the box again.

### Muting stopped for today

The popup shows "Stopped for today:" and one of these reasons. Muting starts
again on the next UTC day.

| Reason | Meaning | What to do |
|---|---|---|
| `@handle: login (x.com shows a login button)` | The visit's tab was logged out. | Log in to x.com in this browser. |
| `@handle: wrong-account (logged in as @a, not @b)` | x.com is logged in as another account. | Log in as @b again, or untick muting and tick it again from the account you want. |
| `@handle: refused (N exact Mute items in the menu [...])` | The ⋯ menu had no item labelled exactly "Mute @handle", or more than one. The brackets list the labels it saw. | If they are not in English, set X's language to English. If only this account's menu is different, add it to Always show. |
| `@handle: refused (X asked for a confirmation; left it unanswered)` | Clicking Mute brought up a confirmation. | Mute that account by hand if you want to, or add it to Always show. |
| `@handle: unmute refused (N exact Unmute items … in the menu [...])` | To unmute an account it had muted, the ⋯ menu needed exactly one item labelled "Unmute @handle" and no Mute item. The brackets list the labels it saw. | If they are not in English, set X's language to English. Otherwise unmute the account by hand at `x.com/settings/muted/all`. |
| `not on settings/muted/all after muting: @handle` | A new mute was not in the top rows of your muted accounts. | Look for it at `x.com/settings/muted/all`, and see [Limits](#limits). |
| `settings/muted/all check: error (…)` | Your muted accounts page could not be read twice in a row, 15 minutes apart. | Open `x.com/settings/muted/all` and check that it loads. X limits how often an account loads some of its data in each 15 minutes, and after many visits in a row, as in a long Run now, the page can show "Something went wrong. Try reloading." until that resets. |
| `Run now: 5 visits in a row did nothing, the last @handle: error (…)` (or `no-post (…)`) | During Run now, five visits in a row ended in an error or found no post: x.com may not have loaded, or X may not be showing profiles. Each of those accounts keeps its second try. | Open `x.com/handle` and check that its posts load. |

An account refused at its menu is tried again on a later day, and if X still
shows it the same menu, it stops that day too. Adding it to Always show ends
that.

### The popup says "…: last refresh failed (…): …. Still using the previous list."

The list you already had is still in use. With more than one list on (as
from install, with Recommended and AI flags), the line starts with the list's
name, such as "Recommended: last refresh failed", and only that list kept its
previous copy; with one list on it starts "Last refresh failed". The
settings page shows each list's own error. If no list was ever fetched, the line
ends after the reason and the popup shows 0 accounts. For Recommended, the
reason starts with the host of the file that failed, such as
`blockedforaireply.levels.io: HTTP 503`. The text
after the colon says why the update was refused:

| Reason | Meaning |
|---|---|
| `network error: …`, `HTTP <status>`, `read error: …` | The feed did not answer properly. For a list you added, `network error: Failed to fetch` usually means its host does not let other sites read the file; use its raw link (see [Lists](#lists)). |
| `unexpected content-type …` | The feed URL returned a web page, not a list. |
| `feed larger than 1000000 bytes`, `too many handles`, `feed is mostly not handles (N invalid lines)` | The response does not look like a handle list. |
| `empty list`, `list shrank from X to Y` | The new list was empty, or under half the size of the stored one. |

Click the circular arrow beside the list's count (**Refresh list now**) to try
again. Otherwise the extension tries again at
its next 6-hourly refresh, or at browser start if one is due. The userscript
stores the reason too but has no popup to show it in; while an x.com tab is
open, it retries at most every 30 minutes until a fetch works.

### Import says "Not imported: line N is not an X handle."

In a list file, each line holds one handle and nothing else: letters, digits
and `_`, up to 15 characters, with or without `@`. A note after a handle, a
profile link or a display name refuses the whole file, so nothing is half
imported. Put notes on lines of their own starting with `#`, fix the line
named, and pick the file again.

### A post you want to see is hidden

Add the author to **Always show these accounts**, or tick **Pause hiding**. On
an account's own profile and post pages, its posts always show.

### Nothing is hidden any more

Check that hiding is not paused and that the popup's list count is not 0. If
posts by listed authors still show, X may have renamed the markup the script
reads (see [Limits](#limits)). Please open an issue.

## Limits

- The feed lists handles, not accounts. An account that renames itself
  escapes until the list catches up, and a handle that is released and
  re-registered would hide its new owner, and with muting on, mute it.
- The name is the aim, not a promise. Only posts by accounts on the list or in
  **Also hide these accounts**, or by a bot set to Hide or Mute, are hidden. A
  reply by any other account stays, however it was written, unless it tags
  such a bot and you turned on hiding posts that tag one.
- The list is someone else's judgement, and the readers' list is the
  judgement of whoever shares. Reports are not checked against anything. Its
  rule needs agreement from several installs on several networks, but it
  cannot tell several installs one person runs on several networks from
  several people: three installs on two networks, a week old, can put any
  account on it. If a feed goes away, the last good
  list stays in use.
- Hiding only works in a browser where it is installed, so it never covers the
  X app (the mutes do), and it has been tested only in desktop Chromium.
- Hiding has a scrolling cost. When nothing on screen matches, there is no
  measurable cost (home timeline, full list loaded: p95 21.7 and 20.9 ms
  against a baseline of 24.1 and 20.5 ms). When cells are hidden, X re-lays
  out its list, and scroll frames get slower: on a profile's replies page with
  4 of the 11 to 17 rendered posts hidden, the 95th-percentile scroll frame
  went from about 20 ms to 30-41 ms.
- The script relies on X's `data-testid` attributes (`tweet`, `User-Name`,
  `cellInnerDiv`). If X renames them, nothing is hidden until the selectors
  are updated; it fails open, not closed.
- Only post cells are hidden. Notification rows that are not posts ("X liked
  your post") are not.
- Tag hiding reads the profile links in a post's own text. A bot named without
  a link, or named only in the "Replying to" line, is not seen.
- Tag hiding waits until x.com shows which account is logged in (the profile
  link in its sidebar) so that your own posts stay visible. Until then, and on
  any layout without that link, posts that tag a bot are shown.
- The six bot rows are fixed in the code. To hide another bot, add it under
  **Also hide these accounts** (which also mutes it while muting is on).
- Muting reads X's menu in English: "Mute @handle", "Unmute @handle",
  "Unfollow @handle". With X set to another language, every visit is refused
  and muting stops for the day.
- The check reads only the top of `x.com/settings/muted/all`. In a background
  tab on 2026-11-06, X drew its first 7 to 9 rows. Mutes made elsewhere between
  checks (by hand, in the X app, or by another tool) push the extension's
  newest mutes down that list, and a mute that is there but not drawn reads as missing
  and stops the day. On 2026-11-18 an account muted again 16 s after an unmute
  stayed below an account muted after its first mute, so the extension's
  re-mute of an account it unmuted earlier may read as missing the same way.
  Don't mute by hand or run another muting tool while AI Anti-Slop is muting.
- Muting runs only while the browser is open with the extension loaded and
  logged in to x.com. It picks up again the next time the browser runs.
- At 50 or 100 a day, any x.com tab of yours counts as "x.com open", including
  one left open in the background or in another window. The check learns that
  such a tab is open, not that you are looking at it.
- After an update or a reload of the extension, an x.com tab opened before it
  does not count until you refresh it, so at 50 or 100 a day muting past 25
  waits until then ([How many a day](#how-many-a-day)).
- The clicks are script events (their `isTrusted` is false). X's menu accepted
  them on 2026-11-06, but X can change its menu or how it treats such clicks at
  any time. A changed menu stops muting for the day; AI Anti-Slop does not
  click anything else instead.

## FAQ

### Which browsers does it run in?

The extension needs Chrome 116 or later, or another Chromium browser of that
age; it was tested in Chromium 156. The userscript was tested in Violentmonkey
2.50.0 on Chromium 156. Muting has run in Brave on the maintainer's own
account since 2026-11-07 ([docs/TESTING.md](docs/TESTING.md)). Hiding has not
been tested in Brave, and nothing has been tested in Edge, Firefox or
Tampermonkey.

### Does it work on my phone?

Hiding cannot reach the X app, and it has not been tried in a mobile browser.
The mutes AI Anti-Slop makes are X's own, so they apply in the X app too.
Muting itself runs from the extension in a desktop browser.

### Can I hide an account that is not on the list?

Yes. Add its handle under **Also hide these accounts, and mute them when muting
is on** and click **Save** (in the userscript: **Edit extra accounts to
hide**). While muting is on it is muted too; there is no hide-only setting for
an extra account then. One of the six bots follows its row even when it is in
this box, so it is muted only when that row says **Mute on X**; use the row
instead (see [Bots](#bots)), which has **Hide here**.

### If an account leaves the list, is it unmuted?

Yes, if AI Anti-Slop muted it and muting is still on. It is unmuted ahead of
new mutes, within the number a day you picked, or at once with **Run now** (see
[Unmuting](#unmuting)). A
mute you made yourself is left alone.

### How do I remove it?

Remove the extension in `chrome://extensions`, or delete the script in your
userscript manager. Hiding leaves nothing to undo. Removing the extension
deletes your labels and settings, so export them first if you want them
(**Export labels**, and **Export settings** under **Export or import**). It
does not delete labels you shared from AI Anti-Slop's server: click **Delete
what I shared** on the settings page first, or what the server keeps about
each account is deleted 90 days after your newest label on it. The mutes
AI Anti-Slop made stay on your X account; unmute them on X at
`x.com/settings/muted/all`. To see
which accounts it muted, read the record before removing the extension: click
**service worker** on its card in `chrome://extensions` and, in the console
that opens, run `chrome.storage.local.get('xsh:mutes').then(console.log)`.

## Development

```
pnpm install
pnpm test            # node --test 'test/*.test.mjs'
pnpm run build       # rebuild dist/x-slop-hide.user.js from src/
pnpm run check       # userscript is current + parses + tests + server tests (what CI runs)
pnpm run package:store                     # Chrome Web Store zip of HEAD, into build/
node scripts/store-screenshots.mjs --chrome <chromium>   # redraw store/images/
```

- `scripts/package-store.mjs`: builds the store zip from a commit with
  `git archive`, holding only the files the extension loads plus `LICENSE`,
  and refuses a manifest with a `key`, a name over 75 or a description over
  132 characters, or a version that differs from `package.json`, and a zip
  with a missing or unparseable file. `--ref v0.5.0` zips a tag.
- `scripts/store-screenshots.mjs`: renders the store screenshots and promo
  tile in `store/images/` from the real extension on a local example page.
  `store/listing.md` has what to enter in the store dashboard.

- `src/lib.js`: pure logic, shared by every runtime and the tests: list
  parsing and validation, the update guard, author detection, the hide rule,
  the bot rows and tag hiding, and muting's rules (which menu item to click,
  the visit order, the daily caps and the mute record).
- `src/content.js`: the content script. It watches the page and marks the
  cells to hide, draws the **Hide as slop** buttons while labelling is on, and
  tells the worker, when asked, whether its tab is one the worker opened. In a
  tab the background worker opened for a visit, it runs
  that one job (mute the profile's account, or read `settings/muted/all`) and
  reports the result.
- `src/background.js`: the service worker. It fetches the feed and stores it,
  and, while muting is on, runs the visits: a 1-minute alarm, one background
  tab at a time, and a 90 s limit per tab. It also stores the labels.
- `src/popup.*`: the popup. `src/settings.*`: the settings page (lists,
  your accounts, sharing).
- `server/`: the readers' list server, a Cloudflare Worker with a D1
  database, and its tests (`node --test 'server/test/*.test.mjs'`, which CI
  runs). `server/test/roundtrip.test.mjs` runs the extension's own request
  and list code against it. How to run and deploy it is in
  [server/README.md](server/README.md).
- `src/userscript-adapter.js` and `scripts/build-userscript.mjs`: the
  userscript build, which concatenates `lib.js`, the adapter and `content.js`.
  The adapter has no visit jobs and no label storage, so the userscript hides
  but never mutes or labels.
  A release bumps `version` in `manifest.json` (and `package.json`), because
  userscript managers update only when it goes up.

The DOM tests run the real `content.js` against [linkedom](https://github.com/WebReflection/linkedom)
documents shaped like X's markup, including its profile and muted-accounts
pages and its ⋯ menu as seen on 2026-11-06. Their handles are made up. The
wiring tests run the real `background.js` against an in-memory `chrome`. None
of them can catch X changing its markup, so after a change to the selectors,
check on real x.com: load the extension, scroll a busy reply thread, and
confirm that each hidden post's `@handle` is on the list and that no listed
author's post is left showing.

## Testing

Hiding was checked on real x.com on 2026-11-03 (four pages, 0 mismatches), and
versions 0.2.0 to 0.5.0 ran in headless Chromium against fixture pages. Muting
has run in Brave on the maintainer's own account since 2026-11-07; 0.5.0's
labels and daily setting have not run in Brave yet. One unmute from 0.8.0's
page code ran on real x.com on 2026-11-18. 0.9.0's **Run now** has run against the
real worker and popup in Chromium with x.com unreachable, not yet on x.com.
Sharing has run in Chromium against the server on this machine (`wrangler
dev`), not yet against the deployed server or on x.com.
[docs/TESTING.md](docs/TESTING.md) has each run, its method and results, and
what has not been tested.

## Contributing

Reports, ideas and pull requests are welcome.
[Report a problem or suggest something](https://github.com/StartupBros-com/ai-anti-slop/issues/new/choose)
on GitHub, which needs a GitHub account. The popup and the settings page link
there too, with your version and browser filled in (0.9.0 and earlier do not
have the link). An account that shouldn't be on a list is a request for
whoever runs that list; see [Whose list is it?](#whose-list-is-it).

[CONTRIBUTING.md](CONTRIBUTING.md) covers setting up, the checks CI runs and
what a pull request needs. For anything non-trivial, open an issue first so we
can agree on the approach before you spend time on it. Report a security
problem privately instead; [SECURITY.md](SECURITY.md) says how.

## License

[MIT](LICENSE). The list is not part of this repository and is not covered by
this licence.
