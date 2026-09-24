// worker/src/stats.js — assembles the GET /v1/stats JSON document.
//
// Reads live data from Analytics Engine for the last 30 days, and, for
// launchesPerDay, backs off to the D1 nightly-rollup table for the 60 days
// before that (last 90 days total, per feature 573's plan). Probe rows are
// excluded everywhere: the launch validator's sentinel version (blob2 =
// '0.0.0'), the update-checked sentinel result (blob7 = 'probe'), and — as
// a belt-and-suspenders net that also covers update.installed, which has no
// sentinel field of its own — the probe's fixed install id.

import { runSql, DATASET, PROBE_INSTALL_ID } from "./query.js";

const NOT_PROBE_INSTALL = `index1 != '${PROBE_INSTALL_ID}'`;
const NOT_PROBE_VERSION = `blob2 != '0.0.0'`;
const NOT_PROBE_RESULT = `blob7 != 'probe'`;

function num(row, key) {
  return Number((row && row[key]) ?? 0);
}

async function installsWindow(env, days) {
  const sql =
    `SELECT count(DISTINCT index1) AS n FROM ${DATASET} ` +
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND ${NOT_PROBE_INSTALL}`;
  const rows = await runSql(env, sql);
  return num(rows[0], "n");
}

async function launchesByVersionChannel(env) {
  const sql =
    `SELECT blob2 AS version, blob4 AS channel, count() AS n FROM ${DATASET} ` +
    `WHERE blob1 = 'launch' AND ${NOT_PROBE_VERSION} AND ${NOT_PROBE_INSTALL} ` +
    `GROUP BY blob2, blob4 ORDER BY n DESC`;
  const rows = await runSql(env, sql);
  return rows.map((r) => ({ version: r.version, channel: r.channel, n: num(r, "n") }));
}

async function macosShare(env) {
  const sql =
    `SELECT blob5 AS macos, count() AS n FROM ${DATASET} ` +
    `WHERE blob1 = 'launch' AND ${NOT_PROBE_VERSION} AND ${NOT_PROBE_INSTALL} ` +
    `GROUP BY blob5 ORDER BY n DESC`;
  const rows = await runSql(env, sql);
  return rows.map((r) => ({ macos: r.macos, n: num(r, "n") }));
}

async function updatesInstalled(env) {
  // Alias as `to_build`, not `to` — the Analytics Engine SQL dialect doesn't
  // accept backtick- or double-quoted identifiers, so a bare `to` alias
  // collides with the SQL keyword.
  const sql =
    `SELECT blob8 AS to_build, count() AS n FROM ${DATASET} ` +
    `WHERE blob1 = 'update.installed' AND ${NOT_PROBE_INSTALL} ` +
    `GROUP BY blob8 ORDER BY n DESC`;
  const rows = await runSql(env, sql);
  return rows.map((r) => ({ to: r.to_build, n: num(r, "n") }));
}

async function updateChecks(env) {
  const sql =
    `SELECT blob7 AS result, count() AS n FROM ${DATASET} ` +
    `WHERE blob1 = 'update.checked' AND ${NOT_PROBE_RESULT} AND ${NOT_PROBE_INSTALL} ` +
    `GROUP BY blob7 ORDER BY n DESC`;
  const rows = await runSql(env, sql);
  return rows.map((r) => ({ result: r.result, n: num(r, "n") }));
}

async function launchesPerDayFromAE(env) {
  const sql =
    `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, count() AS launches, ` +
    `count(DISTINCT index1) AS installs FROM ${DATASET} ` +
    `WHERE blob1 = 'launch' AND ${NOT_PROBE_VERSION} AND ${NOT_PROBE_INSTALL} ` +
    `AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`;
  const rows = await runSql(env, sql);
  return rows.map((r) => ({
    day: String(r.day).slice(0, 10),
    launches: num(r, "launches"),
    installs: num(r, "installs"),
  }));
}

// D1's per-row `installs` is count(DISTINCT index1) *within one
// (day, event, version, channel, macos, arch) group*; summing it across the
// groups for a day is an approximation (it can overcount an install that
// spans two groups on the same day, e.g. a channel switch). Acceptable at
// this dataset's volume; the live AE path for the last 30 days is exact.
async function launchesPerDayFromD1(env) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(n) AS launches, SUM(installs) AS installs FROM daily ` +
      `WHERE event = 'launch' AND day < date('now', '-30 days') AND day >= date('now', '-90 days') ` +
      `GROUP BY day ORDER BY day`,
  ).all();
  return (results ?? []).map((r) => ({
    day: r.day,
    launches: Number(r.launches ?? 0),
    installs: Number(r.installs ?? 0),
  }));
}

async function launchesPerDay(env) {
  const [fromD1, fromAE] = await Promise.all([launchesPerDayFromD1(env), launchesPerDayFromAE(env)]);
  const byDay = new Map();
  for (const row of fromD1) byDay.set(row.day, row);
  for (const row of fromAE) byDay.set(row.day, row); // AE wins on overlap; the two windows should not overlap by construction
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export async function buildStats(env) {
  const [installs1d, installs7d, installs30d, byVersionChannel, macos, updates, checks, perDay] = await Promise.all([
    installsWindow(env, 1),
    installsWindow(env, 7),
    installsWindow(env, 30),
    launchesByVersionChannel(env),
    macosShare(env),
    updatesInstalled(env),
    updateChecks(env),
    launchesPerDay(env),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    source: { live: "analytics_engine", history: "d1" },
    installs: { "1d": installs1d, "7d": installs7d, "30d": installs30d },
    launchesByVersionChannel: byVersionChannel,
    macosShare: macos,
    updatesInstalled: updates,
    updateChecks: checks,
    launchesPerDay: perDay,
  };
}
