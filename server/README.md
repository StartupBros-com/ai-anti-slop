# AI Anti-Slop crowd list server

A Cloudflare Worker with one D1 database. Installs of the AI Anti-Slop browser extension that opt in send reports, each saying that an X account's post is Slop (or Not slop, for a label saved by a version before 0.9.0). The Worker publishes the accounts that enough independent installs agree on as a plain NDJSON file. The extension reads that file as one source of its Recommended list. Tracking issue: StartupBros-com/ai-anti-slop#81.

An entry means "reported by N readers". It is not proof of anything about the account.

## When an account is listed

All of these must hold. The numbers live in one frozen `RULES` object in `src/core.js`, and the tests read them from there.

- At least 3 different installs reported the account as Slop.
- Those reports cover at least 2 different threads (the post id of the page; a report with no thread counts its own status id as its thread) and come from at least 2 different networks.
- An install counts only once its first report is at least 7 days old.
- A Slop report counts only once it is at least 24 hours old.
- The Slop reporters are at least 3 times as many as the aged installs that reported the account as Not slop. Not slop reports count at once, with no 24 hour wait.
- Reports older than 90 days are deleted at each build and never counted.

After the rule runs, the operator's overrides apply: `delist` always removes an account and `list` always adds one.

A network is the IPv4 /24 or the IPv6 /48 of the caller, stored only as a keyed hash.

## What is stored

- `reporter`: the first 32 hex characters of HMAC-SHA256(`HMAC_SECRET`, `"r:" + key`). The install key itself is never stored.
- `net`: the first 16 hex characters of HMAC-SHA256(`HMAC_SECRET`, `"n:" + prefix`), where prefix is `a.b.c` or the first three IPv6 hextets, taken from the `CF-Connecting-IP` header. The IP address is never stored. With no header (local dev) the prefix is `local`.
- Report times are rounded down to the hour.
- No user agent, Referer or Origin is stored, and request bodies are not logged.
- A removal request stores the handle, the optional reason and contact text the person typed, and the hashed network.
- With `HMAC_SECRET` unset, every write endpoint returns 503. Changing the secret later makes every stored reporter and network id unmatchable, so installs would look new.

## Endpoints

Every response carries `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff`. `OPTIONS` on any path returns 204 with the allowed methods, headers and a one day max age. Write bodies are read as text whatever the content type and parsed as JSON, so the extension can send `text/plain` and skip the preflight. Bodies over 32,768 bytes get 413. Unknown paths get a 404 JSON body.

| Endpoint | What it does |
|---|---|
| `POST /v1/reports` | `{v:1, key, reports:[{label, handle, status, thread, hash}]}`, 1 to 50 items. `key` is 32 lowercase hex characters. An invalid item goes in `rejected` and is not fatal. Returns `{ok, accepted, rejected, deferred, retryAfter?}`. A new install from a network that already started 10 installs today gets 429. Each install may write 100 reports per UTC day; the rest are returned as `deferred`. |
| `POST /v1/retract` | `{v:1, key, statuses:[...]}`, up to 50. Deletes this install's reports for those statuses. Returns `{ok, removed}`; an unknown key gives `removed: 0`. |
| `POST /v1/forget` | `{v:1, key}`. Deletes every report of this install and its reporter row. Returns `{ok, removed}`. |
| `GET /v1/list.ndjson` | The latest built list, one line per account sorted by handle: `{"username":"...","reporters":3,"since":"YYYY-MM-DD"}`. Empty body before the first build or when nothing is listed. `Cache-Control: public, max-age=600`, an `ETag` of the build time, and the Workers Cache API for 600 seconds. |
| `GET /v1/changes?limit=N` | Builds that added or removed something, newest first: `[{at, count, added, removed}]`. N is 1 to 100, default 20. |
| `GET /v1/status` | `{ok, listed, reports, reporters, builtAt}`. The counts are written at each build, so a public caller cannot trigger a table scan. |
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

A Cron Trigger runs `17 */3 * * *`, and the admin endpoints run the same code. `build()` in `src/core.js` sends one `db.batch` so it is atomic: delete expired reports, delete counters older than 3 days, fill `next_listed` from the rule and the overrides (keeping `since` for accounts already listed), insert a `changes` row only when something was added or removed, replace `listed` with `next_listed`, and write the NDJSON body and the build time to `meta`. All counting is done in SQL, because a Worker on the free plan has 10 ms of CPU per call and D1 query time does not count against it.

The cached list file can lag a cron build by up to 10 minutes. An admin override or rebuild also clears the cache entry in the colo that served it, so it shows at once there.

The whole list is one `meta` value, and D1 allows 2,000,000 bytes per value. A line is about 60 bytes, so the file fits roughly 30,000 accounts.

## Run it locally

```
cd server
pnpm install
printf 'HMAC_SECRET=dev-secret\nADMIN_TOKEN=dev-token\n' > .dev.vars   # git-ignored
pnpm exec wrangler d1 migrations apply ai-anti-slop --local
pnpm exec wrangler dev --local --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=17+*/3+*+*+*'
```

Tests need no Cloudflare account. They run over a small D1 stand-in on `node:sqlite` (Node 24). From the repository root:

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

Limits on the Workers Free plan: 100,000 requests a day and 10 ms of CPU per call (cron included); D1 allows 5,000,000 rows read and 100,000 rows written a day.

Assumptions: 1,000 installs, 3,000 reports a day, each install fetching the list about 6 times a day.

- Requests: about 3,000 report batches (usually fewer, since items are batched), 6,000 list fetches, a few hundred other calls, 8 cron runs. Around 10,000 a day, a tenth of the limit.
- CPU: a request does two HMACs, a few small queries and a JSON parse. That is well under 10 ms, though it has not been measured on the deployed Worker.
- Rows written: one report is a table row plus its index entries, counted as about 5 rows, so 3,000 reports are about 15,000. Counters add about the same number of requests again. A build rewrites a few hundred rows at most. Roughly 25,000 a day.
- Rows read: this is the limit that moves first. Each build scans the live reports once. At steady state there are 90 days of reports, about 270,000 rows, so 8 builds read about 2,200,000 rows, and about double that if each index entry counts as a row. That is close to 5,000,000. Local runs did not show how D1 counts this, so check the D1 metrics after the first week.

The $5 Workers Paid plan is needed when the D1 metrics show daily rows read near 4,000,000, which the arithmetic puts at a sustained 3,000 or more reports a day with 90 day retention, or when requests near 100,000 a day, which is roughly 5,000 installs. Before paying, running the cron every 6 hours halves the build reads, and cutting `EXPIRY_DAYS` cuts them in proportion.
