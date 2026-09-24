#!/bin/bash
# Probe the telemetry Worker: 204 on each good event, 400 on each bad shape.
# Usage: worker/probe.sh [base-url]   (default https://telemetry.deckosaurus.com;
#        use http://localhost:8787 against `wrangler dev --config worker/wrangler.toml`)
set -u
BASE="${1:-https://telemetry.deckosaurus.com}"
ID="11111111-2222-4333-8444-555555555555"
TS="2026-09-24T00:00:00Z"
FAIL=0
post() { curl -s -o /dev/null -w "%{http_code}" -X POST -H "content-type: application/json" --data "$2" "$BASE/v1/event"; }
check() { # name expected body
  local code; code=$(post "$1" "$3")
  if [ "$code" = "$2" ]; then echo "  ✓ $1 → $code"; else echo "  ✘ $1 → $code (expected $2)"; FAIL=1; fi
}
echo "probing $BASE"
check "launch"            204 "{\"event\":\"launch\",\"installId\":\"$ID\",\"timestamp\":\"$TS\",\"version\":\"0.0.0\",\"build\":\"0\",\"channel\":\"canary\",\"macOSVersion\":\"probe\",\"arch\":\"arm64\"}"
check "update.checked"    204 "{\"event\":\"update.checked\",\"installId\":\"$ID\",\"timestamp\":\"$TS\",\"result\":\"probe\"}"
check "update.installed"  204 "{\"event\":\"update.installed\",\"installId\":\"$ID\",\"timestamp\":\"$TS\",\"from\":\"0\",\"to\":\"0\"}"
check "wrong event"       400 "{\"event\":\"nope\",\"installId\":\"$ID\",\"timestamp\":\"$TS\"}"
check "non-UUID id"       400 "{\"event\":\"update.checked\",\"installId\":\"jscott\",\"timestamp\":\"$TS\",\"result\":\"x\"}"
check "extra field"       400 "{\"event\":\"update.checked\",\"installId\":\"$ID\",\"timestamp\":\"$TS\",\"result\":\"x\",\"user\":\"me\"}"
check "missing field"     400 "{\"event\":\"launch\",\"installId\":\"$ID\",\"timestamp\":\"$TS\"}"
check "oversize body"     400 "{\"event\":\"update.checked\",\"installId\":\"$ID\",\"timestamp\":\"$TS\",\"result\":\"$(printf 'x%.0s' $(seq 1 3000))\"}"
check "not JSON"          400 "hello"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/"); [ "$code" = "200" ] && echo "  ✓ GET / → 200" || { echo "  ✘ GET / → $code"; FAIL=1; }
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/event"); [ "$code" = "405" ] && echo "  ✓ GET /v1/event → 405" || { echo "  ✘ GET /v1/event → $code"; FAIL=1; }

# --- feature 573: /v1/stats, /stats, /v1/query, /v1/rollup ---

STATS_BODY=$(curl -s -w "\n%{http_code}" "$BASE/v1/stats")
STATS_CODE=$(echo "$STATS_BODY" | tail -1)
STATS_JSON=$(echo "$STATS_BODY" | sed '$d')
if [ "$STATS_CODE" = "200" ]; then
  missing=""
  for key in generatedAt source installs launchesByVersionChannel macosShare updatesInstalled updateChecks launchesPerDay; do
    echo "$STATS_JSON" | grep -q "\"$key\"" || missing="$missing $key"
  done
  if [ -z "$missing" ]; then echo "  ✓ GET /v1/stats → 200, has all documented keys"; else echo "  ✘ GET /v1/stats → 200 but missing keys:$missing"; FAIL=1; fi
else
  echo "  ✘ GET /v1/stats → $STATS_CODE (expected 200)"; FAIL=1
fi

STATS_PAGE_HEADERS=$(curl -s -D - -o /tmp/probe-stats-page.$$ "$BASE/stats")
STATS_PAGE_CODE=$(echo "$STATS_PAGE_HEADERS" | head -1 | grep -o '[0-9][0-9][0-9]')
if [ "$STATS_PAGE_CODE" = "200" ] && echo "$STATS_PAGE_HEADERS" | grep -qi "content-type: text/html"; then
  echo "  ✓ GET /stats → 200 text/html"
else
  echo "  ✘ GET /stats → $STATS_PAGE_CODE (expected 200 text/html)"; FAIL=1
fi
rm -f /tmp/probe-stats-page.$$

QUERY_CODE=$(curl -s -o /tmp/probe-query.$$ -w "%{http_code}" -X POST -H "content-type: application/json" --data '{"sql":"SELECT 1 FROM deckosaurus_telemetry"}' "$BASE/v1/query")
if [ "$QUERY_CODE" = "403" ]; then
  echo "  ✓ POST /v1/query (disabled) → 403"
elif [ "$QUERY_CODE" = "200" ]; then
  # QUERY_ENABLED=1: prove it, then prove a bad body is rejected.
  echo "  ✓ POST /v1/query (enabled) → 200"
  BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "content-type: application/json" --data '{"sql":"DELETE FROM deckosaurus_telemetry"}' "$BASE/v1/query")
  [ "$BAD_CODE" = "400" ] && echo "  ✓ POST /v1/query (enabled, bad body) → 400" || { echo "  ✘ POST /v1/query (enabled, bad body) → $BAD_CODE (expected 400)"; FAIL=1; }
else
  echo "  ✘ POST /v1/query → $QUERY_CODE (expected 403 disabled or 200 enabled)"; FAIL=1
fi
rm -f /tmp/probe-query.$$

ROLLUP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/rollup?day=2026-09-24")
[ "$ROLLUP_CODE" = "403" ] && echo "  ✓ POST /v1/rollup (no key) → 403" || { echo "  ✘ POST /v1/rollup (no key) → $ROLLUP_CODE (expected 403)"; FAIL=1; }

exit $FAIL
