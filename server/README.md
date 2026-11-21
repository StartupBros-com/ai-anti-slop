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

A Cron Trigger runs `17 */6 * * *`, and the admin endpoints run the same code. `build()` in `src/core.js` sends one `db.batch` so it is atomic: delete expired reports, prune old reporter rows and closed removal requests, delete counters older than 3 days, fill `next_listed` from the rule and the overrides (keeping `since` for accounts already listed), insert a `changes` row only when something was added or removed, write to `listed` only the rows that differ from `next_listed` (deletes, `reporters` updates and inserts), empty `next_listed`, and write the NDJSON body, the stats and the build time to `meta`. The rule query reads `reports` once as a plain table scan (`NOT INDEXED`); an index scan would cost a table lookup per row as well. All counting is done in SQL, because a Worker on the free plan has 10 ms of CPU per call and D1 query time does not count against it.

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

Limits on the free plans: Workers allow 100,000 requests a day and 10 ms of CPU per call (cron included); D1 allows 5,000,000 rows read and 100,000 rows written a day, and 5 GB stored.

How rows are counted below: D1 bills every row a statement scans as read, and every table row and index entry it changes as written. A report insert or delete changes 4 rows (the table row, its primary key entry, `reports_label_at` and `reports_handle`). A counter insert is 2 rows and a counter update 1. `next_listed` is `WITHOUT ROWID`, so a staged row is 1. The plans behind these numbers are SQLite's own `EXPLAIN QUERY PLAN`, run against the migration under `node:sqlite`, and the same statements ran under `wrangler dev`. D1's metrics on the deployed database have not been seen yet, so check them after the first week.

The worst case the code allows: `REPORTS_PER_DAY` accepts at most 6,000 reports a day from all installs together, so 90 days hold at most 540,000 reports. Assumed with it: 1,000 installs, every one sharing, about 5 report requests each a day, and 500 listed accounts with 2% of them changing per build.

- **Requests:** about 5,000 report requests, 4,000 list downloads (each install every 6 hours; the cached answer still runs the Worker), a few hundred other calls and 4 cron runs. About 10,000 a day, a tenth of the limit.
- **CPU:** a request does two HMACs, a few small queries and a JSON parse; the counting is in SQL, whose time is D1's, not the Worker's. Not measured on the deployed Worker.
- **Rows read:** a build scans `reports` once (540,000), `reporters` twice (2,000), the expiring reports through the index (12,000), the counters (about 4,400) and the listed accounts a few times over (about 6,000): about 566,000. Four builds a day are about 2,300,000 with the requests, under half the limit.
- **Rows written:** 24,000 for the day's report inserts and 24,000 for the day's expiry deletes, about 11,000 for the per-install and global counters, about 2,000 for the counter purge, 4,000 for staging `next_listed` (1,000 rows a build) and under 200 for `listed`, `meta` and `changes`. About 65,000 a day, two thirds of the limit.
- **Storage:** a report is roughly 250 bytes with its three index entries, so 540,000 are about 135 MB, far under 5 GB.

Rows written move first. Each extra 1,000 reports a day adds about 9,000 written (insert, expiry and counter), so the free plan holds the cap up to about 9,000; each extra 1,000 listed accounts adds about 8,000 written a day (two rows per build, four builds). Move to the $5 Workers Paid plan when the D1 metrics show rows written near 80,000 a day, when the `report_all` counter reaches 6,000 on most days (reports then wait for the next UTC day), or when the list passes about 3,000 accounts. Before paying, a lower `EXPIRY_DAYS` cuts reads and the steady-state expiry deletes in proportion.
