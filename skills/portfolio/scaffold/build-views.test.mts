import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync as wfs, readFileSync, readdirSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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

test("idea appears in later", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-01-05");
  assert.ok(roadmap.includes("[I01] Loose idea"), roadmap);
  assert.ok(roadmap.includes("One-liner about the idea."));
});

test("next horizon idea appears in next", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-01-05");
  const nxt = idx(roadmap, "## ⏭️ Next");
  const later = idx(roadmap, "## 🌅 Later");
  assert.ok(roadmap.includes("[I03] Raised idea 💡 — Raised idea summary."));
  const i = idx(roadmap, "[I03] Raised idea");
  assert.ok(nxt < i && i < later);
  assert.ok(!roadmap.slice(later).includes("[I03]"));
  assert.ok(later < idx(roadmap, "[I01] Loose idea"));
});

test("promoted idea hidden", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-01-05");
  assert.ok(!roadmap.includes("I02"));
});

test("ships after rendered for pending blocker", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-01-05");
  const board = bv.renderBoard(items, "2026-01-05");
  assert.ok(roadmap.includes("after S02"));
  assert.ok(board.includes("after S02"));
});

test("ships after dropped when blocker done", (t) => {
  const { items } = setup(t);
  items.get("S02")!.status = "done";
  const roadmap = bv.renderRoadmap(items, "2026-01-05");
  assert.ok(!roadmap.includes("after S02"));
});

test("now next later sections", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-01-05");
  assert.ok(!roadmap.includes("## 🎯 Now"));
  assert.ok(!roadmap.includes("[E01] Alpha"));
  const nxt = idx(roadmap, "## ⏭️ Next");
  const later = idx(roadmap, "## 🌅 Later");
  const beta = idx(roadmap, "[E02] Beta");
  assert.ok(nxt < beta && beta < later);
  assert.ok(roadmap.includes("Beta epic summary line that continues over two lines."));
  const foundation = idx(roadmap, "[S02] Foundation");
  assert.ok(nxt < foundation && foundation < later);
  const dependentIdx = idx(roadmap, "[S03] Dependent");
  assert.ok(nxt < dependentIdx && dependentIdx < later);
  assert.ok(roadmap.slice(dependentIdx, later).includes("after S02"));
});

test("render idempotent", (t) => {
  const { items } = setup(t);
  const a = bv.renderRoadmap(items, "2026-01-05");
  const b = bv.renderRoadmap(items, "2026-01-05");
  assert.equal(a, b);
  assert.equal(bv.renderBoard(items, "2026-01-05"), bv.renderBoard(items, "2026-01-05"));
});

test("board keeps status sections", (t) => {
  const { items } = setup(t);
  const board = bv.renderBoard(items, "2026-01-05");
  for (const heading of ["## ⛔ Blocked", "## 🎬 Ready for Dev", "## 🏃 Active", "## 🏆 Shipped"]) {
    assert.ok(board.includes(heading), heading);
  }
  assert.ok(board.includes("[S01] First story — E01 Alpha"));
});

test("loads updated completed story fields", (t) => {
  const { items } = setup(t);
  const s01 = items.get("S01")!;
  assert.ok("updated" in s01);
  assert.ok("completed" in s01);
  assert.ok("story" in s01);
});

test("ship date prefers completed", () => {
  assert.equal(bv.shipDate({ completed: "2026-02-01", updated: "2026-01-01" }), "2026-02-01");
  assert.equal(bv.shipDate({ completed: "", updated: "2026-01-01" }), "2026-01-01");
});

test("is parked cascades from epic", (t) => {
  const { items } = setup(t);
  items.get("E02")!.status = "parked";
  assert.ok(bv.isParked(items.get("S02")!, items));
  assert.ok(!bv.isParked(items.get("S01")!, items));
});

test("within days", () => {
  assert.ok(bv.withinDays("2026-01-20", "2026-02-01", 30));
  assert.ok(!bv.withinDays("2025-12-01", "2026-02-01", 30));
  assert.ok(!bv.withinDays("", "2026-02-01", 30));
});

test("active epic non-now horizon no warning", (t) => {
  const { items } = setup(t);
  items.get("E01")!.horizon = "next";
  const warns = bv.validate(items);
  assert.ok(!warns.some((w) => w.includes("expected now")));
});

