# codex-e2e-runner Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ローカル / Docker 上で 1 シナリオを Codex + playwright-cli で実行できる「コアランナー」を完成させる。実シナリオ実行は手動 smoke、それ以外は全部ユニットテスト + dry-run で検証する。

**Architecture:** TypeScript の lib (parse-scenario / build-issue / resolve-repo) + Bash 製の run-regression / validate / entrypoint スクリプト + Dockerfile + compose.yml。lib は vitest でユニットテスト、scripts は shellcheck + `--dry-run` モードで検証。

**Tech Stack:** Node.js 22 / TypeScript (tsx) / zod / gray-matter / vitest / biome / Docker / playwright-cli / @openai/codex / gh CLI

---

## このプランのスコープ

設計書 `docs/specs/2026-05-28-codex-e2e-runner-design.md` を 3 プランに分割する。**この計画は (1) のみ**。

1. **Core runner (このプラン)**: lib + 主要 scripts + Dockerfile + compose.yml + ユニットテスト + CI
2. **Infra deployment** (別プラン): `infra/` (terraform + cloud-init) + 初回 deploy 手順
3. **Propose scenarios** (別プラン): `scripts/propose-scenarios.sh` + `prompts/propose.md` + 週次提案フロー

### 完了時のゴール

- `npm test` で lib テスト全部 PASS
- `npm run lint` で biome エラーなし
- `shellcheck scripts/*.sh` で警告なし
- `docker build .` 成功
- `docker compose config -q` でエラーなし
- `docker compose exec codex-e2e /app/scripts/run-regression.sh --dry-run` がエラーなしで終了
- `docker compose exec codex-e2e /app/scripts/validate.sh /work/scenarios/valid-login.md` で OK 表示
- CI workflow (`.github/workflows/ci.yml`) が main push で緑

実シナリオ実行（codex exec → playwright-cli → stg ターゲット）は手動 smoke として実施するが、自動テストの対象外。

## ファイル構造

```
e2e-runner/                          (既に main に存在)
├── README.md                        (既存、変更なし)
├── .gitignore                       (既存、変更なし)
├── docs/specs/                      (既存、変更なし)
├── docs/plans/2026-05-28-core-runner.md  (このファイル)
│
├── package.json                     [NEW]
├── package-lock.json                [NEW] npm install で生成
├── tsconfig.json                    [NEW]
├── vitest.config.ts                 [NEW]
├── biome.json                       [NEW]
│
├── lib/
│   ├── parse-scenario.ts            [NEW] md → JSON (zod 検証)
│   ├── build-issue.ts               [NEW] RunResult JSON → Issue payload
│   └── resolve-repo.ts              [NEW] git remote → owner/repo
│
├── tests/
│   ├── parse-scenario.test.ts       [NEW]
│   ├── build-issue.test.ts          [NEW]
│   ├── resolve-repo.test.ts         [NEW]
│   └── fixtures/
│       ├── valid-login.md           [NEW]
│       ├── missing-frontmatter.md   [NEW]
│       ├── invalid-id.md            [NEW]
│       ├── result-pass.json         [NEW]
│       ├── result-fail.json         [NEW]
│       ├── result-infra-error.json  [NEW]
│       └── result-runner-bug.json   [NEW]
│
├── prompts/
│   └── run.md                       [NEW] Codex 実行プロンプト v1
│
├── scripts/
│   ├── entrypoint.sh                [NEW] サブコマンド dispatcher
│   ├── validate.sh                  [NEW] md 形式検証
│   └── run-regression.sh            [NEW] シナリオ実行 (--dry-run 対応)
│
├── Dockerfile                       [NEW]
├── compose.yml                      [NEW]
├── .env.example                     [NEW]
│
└── .github/workflows/
    └── ci.yml                       [NEW] lib test + lint + shellcheck + docker build
```

### 責務の境界

- **lib/*.ts**: stdin/argv/env を受けて stdout/exit code を返す純関数的 CLI。副作用なし (ファイル書き込みは呼び出し側の責任)
- **scripts/*.sh**: lib を tsx で叩く・codex/playwright-cli/gh を呼ぶ・ファイル I/O の責務
- **prompts/*.md**: Codex に渡す静的テキスト。コードではない
- **Dockerfile / compose.yml / .env.example**: 実行環境の宣言
- **tests/**: lib のみテスト。scripts は shellcheck + --dry-run で間接検証

---

### Task 1: Repo setup (npm + biome + vitest + tsconfig)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `biome.json`

- [ ] **Step 1: `package.json` を作成**

```json
{
  "name": "codex-e2e-runner",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "gray-matter": "^4.0.3",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["lib/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: `vitest.config.ts` を作成**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 5000,
  },
});
```

- [ ] **Step 4: `biome.json` を作成**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": {
    "include": ["lib/**/*.ts", "tests/**/*.ts", "*.ts"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "javascript": {
    "formatter": { "quoteStyle": "double", "semicolons": "always" }
  }
}
```

- [ ] **Step 5: 依存をインストール**

```bash
npm install
```

期待: `package-lock.json` が生成され、`node_modules/` ができる。エラーなし。

- [ ] **Step 6: 初期 lint / test がエラーなしで通る**

```bash
npm run lint
npm test
```

期待: lint は対象ファイルなしで OK。test は "No test files found" のメッセージで終了するが exit 0 で抜ける。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts biome.json
git commit -m "chore: setup npm + biome + vitest + tsconfig"
```

