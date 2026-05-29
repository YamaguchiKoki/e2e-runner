#!/usr/bin/env bash
# scenarios md のフォーマット検証。各ファイルを parse-scenario に通す。
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: validate.sh <md-file...>" >&2
  exit 2
fi

fail=0
for f in "$@"; do
  if [[ ! -f "$f" ]]; then
    echo "NOT FOUND: $f" >&2
    fail=1
    continue
  fi
  if TARGET_URL=https://placeholder.invalid tsx /app/lib/parse-scenario.ts "$f" > /dev/null; then
    echo "OK: $f"
  else
    echo "INVALID: $f" >&2
    fail=1
  fi
done

exit "$fail"
