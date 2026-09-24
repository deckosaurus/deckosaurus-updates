// worker/src/query.js — Analytics Engine SQL API client, shared by stats.js,
// rollup.js and the /v1/query route.
//
// The SQL API takes a raw SQL string as the POST body (not JSON) and
// returns `{"data": [...]}` with every column value serialized as a string
// — callers must cast with Number() where they expect a count. Errors
// thrown here are short and never include the bearer token.

const ACCOUNT_ID = "1667c53851a35cdfa20adb0e7ce2337e";
const SQL_API_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`;
const QUERY_TIMEOUT_MS = 10_000;

export const DATASET = "deckosaurus_telemetry";
export const PROBE_INSTALL_ID = "11111111-2222-4333-8444-555555555555";

// Run one SQL statement against the Analytics Engine SQL API. Throws an
// Error with a short, token-free message on any failure.
export async function runSql(env, sql) {
  if (!env.CF_ANALYTICS_TOKEN) throw new Error("analytics token not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SQL_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
      body: sql,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error("analytics query timed out");
    throw new Error("analytics query failed");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`analytics query failed: ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("analytics query returned bad JSON");
  }
  if (!json || !Array.isArray(json.data)) throw new Error("analytics query returned unexpected shape");
  return json.data;
}

// Validate a user-supplied /v1/query `sql` string. Returns null when valid,
// or a short reason string otherwise. Read-only: does not mutate `sql`.
export function validateQuery(sql) {
  if (typeof sql !== "string" || sql.length === 0) return "sql must be a non-empty string";
  const trimmed = sql.trim();
  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (body.includes(";")) return "only one statement is allowed";
  if (!/^select\b/i.test(body)) return "only SELECT is allowed";
  const forbidden = /\b(insert|update|delete|drop|alter|create|attach|pragma)\b/i;
  if (forbidden.test(body)) return "statement contains a forbidden keyword";
  if (/\bjoin\b/i.test(body)) return "JOIN is not allowed";
  const fromMatches = body.match(/\bfrom\b/gi) ?? [];
  if (fromMatches.length !== 1) return "exactly one FROM is required";
  const fromTable = body.match(/\bfrom\s+([a-zA-Z0-9_]+)/i);
  if (!fromTable || fromTable[1] !== DATASET) return `FROM must be ${DATASET}`;
  const limitMatch = body.match(/\blimit\s+(\d+)/i);
  if (limitMatch && Number(limitMatch[1]) > 1000) return "LIMIT must be 1000 or less";
  return null;
}

// Append `LIMIT 1000` when the query has none; otherwise return it unchanged
// (validateQuery has already confirmed any existing LIMIT is <= 1000).
export function capLimit(sql) {
  const trimmed = sql.trim();
  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (/\blimit\s+\d+/i.test(body)) return body;
  return `${body} LIMIT 1000`;
}