test("board lane assignment", (t) => {
  const { items } = setup(t);
  assert.equal(bv.boardLane(items.get("S01")!, items), "active");
  assert.equal(bv.boardLane(items.get("S02")!, items), "ready");
  assert.equal(bv.boardLane(items.get("S03")!, items), "blocked");
});

test("board done story not a card", (t) => {
  const { items } = setup(t);
  items.get("S02")!.status = "done";
  assert.equal(bv.boardLane(items.get("S02")!, items), null);
});

test("board parked story excluded", (t) => {
  const { items } = setup(t);
  items.get("E02")!.status = "parked";
  assert.equal(bv.boardLane(items.get("S02")!, items), null);
  assert.equal(bv.boardLane(items.get("S03")!, items), null);
});

test("board shipped lane recent done epic", (t) => {
  const { items } = setup(t);
  items.get("E02")!.status = "done";
  items.get("E02")!.updated = "2026-06-20";
  const board = bv.renderBoard(items, "2026-07-01");
  const shipped = idx(board, "🏆 Shipped");
  assert.ok(board.slice(shipped).includes("[E02]"));
});

test("board shipped excludes old done epic", (t) => {
  const { items } = setup(t);
  items.get("E02")!.status = "done";
  items.get("E02")!.updated = "2026-01-01";
  const board = bv.renderBoard(items, "2026-07-01");
  const shipped = idx(board, "🏆 Shipped");
  assert.ok(!board.slice(shipped).includes("[E02]"));
});

test("roadmap excludes active epic", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-07-01");
  assert.ok(!roadmap.includes("[E01]"));
  assert.ok(!roadmap.includes("## 🎯 Now"));
});

test("roadmap future epic in next", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-07-01");
  assert.ok(roadmap.includes("[E02]"));
  const nxt = idx(roadmap, "## ⏭️ Next");
  const later = idx(roadmap, "## 🌅 Later");
  assert.ok(roadmap.slice(nxt, later).includes("[E02]"));
});

test("roadmap uses details accordion", (t) => {
  const { items } = setup(t);
  const roadmap = bv.renderRoadmap(items, "2026-07-01");
  assert.ok(roadmap.includes("<details>"));
  assert.ok(roadmap.includes("<summary>"));
});

test("roadmap parked section", (t) => {
  const { items } = setup(t);
  items.get("E02")!.status = "parked";
  const roadmap = bv.renderRoadmap(items, "2026-07-01");
  const parked = idx(roadmap, "## ⏸️ Parked");
  assert.ok(roadmap.slice(parked).includes("[E02]"));
  assert.ok(!roadmap.slice(0, parked).includes("[E02]"));
});

test("braglog groups and orders", (t) => {
  const { items } = setup(t);
  items.get("S01")!.status = "done";
  items.get("S01")!.updated = "2026-06-15";
  items.get("S02")!.status = "done";
  items.get("S02")!.updated = "2026-07-02";
  const brag = bv.renderBraglog(items, "2026-07-10");
  assert.ok(brag.includes("## July 2026"));
  assert.ok(brag.includes("## June 2026"));
  assert.ok(idx(brag, "## July 2026") < idx(brag, "## June 2026"));
  assert.ok(brag.includes("[S01]"));
  assert.ok(brag.includes("[S02]"));
});

test("braglog excludes dropped and open", (t) => {
  const { items } = setup(t);
  items.get("S01")!.status = "dropped";
  const brag = bv.renderBraglog(items, "2026-07-10");
  assert.ok(!brag.includes("[S01]"));
  assert.ok(!brag.includes("[S03]"));
});

test("braglog uses completed override", (t) => {
  const { items } = setup(t);
  items.get("S01")!.status = "done";
  items.get("S01")!.updated = "2026-01-01";
  items.get("S01")!.completed = "2026-07-05";
  const brag = bv.renderBraglog(items, "2026-07-10");
  assert.ok(brag.includes("2026-07-05"));
  assert.ok(brag.includes("## July 2026"));
});

test("html has three tabs", (t) => {
  const { items } = setup(t);
  const htm = bv.renderHtml(items, "2026-07-10");
  assert.ok(htm.includes('id="board"'));
  assert.ok(htm.includes('id="roadmap"'));
  assert.ok(htm.includes('id="braglog"'));
  assert.ok(htm.includes('data-tab="board"'));
});

