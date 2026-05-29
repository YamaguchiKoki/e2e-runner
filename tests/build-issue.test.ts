import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(out.body).toMatch(/ {4}yaml-snapshot here/);
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
      expect(matches.length).toBe(30);
      expect(out.body).toContain("30 more lines truncated");
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it("引数なしは exit 2", () => {
    const r = run([]);
    expect(r.status).toBe(2);
  });

  it("存在しない file は exit 1", () => {
    const r = run(["--file", "/nonexistent/path/x.json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("file not found");
  });

  it("invalid JSON は exit 1", () => {
    const tmpPath = path.join(FIXTURES, "_tmp-invalid.json");
    fs.writeFileSync(tmpPath, "{ this is not json");
    try {
      const r = run(["--file", tmpPath]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("invalid JSON");
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it("RUNNER_BUG without runId: body は run id 行を含まない", () => {
    const tmpPath = path.join(FIXTURES, "_tmp-runner-bug-no-runid.json");
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        status: "RUNNER_BUG",
        scenarioId: "x-001",
        rootCause: "test",
      }),
    );
    try {
      const r = run(["--file", tmpPath]);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.body).not.toContain("run id");
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
