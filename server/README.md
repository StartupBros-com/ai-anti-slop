# AI Anti-Slop crowd list server

A Cloudflare Worker with one D1 database. Installs of the AI Anti-Slop browser extension that opt in send reports, each saying that an X account's post is Slop (or Not slop, for a label saved by a version before 0.9.0). The Worker publishes the accounts that enough independent installs agree on as a plain NDJSON file. The extension reads that file as one source of its Recommended list. Tracking issues: StartupBros-com/ai-anti-slop#81, and #90 for one verdict per install and account.

An entry means "reported by N readers". It is not proof of anything about the account.

## When an account is listed

Each install holds one verdict on each account it has reported, Slop or Not slop, taken from its newest label on any of that account's posts ([below](#how-a-report-changes-a-verdict)). All of these must hold. The numbers live in one frozen `RULES` object in `src/core.js`, and the tests read them from there.

- At least 3 installs' verdicts on the account are Slop.
- The posts behind those verdicts are in at least 2 different threads (the post id of the page; a post with no thread counts its own status id as its thread), and the verdicts came from at least 2 different networks.
- An install counts only once its first report is at least 7 days old.
- A verdict counts only once its side, Slop or Not slop, has stood for 24 hours.
- The Slop verdicts are at least 3 times as many as the Not slop verdicts, both counted by those two rules.
- A verdict whose label was made more than 90 days ago is deleted at each build and never counted.
- While a removal request for the account stands (90 days), a Slop verdict counts only if its label was made on a later UTC day than the request.

After the rule runs, an operator's `delist` override always removes an account. Nothing adds an account by hand.

A network is the IPv4 /24 or the IPv6 /48 of the caller, stored only as a keyed hash.

### How a report changes a verdict

A label's day is the UTC day the extension says it was made (`day`), or the hour the report arrived when it sends no day, as 0.10.0 does. A day later than the arrival counts as the arrival hour, and a day more than 90 days back is rejected.

| The report | The install's verdict on that account |
|---|---|
| Its first on the account | Created. |
| The post the verdict holds, or the post of its newest label, sent again | Unchanged. |
| The other side, labelled on a later day (or on the same day, when it is Not slop) | Replaced by this report's post, thread, network and arrival hour, so its 24 hours start again. |
| The same side, another post, labelled later | The label's day moves forward, and this post is kept as the post of the newest label. The post, thread, network and arrival hour that put the verdict on its side stay, so more labels never lower an account's thread or network count, and the side's 24 hours do not start again. |
| Anything else: labelled before the verdict's day, or the same side on the same day | Unchanged. |

A retraction by post id deletes the verdict when that post is the verdict's post or the post of its newest label, so a cleared label's day never keeps counting; retracting any other post of the same account leaves the verdict and its day as they are. A retraction by handle deletes the install's verdict on that account, whichever posts it holds. 0.10.0 retracts by post id only, so a 0.10.0 reader who clears either of those labels loses that verdict even while keeping other labels on the account: the count can be lower than what readers keep, not higher.

## What is stored

- `reporter`: the first 32 hex characters of HMAC-SHA256(`HMAC_SECRET`, `"r:" + key`). The install key itself is never stored.
- `net`: the first 16 hex characters of HMAC-SHA256(`HMAC_SECRET`, `"n:" + prefix`), where prefix is `a.b.c` or the first three IPv6 hextets, taken from the `CF-Connecting-IP` header. The IP address is never stored. With no header (local dev) the prefix is `local`.
- A verdict row holds the reporter, the account's handle, the post's status id and its thread id, `latest` (the status id of the newest label's post), the label, the network, `at` (the hour its side last changed, rounded down) and `labeled` (the start of its newest label's UTC day, or the arrival hour). One row per install and account; older reports on the account are not kept.
- The hash of a post's words that 0.10.0 sends is checked for its form and not stored.
- No user agent, Referer or Origin is stored, and request bodies are not logged.
- A removal request stores the handle and the hour, nothing else; `reason` and `contact` fields are ignored.
- Each build deletes verdicts whose label was made more than 90 days ago, reporter rows with no verdict left whose `first_seen` is more than 90 days old, removal requests more than 90 days old, and counter rows older than 3 days.
- Counters, per UTC day: `report` per reporter, `new_install` and `removal` per network, `report_all` for every report accepted, and `removal_all` for every removal request taken.
- With `HMAC_SECRET` unset, every write endpoint returns 503. Changing the secret later makes every stored reporter and network id unmatchable, so installs would look new.

