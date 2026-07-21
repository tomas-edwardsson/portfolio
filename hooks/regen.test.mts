import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { portfolioRootFor } from "./regen.mts";

test("portfolioRootFor accepts an item path", () => {
  assert.equal(portfolioRootFor("/w/repo/portfolio/epics/2026-01-01-a/_epic.md"),
    "/w/repo/portfolio");
  assert.equal(portfolioRootFor("/w/repo/portfolio/inbox/2026-01-01-x.md"),
    "/w/repo/portfolio");
});

test("portfolioRootFor normalizes Windows backslash paths", () => {
  assert.equal(portfolioRootFor("C:\\Users\\t\\repo\\portfolio\\inbox\\2026-01-01-x.md"),
    "C:/Users/t/repo/portfolio");
});

test("portfolioRootFor rejects generated views and non-items", () => {
  assert.equal(portfolioRootFor("/w/repo/portfolio/BOARD.md"), null);
  assert.equal(portfolioRootFor("/w/repo/portfolio/ROADMAP.md"), null);
  assert.equal(portfolioRootFor("/w/repo/portfolio/BRAGLOG.md"), null);
  assert.equal(portfolioRootFor("/w/repo/portfolio/portfolio.html"), null);
  assert.equal(portfolioRootFor("/w/repo/src/portfolio.md"), null);
  assert.equal(portfolioRootFor("/w/repo/README.md"), null);
  assert.equal(portfolioRootFor(undefined), null);
  assert.equal(portfolioRootFor(""), null);
});

test("portfolioRootFor uses the first portfolio segment", () => {
  assert.equal(portfolioRootFor("/w/portfolio/epics/x/portfolio/y.md"), "/w/portfolio");
});

function runHook(t: TestContext, stdin: string): { status: number | null; root: string } {
  const tmp = mkdtempSync(join(tmpdir(), "regen-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, "portfolio");
  mkdirSync(root, { recursive: true });
  // Sentinel stand-in for build-views.mts: proves the hook spawned it.
  writeFileSync(join(root, "build-views.mts"),
    'import { writeFileSync } from "node:fs";\n' +
    'writeFileSync(new URL("ran.txt", import.meta.url), "ran", "utf8");\n', "utf8");
  const res = spawnSync(process.execPath, [join(import.meta.dirname, "regen.mts")],
    { input: stdin.replaceAll("__ROOT__", root), encoding: "utf8" });
  return { status: res.status, root };
}

test("hook regenerates on a portfolio item edit", (t) => {
  const { status, root } = runHook(t, JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "__ROOT__/inbox/2026-01-01-x.md" },
  }));
  assert.equal(status, 0);
  assert.ok(existsSync(join(root, "ran.txt")));
});

test("hook skips generated files", (t) => {
  const { status, root } = runHook(t, JSON.stringify({
    tool_input: { file_path: "__ROOT__/BOARD.md" },
  }));
  assert.equal(status, 0);
  assert.ok(!existsSync(join(root, "ran.txt")));
});

test("hook exits 0 on garbage input", (t) => {
  const { status, root } = runHook(t, "this is not json{{{");
  assert.equal(status, 0);
  assert.ok(!existsSync(join(root, "ran.txt")));
});

test("hook exits 0 when build-views.mts is absent", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "regen-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const res = spawnSync(process.execPath, [join(import.meta.dirname, "regen.mts")], {
    input: JSON.stringify({ tool_input: { file_path: join(tmp, "portfolio", "inbox", "x.md") } }),
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
});
