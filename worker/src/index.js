// Deckosaurus telemetry Worker — feature 567 Phase 1 + feature 573 (dashboard).
//
// POST /v1/event accepts ONE shape: a small JSON object, and writes one
// Analytics Engine data point. It never reads the client IP (no
// `cf-connecting-ip`, no `request.cf`), never logs, never sets a cookie, and
// answers 204 with an empty body. Anything that is not exactly the documented
// shape is a 400 and is not written. GET / points at the privacy policy.
//
// Wire format (the app's TelemetryClient; the lab's JSONL line is the spec):
//   { "event": "launch", "installId": "<UUID>", "timestamp": "<ISO-8601>",
//     "version": "0.3.5", "build": "23", "channel": "stable",
//     "macOSVersion": "Version 27.0 (Build 27A266a)", "arch": "arm64" }
//   { "event": "update.checked",   ..., "result": "up-to-date" }
//   { "event": "update.installed", ..., "from": "21", "to": "23" }
//
// Analytics Engine layout (what Scripts/telemetry-stats.py and worker/src/stats.js read):
//   index1  = installId          (sampling is per install, never per event)
//   blob1   = event
//   blob2   = version   blob3 = build   blob4 = channel
//   blob5   = macOSVersion   blob6 = arch
//   blob7   = result | from   blob8 = to
//   double1 = 1
//
// Feature 573 adds the read side on the same Worker:
//   GET  /v1/stats   — JSON rollup for the dashboard / `make stats`, cached 5 min
//   GET  /stats      — the dashboard page (src/page.js), reads /v1/stats client-side
//   POST /v1/query   — ad hoc SELECT over the dataset, disabled by default (QUERY_ENABLED)
//   POST /v1/rollup  — on-demand nightly-rollup catch-up (day=YYYY-MM-DD)
//   scheduled()      — the 02:00 UTC cron: rolls up yesterday (UTC) into D1
//
// probe.sh's sentinel install id (11111111-2222-4333-8444-555555555555) and
// its version "0.0.0" / result "probe" are written by /v1/event like any
// other row (that is the point of the probe) but excluded from every read
// path in stats.js / rollup.js.

import { buildStats } from "./stats.js";
import { renderStatsPage } from "./page.js";
import { runSql, validateQuery, capLimit } from "./query.js";
import { rollupDay, yesterdayUTC, isValidDay } from "./rollup.js";

const PRIVACY_URL = "https://updates.deckosaurus.com/privacy.html";
const MAX_BODY_BYTES = 2048;
const MAX_QUERY_BODY_BYTES = 8192;
const MAX_FIELD_CHARS = 64;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const COMMON = ["event", "installId", "timestamp"];
const EVENTS = {
  "launch": ["version", "build", "channel", "macOSVersion", "arch"],
  "update.checked": ["result"],
  "update.installed": ["from", "to"],
};

function bad(reason) {
  return new Response(reason + "\n", { status: 400, headers: { "content-type": "text/plain" } });
}

function badJson(reason) {
  return new Response(JSON.stringify({ error: reason }), { status: 400, headers: { "content-type": "application/json" } });
}

function forbiddenJson(reason) {
  return new Response(JSON.stringify({ error: reason }), { status: 403, headers: { "content-type": "application/json" } });
}

// Errors from Analytics Engine / D1 become a one-line JSON 502. err.message
// is always a short, token-free string (see query.js) — never the raw
// upstream body or a stack trace.
function upstreamErrorJson(err) {
  const message = (err && err.message) || "upstream query failed";
  return new Response(JSON.stringify({ error: message }), { status: 502, headers: { "content-type": "application/json" } });
}

export function validate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const fields = EVENTS[body.event];
  if (!fields) return "unknown event";
  const allowed = new Set([...COMMON, ...fields]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return "unexpected field: " + key;
    const value = body[key];
    if (typeof value !== "string") return "field must be a string: " + key;
    if (value.length === 0 || value.length > MAX_FIELD_CHARS) return "field length out of range: " + key;
  }
  for (const key of [...COMMON, ...fields]) {
    if (!(key in body)) return "missing field: " + key;
  }
  if (!UUID.test(body.installId)) return "installId must be a UUID";
  if (Number.isNaN(Date.parse(body.timestamp))) return "timestamp must be ISO-8601";
  return null;
}

