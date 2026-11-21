# AI Anti-Slop crowd list server

A Cloudflare Worker with one D1 database. Installs of the AI Anti-Slop browser extension that opt in send reports, each saying that an X account's post is Slop (or Not slop, for a label saved by a version before 0.9.0). The Worker publishes the accounts that enough independent installs agree on as a plain NDJSON file. The extension reads that file as one source of its Recommended list. Tracking issue: StartupBros-com/ai-anti-slop#81.

An entry means "reported by N readers". It is not proof of anything about the account.

## When an account is listed

All of these must hold. The numbers live in one frozen `RULES` object in `src/core.js`, and the tests read them from there.

- At least 3 different installs reported the account as Slop.
- Those reports cover at least 2 different threads (the post id of the page; a report with no thread counts its own status id as its thread) and come from at least 2 different networks.
- An install counts only once its first report is at least 7 days old.
- A report, Slop or Not slop, counts only once it is at least 24 hours old.
- The Slop reporters are at least 3 times as many as the Not slop reporters, both counted by those two rules.
- Reports older than 90 days are deleted at each build and never counted.

After the rule runs, the operator's overrides apply: `delist` always removes an account and `list` always adds one.

A network is the IPv4 /24 or the IPv6 /48 of the caller, stored only as a keyed hash.

## What is stored

- `reporter`: the first 32 hex characters of HMAC-SHA256(`HMAC_SECRET`, `"r:" + key`). The install key itself is never stored.
- `net`: the first 16 hex characters of HMAC-SHA256(`HMAC_SECRET`, `"n:" + prefix`), where prefix is `a.b.c` or the first three IPv6 hextets, taken from the `CF-Connecting-IP` header. The IP address is never stored. With no header (local dev) the prefix is `local`.
- Report times are rounded down to the hour.
- No user agent, Referer or Origin is stored, and request bodies are not logged.
- A removal request stores the handle, the optional reason and contact text the person typed, and the hashed network.
- Each build deletes reports older than 90 days, reporter rows with no report left whose `first_seen` is more than 90 days old, removal requests marked `done` or `rejected` that arrived more than 90 days ago, and counter rows older than 3 days. Open removal requests are kept.
- Counters, per UTC day: `report` per reporter, `new_install` and `removal` per network, and `report_all` for every report accepted.
- With `HMAC_SECRET` unset, every write endpoint returns 503. Changing the secret later makes every stored reporter and network id unmatchable, so installs would look new.

## Endpoints

Every response carries `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff`. `OPTIONS` on any path returns 204 with the allowed methods, headers and a one day max age. Write bodies are read as text whatever the content type and parsed as JSON, so the extension can send `text/plain` and skip the preflight. Bodies over 32,768 bytes get 413. Unknown paths get a 404 JSON body.

