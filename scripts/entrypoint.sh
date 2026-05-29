#!/usr/bin/env bash
# Docker ENTRYPOINT. サブコマンドで分岐する。
set -euo pipefail

case "${1:-}" in
  validate)
    shift
    exec /app/scripts/validate.sh "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
