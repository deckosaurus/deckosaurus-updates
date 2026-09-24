# Telemetry Worker

The Cloudflare Worker behind `https://telemetry.deckosaurus.com` — Deckosaurus feature 567 (write
side) + feature 573 (read side / dashboard). Split into modules under `src/`:

| file | what |
|---|---|
| `src/index.js` | routing; `POST /v1/event` (567, unchanged); wires up the routes below |
| `src/stats.js` | `GET /v1/stats` — assembles the JSON rollup from Analytics Engine + D1 |
| `src/query.js` | Analytics Engine SQL API client, `/v1/query` validation, shared constants |
| `src/rollup.js` | nightly D1 rollup (`rollupDay`, the 02:00 UTC cron, `POST /v1/rollup`) |
| `src/page.js` | `GET /stats` — the dashboard page (one inline HTML string, Chart.js from cdnjs) |
| `schema.sql` | the D1 `daily` table |

What `/v1/event` accepts, and what it never touches, is in the header comment of `src/index.js`;
the user-facing statement is `../privacy.html`. The Analytics Engine blob/index layout both
`/v1/event` and the read side agree on is documented there too.

## Routes

| route | method | who | what |
|---|---|---|---|
| `/v1/event` | POST | the app | unchanged (567) — validates and writes one Analytics Engine data point |
| `/v1/stats` | GET | dashboard, `make stats`, agents | one JSON document (installs 1/7/30d, launches by version×channel, macOS share, update funnel, update-check results, launches per day for the last 90 days); probe rows excluded; cached 5 min (`caches.default`, `Cache-Control: public, max-age=300`) |
| `/stats` | GET | a browser | the dashboard page; fetches `/v1/stats` client-side |
| `/v1/query` | POST | AI agents | `{"sql": "SELECT …"}` over the `deckosaurus_telemetry` dataset — disabled until `QUERY_ENABLED=1` (see below) |
| `/v1/rollup` | POST | cron, or on-demand | `?day=YYYY-MM-DD` — rolls that UTC day's Analytics Engine data into D1; gated by `QUERY_ENABLED=1` or the `X-Rollup-Key` header |

Errors from `/v1/stats`, `/v1/query` and `/v1/rollup` are a one-line JSON `{"error": "..."}` (400
for a bad request, 403 for not-authorized, 502 for an upstream Analytics Engine/D1 failure) — never
the token, never a stack trace.

## Secrets

Two Worker secrets, both piped in from the app's gitignored `Makefile.config` (or generated) —
**never** `cat` or `echo` the values:

```
grep '^CF_ANALYTICS_TOKEN' /Users/jscott/Developer/deck-factory-A/repo/app/deckosaurus/Makefile.config \
  | sed 's/^[^=]*= *//' \
  | wrangler secret put CF_ANALYTICS_TOKEN --config worker/wrangler.toml --env staging   # or no --env for production

openssl rand -hex 16 | wrangler secret put ROLLUP_KEY --config worker/wrangler.toml --env staging
```

`CF_ANALYTICS_TOKEN` authorizes the Analytics Engine SQL API
(`POST https://api.cloudflare.com/client/v4/accounts/1667c53851a35cdfa20adb0e7ce2337e/analytics_engine/sql`,
`Authorization: Bearer`), used by `/v1/stats`, `/v1/query` and the rollup. `ROLLUP_KEY` authorizes
an on-demand `POST /v1/rollup` via the `X-Rollup-Key` header when `QUERY_ENABLED` is `"0"`.

## `QUERY_ENABLED`

A `[vars]` entry, `"0"` by default in both `wrangler.toml` environments. `POST /v1/query` answers
403 while it is `"0"`; the owner sets it to `"1"` once Cloudflare Access is in front of the route
(see below) — that also becomes the standing authorization for `POST /v1/rollup`, so the
`X-Rollup-Key` header is only needed for a manual catch-up before Access/`QUERY_ENABLED` are on.

## D1 — nightly rollup

`daily(day, event, version, channel, macos, arch, installs, n)`, primary key
`(day, event, version, channel, macos, arch)` — one row per day/event/version/channel/macOS/arch
combination, `installs` = distinct install count within that group, `n` = row count. Created with:

```
wrangler d1 create deckosaurus-telemetry              # prints the database_id for wrangler.toml
wrangler d1 execute deckosaurus-telemetry --remote --file worker/schema.sql
```

The `[triggers] crons = ["0 2 * * *"]` cron runs `scheduled()` daily at 02:00 UTC, which rolls up
*yesterday* (UTC) via `rollupDay()` — delete-then-insert, so re-running a day is idempotent. A
missed night (or backfilling before the cron existed) is caught up with:

```
curl -X POST "https://telemetry.deckosaurus.com/v1/rollup?day=YYYY-MM-DD" -H "X-Rollup-Key: <the secret>"
```

`/v1/stats`' `launchesPerDay` reads D1 for days older than 30 days (up to 90 days back) and
Analytics Engine live for the last 30, merged by day — D1's per-day `installs` is an approximation
(`SUM` across that day's version/channel/macOS/arch groups, which can very slightly overcount an
install that changed group mid-day); the live 30-day window is exact.

## Access (owner step — not done by this Worker)

One Cloudflare Access application on `telemetry.deckosaurus.com`, two policies:
- `/stats*` and `/v1/stats` → allow the owner's email (one-time PIN).
- `/v1/query` → allow a service token (`deckosaurus-agent`); `QUERY_ENABLED` flips to `"1"` once
  the token exists.

`/v1/event` stays open — every install posts to it unauthenticated.

## Local dev / staging

```
wrangler deploy --config worker/wrangler.toml                        # production; from a Mac with `wrangler login`
wrangler deploy --config worker/wrangler.toml --env staging           # staging: workers.dev URL, no custom domain, same AE dataset + D1
worker/probe.sh                                                       # against the live production URL
worker/probe.sh https://deckosaurus-telemetry-staging.<subdomain>.workers.dev
wrangler dev --config worker/wrangler.toml --env staging              # local; then worker/probe.sh http://localhost:8787
```

`--env staging` needs `CF_ANALYTICS_TOKEN` and `ROLLUP_KEY` set on it too (see Secrets above, with
`--env staging`). Publishing a `workers_dev = true` Worker for the first time on this account needs
a one-time `workers.dev` subdomain registered at
`https://dash.cloudflare.com/1667c53851a35cdfa20adb0e7ce2337e/workers/onboarding` — the owner's
step; until then, `wrangler deploy --env staging` and `wrangler dev --remote` both fail with "You
need to register a workers.dev subdomain". `wrangler dev` (fully local, no `--remote`) still works
for iterating on routing/validation logic: Analytics Engine reads/writes are a plain `fetch()` to
Cloudflare's public API (so `/v1/stats`, `/v1/query` and the AE side of rollup see real data even
in local dev), while `env.DB` (D1) runs against a local emulated database unless `--remote` is used.
