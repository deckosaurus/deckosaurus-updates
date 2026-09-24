// worker/src/rollup.js — nightly rollup of Analytics Engine into D1.
//
// D1 carries history past Analytics Engine's retention window: table
// `daily(day, event, version, channel, macos, arch, installs, n)`, one row
// per (day, event, version, channel, macos, arch) combination. A day's rows
// are replaced wholesale on each run (delete-then-insert), so re-running the
// same day — the missed-night catch-up path — is idempotent.

import { runSql, DATASET, PROBE_INSTALL_ID } from "./query.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(day) {
  return typeof day === "string" && DAY_RE.test(day);
}

function utcDayString(date) {
  return date.toISOString().slice(0, 10);
}

// The UTC calendar day before `now` (default: the real current time), as
// used by the 02:00 UTC cron to roll up "yesterday".
export function yesterdayUTC(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDayString(d);
}

// Roll up one UTC day from Analytics Engine into D1. `day` must already be
// validated (isValidDay) by the caller. Returns the number of grouped rows
// written.
export async function rollupDay(env, day) {
  if (!isValidDay(day)) throw new Error("day must be YYYY-MM-DD");
  if (!env.DB) throw new Error("D1 binding DB not configured");

  const sql =
    `SELECT blob1 AS event, blob2 AS version, blob4 AS channel, blob5 AS macos, blob6 AS arch, ` +
    `count() AS n, count(DISTINCT index1) AS installs FROM ${DATASET} ` +
    `WHERE timestamp >= toDateTime('${day} 00:00:00') ` +
    `AND timestamp < toDateTime('${day} 00:00:00') + INTERVAL '1' DAY ` +
    `AND index1 != '${PROBE_INSTALL_ID}' ` +
    `GROUP BY event, version, channel, macos, arch`;
  const rows = await runSql(env, sql);

  await env.DB.prepare(`DELETE FROM daily WHERE day = ?`).bind(day).run();

  if (rows.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO daily (day, event, version, channel, macos, arch, installs, n) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = rows.map((r) =>
    stmt.bind(
      day,
      r.event ?? "",
      r.version ?? "",
      r.channel ?? "",
      r.macos ?? "",
      r.arch ?? "",
      Number(r.installs ?? 0),
      Number(r.n ?? 0),
    ),
  );
  await env.DB.batch(batch);
  return rows.length;
}