test("html board has lanes and roadmap details", (t) => {
  const { items } = setup(t);
  const htm = bv.renderHtml(items, "2026-07-10");
  assert.ok(htm.includes("Ready for Dev"));
  assert.ok(htm.includes("<details"));
});

test("html board has epic rail", (t) => {
  const { items } = setup(t);
  const htm = bv.renderHtml(items, "2026-07-10");
  assert.ok(htm.includes('class="rail"'));
  assert.ok(htm.includes('data-epic-nav="all"'));
  assert.ok(htm.includes('data-epic-nav="E01"'));
  assert.ok(htm.includes('data-epic="E01"'));
  assert.ok(htm.includes('data-epic="all"'));
});

test("html rail hides epic with no open work", (t) => {
  const { items } = setup(t);
  items.get("S01")!.status = "done";
  const htm = bv.renderHtml(items, "2026-07-10");
  assert.ok(!htm.includes('data-epic-nav="E01"'));
  assert.ok(!htm.includes('data-epic="E01"'));
  assert.ok(htm.includes('data-epic-nav="all"'));
});

test("html self contained", (t) => {
  const { items } = setup(t);
  const htm = bv.renderHtml(items, "2026-07-10");
  assert.ok(!htm.includes("http://"));
  assert.ok(!htm.includes("https://"));
  assert.ok(!htm.includes("<link"));
});

test("html contains both views", (t) => {
  const { items } = setup(t);
  const html = bv.renderHtml(items, "2026-01-05");
  for (const token of ["Roadmap", "Board", "E01", "Alpha", "I01",
    "Loose idea", "after S02", "2026-01-05"]) {
    assert.ok(html.includes(token), token);
  }
});

test("html escapes titles", (t) => {
  const { items } = setup(t);
  items.get("S01")!.title = "Evil <script>alert(1)</script> & co";
  const html = bv.renderHtml(items, "2026-01-05");
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp; co"));
});

test("html idempotent", (t) => {
  const { items } = setup(t);
  assert.equal(bv.renderHtml(items, "2026-01-05"), bv.renderHtml(items, "2026-01-05"));
});

test("html brief link relative to portfolio dir", (t) => {
  const { items } = setup(t);
  items.get("E01")!.status = "future";
  items.get("E01")!.brief = "portfolio/epics/2026-01-01-alpha/brief.html";
  const html = bv.renderHtml(items, "2026-01-05");
  assert.ok(html.includes('href="epics/2026-01-01-alpha/brief.html"'));
  assert.ok(!html.includes('href="portfolio/epics'));
});

test("templates have no inline frontmatter comments", () => {
  const tdir = join(import.meta.dirname, "templates");
  for (const name of readdirSync(tdir).filter((n) => n.endsWith(".md")).sort()) {
    const lines = readFileSync(join(tdir, name), "utf8").split(/\r?\n/);
    assert.equal(lines[0].trim(), "---", name);
    for (const line of lines.slice(1)) {
      if (line.trim() === "---") break;
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      assert.ok(!line.includes("#"), `${name}: inline comment on value line: ${line}`);
    }
  }
});

test("cli writes all four views with --root", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-cli-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  fixture(tmp);
  wfs(join(tmp, ".title"), "TestProduct\n", "utf8");
  const script = join(import.meta.dirname, "build-views.mts");
  const res = spawnSync(process.execPath, [script, "--root", tmp], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.startsWith("Wrote "), res.stdout);
  for (const f of ["BOARD.md", "ROADMAP.md", "BRAGLOG.md", "portfolio.html"]) {
    assert.ok(existsSync(join(tmp, f)), f);
  }
  const board = readFileSync(join(tmp, "BOARD.md"), "utf8");
  assert.ok(board.startsWith(bv.GENERATED));
  const html = readFileSync(join(tmp, "portfolio.html"), "utf8");
  assert.ok(html.includes("TestProduct"));
});

test("importing the module as a side effect runs nothing", () => {
  // Guard regression: if importing ran main(), it would print "Wrote …"
  // and write BOARD.md next to the script.
  const script = join(import.meta.dirname, "build-views.mts");
  const res = spawnSync(process.execPath, ["-e",
    'const{pathToFileURL}=require("node:url");' +
    'import(pathToFileURL(process.argv[1]).href).catch(e=>{console.error(e);process.exit(1)});',
    script], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "");
  assert.ok(!existsSync(join(import.meta.dirname, "BOARD.md")));
});
