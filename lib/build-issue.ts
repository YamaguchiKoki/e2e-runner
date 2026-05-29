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
type NonPassResult = Exclude<RunResult, { status: "PASS" }>;

const MAX_SNAPSHOT_LINES = 30;

function truncateSnapshot(s: string): string {
  const lines = s.split("\n");
  if (lines.length <= MAX_SNAPSHOT_LINES) return s;
  return `${lines.slice(0, MAX_SNAPSHOT_LINES).join("\n")}\n... (${lines.length - MAX_SNAPSHOT_LINES} more lines truncated)`;
}

function buildTitle(r: NonPassResult): string {
  const tag = `[E2E ${r.status}]`;
  if (r.status === "FAIL") {
    return `${tag} ${r.scenarioId}: ${r.failedStep} で失敗`;
  }
  return `${tag} ${r.scenarioId}: ${r.rootCause}`;
}

function buildLabels(r: NonPassResult): string[] {
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

function buildBody(r: NonPassResult): string {
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
  if (r.runId != null) lines.push(`- **run id**: \`${r.runId}\``);
  if (r.status === "FAIL") {
    lines.push(`- **所要時間**: ${r.durationMs}ms`);
  }
  if (r.status === "INFRA_ERROR") {
    lines.push("");
    lines.push(
      "> インフラ系の失敗です。リトライしても直らなければターゲット環境を確認してください。",
    );
  }
  if (r.status === "RUNNER_BUG") {
    lines.push("");
    lines.push("> runner 内部のバグです。codex の出力か lib の zod スキーマを確認してください。");
  }
  if (r.status === "FAIL") {
    lines.push("");
    lines.push("## 画面スナップショット抜粋");
    lines.push("");
    for (const line of truncateSnapshot(r.snapshotExcerpt).split("\n")) {
      lines.push(`    ${line}`);
    }
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
  if (fileIdx === -1) {
    process.stderr.write("usage: build-issue.ts --file <result.json>\n");
    return 2;
  }
  const filePath = argv[fileIdx + 1];
  if (!filePath) {
    process.stderr.write("usage: build-issue.ts --file <result.json>\n");
    return 2;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    process.stderr.write(`file not found: ${filePath}\n`);
    return 1;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    process.stderr.write(`invalid JSON in ${filePath}\n`);
    return 1;
  }

  const parsed = RunResultSchema.safeParse(json);
  if (!parsed.success) {
    process.stderr.write(`${JSON.stringify(parsed.error.format(), null, 2)}\n`);
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
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
