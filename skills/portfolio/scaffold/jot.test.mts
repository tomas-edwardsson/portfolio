import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { slugify, nextId, epicDir, jot } from "./jot.mts";

const SCAFFOLD_DIR = dirname(fileURLToPath(import.meta.url));

function makeRoot(t: TestContext): string {
  const tmp = mkdtempSync(join(tmpdir(), "jot-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, "inbox"), { recursive: true });
  mkdirSync(join(tmp, "epics", "2026-01-01-alpha"), { recursive: true });
  writeFileSync(join(tmp, "epics", "2026-01-01-alpha", "_epic.md"),
    "---\nid: E01\ntype: epic\ntitle: Alpha\nstatus: active\n---\n\nAlpha.\n", "utf8");
  writeFileSync(join(tmp, "inbox", "2026-01-02-old.md"),
    "---\nid: I03\ntype: idea\ntitle: Old\nstatus: future\n---\n\nOld.\n", "utf8");
  writeFileSync(join(tmp, "epics", "2026-01-01-alpha", "2026-01-02-t.md"),
    "---\nid: T007\ntype: task\ntitle: Seven\nstatus: done\nepic: E01\n---\n\nx.\n", "utf8");
  return tmp;
}

test("slugify", () => {
  assert.equal(slugify("Fix the CI!  Now"), "fix-the-ci-now");
  assert.equal(slugify("--Weird__ (title)--"), "weird-title");
  assert.equal(slugify("ÁÉÍ"), "");
});

test("next id scans inbox and epics", (t) => {
  const root = makeRoot(t);
  assert.equal(nextId(root, "I", 2), "I04");
  assert.equal(nextId(root, "T", 3), "T008");
  assert.equal(nextId(root, "E", 2), "E02");
  assert.equal(nextId(root, "S", 2), "S01");
});

test("epic dir resolves by id", (t) => {
  const root = makeRoot(t);
  assert.equal(epicDir(root, "E01"), join(root, "epics", "2026-01-01-alpha"));
  assert.equal(epicDir(root, "E99"), null);
});

test("jot creates an inbox idea", (t) => {
  const root = makeRoot(t);
  const { out, code } = jot(root, ["Try the new parser", "One-liner."]);
  assert.equal(code, 0);
  const files = readdirSync(join(root, "inbox")).filter((f) => f.includes("try-the-new-parser"));
  assert.equal(files.length, 1);
  const text = readFileSync(join(root, "inbox", files[0]), "utf8");
  assert.ok(text.includes("id: I04"));
  assert.ok(text.includes("type: idea"));
  assert.ok(text.includes("title: Try the new parser"));
  assert.ok(text.includes("One-liner."));
  assert.ok(out.includes("I04"));
  assert.ok(out.startsWith("Created inbox/"));
  assert.ok(!out.includes(root));
});

test("jot refuses duplicate file", (t) => {
  const root = makeRoot(t);
  assert.equal(jot(root, ["Same title"]).code, 0);
  const again = jot(root, ["Same title"]);
  assert.equal(again.code, 1);
  assert.ok(again.out.includes("already exists"));
  assert.ok(again.out.startsWith("error: inbox/"));
  assert.ok(!again.out.includes(root));
});

test("jot --epic files a task under the epic", (t) => {
  const root = makeRoot(t);
  const { out, code } = jot(root, ["--epic", "E01", "Wire the flag", "Desc."]);
  assert.equal(code, 0);
  const dir = join(root, "epics", "2026-01-01-alpha");
  const files = readdirSync(dir).filter((f) => f.includes("wire-the-flag"));
  assert.equal(files.length, 1);
  const text = readFileSync(join(dir, files[0]), "utf8");
  assert.ok(text.includes("id: T008"));
  assert.ok(text.includes("type: task"));
  assert.ok(text.includes("epic: E01"));
  assert.ok(!text.includes("story:"));
  assert.ok(out.includes("T008"));
  assert.ok(out.startsWith("Created epics/2026-01-01-alpha/"));
  assert.ok(!out.includes(root));
});

test("jot --epic --story records the story link", (t) => {
  const root = makeRoot(t);
  const { code } = jot(root, ["--epic", "E01", "--story", "S05", "Linked task"]);
  assert.equal(code, 0);
  const dir = join(root, "epics", "2026-01-01-alpha");
  const f = readdirSync(dir).filter((n) => n.includes("linked-task"))[0];
  assert.ok(readFileSync(join(dir, f), "utf8").includes("story: S05"));
});

test("set-epic marker round trip", (t) => {
  const root = makeRoot(t);
  assert.equal(jot(root, ["--set-epic", "E01"]).code, 0);
  assert.equal(readFileSync(join(root, ".current-epic"), "utf8").trim(), "E01");
  const { code } = jot(root, ["--epic", "Task via marker"]);
  assert.equal(code, 0);
  assert.equal(jot(root, ["--clear-epic"]).code, 0);
  assert.ok(!existsSync(join(root, ".current-epic")));
  const after = jot(root, ["--epic", "No marker now"]);
  assert.equal(after.code, 1);
  assert.ok(after.out.includes("no epic given"));
  assert.ok(after.out.includes("no .current-epic set"));
  assert.ok(!after.out.includes(root));
});

test("set-epic unknown id fails", (t) => {
  const root = makeRoot(t);
  const res = jot(root, ["--set-epic", "E99"]);
  assert.equal(res.code, 1);
  assert.ok(res.out.includes("not found"));
});

test("--story without --epic fails", (t) => {
  const root = makeRoot(t);
  const res = jot(root, ["--story", "S05", "Oops"]);
  assert.equal(res.code, 1);
  assert.ok(res.out.includes("--story requires --epic"));
});

test("--next-id prints and creates nothing", (t) => {
  const root = makeRoot(t);
  const res = jot(root, ["--next-id", "T"]);
  assert.equal(res.code, 0);
  assert.equal(res.out.trim(), "T008");
  assert.equal(readdirSync(join(root, "inbox")).length, 1);
});

test("no args prints usage", (t) => {
  const root = makeRoot(t);
  const res = jot(root, []);
  assert.equal(res.code, 1);
  assert.ok(res.out.includes("usage:"));
});

function makeCliRoot(t: TestContext, buildViewsBody: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "jot-cli-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  copyFileSync(join(SCAFFOLD_DIR, "jot.mts"), join(tmp, "jot.mts"));
  writeFileSync(join(tmp, "build-views.mts"), buildViewsBody, "utf8");
  mkdirSync(join(tmp, "inbox"), { recursive: true });
  mkdirSync(join(tmp, "epics"), { recursive: true });
  return tmp;
}

test("main aborts and prints nothing on regen failure", (t) => {
  const root = makeCliRoot(t, "process.exit(3);\n");
  const res = spawnSync(process.execPath, [join(root, "jot.mts"), "Some idea"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 3);
  assert.ok(!res.stdout.includes("Created"));
});

test("main prints Created after successful regen", (t) => {
  const root = makeCliRoot(t, "process.exit(0);\n");
  const res = spawnSync(process.execPath, [join(root, "jot.mts"), "Some idea"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Created inbox/"));
});
