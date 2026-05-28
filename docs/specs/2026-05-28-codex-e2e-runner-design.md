# codex-e2e-runner: 定期 E2E ランナー設計

- **作成日**: 2026-05-28
- **ステータス**: Draft (brainstorming 完了)
- **対象リポ**: 新規リポ `codex-e2e-runner`（IaC 本体）+ 既存リポ `strike-hyperion`（シナリオ保持）
- **ブレストログ**: superpowers:brainstorming スキル経由で詰めた

## 1. 目的とゴール

strike-hyperion の stg 環境（Cloudflare Workers ホスティング）に対し、平日朝に
コア導線の E2E をリグレッション検出目的で自動実行する。失敗を GitHub Issue で
顕在化させ、開発者が出社前にデグレを把握できる状態を作る。

将来的に同じ仕組みを他の社内プロダクトにも横展開できるよう、IaC ごとテンプレート化する。

### 成功条件

- 平日朝 7:00 JST に stg のコア導線シナリオが自動実行される
- 失敗時は GitHub Issue が起票され、誰でも気付ける
- 新規 PJ への横展開が「VPS 起動 + .env 差し替え + scenarios 書き換え」だけで済む
- 月額の追加コストが ¥1000 以内（VPS 1 台 + 既存サブスク活用）

### スコープ外

- PR ごとの自動 E2E（preview deploy 連動）。本仕様は定期実行のみ
- prod への E2E。stg のみが対象
- E2E 失敗の自動修正（Codex に直させる等）

## 2. 制約と前提

- **従量課金 NG**: Anthropic API / OpenAI API の従量利用は避ける。ChatGPT Plus 等の
  定額サブスクで Codex CLI を動かす前提
- **MCP 不使用**: playwright-cli (素の Bash CLI) を Codex に shell tool 経由で叩かせる
- **GHA 利用枠は小さめ**: runner 本体の CI は paths filter で `e2e/**` 配下変更時のみ起動
- **宣言的なインフラ**: terraform + cloud-init + Dockerfile + compose.yml で記述、
  手続き的なシェルは `scripts/*.sh` の薄いラッパーのみに留める
- **横展開可能**: codex-e2e-runner リポは PJ 固有知識を持たず、`.env` と
  対象 PJ の `scenarios/` だけで動作を決める

## 3. アーキテクチャ全体図

```
┌─ codex-e2e-runner repo (新規・独立) ─────────────────┐
│   infra/main.tf + cloud-init.yml                      │
│   Dockerfile + compose.yml                            │
│   prompts/ + lib/ + scripts/ + tests/                 │
│   GHA: lib テスト + docker build + GHCR push          │
└──────────────────────────────────────────────────────┘
              │ terraform apply              │ docker pull
              ▼                              ▼
┌─ Hetzner CAX11 VPS ──────────────────────────────────┐
│   /opt/codex-e2e-runner/                              │
│     docker compose: codex-e2e + ofelia                │
│     ofelia: 0 7 * * 1-5 → run-regression.sh           │
│             0 6 * * 1   → propose-scenarios.sh        │
│   /opt/targets/strike-hyperion/  (毎回 git pull)      │
└──────────────────────────────────────────────────────┘
              │ playwright-cli                │ gh issue/pr
              ▼                              ▼
   strike-hyperion-web-stg.yaichi.workers.dev / GitHub Repo
```

### 設計の核

- **コードは GitHub に集約**: シナリオ・スクリプト・プロンプト・IaC すべて git 管理
- **VPS は薄く**: 状態は持たず、`terraform apply` で再構築可能
- **対象 PJ と runner repo の分離**: runner はテンプレート、PJ は scenarios だけ
- **状態の永続化先は GitHub**: 失敗 Issue・提案 draft PR の形で残る
- **`scripts/*.sh` だけが手続き的**、それ以外は宣言的に書く

## 4. 2 リポ構造

### 4-1. `codex-e2e-runner` (新規リポ)