## Endpoints

Every response carries `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff`. `OPTIONS` on any path returns 204 with the allowed methods, headers and a one day max age. Write bodies are read as text whatever the content type and parsed as JSON, so the extension can send `text/plain` and skip the preflight. Bodies over 32,768 bytes get 413. Unknown paths get a 404 JSON body.

| Endpoint | What it does |
|---|---|
| `POST /v1/reports` | `{v:1, key, reports:[{label, handle, status, thread, day}]}`, 1 to 50 items. `key` is 32 lowercase hex characters. `day` is optional, `YYYY-MM-DD`; a 0.10.0 item also carries `hash`, which is checked and dropped. An invalid item goes in `rejected` and is not fatal. Returns `{ok, accepted, rejected, deferred, retryAfter?}`. A new install from a network that already started 10 installs today gets 429. Each install may write 100 reports per UTC day, and all installs together 6,000; the rest are returned as `deferred`, with `retryAfter` the milliseconds to the next UTC midnight. Each limit is a counter bumped with `INSERT ... ON CONFLICT ... RETURNING n` before the decision, and the part not taken is subtracted again, so requests at the same moment cannot all pass. |
| `POST /v1/retract` | `{v:1, key, statuses:[...], handles:[...]}`, up to 50 of each and at least one in all; `handles` is optional. A status deletes this install's verdict whose post or newest label's post it is, a handle its verdict on that account. Returns `{ok, removed}`; an unknown key gives `removed: 0`. |
| `POST /v1/forget` | `{v:1, key}`. Deletes every verdict of this install and its reporter row. Returns `{ok, removed}`. |
| `GET /v1/list.ndjson` | The latest built list, one line per account sorted by handle: `{"username":"...","reporters":3,"since":"YYYY-MM-DD"}`. Empty body when nothing is listed. After a build: `Cache-Control: public, max-age=600`, an `ETag` of the build time, and the Workers Cache API for 600 seconds. Before the first build: an empty body with `Cache-Control: no-store`, not cached, so the first build shows at once. |
| `GET /v1/changes?limit=N` | Builds that added or removed something, newest first: `[{at, count, added, removed}]`. N is 1 to 100, default 20. |
| `GET /v1/status` | `{ok, listed, reporters, builtAt}`. The counts are written at each build, so a public caller cannot trigger a table scan; before the first build `reporters` is counted live (that table is small). |
| `GET /` | A small page that explains the list and the rule and has the removal form. |
| `POST /v1/removal` | Form or JSON: `handle`. For an account that is not listed it stores nothing and answers `unlisted`; for one whose request still stands (90 days) it stores nothing and answers `standing` with that request's day. Otherwise the request is stored (`taken`): the account leaves the list at the next build, and until the request is 90 days old only Slop labels made on later UTC days count for it. 5 taken requests per network per UTC day and 50 in all, then 429. Forms get a page saying which of the three happened, JSON gets `{ok, handle, state, since?}`. |

Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`. The token is compared in constant time. With `ADMIN_TOKEN` unset they return 404; with a missing or wrong token they return 401.

| Endpoint | What it does |
|---|---|
| `POST /v1/admin/override` | `{handle, action:"delist"\|"clear", note}`, then rebuilds at once. |
| `POST /v1/admin/rebuild` | Rebuilds now. |
| `GET /v1/admin/candidates?limit=N` | Accounts with any Slop verdict: `slop_reporters` (aged installs past the 24 hour wait, after a standing removal request, as the rule counts them), `slop_reporters_all`, `not_slop_reporters`, `threads`, `nets`, `newest` (the latest Slop label's day), `listed`, `override`, `removal_requested` (the standing request's hour). Most reported first. |

## How the build works

A Cron Trigger runs `17 */6 * * *`, and the admin endpoints run the same code. `build()` in `src/core.js` sends one `db.batch` so it is atomic: delete expired verdicts, prune old reporter rows and removal requests past 90 days, delete counters older than 3 days, fill `next_listed` from the rule and the delist overrides (keeping `since` for accounts already listed), insert a `changes` row only when something was added or removed, write to `listed` only the rows that differ from `next_listed` (deletes, `reporters` updates and inserts), empty `next_listed`, and write the NDJSON body, the stats and the build time to `meta`. The rule query reads `reports` through `reports_handle`, so its rows come in handle order and the grouping needs no sort. D1 counts the index rows it reads, about one per verdict (measured below); on the per-report table before #90, a plain table scan plus the sort read about two per report. All counting is done in SQL, because a Worker on the free plan has 10 ms of CPU per call and D1 query time does not count against it.

The cached list file can lag a cron build by up to 10 minutes. An admin override or rebuild also clears the cache entry in the colo that served it, so it shows at once there.

The whole list is one `meta` value, and D1 allows 2,000,000 bytes per value. A line is about 60 bytes, so the file fits roughly 30,000 accounts.

## Run it locally

```
cd server
pnpm install
printf 'HMAC_SECRET=dev-secret\nADMIN_TOKEN=dev-token\n' > .dev.vars   # git-ignored
pnpm exec wrangler d1 migrations apply ai-anti-slop --local
pnpm exec wrangler dev --local --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=17+*/6+*+*+*'
```

Tests need no Cloudflare account. They run over a small D1 stand-in on `node:sqlite` (Node 22, as CI runs them, or later). From the repository root:

```
node --test 'server/test/*.test.mjs'
```

## Deploy

Deployed on 2026-11-21 at `ai-anti-slop.startupbros.com`, a Workers custom domain, with the cron above. The hostname is permanent once an extension release names it. The custom domain's IPv6 records were published at once and its IPv4 record about 4 minutes later, so a new deploy may answer only over IPv6 at first.

These are the steps that first deploy took. A fork deploying its own server does the same with its own database and hostname.

1. `pnpm exec wrangler login`
2. Once: `pnpm exec wrangler d1 create ai-anti-slop`, then put the printed `database_id` in `wrangler.jsonc`.
3. `pnpm exec wrangler d1 migrations apply ai-anti-slop --remote`
4. The first deploy uploads the two secrets with it: `pnpm exec wrangler deploy --secrets-file <file>`, where the file is JSON, `{"HMAC_SECRET": "…", "ADMIN_TOKEN": "…"}`, with long random values. Keep a copy of `HMAC_SECRET` somewhere safe, then delete the file. `pnpm exec wrangler secret list` shows both as `secret_text`. Later deploys are `pnpm exec wrangler deploy`; secrets stay.
5. Save the admin token in `~/.config/ai-anti-slop/admin-token` (or export `ANTISLOP_ADMIN_TOKEN`) for the CLI below.

## Admin CLI

`node admin.mjs [--base URL] <command>`. The base defaults to `https://ai-anti-slop.startupbros.com`. The token is read from `ANTISLOP_ADMIN_TOKEN`, else from `~/.config/ai-anti-slop/admin-token`, and is never printed.

