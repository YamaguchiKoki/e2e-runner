import { execSync } from "node:child_process";

function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function main(): number {
  let url: string;
  try {
    url = execSync("git config --get remote.origin.url", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    if (!isGitRepo()) {
      process.stderr.write("not a git repository\n");
      return 1;
    }
    process.stderr.write("origin remote not configured\n");
    return 1;
  }
  if (!url) {
    process.stderr.write("origin remote URL is empty\n");
    return 1;
  }
  const normalized = url.replace(/\/+$/, "");
  const match = normalized.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    process.stderr.write(`could not parse owner/repo from: ${url}\n`);
    return 1;
  }
  const [, owner, repo] = match;
  if (!owner || !repo) {
    process.stderr.write(`could not parse owner/repo from: ${url}\n`);
    return 1;
  }
  process.stdout.write(`${owner}/${repo}\n`);
  return 0;
}

process.exit(main());