| Endpoint | What it does |
|---|---|
| `POST /v1/reports` | `{v:1, key, reports:[{label, handle, status, thread, hash}]}`, 1 to 50 items. `key` is 32 lowercase hex characters. An invalid item goes in `rejected` and is not fatal. Returns `{ok, accepted, rejected, deferred, retryAfter?}`. A new install from a network that already started 10 installs today gets 429. Each install may write 100 reports per UTC day, and all installs together 6,000; the rest are returned as `deferred`, with `retryAfter` the milliseconds to the next UTC midnight. Each limit is a counter bumped with `INSERT ... ON CONFLICT ... RETURNING n` before the decision, and the part not taken is subtracted again, so requests at the same moment cannot all pass. |
| `POST /v1/retract` | `{v:1, key, statuses:[...]}`, up to 50. Deletes this install's reports for those statuses. Returns `{ok, removed}`; an unknown key gives `removed: 0`. |
| `POST /v1/forget` | `{v:1, key}`. Deletes every report of this install and its reporter row. Returns `{ok, removed}`. |
| `GET /v1/list.ndjson` | The latest built list, one line per account sorted by handle: `{"username":"...","reporters":3,"since":"YYYY-MM-DD"}`. Empty body when nothing is listed. After a build: `Cache-Control: public, max-age=600`, an `ETag` of the build time, and the Workers Cache API for 600 seconds. Before the first build: an empty body with `Cache-Control: no-store`, not cached, so the first build shows at once. |
| `GET /v1/changes?limit=N` | Builds that added or removed something, newest first: `[{at, count, added, removed}]`. N is 1 to 100, default 20. |
| `GET /v1/status` | `{ok, listed, reporters, builtAt}`. The counts are written at each build, so a public caller cannot trigger a table scan; before the first build `reporters` is counted live (that table is small). |
| `GET /` | A small page that explains the list and the rule and has the removal form. |
| `POST /v1/removal` | Form or JSON: `handle`, optional `reason` (up to 1,000 characters), optional `contact` (up to 200). Stored as `open`; it never delists by itself. 5 per network per UTC day, then 429. Forms get a thank-you page, JSON gets `{ok, id}`. |

Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`. The token is compared in constant time. With `ADMIN_TOKEN` unset they return 404; with a missing or wrong token they return 401.

| Endpoint | What it does |
|---|---|
| `GET /v1/admin/removals?status=open` | Removal requests with that status (`open`, `done`, `rejected`). |
| `POST /v1/admin/removal` | `{id, status:"done"\|"rejected", note}`. |
| `POST /v1/admin/override` | `{handle, action:"delist"\|"list"\|"clear", note}`, then rebuilds at once. |
| `POST /v1/admin/rebuild` | Rebuilds now. |
| `GET /v1/admin/candidates?limit=N` | Accounts with any Slop report: `slop_reporters` (aged installs, past the 24 hour wait, as the rule counts them), `slop_reporters_all`, `not_slop_reporters`, `threads`, `nets`, `newest`, `listed`, `override`. Most reported first. |

## How the build works

A Cron Trigger runs `17 */6 * * *`, and the admin endpoints run the same code. `build()` in `src/core.js` sends one `db.batch` so it is atomic: delete expired reports, prune old reporter rows and closed removal requests, delete counters older than 3 days, fill `next_listed` from the rule and the overrides (keeping `since` for accounts already listed), insert a `changes` row only when something was added or removed, write to `listed` only the rows that differ from `next_listed` (deletes, `reporters` updates and inserts), empty `next_listed`, and write the NDJSON body, the stats and the build time to `meta`. The rule query reads `reports` through `reports_handle`, so its rows come in handle order and the grouping needs no sort. D1 counts the index rows it reads, about one per report; a plain table scan plus the sort read about two per report (measured below). All counting is done in SQL, because a Worker on the free plan has 10 ms of CPU per call and D1 query time does not count against it.

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

Nothing here is deployed yet. The hostname `ai-anti-slop.startupbros.com` waits on the operator's OK, and it is permanent once an extension release names it.

1. `pnpm exec wrangler login`
2. `pnpm exec wrangler d1 create ai-anti-slop`, then put the printed `database_id` in `wrangler.jsonc`.
3. `pnpm exec wrangler d1 migrations apply ai-anti-slop --remote`
4. `pnpm exec wrangler secret put HMAC_SECRET` and `pnpm exec wrangler secret put ADMIN_TOKEN`. Use long random values and keep a copy of `HMAC_SECRET` somewhere safe.
5. `pnpm exec wrangler deploy`
6. Save the admin token in `~/.config/ai-anti-slop/admin-token` (or export `ANTISLOP_ADMIN_TOKEN`) for the CLI below.

## Admin CLI

`node admin.mjs [--base URL] <command>`. The base defaults to `https://ai-anti-slop.startupbros.com`. The token is read from `ANTISLOP_ADMIN_TOKEN`, else from `~/.config/ai-anti-slop/admin-token`, and is never printed.

