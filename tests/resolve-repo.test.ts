import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
  afterAll(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

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

  it("origin URL が空文字列なら exit 1", () => {
    const dir = makeTempGit(null);
    tmpDirs.push(dir);
    // origin を追加した後、URL を空に上書き
    execSync('git remote add origin "https://example.com/x/y.git"', { cwd: dir });
    execSync('git config remote.origin.url ""', { cwd: dir });
    const r = runInDir(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("empty");
  });

  it("末尾スラッシュ付き URL でも owner/repo を抽出", () => {
    const dir = makeTempGit("https://github.com/yaichi-tech/strike-hyperion/");
    tmpDirs.push(dir);
    const r = runInDir(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("yaichi-tech/strike-hyperion");
  });
});
