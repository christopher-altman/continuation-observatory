#!/usr/bin/env bash
set -euo pipefail

apex="${1:-https://continuationobservatory.org}"
www="${2:-https://www.continuationobservatory.org}"

body_file="$(mktemp)"
header_file="$(mktemp)"
trap 'rm -f "$body_file" "$header_file"' EXIT

curl -fsS "$apex/" -o "$body_file"
grep -q "Signed mean entropy delta" "$body_file"
grep -q "CC BY 4.0 data · MIT code" "$body_file"

curl -fsS "$apex/falsification" -o "$body_file"
grep -q "OBSERVATORY NOMINAL" "$body_file"
grep -q "Qwen/Qwen3.5-9B" "$body_file"
if grep -Eq "VERDICT SUSPENDED|historical parameter d" "$body_file"; then
  exit 1
fi

curl -fsS "$apex/models" -o "$body_file"
grep -q "Last observed 2026-05-10" "$body_file"
grep -q "Begins 2026-07-26" "$body_file"
grep -q "Qwen/Qwen3.5-9B" "$body_file"

curl -fsS "$apex/metric-definitions.json" -o "$body_file"
grep -q "entropy_delta_mean.v1" "$body_file"
grep -q "cii_mean.v1" "$body_file"

curl -sS -D "$header_file" -o /dev/null \
  "$www/models?canonical-smoke=1"
grep -Eq '^HTTP/[0-9.]+ 308' "$header_file"
grep -Eiq '^location: https://continuationobservatory\.org/models\?canonical-smoke=1' "$header_file"

printf 'Production smoke checks passed.\n'
