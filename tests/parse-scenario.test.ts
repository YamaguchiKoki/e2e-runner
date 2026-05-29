import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal in test name
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
    const r = run([path.join(FIXTURES, "valid-no-timeout.md")], {
      TARGET_URL: "https://stg.example.com",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.frontMatter.timeoutSec).toBe(120);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal in test name
  it("TARGET_URL 未設定で ${TARGET_URL} を含む target は exit 1", () => {
    // 環境から TARGET_URL を確実に外す
    const env = { ...process.env };
    delete env.TARGET_URL;
    const r = spawnSync("npx", ["tsx", BIN, path.join(FIXTURES, "valid-login.md")], {
      encoding: "utf-8",
      env,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TARGET_URL");
  });
});
