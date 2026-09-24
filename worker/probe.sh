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
exit $FAIL