```
codex-e2e-runner/
├─ infra/
│   ├─ main.tf              Hetzner Cloud VPS + SSH key
│   ├─ cloud-init.yml       docker / git clone 初期化
│   ├─ terraform.tfvars.example
│   └─ variables.tf
├─ Dockerfile               codex + node + chromium + playwright-cli + gh + tsx
├─ compose.yml              codex-e2e + ofelia の 2 service / cron をラベルで宣言
├─ prompts/
│   ├─ run.md               シナリオ実行プロンプト (Codex 用)
│   └─ propose.md           シナリオ提案プロンプト
├─ lib/
│   ├─ parse-scenario.ts    front-matter + 本文を zod 検証 / JSON 化
│   ├─ build-issue.ts       RunResult JSON → Issue title/body/labels
│   └─ resolve-repo.ts      cwd の git remote から owner/repo を解決
├─ scripts/
│   ├─ run-regression.sh    1 シナリオ実行 + 失敗時 Issue 化
│   ├─ propose-scenarios.sh 先週 PR を見て draft PR で新シナリオ提案
│   └─ validate.sh          scenarios md フォーマット検証 (Docker image の entrypoint 兼用)
├─ tests/
│   ├─ parse-scenario.test.ts
│   ├─ build-issue.test.ts
│   ├─ resolve-repo.test.ts
│   └─ fixtures/
├─ package.json             zod, date-fns, vitest, tsx
├─ vitest.config.ts
├─ .env.example
└─ .github/workflows/ci.yml lib test + docker build + GHCR push
```

### 4-2. 対象 PJ 側 (例: `strike-hyperion`)

```
strike-hyperion/
└─ e2e/
    ├─ scenarios/
    │   └─ <id>.md         手書き + 進化するシナリオ
    └─ .env.example         対象 PJ 用 env 例 (テストユーザー情報)
```

→ `lib/` `scripts/` 等の実装コードは持たない。シナリオの validate は
**Docker 経由で runner image を叩く** ことで PJ にツール依存を増やさない。

## 5. コンポーネント詳細

### 5-1. Dockerfile

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git chromium \
    && curl -sS https://webi.sh/gh | sh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex playwright-cli tsx

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin

# validate サブコマンド用の entrypoint
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["sleep", "infinity"]
```

`entrypoint.sh` は引数で分岐:
- `validate <files...>` → `validate.sh` を呼ぶ
- 引数なし → `exec "$@"` (compose の `command:` が効く)

### 5-2. compose.yml

```yaml
services:
  codex-e2e:
    build: .
    container_name: codex-e2e
    env_file: .env
    volumes:
      - codex-auth:/root/.codex          # codex login の永続化
      - artifacts:/app/.e2e-artifacts
      - targets:/opt/targets             # 対象 PJ の clone 先
    labels:
      ofelia.enabled: "true"
      ofelia.job-exec.regression.schedule: "0 7 * * 1-5"
      ofelia.job-exec.regression.command: "/app/scripts/run-regression.sh"
      ofelia.job-exec.regression.no-overlap: "true"
      ofelia.job-exec.propose.schedule:    "0 6 * * 1"
      ofelia.job-exec.propose.command:     "/app/scripts/propose-scenarios.sh"
      ofelia.job-exec.propose.no-overlap:  "true"
    command: ["sleep", "infinity"]
    restart: unless-stopped

  ofelia:
    image: mcuadros/ofelia:latest
    container_name: codex-e2e-cron
    command: daemon --docker
    depends_on: [codex-e2e]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

volumes:
  codex-auth:
  artifacts:
  targets:
```

ホストの cron daemon に依存せず、すべて compose ラベルで schedule を宣言する。

### 5-3. infra/main.tf

```hcl
terraform {
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.45" }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_ssh_key" "main" {
  name       = "codex-e2e-${var.server_name}"
  public_key = var.ssh_public_key
}

resource "hcloud_server" "runner" {
  name        = var.server_name
  server_type = "cax11"           # ARM 2vCPU 4GB, €3.79/月
  image       = "debian-12"
  location    = var.location      # "fsn1" 等
  ssh_keys    = [hcloud_ssh_key.main.id]

  user_data = templatefile("${path.module}/cloud-init.yml", {
    repo_url = var.repo_url
    branch   = var.branch
  })
}

output "server_ip" { value = hcloud_server.runner.ipv4_address }
```

`variables.tf` で `hcloud_token` / `ssh_public_key` / `server_name` /
`location` / `repo_url` / `branch` を宣言。`terraform.tfvars` は git 外。

### 5-4. infra/cloud-init.yml

```yaml
#cloud-config
package_update: true
packages: [docker.io, docker-compose-plugin, git]

runcmd:
  - systemctl enable --now docker
  - git clone --branch ${branch} ${repo_url} /opt/codex-e2e-runner
  - cd /opt/codex-e2e-runner && cp .env.example .env
  - |
    cat > /opt/codex-e2e-runner/SETUP-NEXT.md <<'EOF'
    Next steps (manual):
    1. Edit /opt/codex-e2e-runner/.env (TARGET_REPO_URL, GH_TOKEN, E2E_ACCOUNT_*)
    2. docker compose run --rm codex-e2e codex login
    3. docker compose up -d
    EOF
```

`.env` 投入と `codex login` は **対話・secret を伴うため自動化しない**。
terraform state に secret を絶対乗せない原則。

### 5-5. prompts/run.md (Codex 用実行プロンプト)

e2e-runner SKILL.md の "実行手順" をベースに、Claude Code 固有部分
(`Read` ツール、スキル切り替え、`CLAUDE_PLUGIN_ROOT`) を除去して Codex 用に書き直す。

含めるべき要素:

1. 入力変数の明示: `SCENARIO_PATH`, `TARGET_URL`, `RESULT_FILE`, `ACCOUNT_PASSWORD`
2. 手順:
   - `tsx lib/parse-scenario.ts $SCENARIO_PATH` で JSON 取得
   - `playwright-cli open $TARGET_URL` で開始
   - 本文の各手順を `snapshot` → `ref 取得` → `click/fill/...` で実行
   - `## 期待結果` 配下と突合
   - 失敗時に RunResult JSON (FAIL / INFRA_ERROR) を `$RESULT_FILE` に書く
   - 成功時に `{status: PASS}` を `$RESULT_FILE` に書く
3. 制約: パスワードを snapshot/screenshot に残さない
4. アーティファクトの出力先: `.e2e-artifacts/<run-id>/`

### 5-6. lib/*.ts (Codex 用に書き換えたロジック)

既存 e2e-skills プラグインのコードを参考に、Claude Code 依存を除いた形で
ゼロから書く（コピー流用ではなく、Codex 前提で再設計）。

- **parse-scenario.ts**:
  入力 = md ファイルパス、stdout = JSON。`target` の `${TARGET_URL}` を env で展開。
  `account` から `accountEnvKey` を導出。zod スキーマで front-matter を検証。
- **build-issue.ts**:
  入力 = RunResult JSON ファイル、stdout = `{title, body, labels[]}` JSON。
  FAIL / INFRA_ERROR / RUNNER_BUG ごとに body と labels を出し分け。
  snapshotExcerpt を 30 行に切り詰め。
- **resolve-repo.ts**:
  cwd の `git config --get remote.origin.url` を読んで `owner/repo` 形式に正規化。
  https / ssh 両形式に対応。

### 5-7. scripts/run-regression.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# preflight
required_vars=(TARGET_REPO_URL TARGET_URL GITHUB_REPO GH_TOKEN)
for v in "${required_vars[@]}"; do
  [[ -z "${!v:-}" ]] && { echo "FATAL: missing $v" >&2; exit 2; }
done

# 対象 PJ を pull
TARGET_DIR="/opt/targets/$(basename "$TARGET_REPO_URL" .git)"
if [[ ! -d "$TARGET_DIR" ]]; then
  git clone "$TARGET_REPO_URL" "$TARGET_DIR"
fi
git -C "$TARGET_DIR" fetch origin "$TARGET_BRANCH"
git -C "$TARGET_DIR" reset --hard "origin/$TARGET_BRANCH"

# シナリオごとに実行
for scenario in "$TARGET_DIR"/e2e/scenarios/*.md; do
  id=$(basename "$scenario" .md)
  result_file="/tmp/result-${id}.json"

  # 2 回まで試行
  for attempt in 1 2; do
    rm -f "$result_file"
    timeout 300 codex exec --full-auto --sandbox workspace-write \
      --cwd "$TARGET_DIR" \
      "$(cat /app/prompts/run.md)

SCENARIO_PATH=$scenario
RESULT_FILE=$result_file
TARGET_URL=$TARGET_URL" \
      || true

    status=$(jq -r .status "$result_file" 2>/dev/null || echo "RUNNER_BUG")
    [[ "$status" == "PASS" ]] && break
    [[ $attempt -lt 2 ]] && sleep 60
  done

  if [[ "$status" != "PASS" ]]; then
    issue_json=$(tsx /app/lib/build-issue.ts --file "$result_file")
    title=$(jq -r .title <<<"$issue_json")
    body=$(jq -r .body <<<"$issue_json")
    labels=$(jq -r '.labels | join(",")' <<<"$issue_json")
    gh issue create -R "$GITHUB_REPO" --title "$title" --body "$body" --label "$labels" \
      || echo "ISSUE CREATE FAILED: $id" >&2
  fi
done
```

### 5-8. scripts/propose-scenarios.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_DIR="/opt/targets/$(basename "$TARGET_REPO_URL" .git)"
git -C "$TARGET_DIR" fetch origin "$TARGET_BRANCH"
git -C "$TARGET_DIR" reset --hard "origin/$TARGET_BRANCH"

# 直近 1 週間にマージされた PR を JSON で取得
since=$(date -d '7 days ago' +%Y-%m-%d)
pr_json=$(gh pr list -R "$GITHUB_REPO" --state merged \
  --search "merged:>=$since" --json title,body,files,number --limit 50)

branch="proposal/scenarios-$(date +%Y%m%d)"
git -C "$TARGET_DIR" checkout -b "$branch"

# Codex に提案させる
codex exec --full-auto --sandbox workspace-write \
  --cwd "$TARGET_DIR" \
  "$(cat /app/prompts/propose.md)

PR_LIST_JSON=$(echo "$pr_json" | base64 -w0)
EXISTING_SCENARIOS_DIR=e2e/scenarios"

# 差分があれば draft PR
if ! git -C "$TARGET_DIR" diff --quiet HEAD -- e2e/scenarios/; then
  git -C "$TARGET_DIR" add e2e/scenarios/
  git -C "$TARGET_DIR" commit -m "proposal: add scenarios from PRs merged since $since"
  git -C "$TARGET_DIR" push origin "$branch"
  gh pr create -R "$GITHUB_REPO" --draft \
    --title "[scenarios] propose new E2E scenarios for $since〜" \
    --body "Auto-generated proposal. Review before merge." \
    --head "$branch"
fi
```

## 6. データフロー

### 6-1. シナリオ md フォーマット

```markdown
---
id: login-systemadmin-001
target: ${TARGET_URL}
account: SYSTEM_ADMIN
issueRepo: yaichi-tech/strike-hyperion
timeoutSec: 120
tags: [smoke, auth]
---

## 手順
1. ログインページを開く
2. メール `admin@example.com` とパスワードを入力
3. 「ログイン」ボタンを押す

## 期待結果
- ダッシュボード画面 (`/dashboard`) に遷移する
- ヘッダーに「システム管理者」の文字が表示される
```

- `target` の `${TARGET_URL}` は parse-scenario が env で展開
- `account` (`SYSTEM_ADMIN`) → `accountEnvKey` (`E2E_ACCOUNT_SYSTEM_ADMIN_PASSWORD`)
- `## 期待結果` の各行を Codex がチェックリストとして使う

### 6-2. RunResult JSON スキーマ

```ts
const RunResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("PASS"),
    scenarioId: z.string(),
    target: z.string(),
    durationMs: z.number(),
    runId: z.string(),
  }),
  z.object({
    status: z.literal("FAIL"),
    scenarioId: z.string(),
    target: z.string(),
    failedStep: z.string(),
    rootCause: z.string(),
    snapshotExcerpt: z.string().max(30 * 200),  // 30 行 × 200 文字目安
    durationMs: z.number(),
    runId: z.string(),
  }),
  z.object({
    status: z.literal("INFRA_ERROR"),
    scenarioId: z.string(),
    target: z.string(),
    rootCause: z.string(),
    runId: z.string(),
  }),
]);
```

`build-issue.ts` は **RUNNER_BUG ケース**（Codex が JSON を書けなかった等）も
追加で扱う。Bash 側で生成した `{status: RUNNER_BUG, scenarioId, rootCause}` を
渡せる形に拡張。

### 6-3. 秘密情報の流れ

```
.env (VPS のローカル、git 外)
  ├─ TARGET_REPO_URL
  ├─ TARGET_BRANCH
  ├─ TARGET_URL
  ├─ GITHUB_REPO
  ├─ GH_TOKEN                                    (scope: repo のみ)
  └─ E2E_ACCOUNT_<NAME>_PASSWORD (複数)
  │
  ▼ docker compose env_file
codex-e2e container
  │
  ▼ プロセス env
Codex プロンプトに「パスワードを snapshot/screenshot に残さない」を明記
```

OPENAI_API_KEY は不要。`codex login` 済みクレデンシャルが `/root/.codex` volume に永続化。

## 7. エラー処理

### 7-1. 失敗の分類

| 種別 | 条件 | ラベル |
|---|---|---|
| PASS | 期待結果 全成立 | (Issue なし) |
| FAIL | 期待結果いずれかが不成立 | `e2e-failure`, `scenario:<id>` |
| INFRA_ERROR | playwright-cli 起動失敗 / target unreachable / timeout | `e2e-infra`, `scenario:<id>` |
| RUNNER_BUG | parse-scenario / build-issue 失敗、Codex が JSON 書けない、終了コード不正 | `e2e-runner-bug`, `scenario:<id>` |

3 種類とも Issue 起票。ラベルで切り分け可能にする。

### 7-2. 再試行

- 1 シナリオあたり最大 2 回（本番 + 60 秒後リトライ）
- PASS なら即終了、RUNNER_BUG はリトライしない（仕様違反は再現性ある）
- リトライは Bash 側で実装、Codex セッションは毎回 fresh
- 確定失敗のみ Issue 起票

### 7-3. タイムアウト階層

| レイヤー | 値 | 仕掛け |
|---|---|---|
| 単一 playwright-cli コマンド | 30 秒 | デフォルト |
| 1 シナリオ全体 | `frontMatter.timeoutSec`（既定 120 秒） | プロンプト + Bash `timeout` |
| 1 シナリオ + リトライ | 5 分 | Bash `timeout 300` |
| run-regression.sh 全体 | 30 分 | ofelia の `no-overlap: true` |

### 7-4. Issue 起票失敗のフォールバック

```bash
gh issue create ... || {
  # ラベル不在の可能性 → 自動作成して再試行
  gh label create e2e-failure --color B60205 2>/dev/null || true
  gh label create "scenario:$id" --color BFD4F2 2>/dev/null || true
  gh issue create ... || {
    # 二度目も失敗 → アーティファクトとして保存
    cat "$result_file" >> /app/.e2e-artifacts/failed-issue-creates.log
    echo "[$(date)] Issue creation failed for $id" >&2
    exit 1
  }
}
```

### 7-5. 同一失敗の集約

MVP では集約しない（毎回新規 Issue）。将来必要になったら build-issue.ts に
dedup 関数を追加する形で拡張。

### 7-6. 死活監視

MVP では heartbeat 省略。Healthchecks.io 等の外形監視は将来追加。
週次 propose ジョブが draft PR を作っていることで間接的に runner の生存を確認できる。

### 7-7. preflight check

`scripts/run-regression.sh` 冒頭で必須環境変数を全部チェック。
1 つでも欠けていれば即 exit 2（Issue を立てない）。

## 8. テスト戦略

### 8-1. テスト対象

| 対象 | 方法 |
|---|---|
| `lib/*.ts` | vitest |
| Dockerfile | CI で `docker build` |
| compose.yml | CI で `docker compose config -q` |
| `infra/main.tf` | CI で `terraform fmt -check` + `validate` |
| `scripts/*.sh` | shellcheck のみ。挙動テストは書かない |
| シナリオ md | 対象 PJ の pre-commit で Docker 経由 validate |

### 8-2. lib テストの観点

- **parse-scenario.test.ts**:
  正常系（fixtures の md）/ front-matter 欠落 / 必須フィールド欠落 /
  unknown account / 不正な ID パターン / `${TARGET_URL}` 展開
- **build-issue.test.ts**:
  FAIL / INFRA_ERROR / RUNNER_BUG の title/body/labels が期待通り /
  snapshotExcerpt 30 行切り詰め / 特殊文字エスケープ /
  `scenario:<id>` ラベル生成
- **resolve-repo.test.ts**:
  https / ssh 両形式 / 非 git ディレクトリ / origin 未設定

### 8-3. CI 構成 (codex-e2e-runner repo)

```yaml
on:
  pull_request:
    paths: ["**"]
  push:
    branches: [main]

jobs:
  lib-test:           # vitest run
  shell-lint:         # shellcheck scripts/*.sh
  docker-build:       # docker build . (push なし、PR 用)
  docker-publish:     # main push 時のみ GHCR push
  compose-validate:   # docker compose config -q
  terraform-validate: # init -backend=false + validate + fmt -check
```

paths filter は不要（runner repo は全部 e2e 関連）。

### 8-4. 対象 PJ 側の pre-commit

```yaml
- repo: local
  hooks:
    - id: e2e-scenarios-validate
      name: Validate e2e/scenarios/*.md
      entry: docker run --rm -v ${PWD}/e2e/scenarios:/scenarios:ro ghcr.io/<owner>/codex-e2e-runner:latest validate /scenarios
      language: system
      files: ^e2e/scenarios/.*\.md$
      pass_filenames: false
```

### 8-5. スモークテスト

デプロイ後の手動検証:
```bash
docker compose run --rm codex-e2e /app/scripts/run-regression.sh --dry-run
docker compose run --rm codex-e2e /app/scripts/run-regression.sh --only login-001
```

`--dry-run` モードを scripts に実装し、Codex exec を呼ばずプロンプト構築までで止まる
ようにする。CI でも `--dry-run` で構造破綻を検出。

## 9. 運用と横展開

### 9-1. 初回セットアップ

```bash
# ローカル
git clone https://github.com/<owner>/codex-e2e-runner.git
cd codex-e2e-runner

# terraform.tfvars を用意
cat > infra/terraform.tfvars <<EOF
hcloud_token   = "..."
ssh_public_key = "ssh-ed25519 AAAA..."
server_name    = "codex-e2e-strike-hyperion"
location       = "fsn1"
repo_url       = "https://github.com/<owner>/codex-e2e-runner.git"
branch         = "main"
EOF

terraform -chdir=infra init
terraform -chdir=infra apply

# SSH して secret 投入 + codex login
ssh root@$(terraform -chdir=infra output -raw server_ip)
cd /opt/codex-e2e-runner
$EDITOR .env
docker compose run --rm codex-e2e codex login
docker compose up -d

# スモーク
docker compose exec codex-e2e /app/scripts/run-regression.sh --dry-run
```

### 9-2. 初期シナリオの整備

1. smoke 1 本: ログイン → ダッシュボード遷移
2. smoke 2 本目: 主要画面 1 つの一覧表示
3. クリティカル導線: 顧客作成 / 契約登録 等
4. 上記が安定したら週次 propose ジョブを有効化

初期 3 本までは Claude Code の `e2e-creator` スキルで人間が書く。
runner は同じフォーマットの md を読めるので互換性あり。

### 9-3. 日常運用

| 操作 | コマンド |
|---|---|
| ジョブ履歴 | `ssh root@... 'docker logs codex-e2e-cron --tail 50'` |
| 実行詳細 | `ssh root@... 'docker logs codex-e2e --since 24h'` |
| 手動キック | `docker compose exec codex-e2e /app/scripts/run-regression.sh` |
| runner 更新 | `cd /opt/codex-e2e-runner && git pull && docker compose up -d --build` |
| 対象 PJ 更新 | scripts が毎回 pull するので不要 |

### 9-4. 横展開: 新 PJ 用に deploy

```bash
git clone https://github.com/<owner>/codex-e2e-runner.git codex-e2e-runner-other
cd codex-e2e-runner-other
$EDITOR infra/terraform.tfvars   # server_name を新 PJ 用に
terraform -chdir=infra workspace new other-pj
terraform -chdir=infra apply
# 以降は 9-1 と同じ
```

→ 1 VPS = 1 PJ。runner repo は fork せず、terraform workspace で state 分離。

### 9-5. コスト概算

| 項目 | 月額 |
|---|---|
| Hetzner CAX11 (ARM) | €3.79 (約 ¥630) |
| ChatGPT Plus サブスク | $20 (約 ¥3,000) ※既存資産 |
| GHA (runner repo CI) | Free 枠内 (~100 分) |
| GHCR image storage | Free 枠内 |
| **新規発生** | **約 ¥630/月** |

## 10. オープン論点 (実装計画フェーズで詰める)

- `codex login` の状態保存先 (`/root/.codex`) の中身バックアップ方針
- `propose-scenarios.sh` で Codex が出す md がトークン上限を超える可能性 → PR 数の上限制御
- VPS 上の `gh` CLI 認証方法（GH_TOKEN 環境変数 vs `gh auth login`）
- 初回 `codex login` を VPS 上で対話 OAuth するときの実装詳細（リモートホスト
  からブラウザを開く方法 / device-code フローが使えるか確認）
- 失敗が連続したときの dedup 戦略（将来）
- Healthchecks.io の導入タイミング

## 11. 用語

- **runner repo**: `codex-e2e-runner` リポジトリ。IaC 本体
- **対象 PJ**: シナリオを保持し、E2E の対象になるプロダクト（例: strike-hyperion）
- **シナリオ**: `e2e/scenarios/<id>.md`。手順と期待結果を Markdown で記述
- **RunResult**: シナリオ実行結果の JSON。PASS / FAIL / INFRA_ERROR / RUNNER_BUG
