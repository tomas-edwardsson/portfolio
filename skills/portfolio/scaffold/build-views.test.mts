import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { TestContext } from "node:test";

import * as bv from "./build-views.mts";

function idx(hay: string, needle: string): number {
  const i = hay.indexOf(needle);
  assert.ok(i >= 0, `expected to find: ${needle}`);
  return i;
}

test("quoted title is unquoted", () => {
  const [fm] = bv.parseFrontmatter('---\nid: S99\ntitle: "Decision: pick a policy"\n---\nbody\n');
  assert.equal(fm["title"], "Decision: pick a policy");
});

test("single quotes and bare values untouched", () => {
  const [fm] = bv.parseFrontmatter("---\nid: S98\ntitle: 'Quoted single'\nstatus: future\n---\n");
  assert.equal(fm["title"], "Quoted single");
  assert.equal(fm["status"], "future");
});

test("missing frontmatter returns text as body", () => {
  const [fm, body] = bv.parseFrontmatter("# Just a doc\n\nHello.\n");
  assert.deepEqual(fm, {});
  assert.ok(body.includes("Hello."));
});

test("crlf frontmatter parses", () => {
  const [fm] = bv.parseFrontmatter("---\r\nid: T01\r\ntitle: Win file\r\n---\r\nbody\r\n");
  assert.equal(fm["id"], "T01");
  assert.equal(fm["title"], "Win file");
});

test("parse id list", () => {
  assert.deepEqual(bv.parseIdList("[S05, S09]"), ["S05", "S09"]);
  assert.deepEqual(bv.parseIdList("S05"), ["S05"]);
  assert.deepEqual(bv.parseIdList(""), []);
});

test("first body line joins paragraph", () => {
  const body = "# Heading\n\n<!-- a comment -->\nFirst line of the paragraph\ncontinues on a second line\nand a third line.\n\nSecond paragraph, must not be included.\n";
  assert.equal(bv.firstBodyLine(body),
    "First line of the paragraph continues on a second line and a third line.");
});

function writeItem(root: string, rel: string, fm: Record<string, string>): void {
  const body = fm["body"] ?? "Some description.";
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (k === "body") continue;
    lines.push(`${k.replaceAll("_", "-")}: ${v}`);
  }
  lines.push("---", "", body);
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  wfs(path, lines.join("\n") + "\n", "utf8");
}

function fixture(tmp: string): string {
  const root = tmp;
  writeItem(root, "epics/2026-01-01-alpha/_epic.md", { id: "E01", type: "epic",
    title: "Alpha", status: "active", horizon: "now", body: "Alpha epic summary line." });
  writeItem(root, "epics/2026-01-01-alpha/2026-01-01-s1.md", { id: "S01",
    type: "story", title: "First story", status: "active", epic: "E01" });
  writeItem(root, "epics/2026-01-02-beta/_epic.md", { id: "E02", type: "epic",
    title: "Beta", status: "future", horizon: "next",
    body: "Beta epic summary line that\ncontinues over two lines." });
  writeItem(root, "epics/2026-01-02-beta/2026-01-02-s2.md", { id: "S02",
    type: "story", title: "Foundation", status: "future", epic: "E02" });
  writeItem(root, "epics/2026-01-02-beta/2026-01-02-s3.md", { id: "S03",
    type: "story", title: "Dependent", status: "future", epic: "E02", blocked_by: "[S02]" });
  writeItem(root, "inbox/2026-01-03-idea.md", { id: "I01", type: "idea",
    title: "Loose idea", status: "future", horizon: "later", body: "One-liner about the idea." });
  writeItem(root, "inbox/2026-01-04-promoted.md", { id: "I02", type: "idea",
    title: "Old idea", status: "promoted", promoted_to: "E02" });
  writeItem(root, "inbox/2026-01-05-idea-next.md", { id: "I03", type: "idea",
    title: "Raised idea", status: "future", horizon: "next", body: "Raised idea summary." });
  return root;
}

function setup(t: TestContext): { root: string; items: bv.Items } {
  const tmp = mkdtempSync(join(tmpdir(), "pf-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = fixture(tmp);
  const [items, warns] = bv.loadItems(root);
  assert.deepEqual(warns, []);
  return { root, items };
}

test("fixture loads all items without warnings", (t) => {
  const { items } = setup(t);
  assert.deepEqual([...items.keys()].sort(),
    ["E01", "E02", "I01", "I02", "I03", "S01", "S02", "S03"]);
  assert.equal(items.get("S03")!.blockedBy[0], "S02");
});

test("frontmatterless file skipped silently", (t) => {
  const { root, items } = setup(t);
  const marker = "Sentinel text unique to the reference doc.";
  wfs(join(root, "epics", "2026-01-01-alpha", "cost-analysis.md"),
    `# Cost Analysis\n\n${marker}\n`, "utf8");
  const [items2, warns] = bv.loadItems(root);
  assert.deepEqual(warns, []);
  assert.ok(!JSON.stringify([...items2.values()]).includes(marker));
  assert.deepEqual([...items2.keys()].sort(), [...items.keys()].sort());
});

test("frontmatter without id warns", (t) => {
  const { root } = setup(t);
  wfs(join(root, "epics", "2026-01-01-alpha", "orphan.md"),
    "---\ntype: task\ntitle: Orphan task\n---\n\nNo id set.\n", "utf8");
  const [items, warns] = bv.loadItems(root);
  assert.ok(warns.some((w) => w.includes("missing id")), JSON.stringify(warns));
  assert.ok(!JSON.stringify([...items.values()]).includes("Orphan task"));
});

test("duplicate id warns", (t) => {
  const { root } = setup(t);
  writeItem(root, "inbox/2026-01-06-dup.md", { id: "I01", type: "idea",
    title: "Duplicate", status: "future" });
  const [, warns] = bv.loadItems(root);
  assert.ok(warns.some((w) => w.includes("duplicate id I01")), JSON.stringify(warns));
});

test("unknown blocked-by warns", (t) => {
  const { items } = setup(t);
  items.get("S03")!.blockedBy = ["S99"];
  const warns = bv.validate(items);
  assert.ok(warns.some((w) => w.includes("unknown blocked-by id S99")));
});

test("cycle warns", (t) => {
  const { items } = setup(t);
  items.get("S02")!.blockedBy = ["S03"];
  const warns = bv.validate(items);
  assert.ok(warns.some((w) => w.includes("cycle")));
});

test("unknown status warns", (t) => {
  const { items } = setup(t);
  items.get("S01")!.status = "bananas";
  const warns = bv.validate(items);
  assert.ok(warns.some((w) => w.includes("unknown status 'bananas'")));
});

test("idea horizon now warns", (t) => {
  const { items } = setup(t);
  items.get("I01")!.horizon = "now";
  const warns = bv.validate(items);
  assert.ok(warns.some((w) => w.includes("I01") && w.includes("horizon")), JSON.stringify(warns));
});

test("parked status is valid", (t) => {
  const { items } = setup(t);
  items.get("E01")!.status = "parked";
  const warns = bv.validate(items);
  assert.deepEqual(warns.filter((w) => w.includes("status") && w.includes("E01")), []);
});
