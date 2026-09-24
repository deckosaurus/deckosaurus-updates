// Deckosaurus telemetry Worker — feature 567 Phase 1.
//
// Accepts ONE shape: POST /v1/event with a small JSON object, and writes one
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
// Analytics Engine layout (what Scripts/telemetry-stats.py reads):
//   index1  = installId          (sampling is per install, never per event)
//   blob1   = event
//   blob2   = version   blob3 = build   blob4 = channel
//   blob5   = macOSVersion   blob6 = arch
//   blob7   = result | from   blob8 = to
//   double1 = 1

const PRIVACY_URL = "https://updates.deckosaurus.com/privacy.html";
const MAX_BODY_BYTES = 2048;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        "Deckosaurus telemetry endpoint. Anonymous, opt-out; what is sent and why: " + PRIVACY_URL + "\n",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }
    if (url.pathname !== "/v1/event") return new Response("not found\n", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed\n", { status: 405, headers: { allow: "POST" } });

    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) return bad("body too large");
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return bad("body too large");

    let body;
    try { body = JSON.parse(text); } catch { return bad("body must be JSON"); }
    const problem = validate(body);
    if (problem) return bad(problem);

    if (env.TELEMETRY) env.TELEMETRY.writeDataPoint(dataPoint(body));
    return new Response(null, { status: 204 });
  },
};