```
status
candidates [--limit N]
removals [--status open|done|rejected]
resolve <id> done|rejected [note]
delist <handle> [note]
list <handle> [note]
clear <handle>
rebuild
```

## Free plan arithmetic

Limits on the free plans: Workers allow 100,000 requests a day and 10 ms of CPU per call (cron included); D1 allows 5,000,000 rows read and 100,000 rows written a day, 500 MB per database (5 GB per account), 30 seconds per query, and 50 queries per call, where a `db.batch` counts as one. The row limits are per Cloudflare account, so other D1 databases on the same account use them up too. Since 2026-09-01, an account past either daily row limit gets an error on every D1 query until midnight UTC. Here that means reports answer 500 and the extension keeps them for a retry 30 minutes later, and a list download that misses the cache answers 500 and the extension keeps its last copy of the readers' list.

**Measured, not estimated.** On 2026-11-21 a local D1 database (wrangler 4.158.0, workerd's SQLite) was filled to the most the code allows: `REPORTS_PER_DAY` accepts 6,000 reports a day, so 90 days hold 540,000. The seed had 1,050 installs, 5% Not slop reports, 20% of reports on 500 accounts and the rest on 216,000 accounts with about 2 each, which listed 1,355 accounts. Every statement of `build()` and of the requests ran through the real D1 binding (wrangler's `getPlatformProxy`), which returns D1's own `rows_read` and `rows_written`. Cloudflare's metrics on the deployed database have not been seen yet, so compare them after the first week.

| | Rows read | Rows written | Time |
|---|---|---|---|
| A build, first (nothing listed yet) | 559,463 | 12,018 | 0.9 s |
| A build, steady (6 hours later) | 556,943 | 4,201 | 0.7 s |
| A report request, new install, 5 reports | 3 | 28 | |
| A report request, known install, 5 reports | 5 | 22 | |
| `GET /v1/list.ndjson` not in the cache, or `GET /v1/status` | 4 | 0 | |

Where the steady build's writes go: 1,482 for the reports past 90 days (one per deleted report), 2,711 for staging and emptying `next_listed` (two per listed account, as it is `WITHOUT ROWID`), and 8 for `meta` and `changes`. A report insert is 4 rows written (the row and its three index entries); a counter is 2 when it is new and 1 after.

A day at that ceiling, with 1,000 installs sharing:

- **Rows read:** four builds are about 2,230,000; requests add tens of thousands. That is under half of 5,000,000. An admin override or rebuild runs a whole build, about 557,000 more, so about four of them fit in a day at the ceiling.
- **Rows written:** 24,000 for the day's 6,000 reports, 2,400 to 12,000 for counters (2 per request, so more when installs send fewer reports at a time), 16,800 for four builds, and a few hundred for new installs: about 43,000 to 53,000, half of 100,000.
- **Requests:** at most 6,000 report requests, about 4,000 list downloads (each install every 6 hours; a cached answer still runs the Worker), a few hundred other calls and 4 cron runs: under 11,000 of 100,000. CPU per call was not measured; the counting is in SQL, whose time is D1's, not the Worker's.
- **Storage:** the database file was 103 MB at 532,836 reports, about 194 bytes each, against the 500 MB cap.
- **Query time:** the longest statement, the rule, took 0.7 to 0.9 s on this machine, against the 30 s limit.

Rows written move first as the list grows: each 1,000 more listed accounts adds about 8,000 written a day (two rows per build, four builds), so the free plan holds the cap with up to about 6,000 listed accounts. Move to the $5 Workers Paid plan when D1's metrics show rows written near 80,000 or rows read near 4,000,000 a day, when the `report_all` counter reaches 6,000 on most days (reports then wait for the next UTC day), or when the list passes about 5,000 accounts. Before paying, a lower `EXPIRY_DAYS` cuts the reads and the stored reports in proportion.