```
status
candidates [--limit N]
delist <handle> [note]
clear <handle>
rebuild
```

## Free plan arithmetic

Limits on the free plans: Workers allow 100,000 requests a day and 10 ms of CPU per call (cron included); D1 allows 5,000,000 rows read and 100,000 rows written a day, 500 MB per database (5 GB per account), 30 seconds per query, and 50 queries per call, where a `db.batch` counts as one. The row limits are per Cloudflare account, so other D1 databases on the same account use them up too. Since 2026-09-01, an account past either daily row limit gets an error on every D1 query until midnight UTC. Here that means reports answer 500 and the extension keeps them for a retry 30 minutes later, and a list download that misses the cache answers 500 and the extension keeps its last copy of the readers' list.

**Measured, not estimated.** On 2026-11-22 a local D1 database (wrangler 4.158.0, workerd's SQLite) was filled to the most the code allows. `REPORTS_PER_DAY` accepts 6,000 reports a day, so 90 days bring 540,000, and the seed made every one its own install and account, the most verdict rows those reports can leave. It had 1,050 installs (1,000 aged), 500 accounts with 216 installs each, 214,500 with 2 each and 1,000 with 3 each, 5% Not slop, 25 standing removal requests and one delist override, and the first build listed 1,169 accounts. Every statement of `build()` and of the requests ran through the real D1 binding (wrangler's `getPlatformProxy`), which returns D1's own `rows_read` and `rows_written`. The same run checked the verdict upsert on workerd: the same post sent again and an older label wrote nothing, a newer label on the other side replaced the row, and a removal request took its account off at the next build. The times vary from run to run. Cloudflare's metrics on the deployed database have not been seen yet, so compare them after the first week.