export function dataPoint(body) {
  return {
    indexes: [body.installId],
    blobs: [
      body.event,
      body.version ?? "",
      body.build ?? "",
      body.channel ?? "",
      body.macOSVersion ?? "",
      body.arch ?? "",
      body.result ?? body.from ?? "",
      body.to ?? "",
    ],
    doubles: [1],
  };
}

async function handleEvent(request, env) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return bad("body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return bad("body too large");

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("body must be JSON");
  }
  const problem = validate(body);
  if (problem) return bad(problem);

  if (env.TELEMETRY) env.TELEMETRY.writeDataPoint(dataPoint(body));
  return new Response(null, { status: 204 });
}

// The Worker keeps ONE copy for 5 minutes (cache API, keyed on the bare path so a cache-busting
// query string from the page still hits it); the CLIENT is told not to cache at all. The zone's
// Browser Cache TTL otherwise rewrote our max-age=300 to 14400 (measured), and a dashboard that
// shows four-hour-old numbers is worse than one that waits a second.
const STATS_TTL_SECONDS = 300;
const CLIENT_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
async function handleStats(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL("/v1/stats", request.url).toString(), { method: "GET" });
  const cached = await cache.match(key);
  if (cached) return new Response(cached.body, { status: 200, headers: CLIENT_HEADERS });
  let stats;
  try {
    stats = await buildStats(env);
  } catch (err) {
    return upstreamErrorJson(err);
  }
  const body = JSON.stringify(stats);
  ctx.waitUntil(cache.put(key, new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, s-maxage=${STATS_TTL_SECONDS}` },
  })));
  return new Response(body, { status: 200, headers: CLIENT_HEADERS });
}

async function handleQuery(request, env) {
  if (env.QUERY_ENABLED !== "1") return forbiddenJson("query route is disabled");

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_QUERY_BODY_BYTES) return badJson("body too large");
  const text = await request.text();
  if (text.length > MAX_QUERY_BODY_BYTES) return badJson("body too large");

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return badJson("body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badJson("body must be a JSON object");

  const problem = validateQuery(body.sql);
  if (problem) return badJson(problem);

  const sql = capLimit(body.sql);
  let rows;
  try {
    rows = await runSql(env, sql);
  } catch (err) {
    return upstreamErrorJson(err);
  }
  return new Response(JSON.stringify({ rows, rowCount: rows.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleRollup(request, env) {
  const url = new URL(request.url);
  const day = url.searchParams.get("day");

  const authorized = env.QUERY_ENABLED === "1" || (env.ROLLUP_KEY && request.headers.get("x-rollup-key") === env.ROLLUP_KEY);
  if (!authorized) return forbiddenJson("not authorized");
  if (!isValidDay(day)) return badJson("day query param is required, as YYYY-MM-DD");

  let rows;
  try {
    rows = await rollupDay(env, day);
  } catch (err) {
    return upstreamErrorJson(err);
  }
  return new Response(JSON.stringify({ ok: true, day, rows }), { status: 200, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        "Deckosaurus telemetry endpoint. Anonymous, opt-out; what is sent and why: " + PRIVACY_URL + "\n",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }

    if (url.pathname === "/v1/stats") {
      if (request.method !== "GET") return new Response("method not allowed\n", { status: 405, headers: { allow: "GET" } });
      return handleStats(request, env, ctx);
    }

    if (url.pathname === "/stats") {
      if (request.method !== "GET") return new Response("method not allowed\n", { status: 405, headers: { allow: "GET" } });
      return new Response(renderStatsPage(), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/v1/query") {
      if (request.method !== "POST") return new Response("method not allowed\n", { status: 405, headers: { allow: "POST" } });
      return handleQuery(request, env);
    }

    if (url.pathname === "/v1/rollup") {
      if (request.method !== "POST") return new Response("method not allowed\n", { status: 405, headers: { allow: "POST" } });
      return handleRollup(request, env);
    }

    if (url.pathname !== "/v1/event") return new Response("not found\n", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed\n", { status: 405, headers: { allow: "POST" } });
    return handleEvent(request, env);
  },

  // The 02:00 UTC cron (see [triggers] in wrangler.toml): roll up yesterday
  // (UTC) into D1. Idempotent — POST /v1/rollup?day= re-runs any missed day.
  async scheduled(event, env, ctx) {
    const day = yesterdayUTC(new Date(event.scheduledTime));
    ctx.waitUntil(rollupDay(env, day));
  },
};
