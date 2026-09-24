-- Deckosaurus telemetry Worker — D1 schema (feature 573).
-- Apply with: wrangler d1 execute deckosaurus-telemetry --remote --file worker/schema.sql
--
-- One row per (day, event, version, channel, macos, arch) combination,
-- written nightly by rollup.js's rollupDay(). `installs` is
-- count(DISTINCT installId) within that group; `n` is the row count.
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  macos TEXT NOT NULL,
  arch TEXT NOT NULL,
  installs INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, event, version, channel, macos, arch)
);