| | Rows read | Rows written | Time |
|---|---|---|---|
| A build, first (nothing listed yet) | 592,043 | 20,153 | 1.7 s |
| A build, steady (6 hours later) | 582,786 | 2,620 | 1.4 s |
| A report request, new install, 5 new verdicts | 3 | 28 | |
| A report request, known install, 2 new verdicts and 3 later labels on the same side | 8 | 16 | |
| A report request that changes nothing (the same post again) | 4 | 4 | |
| A removal request | 3 | 5 | |
| `GET /v1/list.ndjson` not in the cache, or `GET /v1/status` | 4 | 0 | |

Where the steady build's writes go: 2,346 for staging and emptying `next_listed` (two per listed account, as it is `WITHOUT ROWID`), 267 for `listed` rows that were added or whose count changed, 6 for `meta`, and 1 for `changes`. It deleted no verdicts, because a label is dated by its day: one day's labels, at most 6,000, expire at the first build after each UTC midnight, one row written each. The first build's 14,590 deletions are that, for the seed's labels past 90 days. A new verdict is 4 rows written (the row and its three index entries), a later label on the same side or a change of side 2, and the same post again 0; a counter is 2 when it is new and 1 after.

A day at that ceiling, with 1,000 installs sharing:

- **Rows read:** four builds are about 2,330,000; requests add tens of thousands. That is under half of 5,000,000. An admin override or rebuild runs a whole build, about 584,000 more, so about four of them fit in a day at the ceiling.
- **Rows written:** at most 24,000 for the day's 6,000 reports (fewer when they are later labels on accounts an install already has a verdict on), 2,400 to 12,000 for counters (2 per request, so more when installs send fewer reports at a time), about 10,500 for four builds and up to 6,000 for the day's expired verdicts, and a few hundred for new installs: about 43,000 to 53,000, half of 100,000.
- **Requests:** at most 6,000 report requests, about 4,000 list downloads (each install every 6 hours; a cached answer still runs the Worker), a few hundred other calls and 4 cron runs: under 11,000 of 100,000. CPU per call was not measured; the counting is in SQL, whose time is D1's, not the Worker's.
- **Storage:** the database file was 66.7 MB at 525,417 verdicts, about 127 bytes each, against the 500 MB cap.
- **Query time:** the longest statement, the rule, took 1.1 to 1.6 s on this machine, against the 30 s limit.

Rows written move first as the list grows: each 1,000 more listed accounts adds about 8,000 written a day (two rows per build, four builds), so the free plan holds the cap with up to about 6,000 listed accounts. Move to the $5 Workers Paid plan when D1's metrics show rows written near 80,000 or rows read near 4,000,000 a day, when the `report_all` counter reaches 6,000 on most days (reports then wait for the next UTC day), or when the list passes about 5,000 accounts. Before paying, a lower `EXPIRY_DAYS` cuts the reads and the stored verdicts in proportion.
