#!/usr/bin/env bash
# シナリオを順に実行する。--dry-run で実際の codex exec を呼ばずに動作確認。
# --only <id> で特定シナリオだけ実行。

# 注意: 同一シナリオが連続失敗しても、毎回新規 Issue を起票する (MVP の挙動)。
# Issue 集約 / dedup は build-issue.ts や別 cron で実装する想定 (将来)。
set -euo pipefail

DRY_RUN=0
ONLY=""
MATCHED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only)    ONLY="$2"; shift 2 ;;
    *)         echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# preflight
required_vars=(TARGET_REPO_URL TARGET_BRANCH TARGET_URL GITHUB_REPO GH_TOKEN)
missing=()
for v in "${required_vars[@]}"; do
  [[ -z "${!v:-}" ]] && missing+=("$v")
done
if (( ${#missing[@]} > 0 )); then
  echo "FATAL: missing env vars: ${missing[*]}" >&2
  exit 2
fi

TARGET_DIR="/opt/targets/$(basename "$TARGET_REPO_URL" .git)"

# 対象 PJ を準備
if [[ "$DRY_RUN" -eq 0 ]]; then
  if [[ ! -d "$TARGET_DIR/.git" ]]; then
    mkdir -p "$(dirname "$TARGET_DIR")"
    git clone "$TARGET_REPO_URL" "$TARGET_DIR"
  fi
  git -C "$TARGET_DIR" fetch origin "$TARGET_BRANCH"
  git -C "$TARGET_DIR" reset --hard "origin/$TARGET_BRANCH"
else
  echo "[dry-run] would clone/pull $TARGET_REPO_URL into $TARGET_DIR"
fi

SCENARIO_DIR="$TARGET_DIR/e2e/scenarios"
if [[ "$DRY_RUN" -eq 1 ]] && [[ ! -d "$SCENARIO_DIR" ]]; then
  echo "[dry-run] $SCENARIO_DIR does not exist locally; listing nothing"
  exit 0
fi

shopt -s nullglob
for scenario in "$SCENARIO_DIR"/*.md; do
  id=$(basename "$scenario" .md)
  if [[ -n "$ONLY" ]] && [[ "$id" != "$ONLY" ]]; then
    continue
  fi
  MATCHED=$((MATCHED + 1))

  result_file="/tmp/result-${id}.json"
  RUN_ID="$(node -e 'console.log(crypto.randomUUID())')"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would execute scenario: $id"
    echo "  scenario:    $scenario"
    echo "  result_file: $result_file"
    echo "  run_id:      $RUN_ID"
    echo "  cwd:         $TARGET_DIR"
    continue
  fi

  status="RUNNER_BUG"
  for attempt in 1 2; do
    rm -f "$result_file"
    timeout 300 codex exec --full-auto --sandbox workspace-write \
      --cwd "$TARGET_DIR" \
      "$(cat /app/prompts/run.md)

SCENARIO_PATH=$scenario
RESULT_FILE=$result_file
TARGET_URL=$TARGET_URL
RUN_ID=$RUN_ID" \
      || true

    if [[ -f "$result_file" ]]; then
      status=$(jq -r .status "$result_file" 2>/dev/null || echo "RUNNER_BUG")
    fi
    [[ "$status" == "PASS" ]] && break
    [[ "$status" == "RUNNER_BUG" ]] && break
    [[ $attempt -lt 2 ]] && sleep 60
  done

  if [[ "$status" != "PASS" ]]; then
    if [[ ! -f "$result_file" ]] || [[ "$status" == "RUNNER_BUG" ]]; then
      cat > "$result_file" <<JSON
{ "status": "RUNNER_BUG", "scenarioId": "$id", "rootCause": "codex did not produce a valid RESULT_FILE", "runId": "$RUN_ID" }
JSON
    fi

    issue_json=$(tsx /app/lib/build-issue.ts --file "$result_file") || {
      echo "build-issue failed for $id" >&2
      continue
    }
    title=$(echo "$issue_json" | jq -r .title) || { echo "jq parse failed for $id (title)" >&2; continue; }
    body=$(echo "$issue_json" | jq -r .body) || { echo "jq parse failed for $id (body)" >&2; continue; }
    labels=$(echo "$issue_json" | jq -r '.labels | join(",")') || { echo "jq parse failed for $id (labels)" >&2; continue; }

    if ! gh issue create -R "$GITHUB_REPO" --title "$title" --body "$body" --label "$labels"; then
      IFS=',' read -ra lbl_arr <<< "$labels"
      for lbl in "${lbl_arr[@]}"; do
        gh label create -R "$GITHUB_REPO" "$lbl" --color B60205 2>/dev/null || true
      done
      gh issue create -R "$GITHUB_REPO" --title "$title" --body "$body" --label "$labels" \
        || echo "ISSUE CREATE FAILED: $id" >&2
    fi
  fi
done

if [[ -n "$ONLY" ]] && [[ "$MATCHED" -eq 0 ]]; then
  echo "FATAL: --only '$ONLY' matched no scenario" >&2
  exit 2
fi

echo "run-regression completed"
