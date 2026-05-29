import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";

const FrontMatterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must match ^[a-z][a-z0-9-]*$"),
  target: z.string().min(1, "target is required"),
  account: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "account must match ^[A-Z][A-Z0-9_]*$"),
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
    process.stderr.write(`${JSON.stringify(parsed.error.format(), null, 2)}\n`);
    return 1;
  }
  const targetUrl = process.env.TARGET_URL ?? "";
  const targetResolved = parsed.data.target.replace(/\$\{TARGET_URL\}/g, targetUrl);
  if (targetResolved.trim() === "") {
    process.stderr.write("target resolved to empty string (is TARGET_URL set?)\n");
    return 1;
  }
  const accountEnvKey = `E2E_ACCOUNT_${parsed.data.account}_PASSWORD`;
  const out = {
    frontMatter: { ...parsed.data, target: targetResolved },
    body: content.trim(),
    accountEnvKey,
    path: absPath,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
