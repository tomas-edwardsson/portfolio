// PostToolUse hook: regenerate portfolio views after an Edit/Write to a
// portfolio item. Reads the hook JSON from stdin. Never fails the tool
// call: always exits 0. Node >= 22.18.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const GENERATED_NAMES = new Set(["BOARD.md", "ROADMAP.md", "BRAGLOG.md"]);

export function portfolioRootFor(filePath: string | undefined | null): string | null {
  if (!filePath) return null;
  const p = filePath.replaceAll("\\", "/"); // Windows hook input arrives with backslashes
  if (!p.endsWith(".md")) return null;
  const idx = p.indexOf("/portfolio/");
  if (idx < 0) return null;
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (GENERATED_NAMES.has(base)) return null;
  return p.slice(0, idx) + "/portfolio";
}

function main(): void {
  try {
    const data = JSON.parse(readFileSync(0, "utf8"));
    const root = portfolioRootFor(data?.tool_input?.file_path);
    if (root) {
      const script = join(root, "build-views.mts");
      if (existsSync(script)) {
        spawnSync(process.execPath, [script], { stdio: "ignore", timeout: 12_000 });
      }
    }
  } catch {
    // Never block the tool call — swallow everything.
  }
  process.exit(0);
}

if (import.meta.main) {
  main();
}