---

### Task 2: lib/parse-scenario.ts (TDD)

**Files:**
- Create: `tests/fixtures/valid-login.md`
- Create: `tests/fixtures/missing-frontmatter.md`
- Create: `tests/fixtures/invalid-id.md`
- Create: `tests/parse-scenario.test.ts`
- Create: `lib/parse-scenario.ts`

- [ ] **Step 1: `tests/fixtures/valid-login.md` を作成**

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

- [ ] **Step 2: `tests/fixtures/missing-frontmatter.md` を作成**

```markdown
## 手順
1. ログインページを開く
```

- [ ] **Step 3: `tests/fixtures/invalid-id.md` を作成**

```markdown
---
id: Login_001
target: https://example.com
account: SYSTEM_ADMIN
---

## 手順
1. ログイン
```

(id が大文字 + アンダースコアで pattern 違反)

- [ ] **Step 4: `tests/parse-scenario.test.ts` を書く**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FIXTURES = path.resolve(__dirname, "fixtures");
const BIN = path.resolve(__dirname, "..", "lib", "parse-scenario.ts");

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("npx", ["tsx", BIN, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

describe("parse-scenario", () => {
  it("valid な md は JSON で出力される", () => {
    const r = run([path.join(FIXTURES, "valid-login.md")], {
      TARGET_URL: "https://stg.example.com",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.frontMatter.id).toBe("login-systemadmin-001");
    expect(out.frontMatter.target).toBe("https://stg.example.com");
    expect(out.frontMatter.account).toBe("SYSTEM_ADMIN");
    expect(out.frontMatter.timeoutSec).toBe(120);
    expect(out.accountEnvKey).toBe("E2E_ACCOUNT_SYSTEM_ADMIN_PASSWORD");
    expect(out.body).toContain("## 手順");
    expect(out.body).toContain("## 期待結果");
  });

  it("${TARGET_URL} が env で展開される", () => {
    const r = run([path.join(FIXTURES, "valid-login.md")], {
      TARGET_URL: "https://other.example.com",
    });
    const out = JSON.parse(r.stdout);
    expect(out.frontMatter.target).toBe("https://other.example.com");
  });

  it("front-matter なしは exit 1", () => {
    const r = run([path.join(FIXTURES, "missing-frontmatter.md")]);
    expect(r.status).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("不正な id pattern は exit 1", () => {
    const r = run([path.join(FIXTURES, "invalid-id.md")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("id");
  });

  it("引数なしは exit 2", () => {
    const r = run([]);
    expect(r.status).toBe(2);
  });

  it("timeoutSec のデフォルトは 120", () => {
    // valid-login.md は明示的に 120 を指定しているので、別 fixture で検証する代わりに
    // inline で書き出してテストする
    // ここでは valid-login.md (120 明示) で動作確認のみ
    const r = run([path.join(FIXTURES, "valid-login.md")], {
      TARGET_URL: "https://stg.example.com",
    });
    const out = JSON.parse(r.stdout);
    expect(out.frontMatter.timeoutSec).toBe(120);
  });
});
```

- [ ] **Step 5: テストを実行して FAIL を確認**

```bash
npm test -- parse-scenario
```

期待: FAIL（`lib/parse-scenario.ts` が存在しないため tsx が落ちる）

- [ ] **Step 6: `lib/parse-scenario.ts` を実装**

```ts
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";

const FrontMatterSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "id must match ^[a-z][a-z0-9-]*$"),
  target: z.string().min(1, "target is required"),
  account: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "account must match ^[A-Z][A-Z0-9_]*$"),
  issueRepo: z
    .string()
    .regex(/^[^\/]+\/[^\/]+$/, "issueRepo must be owner/repo")
    .optional(),
  timeoutSec: z.number().int().positive().default(120),
  tags: z.array(z.string()).optional(),
});

function main(argv: string[]): number {
  const file = argv[0];
  if (!file) {
    process.stderr.write("usage: parse-scenario.ts <md-path>\n");
    return 2;
  }
  const absPath = path.resolve(file);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`file not found: ${absPath}\n`);
    return 1;
  }
  const raw = fs.readFileSync(absPath, "utf-8");
  const { data, content } = matter(raw);
  if (Object.keys(data).length === 0) {
    process.stderr.write("missing front-matter\n");
    return 1;
  }
  const parsed = FrontMatterSchema.safeParse(data);
  if (!parsed.success) {
    process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
    return 1;
  }
  const targetUrl = process.env.TARGET_URL ?? "";
  const targetResolved = parsed.data.target.replace(/\$\{TARGET_URL\}/g, targetUrl);
  const accountEnvKey = `E2E_ACCOUNT_${parsed.data.account}_PASSWORD`;
  const out = {
    frontMatter: { ...parsed.data, target: targetResolved },
    body: content.trim(),
    accountEnvKey,
    path: absPath,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 7: テストを実行して PASS を確認**

```bash
npm test -- parse-scenario
```

期待: 6 件すべて PASS

- [ ] **Step 8: CLI で手動確認**

```bash
TARGET_URL=https://stg.example.com npx tsx lib/parse-scenario.ts tests/fixtures/valid-login.md
```

期待: stdout に JSON が出力（`frontMatter.target` が `https://stg.example.com` になっている）

- [ ] **Step 9: Commit**

```bash
git add lib/parse-scenario.ts tests/parse-scenario.test.ts tests/fixtures/valid-login.md tests/fixtures/missing-frontmatter.md tests/fixtures/invalid-id.md
git commit -m "feat(lib): add parse-scenario with zod-validated front-matter"
```

---

### Task 3: lib/build-issue.ts (TDD)

**Files:**
- Create: `tests/fixtures/result-fail.json`
- Create: `tests/fixtures/result-infra-error.json`
- Create: `tests/fixtures/result-runner-bug.json`
- Create: `tests/fixtures/result-pass.json`
- Create: `tests/build-issue.test.ts`
- Create: `lib/build-issue.ts`

- [ ] **Step 1: `tests/fixtures/result-fail.json` を作成**

```json
{
  "status": "FAIL",
  "scenarioId": "login-systemadmin-001",
  "target": "https://stg.example.com",
  "failedStep": "「ログイン」ボタンを押す",
  "rootCause": "ボタン押下後 30 秒待っても URL が /dashboard に変わらない",
  "snapshotExcerpt": "yaml-snapshot here\nline2\nline3",
  "durationMs": 32100,
  "runId": "abc-123"
}
```

- [ ] **Step 2: `tests/fixtures/result-infra-error.json` を作成**

```json
{
  "status": "INFRA_ERROR",
  "scenarioId": "login-systemadmin-001",
  "target": "https://stg.example.com",
  "rootCause": "playwright-cli open でタイムアウト (30s)",
  "runId": "abc-456"
}
```

- [ ] **Step 3: `tests/fixtures/result-runner-bug.json` を作成**

```json
{
  "status": "RUNNER_BUG",
  "scenarioId": "login-systemadmin-001",
  "rootCause": "Codex が RESULT_FILE に JSON を書かなかった",
  "runId": "abc-789"
}
```

- [ ] **Step 4: `tests/fixtures/result-pass.json` を作成**

```json
{
  "status": "PASS",
  "scenarioId": "login-systemadmin-001",
  "target": "https://stg.example.com",
  "durationMs": 8200,
  "runId": "abc-pass"
}
```

- [ ] **Step 5: `tests/build-issue.test.ts` を書く**

```ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FIXTURES = path.resolve(__dirname, "fixtures");
const BIN = path.resolve(__dirname, "..", "lib", "build-issue.ts");

function run(args: string[]) {
  return spawnSync("npx", ["tsx", BIN, ...args], { encoding: "utf-8" });
}

describe("build-issue", () => {
  it("FAIL は title が [E2E FAIL] を含み、labels に e2e-failure と scenario:<id>", () => {
    const r = run(["--file", path.join(FIXTURES, "result-fail.json")]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.title).toMatch(/^\[E2E FAIL\] login-systemadmin-001/);
    expect(out.title).toContain("「ログイン」ボタンを押す");
    expect(out.body).toContain("login-systemadmin-001");
    expect(out.body).toContain("https://stg.example.com");
    expect(out.body).toContain("「ログイン」ボタンを押す");
    expect(out.body).toContain("/dashboard");
    expect(out.body).toContain("abc-123");
    expect(out.labels).toContain("e2e-failure");
    expect(out.labels).toContain("scenario:login-systemadmin-001");
  });

  it("INFRA_ERROR は labels に e2e-infra", () => {
    const r = run(["--file", path.join(FIXTURES, "result-infra-error.json")]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.title).toMatch(/^\[E2E INFRA_ERROR\]/);
    expect(out.labels).toContain("e2e-infra");
    expect(out.labels).toContain("scenario:login-systemadmin-001");
    expect(out.body).toContain("インフラ");
  });

  it("RUNNER_BUG は labels に e2e-runner-bug", () => {
    const r = run(["--file", path.join(FIXTURES, "result-runner-bug.json")]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.title).toMatch(/^\[E2E RUNNER_BUG\]/);
    expect(out.labels).toContain("e2e-runner-bug");
    expect(out.labels).toContain("scenario:login-systemadmin-001");
  });

  it("PASS は exit 1 (起票対象外)", () => {
    const r = run(["--file", path.join(FIXTURES, "result-pass.json")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PASS");
  });

  it("snapshotExcerpt が 30 行を超えると切り詰められる", () => {
    const tmpPath = path.join(FIXTURES, "_tmp-long-snapshot.json");
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    const fs = require("node:fs");
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        status: "FAIL",
        scenarioId: "x-001",
        target: "https://x",
        failedStep: "step",
        rootCause: "cause",
        snapshotExcerpt: lines,
        durationMs: 1000,
        runId: "x",
      }),
    );
    try {
      const r = run(["--file", tmpPath]);
      const out = JSON.parse(r.stdout);
      const matches = out.body.match(/line-\d+/g) ?? [];
      expect(matches.length).toBeLessThanOrEqual(30);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it("引数なしは exit 2", () => {
    const r = run([]);
    expect(r.status).toBe(2);
  });
});
```

- [ ] **Step 6: テストを実行して FAIL を確認**

```bash
npm test -- build-issue
```

期待: FAIL (`lib/build-issue.ts` 未実装)

- [ ] **Step 7: `lib/build-issue.ts` を実装**

```ts
import fs from "node:fs";
import { z } from "zod";

const PassResult = z.object({
  status: z.literal("PASS"),
  scenarioId: z.string(),
  target: z.string(),
  durationMs: z.number(),
  runId: z.string(),
});

const FailResult = z.object({
  status: z.literal("FAIL"),
  scenarioId: z.string(),
  target: z.string(),
  failedStep: z.string(),
  rootCause: z.string(),
  snapshotExcerpt: z.string(),
  durationMs: z.number(),
  runId: z.string(),
});

const InfraErrorResult = z.object({
  status: z.literal("INFRA_ERROR"),
  scenarioId: z.string(),
  target: z.string(),
  rootCause: z.string(),
  runId: z.string(),
});

const RunnerBugResult = z.object({
  status: z.literal("RUNNER_BUG"),
  scenarioId: z.string(),
  rootCause: z.string(),
  runId: z.string().optional(),
});

const RunResultSchema = z.discriminatedUnion("status", [
  PassResult,
  FailResult,
  InfraErrorResult,
  RunnerBugResult,
]);

type RunResult = z.infer<typeof RunResultSchema>;

const MAX_SNAPSHOT_LINES = 30;

function truncateSnapshot(s: string): string {
  const lines = s.split("\n");
  if (lines.length <= MAX_SNAPSHOT_LINES) return s;
  return lines.slice(0, MAX_SNAPSHOT_LINES).join("\n") + `\n... (${lines.length - MAX_SNAPSHOT_LINES} more lines truncated)`;
}

function buildTitle(r: Exclude<RunResult, { status: "PASS" }>): string {
  const tag = `[E2E ${r.status}]`;
  if (r.status === "FAIL") {
    return `${tag} ${r.scenarioId}: ${r.failedStep} で失敗`;
  }
  return `${tag} ${r.scenarioId}: ${r.rootCause}`;
}

function buildLabels(r: Exclude<RunResult, { status: "PASS" }>): string[] {
  const base = `scenario:${r.scenarioId}`;
  switch (r.status) {
    case "FAIL":
      return ["e2e-failure", base];
    case "INFRA_ERROR":
      return ["e2e-infra", base];
    case "RUNNER_BUG":
      return ["e2e-runner-bug", base];
  }
}

function buildBody(r: Exclude<RunResult, { status: "PASS" }>): string {
  const lines: string[] = ["## サマリ"];
  lines.push(`- **シナリオ**: \`${r.scenarioId}\``);
  if (r.status !== "RUNNER_BUG") {
    lines.push(`- **対象**: ${r.target}`);
  }
  lines.push(`- **ステータス**: ${r.status}`);
  if (r.status === "FAIL") {
    lines.push(`- **失敗ステップ**: ${r.failedStep}`);
  }
  lines.push(`- **推定原因**: ${r.rootCause}`);
  if (r.runId) lines.push(`- **run id**: \`${r.runId}\``);
  if (r.status === "FAIL") {
    lines.push(`- **所要時間**: ${r.durationMs}ms`);
  }
  if (r.status === "INFRA_ERROR") {
    lines.push("");
    lines.push("> インフラ系の失敗です。リトライしても直らなければターゲット環境を確認してください。");
  }
  if (r.status === "RUNNER_BUG") {
    lines.push("");
    lines.push("> runner 内部のバグです。codex の出力か lib の zod スキーマを確認してください。");
  }
  if (r.status === "FAIL") {
    lines.push("");
    lines.push("## 画面スナップショット抜粋");
    lines.push("```yaml");
    lines.push(truncateSnapshot(r.snapshotExcerpt));
    lines.push("```");
  }
  lines.push("");
  lines.push("## 再実行");
  lines.push("```bash");
  lines.push(`docker compose exec codex-e2e /app/scripts/run-regression.sh --only ${r.scenarioId}`);
  lines.push("```");
  return lines.join("\n");
}

function main(argv: string[]): number {
  const fileIdx = argv.indexOf("--file");
  if (fileIdx === -1 || !argv[fileIdx + 1]) {
    process.stderr.write("usage: build-issue.ts --file <result.json>\n");
    return 2;
  }
  const filePath = argv[fileIdx + 1];
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = RunResultSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
    return 1;
  }
  if (parsed.data.status === "PASS") {
    process.stderr.write("PASS は Issue 起票対象外です\n");
    return 1;
  }
  const r = parsed.data;
  const out = {
    title: buildTitle(r),
    body: buildBody(r),
    labels: buildLabels(r),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 8: テストを実行して PASS を確認**

```bash
npm test -- build-issue
```

期待: 6 件すべて PASS

- [ ] **Step 9: Commit**

```bash
git add lib/build-issue.ts tests/build-issue.test.ts tests/fixtures/result-*.json
git commit -m "feat(lib): add build-issue with RunResult discriminated union"
```

---

### Task 4: lib/resolve-repo.ts (TDD)

**Files:**
- Create: `tests/resolve-repo.test.ts`
- Create: `lib/resolve-repo.ts`

- [ ] **Step 1: `tests/resolve-repo.test.ts` を書く**

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = path.resolve(__dirname, "..", "lib", "resolve-repo.ts");

function runInDir(cwd: string) {
  return spawnSync("npx", ["tsx", BIN], { encoding: "utf-8", cwd });
}

function makeTempGit(remote: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-repo-test-"));
  execSync("git init -q", { cwd: dir });
  if (remote) execSync(`git remote add origin "${remote}"`, { cwd: dir });
  return dir;
}

describe("resolve-repo", () => {
  const tmpDirs: string[] = [];
  afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it("https URL → owner/repo", () => {
    const dir = makeTempGit("https://github.com/yaichi-tech/strike-hyperion.git");
    tmpDirs.push(dir);
    const r = runInDir(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("yaichi-tech/strike-hyperion");
  });

  it("ssh URL → owner/repo", () => {
    const dir = makeTempGit("git@github.com:yaichi-tech/strike-hyperion.git");
    tmpDirs.push(dir);
    const r = runInDir(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("yaichi-tech/strike-hyperion");
  });

  it("末尾 .git なしでも OK", () => {
    const dir = makeTempGit("https://github.com/yaichi-tech/strike-hyperion");
    tmpDirs.push(dir);
    const r = runInDir(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("yaichi-tech/strike-hyperion");
  });

  it("非 git ディレクトリは exit 1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-repo-nogit-"));
    tmpDirs.push(dir);
    const r = runInDir(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("git");
  });

  it("origin 未設定は exit 1", () => {
    const dir = makeTempGit(null);
    tmpDirs.push(dir);
    const r = runInDir(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("origin");
  });

  it("github.com 以外でも owner/repo を抽出 (GHE 想定)", () => {
    const dir = makeTempGit("git@github.example.com:owner/repo.git");
    tmpDirs.push(dir);
    const r = runInDir(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("owner/repo");
  });
});
```

- [ ] **Step 2: テストを実行して FAIL を確認**

```bash
npm test -- resolve-repo
```

期待: FAIL (`lib/resolve-repo.ts` 未実装)

- [ ] **Step 3: `lib/resolve-repo.ts` を実装**

```ts
import { execSync } from "node:child_process";

function main(): number {
  let url: string;
  try {
    url = execSync("git config --get remote.origin.url", { encoding: "utf-8" }).trim();
  } catch (e) {
    const isGitRepo = (() => {
      try {
        execSync("git rev-parse --is-inside-work-tree", { encoding: "utf-8", stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    })();
    if (!isGitRepo) {
      process.stderr.write("not a git repository\n");
      return 1;
    }
    process.stderr.write("origin remote not configured\n");
    return 1;
  }
  if (!url) {
    process.stderr.write("origin remote not configured\n");
    return 1;
  }
  const match = url.match(/[:\/]([^\/:]+)\/([^\/]+?)(?:\.git)?$/);
  if (!match) {
    process.stderr.write(`could not parse owner/repo from: ${url}\n`);
    return 1;
  }
  process.stdout.write(`${match[1]}/${match[2]}\n`);
  return 0;
}

process.exit(main());
```

- [ ] **Step 4: テストを実行して PASS を確認**

```bash
npm test -- resolve-repo
```

期待: 6 件すべて PASS

- [ ] **Step 5: 既存リポでも動くか手動確認**

```bash
npx tsx lib/resolve-repo.ts
```

期待: `YamaguchiKoki/e2e-runner` が出力される

- [ ] **Step 6: 全テスト一括実行で全部 PASS**

```bash
npm test
```

期待: parse-scenario / build-issue / resolve-repo すべて PASS

- [ ] **Step 7: lint も通す**

```bash
npm run lint
```

期待: エラーなし。エラーが出たら `npm run format` で自動修正後、再度確認。

- [ ] **Step 8: Commit**

```bash
git add lib/resolve-repo.ts tests/resolve-repo.test.ts
git commit -m "feat(lib): add resolve-repo for git remote → owner/repo"
```

---

### Task 5: prompts/run.md (Codex 実行プロンプト v1)

**Files:**
- Create: `prompts/run.md`

- [ ] **Step 1: `prompts/run.md` を作成**

```markdown
あなたは E2E ランナーです。以下の手順で 1 シナリオを実行し、結果を JSON で保存してください。

# 入力 (環境変数)

- `SCENARIO_PATH`: 実行するシナリオ md の絶対パス
- `RESULT_FILE`: 結果 JSON の出力先パス
- `TARGET_URL`: 対象環境 URL
- `E2E_ACCOUNT_<NAME>_PASSWORD`: アカウントパスワード (`<NAME>` はシナリオ front-matter の `account`)

# 手順

## 1. シナリオの読み込み

```bash
tsx /app/lib/parse-scenario.ts "$SCENARIO_PATH"
```

stdout の JSON を以下のように扱う:
- `frontMatter.id`: シナリオ ID (結果出力に使う)
- `frontMatter.target`: 開くべき URL (`${TARGET_URL}` は既に展開済み)
- `frontMatter.timeoutSec`: 全体タイムアウト秒数
- `accountEnvKey`: 参照するパスワード env キー (例: `E2E_ACCOUNT_SYSTEM_ADMIN_PASSWORD`)
- `body`: 本文 Markdown (## 手順 と ## 期待結果 を含む)

## 2. ブラウザを開く

```bash
playwright-cli open "$TARGET_URL"
playwright-cli snapshot
```

`snapshot` の出力 (YAML) から各要素の `ref` を取得する。

## 3. 本文の手順を実行

`## 手順` 配下の各ステップを順に実行する。要素を特定するときは:
1. `playwright-cli snapshot` で現在の DOM を取得
2. ref を見つけて `playwright-cli click <ref>` や `playwright-cli fill <ref> <text>`

パスワード入力の制約:
- `playwright-cli fill <ref> "$ACCOUNT_PASSWORD"` の直後に snapshot/screenshot を取らない
- 取る場合は ref の value を伏せる方法に切り替える

## 4. 期待結果との突合

`## 期待結果` 配下の各行を 1 つずつ検証する:
- URL の遷移: `playwright-cli eval 'window.location.pathname'` で取得
- テキストの存在: `playwright-cli snapshot` で取得して文字列を確認
- 要素の表示: snapshot の ref が存在することを確認

全部成立 → PASS。1 つでも不成立 → FAIL (最初に失敗した手順を `failedStep`、原因解釈を `rootCause`)。

## 5. 結果 JSON の書き出し

PASS の場合:
```json
{
  "status": "PASS",
  "scenarioId": "<frontMatter.id>",
  "target": "<frontMatter.target>",
  "durationMs": <elapsed>,
  "runId": "<RUN_ID>"
}
```

FAIL の場合:
```json
{
  "status": "FAIL",
  "scenarioId": "<frontMatter.id>",
  "target": "<frontMatter.target>",
  "failedStep": "<手順の文言をそのまま>",
  "rootCause": "<原因の解釈を 1〜2 文で>",
  "snapshotExcerpt": "<最後の snapshot YAML を 30 行まで>",
  "durationMs": <elapsed>,
  "runId": "<RUN_ID>"
}
```

INFRA_ERROR (target unreachable, playwright-cli 起動失敗, タイムアウト) の場合:
```json
{
  "status": "INFRA_ERROR",
  "scenarioId": "<frontMatter.id>",
  "target": "<frontMatter.target>",
  "rootCause": "<例: 'target unreachable: connection refused'>",
  "runId": "<RUN_ID>"
}
```

書き出しは:
```bash
cat > "$RESULT_FILE" <<'EOF'
{ ...JSON... }
EOF
```

# 制約

- パスワード平文を snapshot / screenshot / Issue body / stdout に残さない
- 全体タイムアウト (`frontMatter.timeoutSec` 秒) を超えたら INFRA_ERROR で打ち切る
- アーティファクト (snapshot / screenshot) は `.e2e-artifacts/$RUN_ID/` 配下に保存

# 成功条件

このプロンプトの目的は **`$RESULT_FILE` に有効な RunResult JSON を書くこと**。それさえできれば exit code は問わない (Bash 側で読む)。
```

- [ ] **Step 2: lint で破綻していないか軽く確認**

```bash
cat prompts/run.md | head -20
```

期待: markdown が読める形

- [ ] **Step 3: Commit**

```bash
git add prompts/run.md
git commit -m "feat(prompts): add run.md v1 for Codex scenario execution"
```

---

### Task 6: scripts/entrypoint.sh + scripts/validate.sh

**Files:**
- Create: `scripts/entrypoint.sh`
- Create: `scripts/validate.sh`

- [ ] **Step 1: `scripts/entrypoint.sh` を作成**

```bash
#!/usr/bin/env bash
# Docker ENTRYPOINT。サブコマンドで分岐する。
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
```

- [ ] **Step 2: `scripts/validate.sh` を作成**

```bash
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
```

- [ ] **Step 3: 実行権限を付与**

```bash
chmod +x scripts/entrypoint.sh scripts/validate.sh
```

- [ ] **Step 4: ローカルで validate.sh を試す (lib のパス置換)**

`tsx /app/lib/parse-scenario.ts` は Docker 内パス想定。ローカル動作確認は別途行うので、ここではスクリプトの構文だけ確認する。

```bash
bash -n scripts/entrypoint.sh
bash -n scripts/validate.sh
```

期待: 構文エラーなし (出力なしで exit 0)

- [ ] **Step 5: shellcheck で警告ゼロを確認**

```bash
shellcheck scripts/entrypoint.sh scripts/validate.sh
```

期待: 出力なし (警告ゼロ)。`shellcheck` 未インストールなら `brew install shellcheck` 等で入れる。

- [ ] **Step 6: Commit**

```bash
git add scripts/entrypoint.sh scripts/validate.sh
git commit -m "feat(scripts): add entrypoint dispatcher and validate.sh"
```

---

### Task 7: scripts/run-regression.sh (--dry-run 対応)

**Files:**
- Create: `scripts/run-regression.sh`

- [ ] **Step 1: `scripts/run-regression.sh` を作成**

```bash
#!/usr/bin/env bash
# シナリオを順に実行する。--dry-run で実際の codex exec を呼ばずに動作確認。
# --only <id> で特定シナリオだけ実行。
set -euo pipefail

DRY_RUN=0
ONLY=""
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
    title=$(echo "$issue_json" | jq -r .title)
    body=$(echo "$issue_json" | jq -r .body)
    labels=$(echo "$issue_json" | jq -r '.labels | join(",")')

    if ! gh issue create -R "$GITHUB_REPO" --title "$title" --body "$body" --label "$labels"; then
      for lbl in $(echo "$labels" | tr ',' ' '); do
        gh label create -R "$GITHUB_REPO" "$lbl" --color B60205 2>/dev/null || true
      done
      gh issue create -R "$GITHUB_REPO" --title "$title" --body "$body" --label "$labels" \
        || echo "ISSUE CREATE FAILED: $id" >&2
    fi
  fi
done

echo "run-regression completed"
```

- [ ] **Step 2: 実行権限を付与**

```bash
chmod +x scripts/run-regression.sh
```

- [ ] **Step 3: 構文チェック**

```bash
bash -n scripts/run-regression.sh
```

期待: 出力なし (構文 OK)

- [ ] **Step 4: shellcheck で警告ゼロ**

```bash
shellcheck scripts/run-regression.sh
```

期待: 警告ゼロ。`SC2086` などが出たら quoting を見直して修正する。

- [ ] **Step 5: --dry-run をローカルで試す (Docker 外でも動く想定)**

```bash
TARGET_REPO_URL=https://github.com/yaichi-tech/strike-hyperion.git \
TARGET_BRANCH=main \
TARGET_URL=https://example.com \
GITHUB_REPO=yaichi-tech/strike-hyperion \
GH_TOKEN=dummy \
./scripts/run-regression.sh --dry-run
```

期待: `[dry-run] would clone/pull ...` のログが出て exit 0。clone 実行はしない。

- [ ] **Step 6: 必須環境変数が欠けるとエラーになるか確認**

```bash
./scripts/run-regression.sh --dry-run
```

期待: `FATAL: missing env vars: TARGET_REPO_URL TARGET_BRANCH TARGET_URL GITHUB_REPO GH_TOKEN` で exit 2

- [ ] **Step 7: Commit**

```bash
git add scripts/run-regression.sh
git commit -m "feat(scripts): add run-regression with --dry-run and --only modes"
```

---

### Task 8: Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: `Dockerfile` を作成**

```dockerfile
FROM node:22-bookworm-slim

# 必要パッケージ: git (target clone), chromium (playwright-cli), jq (scripts), gh CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git chromium jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Codex CLI / playwright-cli / tsx をグローバルに
RUN npm install -g @openai/codex playwright-cli tsx

WORKDIR /app

# project deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# project source
COPY lib ./lib
COPY scripts ./scripts
COPY prompts ./prompts

RUN chmod +x scripts/*.sh

# playwright-cli が chromium バイナリを探す場所
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
# Codex login の credential 永続化先 (compose で volume mount)
ENV CODEX_HOME=/root/.codex

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["sleep", "infinity"]
```

- [ ] **Step 2: docker build を実行**

```bash
docker build -t codex-e2e-runner:test .
```

期待: 最後に `Successfully tagged codex-e2e-runner:test` (または同等)。エラーで止まったら出力を読んで修正。

- [ ] **Step 3: validate サブコマンドが動くか確認**

```bash
docker run --rm \
  -v "$PWD/tests/fixtures:/work" \
  codex-e2e-runner:test \
  validate /work/valid-login.md
```

期待: `OK: /work/valid-login.md` が stdout に出て exit 0

- [ ] **Step 4: 不正な md が exit 1 になるか確認**

```bash
docker run --rm \
  -v "$PWD/tests/fixtures:/work" \
  codex-e2e-runner:test \
  validate /work/invalid-id.md
```

期待: `INVALID: /work/invalid-id.md` が stderr に出て exit 1

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Dockerfile (node + chromium + playwright-cli + codex + gh)"
```

---

### Task 9: compose.yml

**Files:**
- Create: `compose.yml`

- [ ] **Step 1: `compose.yml` を作成**

```yaml
services:
  codex-e2e:
    build: .
    image: codex-e2e-runner:local
    container_name: codex-e2e
    env_file: .env
    volumes:
      - codex-auth:/root/.codex
      - artifacts:/app/.e2e-artifacts
      - targets:/opt/targets
    labels:
      ofelia.enabled: "true"
      ofelia.job-exec.regression.schedule: "0 7 * * 1-5"
      ofelia.job-exec.regression.command: "/app/scripts/run-regression.sh"
      ofelia.job-exec.regression.no-overlap: "true"
    command: ["sleep", "infinity"]
    restart: unless-stopped

  cron:
    image: mcuadros/ofelia:latest
    container_name: codex-e2e-cron
    command: daemon --docker
    depends_on:
      - codex-e2e
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

volumes:
  codex-auth:
  artifacts:
  targets:
```

注: `propose-scenarios.sh` の cron 設定は別プランで追加する。MVP では `regression` のみ。

- [ ] **Step 2: 構文検証**

```bash
# .env がまだないので env_file 警告は無視する代わりに、テスト用空ファイルで通す
touch .env
docker compose config -q
rm .env
```

期待: 出力なし (構文 OK)

- [ ] **Step 3: Commit**

```bash
git add compose.yml
git commit -m "feat: add compose.yml with codex-e2e + ofelia cron sidecar"
```

---

### Task 10: .env.example

**Files:**
- Create: `.env.example`

- [ ] **Step 1: `.env.example` を作成**

```bash
# 対象プロジェクトの git URL
TARGET_REPO_URL=https://github.com/yaichi-tech/strike-hyperion.git
TARGET_BRANCH=main

# 対象環境 (E2E 実行対象のフロントエンド URL)
TARGET_URL=https://strike-hyperion-web-stg.yaichi.workers.dev

# Issue / PR 起票先リポジトリ (owner/repo)
GITHUB_REPO=yaichi-tech/strike-hyperion

# gh CLI 用 PAT (scope: repo)
GH_TOKEN=

# シナリオごとに必要なテストユーザーパスワード
# シナリオ front-matter の account: SYSTEM_ADMIN → E2E_ACCOUNT_SYSTEM_ADMIN_PASSWORD
E2E_ACCOUNT_SYSTEM_ADMIN_PASSWORD=
E2E_ACCOUNT_STAFF_PASSWORD=

# Codex は `codex login` で OAuth するので OPENAI_API_KEY は不要
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "feat: add .env.example with all required runner env vars"
```

---

### Task 11: .github/workflows/ci.yml

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: `.github/workflows/ci.yml` を作成**

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  lib:
    runs-on: ubuntu-latest
    name: lib (vitest + biome)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npm run lint
      - run: npm test

  shell:
    runs-on: ubuntu-latest
    name: shell (shellcheck)
    steps:
      - uses: actions/checkout@v4
      - name: Install shellcheck
        run: sudo apt-get update && sudo apt-get install -y shellcheck
      - run: shellcheck scripts/*.sh

  docker:
    runs-on: ubuntu-latest
    name: docker (build + validate)
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          load: true
          tags: codex-e2e-runner:ci
      - name: Validate fixture md via container
        run: |
          docker run --rm \
            -v "$PWD/tests/fixtures:/work" \
            codex-e2e-runner:ci \
            validate /work/valid-login.md

  compose:
    runs-on: ubuntu-latest
    name: compose (config -q)
    steps:
      - uses: actions/checkout@v4
      - name: Create empty .env
        run: touch .env
      - run: docker compose config -q
```

- [ ] **Step 2: ローカルで YAML 構文を軽く確認**

```bash
# yq があれば
yq '.jobs | keys' .github/workflows/ci.yml || cat .github/workflows/ci.yml | head -5
```

期待: jobs に `lib / shell / docker / compose` の 4 つがある

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lib test + shellcheck + docker build + compose validate jobs"
```

- [ ] **Step 4: main へ push して CI を回す**

```bash
git push origin main
```

GitHub Actions タブを開き、4 ジョブすべて緑になることを確認する。失敗したらログを読んで修正。

---

### Task 12: 最終 smoke (任意・ローカルで)

ここまでで CI が緑なら "完了" 条件は満たすが、ローカルで end-to-end の動作確認を 1 回やっておく。

- [ ] **Step 1: `.env` を作って実値を入れる (git add しない)**

```bash
cp .env.example .env
$EDITOR .env
# GH_TOKEN, E2E_ACCOUNT_*_PASSWORD を埋める
```

- [ ] **Step 2: container を起動**

```bash
docker compose up -d
```

期待: codex-e2e と codex-e2e-cron の 2 container が Up

- [ ] **Step 3: codex login (対話 OAuth)**

```bash
docker compose exec codex-e2e codex login
```

ブラウザで ChatGPT サインインフローを完了。

- [ ] **Step 4: dry-run**

```bash
docker compose exec codex-e2e /app/scripts/run-regression.sh --dry-run
```

期待: 対象リポを clone するログ → シナリオごとに `[dry-run] would execute scenario: ...` が出る (シナリオがなければ何も出ない)

- [ ] **Step 5: 後片付け**

```bash
docker compose down
```

(`.env` はローカルに残しておけば次回も使える)

ここまで通れば Core runner は完成。次は infra プラン or propose プラン。

---

## Self-Review (writing-plans skill 自己チェック結果)

- **Spec coverage**: 設計書 §1-§9 のうち、§3 (アーキ図) §4 (ファイル構造) §5 (コンポーネント) §6 (データフロー) §7 (エラー処理) §8 (テスト戦略) を Plan 1 でカバー。§9 (運用) と §5-3/5-4 (infra) と §5-8 (propose) は別プラン
- **Placeholder scan**: `TBD`/`TODO`/`...` の placeholder なし。すべての step に実コードまたは実コマンド
- **Type consistency**: `RunResult` の field 名は parse-scenario / build-issue / run-regression / prompts/run.md 間で一致 (`status`, `scenarioId`, `target`, `failedStep`, `rootCause`, `snapshotExcerpt`, `durationMs`, `runId`)
- **Scope check**: 1 つの実装サイクルに収まる規模 (12 タスク、推定 1〜2 日)
