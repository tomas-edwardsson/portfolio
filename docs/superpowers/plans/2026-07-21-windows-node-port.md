# Windows-Native Node/TS Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plugin's bash/Python tooling (jot.sh, build-views.sh, build_views.py, jq hook) with natively-run TypeScript so the plugin works on native Windows.

**Architecture:** Two self-contained scripts in the scaffold (`build-views.mts`, `jot.mts`) mirroring today's layout, plus a Node hook script (`hooks/regen.mts`) replacing the jq one-liner. No package.json, no build step — Node ≥ 22.18 runs the `.mts` files directly via built-in type stripping.

**Tech Stack:** TypeScript (erasable syntax only), Node `node:` stdlib, `node:test` + `node:assert/strict` for tests.

**Spec:** `docs/superpowers/specs/2026-07-21-windows-node-port-design.md`

## Global Constraints

- Node ≥ 22.18 required; dev machine has v24.16.0. Every invocation is explicitly `node <script>` — no shebang or executable-bit reliance.
- **`.mts` extension, not `.ts`** (deviation from spec filenames, amended in Task 8): the scaffold is copied into arbitrary user repos, and a nearby `package.json` with `"type": "commonjs"` would make Node parse a `.ts` file as CJS and reject the ESM syntax. `.mts` is unconditionally ESM.
- Erasable-syntax TS only: type annotations, interfaces, `type` aliases. **No** enums, namespaces, or constructor parameter properties.
- `node:` stdlib imports only. Explicit `"utf8"` on every file read/write.
- Console (stdout/stderr) output ASCII only; emoji appear only inside generated files.
- Generated output stays byte-identical to the Python version **except** the generated-marker/footer/stamp text, which changes from `build-views.sh` to `build-views.mts`.
- The Python/bash originals stay in-tree until Task 6 (they are the porting reference); delete them only there.
- Commits: brief single-purpose messages (the branch's detailed first commit already exists), footer:
  `🤖 Generated with [Claude Code](https://claude.ai/code)` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## unittest → node:test mapping rules (used by every test-porting step)

Port each Python test with **identical assertion intent**, translating mechanically:

| Python | TypeScript |
|---|---|
| `class TestX(unittest.TestCase)` / `def test_y` | `test("y", (t) => { ... })` from `node:test` |
| `setUp`/`tearDown` fixture | `const { root, items } = setup(t)` helper (defined in Task 2; registers cleanup via `t.after`) |
| `self.assertEqual(a, b)` | `assert.equal(a, b)` (scalars) / `assert.deepEqual(a, b)` (arrays/objects) |
| `self.assertIn(a, b)` | `assert.ok(b.includes(a), b)` |
| `self.assertNotIn(a, b)` | `assert.ok(!b.includes(a))` |
| `self.assertTrue(any(... for w in warns))` | `assert.ok(warns.some(w => ...), JSON.stringify(warns))` |
| `s.index(x)` (raises if absent) | `idx(s, x)` helper: `function idx(hay: string, needle: string): number { const i = hay.indexOf(needle); assert.ok(i >= 0, needle); return i; }` |
| `self.items["S02"]["status"] = "done"` | `items.get("S02")!.status = "done"` |
| `repr(items)` containment checks | `JSON.stringify([...items.values()])` |
| `self.assertIsNone(x)` | `assert.equal(x, null)` |

---

### Task 1: build-views.mts — parsing core

**Files:**
- Create: `skills/portfolio/scaffold/build-views.mts`
- Create (test): `skills/portfolio/scaffold/build-views.test.mts`

**Interfaces:**
- Produces: `parseFrontmatter(text: string): [Record<string, string>, string]`, `parseIdList(value: string): string[]`, `firstBodyLine(body: string): string`, `DONE_STATES: Set<string>`, `GENERATED: string` — all `export`ed; later tasks append to this file.

- [ ] **Step 1: Write the failing tests**

Create `skills/portfolio/scaffold/build-views.test.mts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

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
```

(The `idx` helper is unused until Task 3's ported tests — defining it now keeps every later step append-only.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test skills/portfolio/scaffold/`
Expected: FAIL — `Cannot find module … build-views.mts`

- [ ] **Step 3: Write the implementation**

Create `skills/portfolio/scaffold/build-views.mts`:

```ts
// Generate BOARD.md, ROADMAP.md, BRAGLOG.md and portfolio.html from
// portfolio item frontmatter.
//
// Usage: node build-views.mts [--root DIR]     (Node >= 22.18)
// Warnings go to stderr; exit code is 0 unless the portfolio directory
// itself is missing. node: stdlib only — port of build_views.py.

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

export const DONE_STATES = new Set(["done", "dropped", "promoted"]);
export const GENERATED = "<!-- GENERATED by build-views.mts — do not edit by hand -->";

export interface Item {
  id: string; type: string; title: string; status: string; horizon: string;
  blockedBy: string[]; brief: string; artifact: string; epic: string;
  summary: string; file: string; updated: string; completed: string;
  created: string; story: string;
}
export type Items = Map<string, Item>;

export function parseFrontmatter(text: string): [Record<string, string>, string] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return [{}, text];
  const fm: Record<string, string> = {};
  let i = 1;
  while (i < lines.length && lines[i].trim() !== "---") {
    const line = lines[i];
    i += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
    if (m) {
      let value = m[2].trim();
      if (value.length >= 2 && value[0] === value[value.length - 1] && "\"'".includes(value[0])) {
        value = value.slice(1, -1);
      }
      fm[m[1]] = value;
    }
  }
  return [fm, lines.slice(i + 1).join("\n")];
}

export function parseIdList(value: string): string[] {
  let v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function firstBodyLine(body: string): string {
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s && !s.startsWith("#") && !s.startsWith("<!--")) { start = i; break; }
  }
  if (start < 0) return "";
  const parts = [lines[start].trim()];
  for (const line of lines.slice(start + 1)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) break;
    parts.push(s);
  }
  return parts.join(" ");
}
```

(`writeFileSync`, `readdirSync`, `existsSync`, `realpathSync`, `resolve` are imported now for later tasks; TS type stripping does not error on unused imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test skills/portfolio/scaffold/`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add skills/portfolio/scaffold/build-views.mts skills/portfolio/scaffold/build-views.test.mts
git commit -m "Port frontmatter parsing core to TypeScript"
```

---

### Task 2: build-views.mts — item loading and validation

**Files:**
- Modify: `skills/portfolio/scaffold/build-views.mts` (append)
- Modify: `skills/portfolio/scaffold/build-views.test.mts` (append)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `loadItems(root: string): [Items, string[]]`, `validate(items: Items): string[]`; test helpers `writeItem(root, rel, fm)`, `fixture(tmp): string`, `setup(t): { root: string; items: Items }`.

- [ ] **Step 1: Write the failing tests**

Append to `build-views.test.mts` (add imports at top):

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { TestContext } from "node:test";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test skills/portfolio/scaffold/`
Expected: FAIL — `bv.loadItems is not a function`

- [ ] **Step 3: Write the implementation**

Append to `build-views.mts`:

```ts
export function portfolioName(root: string): string {
  const p = join(root, ".title");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8").trim();
}

function mdFilesSorted(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".md")).sort().map((n) => join(dir, n));
}

export function loadItems(root: string): [Items, string[]] {
  const items: Items = new Map();
  const warnings: string[] = [];

  const add = (path: string): void => {
    const [fm, body] = parseFrontmatter(readFileSync(path, "utf8"));
    if (Object.keys(fm).length === 0) {
      // No frontmatter at all — a plain reference doc, not an item.
      return;
    }
    const iid = fm["id"];
    if (!iid) { warnings.push(`${path}: missing id`); return; }
    if (items.has(iid)) {
      warnings.push(`${path}: duplicate id ${iid} (also in ${items.get(iid)!.file})`);
      return;
    }
    items.set(iid, {
      id: iid,
      type: fm["type"] ?? "",
      title: fm["title"] ?? "",
      status: fm["status"] ?? "",
      horizon: fm["horizon"] ?? "",
      blockedBy: parseIdList(fm["blocked-by"] ?? ""),
      brief: fm["brief"] ?? "",
      artifact: fm["artifact"] ?? "",
      epic: fm["epic"] ?? "",
      summary: firstBodyLine(body),
      file: path,
      updated: fm["updated"] ?? "",
      completed: fm["completed"] ?? "",
      created: fm["created"] ?? "",
      story: fm["story"] ?? "",
    });
  };

  const epicsDir = join(root, "epics");
  if (existsSync(epicsDir)) {
    const subdirs = readdirSync(epicsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const sub of subdirs) for (const f of mdFilesSorted(join(epicsDir, sub))) add(f);
  }
  for (const f of mdFilesSorted(join(root, "inbox"))) add(f);
  return [items, warnings];
}

const VALID_STATUSES = new Set(["future", "active", "blocked", "done", "dropped", "parked", "promoted"]);

export function validate(items: Items): string[] {
  const warnings: string[] = [];
  const sorted = [...items.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of sorted) {
    for (const dep of it.blockedBy) {
      if (!items.has(dep)) warnings.push(`${it.id}: unknown blocked-by id ${dep}`);
    }
    if (it.status && !VALID_STATUSES.has(it.status)) {
      warnings.push(`${it.id}: unknown status '${it.status}'`);
    }
    if (it.type === "idea" && !["", "later", "next"].includes(it.horizon)) {
      warnings.push(`${it.id}: idea horizon '${it.horizon}' not supported ` +
        "(use later or next; promote the idea instead)");
    }
  }
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const visit = (iid: string, stack: string[]): void => {
    state.set(iid, 1);
    for (const dep of items.get(iid)!.blockedBy) {
      if (!items.has(dep)) continue;
      if (state.get(dep) === 1) warnings.push("dependency cycle: " + [...stack, dep].join(" -> "));
      else if (!state.has(dep)) visit(dep, [...stack, dep]);
    }
    state.set(iid, 2);
  };
  for (const iid of [...items.keys()].sort()) {
    if (!state.has(iid)) visit(iid, [iid]);
  }
  return warnings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test skills/portfolio/scaffold/`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add skills/portfolio/scaffold/build-views.mts skills/portfolio/scaffold/build-views.test.mts
git commit -m "Port item loading and validation to TypeScript"
```

---

### Task 3: build-views.mts — model helpers and Markdown renderers

**Files:**
- Modify: `skills/portfolio/scaffold/build-views.mts` (append)
- Modify: `skills/portfolio/scaffold/build-views.test.mts` (append)

**Interfaces:**
- Consumes: Tasks 1–2 exports.
- Produces: `pendingBlockers(item, items): string[]`, `itemEpic(item, items): Item | undefined`, `isParked(item, items): boolean`, `shipDate(item: { completed: string; updated: string }): string`, `withinDays(dateStr, todayStr, days): boolean`, `epicHorizon(item): string`, `boardLane(item, items): string | null`, `monthLabel(dateStr): string`, `renderBoard(items, today): string`, `renderRoadmap(items, today): string`, `renderBraglog(items, today): string`; internal (non-exported): `byId`, `marks`, `blockedSuffix`, `shipsAfterLine`, `storiesOf`, `epicsOf`, `BOARD_LANES`, `EPIC_LANES`, `isoUtcMs`.

- [ ] **Step 1: Write the failing tests**

Append to `build-views.test.mts` the ported versions of these `test_build_views.py` tests, using the mapping rules and the `setup`/`idx` helpers. Full list to port in this step (Python name → TS test name):

| Python test | TS test name |
|---|---|
| `test_idea_appears_in_later` | `idea appears in later` |
| `test_next_horizon_idea_appears_in_next` | `next horizon idea appears in next` |
| `test_promoted_idea_hidden` | `promoted idea hidden` |
| `test_ships_after_rendered_for_pending_blocker` | `ships after rendered for pending blocker` |
| `test_ships_after_dropped_when_blocker_done` | `ships after dropped when blocker done` |
| `test_now_next_later_sections` | `now next later sections` |
| `test_idempotent` | `render idempotent` |
| `test_board_keeps_status_sections` | `board keeps status sections` |
| `test_loads_updated_completed_story` | `loads updated completed story fields` |
| `test_ship_date_prefers_completed` | `ship date prefers completed` |
| `test_is_parked_cascades_from_epic` | `is parked cascades from epic` |
| `test_within_days` | `within days` |
| `test_active_epic_nonnow_horizon_no_warning` | `active epic non-now horizon no warning` |
| `test_board_lane_assignment` | `board lane assignment` |
| `test_board_done_story_not_a_card` | `board done story not a card` |
| `test_board_parked_story_excluded` | `board parked story excluded` |
| `test_board_shipped_lane_recent_done_epic` | `board shipped lane recent done epic` |
| `test_board_shipped_excludes_old_done_epic` | `board shipped excludes old done epic` |
| `test_roadmap_excludes_active_epic` | `roadmap excludes active epic` |
| `test_roadmap_future_epic_in_next` | `roadmap future epic in next` |
| `test_roadmap_uses_details_accordion` | `roadmap uses details accordion` |
| `test_roadmap_parked_section` | `roadmap parked section` |
| `test_braglog_groups_and_orders` | `braglog groups and orders` |
| `test_braglog_excludes_dropped_and_open` | `braglog excludes dropped and open` |
| `test_braglog_uses_completed_override` | `braglog uses completed override` |
| `test_templates_have_no_inline_frontmatter_comments` | `templates have no inline frontmatter comments` |

Reference for assertion bodies: `skills/portfolio/scaffold/test_build_views.py` (in-tree until Task 6). Translate assertions verbatim per the mapping table. Three full examples establishing the pattern — the rest follow it exactly:

```ts
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

test("ship date prefers completed", () => {
  assert.equal(bv.shipDate({ completed: "2026-02-01", updated: "2026-01-01" }), "2026-02-01");
  assert.equal(bv.shipDate({ completed: "", updated: "2026-01-01" }), "2026-01-01");
});
```

The templates test ports as:

```ts
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
```

(add `readFileSync`, `readdirSync` to the test file's `node:fs` import).

One board-heading detail: `test_board_keeps_status_sections` asserts the headings `## ⛔ Blocked`, `## 🎬 Ready for Dev`, `## 🏃 Active`, `## 🏆 Shipped` and the card line `[S01] First story — E01 Alpha`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test skills/portfolio/scaffold/`
Expected: FAIL — `bv.renderRoadmap is not a function` (and siblings)

- [ ] **Step 3: Write the implementation**

Append to `build-views.mts` — a direct port of `build_views.py` lines 158–367:

```ts
export function pendingBlockers(item: Item, items: Items): string[] {
  return item.blockedBy.filter((d) => items.has(d) && !DONE_STATES.has(items.get(d)!.status));
}

export function itemEpic(item: Item, items: Items): Item | undefined {
  return item.epic ? items.get(item.epic) : undefined;
}

export function isParked(item: Item, items: Items): boolean {
  if (item.status === "parked") return true;
  const e = itemEpic(item, items);
  return !!e && e.status === "parked";
}

export function shipDate(item: { completed: string; updated: string }): string {
  return item.completed || item.updated || "";
}

function isoUtcMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(ms);
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null; // e.g. 2026-02-31
  return ms;
}

export function withinDays(dateStr: string, todayStr: string, days: number): boolean {
  const d = isoUtcMs(dateStr);
  const t = isoUtcMs(todayStr);
  if (d === null || t === null) return false;
  const diff = Math.round((t - d) / 86400000);
  return diff >= 0 && diff <= days;
}

export function epicHorizon(item: Item): string {
  if (item.horizon) return item.horizon;
  return item.status === "active" ? "now" : "later";
}

const byId = (a: Item, b: Item): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function marks(item: Item): string {
  let m = "";
  if (item.brief) m += " 📄";
  if (item.artifact) m += " 🔗";
  return m;
}

function blockedSuffix(item: Item, items: Items): string {
  const pend = pendingBlockers(item, items);
  return pend.length ? " ⛔ after " + pend.join(", ") : "";
}

function shipsAfterLine(item: Item, items: Items): string {
  const pend = pendingBlockers(item, items);
  if (!pend.length) return "";
  const parts = pend.map((d) => `${d} (${items.get(d)!.title})`);
  return "  - _ships after: " + parts.join(", ") + "_";
}

function storiesOf(epicId: string, items: Items): Item[] {
  return [...items.values()].filter((x) => x.type === "story" && x.epic === epicId).sort(byId);
}

function epicsOf(items: Items): Item[] {
  return [...items.values()].filter((x) => x.type === "epic").sort(byId);
}

export function boardLane(item: Item, items: Items): string | null {
  if (isParked(item, items) || item.status === "dropped" || item.status === "done") return null;
  if (item.status === "blocked" || pendingBlockers(item, items).length) return "blocked";
  if (item.status === "active") return "active";
  if (item.status === "future") return "ready";
  return null;
}

const BOARD_LANES: [string, string][] =
  [["blocked", "⛔ Blocked"], ["ready", "🎬 Ready for Dev"], ["active", "🏃 Active"]];
// The per-epic board pane shows these three status columns (no Shipped —
// done work lives in the Braglog).
const EPIC_LANES: [string, string][] =
  [["ready", "Ready for Dev"], ["active", "Active"], ["blocked", "Blocked"]];

export function renderBoard(items: Items, today: string): string {
  const out: string[] = [GENERATED, "# Portfolio Board", "", `_Last generated: ${today}_`, ""];
  const cards = [...items.values()]
    .filter((x) => x.type === "story" || x.type === "task").sort(byId);
  for (const [lane, heading] of BOARD_LANES) {
    out.push(`## ${heading}`, "");
    const rows = cards.filter((c) => boardLane(c, items) === lane);
    for (const c of rows) {
      const epic = itemEpic(c, items);
      const tag = epic ? ` — ${epic.id} ${epic.title}` : "";
      out.push(`- [${c.id}] ${c.title}${tag}${marks(c)}${blockedSuffix(c, items)}`);
    }
    if (!rows.length) out.push("_(none)_");
    out.push("");
  }
  out.push("## 🏆 Shipped (last 30 days)", "");
  const shipped = epicsOf(items)
    .filter((e) => e.status === "done" && withinDays(shipDate(e), today, 30));
  shipped.sort((a, b) => (shipDate(a) > shipDate(b) ? -1 : shipDate(a) < shipDate(b) ? 1 : 0));
  for (const e of shipped) out.push(`- [${e.id}] ${e.title} — ${shipDate(e)}${marks(e)}`);
  if (!shipped.length) out.push("_(none)_");
  out.push("");
  return out.join("\n") + "\n";
}

function roadmapEpicMd(e: Item, items: Items, withSummary = false): string[] {
  const openStories = storiesOf(e.id, items).filter((s) => !DONE_STATES.has(s.status));
  const count = `${openStories.length} stor${openStories.length === 1 ? "y" : "ies"}`;
  const lines = ["<details>",
    `<summary>[${e.id}] ${e.title}${marks(e)} — ${count}${blockedSuffix(e, items)}</summary>`, ""];
  if (withSummary && e.summary) lines.push(e.summary);
  for (const s of openStories) {
    lines.push(`- [${s.id}] ${s.title} — \`${s.status}\`${marks(s)}${blockedSuffix(s, items)}`);
    const after = shipsAfterLine(s, items);
    if (after) lines.push(after);
  }
  lines.push("</details>", "");
  return lines;
}

export function renderRoadmap(items: Items, today: string): string {
  const out: string[] = [GENERATED, "# Roadmap", "", `_Last generated: ${today}_`, ""];
  const future = epicsOf(items).filter((e) => e.status === "future");
  const parked = epicsOf(items).filter((e) => e.status === "parked");
  const ideas = [...items.values()]
    .filter((x) => x.type === "idea" && x.status === "future").sort(byId);
  const nextIdeas = ideas.filter((i) => i.horizon === "next");
  const laterIdeas = ideas.filter((i) => i.horizon !== "next");

  out.push("## ⏭️ Next", "");
  const nextEpics = future.filter((e) => epicHorizon(e) === "next");
  for (const e of nextEpics) out.push(...roadmapEpicMd(e, items, true));
  for (const i of nextIdeas) {
    out.push(`- [${i.id}] ${i.title} 💡${i.summary ? ` — ${i.summary}` : ""}`);
  }
  if (!nextEpics.length && !nextIdeas.length) out.push("_(none)_");
  out.push("");

  out.push("## 🌅 Later", "");
  const laterEpics = future.filter((e) => epicHorizon(e) !== "next");
  for (const e of laterEpics) out.push(...roadmapEpicMd(e, items));
  for (const i of laterIdeas) {
    out.push(`- [${i.id}] ${i.title} 💡${i.summary ? ` — ${i.summary}` : ""}`);
  }
  if (!laterEpics.length && !laterIdeas.length) out.push("_(none)_");
  out.push("");

  out.push("## ⏸️ Parked", "");
  for (const e of parked) out.push(...roadmapEpicMd(e, items, true));
  if (!parked.length) out.push("_(none)_");
  out.push("");
  return out.join("\n") + "\n";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

export function monthLabel(dateStr: string): string {
  const ms = isoUtcMs(dateStr);
  if (ms === null) return "Undated";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function doneForBraglog(items: Items): Item[] {
  const done = [...items.values()]
    .filter((x) => x.status === "done" && (x.type === "epic" || x.type === "story"));
  done.sort((a, b) => {
    const sa = shipDate(a), sb = shipDate(b);
    if (sa !== sb) return sa < sb ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return done;
}

export function renderBraglog(items: Items, today: string): string {
  const out: string[] = [GENERATED, "# Braglog", "", `_Last generated: ${today}_`, "",
    "_What's shipped, newest first._", ""];
  const done = doneForBraglog(items);
  let current: string | null = null;
  for (const x of done) {
    const label = monthLabel(shipDate(x));
    if (label !== current) {
      current = label;
      out.push("", `## ${label}`, "");
    }
    const epic = itemEpic(x, items);
    const tag = epic ? ` — ${epic.id} ${epic.title}` : "";
    const kind = x.type === "epic" ? "🏆" : "•";
    out.push(`- ${shipDate(x)} ${kind} [${x.id}] ${x.title}${tag}`);
  }
  if (!done.length) out.push("_(nothing shipped yet)_");
  out.push("");
  return out.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test skills/portfolio/scaffold/`
Expected: PASS (41 tests)

- [ ] **Step 5: Commit**

```bash
git add skills/portfolio/scaffold/build-views.mts skills/portfolio/scaffold/build-views.test.mts
git commit -m "Port Markdown view renderers to TypeScript"
```

---

### Task 4: build-views.mts — HTML renderer

**Files:**
- Modify: `skills/portfolio/scaffold/build-views.mts` (append)
- Modify: `skills/portfolio/scaffold/build-views.test.mts` (append)

**Interfaces:**
- Consumes: Tasks 1–3 exports/internals.
- Produces: `renderHtml(items: Items, today: string, name?: string): string`; internal `h(text): string` (HTML escape), `HTML_CSS`, `HTML_SCRIPT` string constants.

- [ ] **Step 1: Write the failing tests**

Append the ported `render_html` tests (from `TestBuildViews` html tests + `TestRenderHtml`), same mapping rules:

| Python test | TS test name |
|---|---|
| `test_html_has_three_tabs` | `html has three tabs` |
| `test_html_board_has_lanes_and_roadmap_details` | `html board has lanes and roadmap details` |
| `test_html_board_has_epic_rail` | `html board has epic rail` |
| `test_html_rail_hides_epic_with_no_open_work` | `html rail hides epic with no open work` |
| `test_html_self_contained` | `html self contained` |
| `test_html_contains_both_views` | `html contains both views` |
| `test_html_escapes_titles` | `html escapes titles` |
| `test_html_idempotent` | `html idempotent` |
| `test_html_brief_link_relative_to_portfolio_dir` | `html brief link relative to portfolio dir` |

Pattern example (the escaping one, which pins the Python-compatible escaper):

```ts
test("html escapes titles", (t) => {
  const { items } = setup(t);
  items.get("S01")!.title = "Evil <script>alert(1)</script> & co";
  const html = bv.renderHtml(items, "2026-01-05");
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp; co"));
});
```

Note for `html self contained`: the Python test asserts no `http://`/`https://`/`<link` — the port asserts the same three.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test skills/portfolio/scaffold/`
Expected: FAIL — `bv.renderHtml is not a function`

- [ ] **Step 3: Write the implementation**

Append to `build-views.mts`. Two verbatim copies from `build_views.py` (still in-tree):

1. `HTML_CSS` — copy the CSS string from `build_views.py:372-526` into
   `const HTML_CSS = \`…\`;` unchanged (it contains no backticks or `${`).
2. `HTML_SCRIPT` — copy the concatenated `<script>…</script>` string from
   `build_views.py:828-847` into `const HTML_SCRIPT = "<script>(function(){…})();</script>";`
   unchanged, as one string (single-quote JS inside; no escaping needed beyond
   the existing `\"` for the `data-tab` attribute quotes).

Then the logic, a direct port of `build_views.py:529-853`:

```ts
function h(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

function chip(iid: string): string {
  const cls = ({ E: "e", S: "s", T: "t", I: "i" } as Record<string, string>)[iid[0]] ?? "t";
  return `<span class="chip ${cls}">${h(iid)}</span>`;
}

function pill(status: string): string {
  return status ? `<span class="pill ${h(status)}">${h(status)}</span>` : "";
}

function marksHtml(item: Item): string {
  let out = "";
  if (item.brief) {
    let href = item.brief;
    if (href.startsWith("portfolio/")) href = href.slice("portfolio/".length);
    out += ` <a class="mark" href="${h(href)}" title="brief">📄</a>`;
  }
  if (item.artifact) out += ` <a class="mark" href="${h(item.artifact)}" title="artifact">🔗</a>`;
  return out;
}

function blockedHtml(item: Item, items: Items): string {
  const pend = pendingBlockers(item, items);
  if (!pend.length) return "";
  return `<span class="blk">⛔ after ${h(pend.join(", "))}</span>`;
}

function shipsHtml(item: Item, items: Items): string {
  const pend = pendingBlockers(item, items);
  if (!pend.length) return "";
  const parts = pend.map((d) => `${d} (${items.get(d)!.title})`).join(", ");
  return `<div class="ships">ships after: ${h(parts)}</div>`;
}

function storyRow(s: Item, items: Items): string {
  return `<li>${chip(s.id)} <span class="t">${h(s.title)}</span> ` +
    `${pill(s.status)}${marksHtml(s)} ${blockedHtml(s, items)}${shipsHtml(s, items)}</li>`;
}

function flatRow(item: Item, withSummary = true): string {
  const summary = withSummary && item.summary ? `<div class="sum">${h(item.summary)}</div>` : "";
  const idea = item.type === "idea" ? " 💡" : "";
  return `<li>${chip(item.id)} <span class="t">${h(item.title)}</span>` +
    `${idea}${marksHtml(item)}${summary}</li>`;
}

function epicAccent(epicId: string): string {
  const n = parseInt(epicId.slice(1), 10);
  return `var(--e-${Number.isNaN(n) ? 0 : ((n % 6) + 6) % 6})`;
}

function boardCard(c: Item, items: Items, showEpic = true): string {
  const epic = itemEpic(c, items);
  const ea = epic ? epicAccent(epic.id) : "var(--line)";
  const ep = epic && showEpic
    ? `<span class="ep-tag" title="${h(epic.title)}">${h(epic.id)}</span>` : "";
  const blockedCls = c.status === "blocked" || pendingBlockers(c, items).length ? " blocked" : "";
  return `<li><div class="card${blockedCls}" style="--ea:${ea}">` +
    `<span class="t">${h(c.title)}</span>` +
    `<span class="meta">${chip(c.id)}${ep}${marksHtml(c)}</span>` +
    `${blockedHtml(c, items)}</div></li>`;
}

function epicPane(e: Item, items: Items, cards: Item[]): string {
  const ea = epicAccent(e.id);
  const mine = cards.filter((c) => c.epic === e.id);
  const lanes: string[] = [];
  for (const [lane, label] of EPIC_LANES) {
    const rows = mine.filter((c) => boardLane(c, items) === lane)
      .map((c) => boardCard(c, items, false)).join("");
    const body = rows ? `<ul>${rows}</ul>` : '<p class="none">(none)</p>';
    lanes.push(`<div class="lane"><h3>${label}</h3>${body}</div>`);
  }
  const shippedN = mine.filter((c) => c.status === "done").length;
  const summ = e.summary ? `<p class="epic-sum">${h(e.summary)}</p>` : "";
  const foot = shippedN ? `<p class="pane-foot">${shippedN} shipped → Braglog</p>` : "";
  return `<div class="epic-pane" data-epic="${h(e.id)}" hidden ` +
    `style="--ea:${ea}"><div class="pane-head">${chip(e.id)}` +
    `<span class="pt">${h(e.title)}</span></div>${summ}` +
    `<div class="lanes lanes3">${lanes.join("")}</div>${foot}</div>`;
}

function shippedCard(e: Item, hot = false): string {
  const ea = epicAccent(e.id);
  const tick = hot ? '<span class="tick"></span>' : "";
  return `<li><div class="card shipped" style="--ea:${ea}">` +
    `<span class="t">${h(e.title)}</span>${tick}` +
    `<span class="meta">${chip(e.id)}` +
    `<span class="d">${h(shipDate(e))}</span></span></div></li>`;
}

function roadmapAcc(e: Item, items: Items, withSummary = false): string {
  const openStories = storiesOf(e.id, items).filter((s) => !DONE_STATES.has(s.status));
  const count = `${openStories.length} stor${openStories.length === 1 ? "y" : "ies"}`;
  const rows = openStories.map((s) => storyRow(s, items)).join("");
  const body = rows ? `<ul class="rows">${rows}</ul>` : "";
  const summary = withSummary && e.summary ? `<p class="epic-sum">${h(e.summary)}</p>` : "";
  return `<details class="epic-acc"><summary>${chip(e.id)}` +
    `<span>${h(e.title)}</span>${marksHtml(e)}` +
    `<span class="count">${count}</span>${blockedHtml(e, items)}` +
    `</summary>${summary}${body}</details>`;
}

export function renderHtml(items: Items, today: string, name = ""): string {
  const future = epicsOf(items).filter((e) => e.status === "future");
  const parked = epicsOf(items).filter((e) => e.status === "parked");
  const ideas = [...items.values()]
    .filter((x) => x.type === "idea" && x.status === "future").sort(byId);
  const nextIdeas = ideas.filter((i) => i.horizon === "next");
  const laterIdeas = ideas.filter((i) => i.horizon !== "next");
  const all = [...items.values()];
  const nStories = all.filter((x) => x.type === "story").length;
  const nTasks = all.filter((x) => x.type === "task").length;
  const nActive = all.filter((x) => x.type === "epic" && x.status === "active").length;
  const nShipped = all.filter((x) => x.type === "epic" && x.status === "done").length;

  const cards = all.filter((x) => x.type === "story" || x.type === "task").sort(byId);

  const out: string[] = [];
  const eyebrow = name ? `${h(name)} · work tracking · generated` : "work tracking · generated";
  out.push(`<header><div><div class="eyebrow">${eyebrow}</div>` +
    '<h1>Portfolio</h1></div>' +
    `<div class="stamp">build-views.mts<br>${h(today)}</div></header>`);
  out.push('<div class="boxscore">' +
    `<div class="bs"><b class="o">${nActive}</b><span>Epics active</span></div>` +
    `<div class="bs"><b>${nStories}</b><span>Stories</span></div>` +
    `<div class="bs"><b>${nTasks}</b><span>Tasks</span></div>` +
    `<div class="bs"><b>${ideas.length}</b><span>Ideas</span></div>` +
    `<div class="bs"><b class="o">${nShipped}</b><span>Epics shipped</span></div>` +
    "</div>");

  out.push('<nav class="tabs" role="tablist" aria-label="Portfolio views">' +
    '<a href="#board" data-tab="board" id="tab-board" role="tab" ' +
    'aria-controls="board" aria-selected="true">Board</a>' +
    '<a href="#roadmap" data-tab="roadmap" id="tab-roadmap" role="tab" ' +
    'aria-controls="roadmap" aria-selected="false">Roadmap</a>' +
    '<a href="#braglog" data-tab="braglog" id="tab-braglog" role="tab" ' +
    'aria-controls="braglog" aria-selected="false">Braglog</a></nav>');

  const openCount = (eid: string): number =>
    cards.filter((c) => c.epic === eid && boardLane(c, items) !== null).length;

  // Only epics with open work appear in the rail.
  const boardEpics = epicsOf(items)
    .filter((e) => (e.status === "active" || e.status === "future") && openCount(e.id) > 0)
    .sort((a, b) => {
      const ka = (a.status === "active" ? 0 : 1), kb = (b.status === "active" ? 0 : 1);
      if (ka !== kb) return ka - kb;
      return byId(a, b);
    });

  const allLanes: string[] = [];
  for (const [lane, heading] of BOARD_LANES) {
    const rows = cards.filter((c) => boardLane(c, items) === lane)
      .map((c) => boardCard(c, items)).join("");
    const body = rows ? `<ul>${rows}</ul>` : '<p class="none">(none)</p>';
    allLanes.push(`<div class="lane"><h3>${heading}</h3>${body}</div>`);
  }
  const shipped = epicsOf(items)
    .filter((e) => e.status === "done" && withinDays(shipDate(e), today, 30));
  shipped.sort((a, b) => (shipDate(a) > shipDate(b) ? -1 : shipDate(a) < shipDate(b) ? 1 : 0));
  const srows = shipped.map((e, i) => shippedCard(e, i === 0)).join("");
  const sbody = shipped.length ? `<ul>${srows}</ul>` : '<p class="none">(none)</p>';
  allLanes.push(`<div class="lane"><h3>🏆 Shipped · 30d</h3>${sbody}</div>`);

  const rail: string[] = ['<nav class="rail" aria-label="Epics">',
    '<a href="#board" data-epic-nav="all" class="active" ' +
    'style="--ea:var(--orange)"><span class="dot"></span>' +
    '<span class="rl">All work</span></a>'];
  for (const e of boardEpics) {
    rail.push(`<a href="#board/${h(e.id)}" data-epic-nav="${h(e.id)}" ` +
      `style="--ea:${epicAccent(e.id)}"><span class="dot"></span>` +
      `<span class="rl">${chip(e.id)}${h(e.title)}</span>` +
      `<span class="n">${openCount(e.id)}</span></a>`);
  }
  rail.push("</nav>");

  const panes = [`<div class="epic-pane" data-epic="all"><div class="lanes">` +
    `${allLanes.join("")}</div></div>`,
    ...boardEpics.map((e) => epicPane(e, items, cards))];

  out.push('<section class="tab" id="board" role="tabpanel" ' +
    'aria-labelledby="tab-board"><div class="board-wrap">' +
    `${rail.join("")}<div class="panes">${panes.join("")}</div>` +
    "</div></section>");

  const r: string[] = ['<section class="tab" id="roadmap" role="tabpanel" ' +
    'aria-labelledby="tab-roadmap" hidden>'];
  r.push('<h3 class="group">⏭️ Next</h3>');
  const nextEpics = future.filter((e) => epicHorizon(e) === "next");
  r.push(...nextEpics.map((e) => roadmapAcc(e, items, true)));
  if (nextIdeas.length) r.push('<ul class="flat">' + nextIdeas.map((i) => flatRow(i)).join("") + "</ul>");
  if (!nextEpics.length && !nextIdeas.length) r.push('<p class="none">(none)</p>');
  r.push('<h3 class="group">🌅 Later</h3>');
  const laterEpics = future.filter((e) => epicHorizon(e) !== "next");
  r.push(...laterEpics.map((e) => roadmapAcc(e, items)));
  if (laterIdeas.length) r.push('<ul class="flat">' + laterIdeas.map((i) => flatRow(i)).join("") + "</ul>");
  if (!laterEpics.length && !laterIdeas.length) r.push('<p class="none">(none)</p>');
  r.push('<h3 class="group">⏸️ Parked</h3>');
  if (parked.length) r.push(...parked.map((e) => roadmapAcc(e, items, true)));
  else r.push('<p class="none">(none)</p>');
  r.push("</section>");
  out.push(r.join(""));

  const b: string[] = ['<section class="tab" id="braglog" role="tabpanel" ' +
    'aria-labelledby="tab-braglog" hidden><div class="brag">'];
  const done = doneForBraglog(items);
  const monthCounts = new Map<string, number>();
  for (const x of done) {
    const m = monthLabel(shipDate(x));
    monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
  }
  let current: string | null = null;
  let lastEid: string | null = null;
  let openUl = false;
  done.forEach((x, i) => {
    const label = monthLabel(shipDate(x));
    if (label !== current) {
      if (openUl) b.push("</ul>");
      current = label;
      lastEid = null;
      b.push(`<h3>${h(label)}<span class="count">` +
        `${monthCounts.get(label)} shipped</span></h3><ul>`);
      openUl = true;
    }
    const tick = i === 0 ? '<span class="tick"></span>' : "";
    if (x.type === "epic") {
      const ea = epicAccent(x.id);
      lastEid = null;
      b.push(`<li class="epic-done" style="--ea:${ea}">` +
        `<span class="d">${h(shipDate(x))}</span>` +
        `<div class="c"><span class="t">🏆 ${h(x.title)}</span>` +
        `${tick}</div></li>`);
    } else {
      const epic = itemEpic(x, items);
      const ea = epic ? epicAccent(epic.id) : "var(--line)";
      let ep = "";
      if (epic && epic.id !== lastEid) {
        ep = `<span class="ep-name" title="${h(epic.title)}">` +
          `${h(epic.id)} ${h(epic.title)}</span>`;
      }
      if (epic) lastEid = epic.id;
      b.push(`<li style="--ea:${ea}">` +
        `<span class="d">${h(shipDate(x))}</span>` +
        `<div class="c"><span class="t">${h(x.title)}</span>` +
        `${tick}${ep}</div></li>`);
    }
  });
  if (openUl) b.push("</ul>");
  if (!done.length) b.push('<p class="none">(nothing shipped yet)</p>');
  b.push("</div></section>");
  out.push(b.join(""));

  out.push("<footer>GENERATED by build-views.mts — do not edit. " +
    "Source of truth: the item files in epics/ and inbox/.</footer>");

  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${name ? h(name) + " " : ""}Portfolio</title>` +
    `<style>${HTML_CSS}</style></head>` +
    `<body><div class="wrap">${out.join("")}</div>${HTML_SCRIPT}</body></html>\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test skills/portfolio/scaffold/`
Expected: PASS (50 tests)

- [ ] **Step 5: Commit**

```bash
git add skills/portfolio/scaffold/build-views.mts skills/portfolio/scaffold/build-views.test.mts
git commit -m "Port HTML view renderer to TypeScript"
```

---

### Task 5: build-views.mts — CLI main and run-as-main guard

**Files:**
- Modify: `skills/portfolio/scaffold/build-views.mts` (append)
- Modify: `skills/portfolio/scaffold/build-views.test.mts` (append)

**Interfaces:**
- Consumes: everything above.
- Produces: `main(argv?: string[]): void`; the file becomes directly runnable (`node build-views.mts [--root DIR]`) while staying importable side-effect-free. `jot.mts` (Task 6) and `regen.mts` (Task 7) spawn it via `process.execPath`.

- [ ] **Step 1: Write the failing test** (integration: spawn the CLI on a fixture)

Append to `build-views.test.mts` (add `import { spawnSync } from "node:child_process";` and `existsSync` to the fs import):

```ts
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

test("importing the module runs nothing", () => {
  // Guard regression: this test file imports build-views.mts at top level;
  // if import ran main(), every test above would have exploded on missing
  // epics/ in the cwd. Reaching here is the assertion.
  assert.ok(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test skills/portfolio/scaffold/`
Expected: FAIL — CLI exits without writing (`main` not defined / not invoked)

- [ ] **Step 3: Write the implementation**

Append to `build-views.mts`:

```ts
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  let root = import.meta.dirname;
  const i = argv.indexOf("--root");
  if (i >= 0) {
    if (!argv[i + 1]) {
      console.error("usage: node build-views.mts [--root DIR]");
      process.exit(2);
    }
    root = resolve(argv[i + 1]);
  }
  const [items, warnings] = loadItems(root);
  warnings.push(...validate(items));
  const today = todayISO();
  writeFileSync(join(root, "BOARD.md"), renderBoard(items, today), "utf8");
  writeFileSync(join(root, "ROADMAP.md"), renderRoadmap(items, today), "utf8");
  writeFileSync(join(root, "BRAGLOG.md"), renderBraglog(items, today), "utf8");
  writeFileSync(join(root, "portfolio.html"),
    renderHtml(items, today, portfolioName(root)), "utf8");
  for (const w of warnings) console.error(`warning: ${w}`);
  console.log(`Wrote ${join(root, "BOARD.md")}, ${join(root, "ROADMAP.md")}, ` +
    `${join(root, "BRAGLOG.md")} and ${join(root, "portfolio.html")}`);
}

if (process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test skills/portfolio/scaffold/`
Expected: PASS (52 tests)

- [ ] **Step 5: Byte-parity spot check against the Python original**

```bash
cd "$(mktemp -d)" && mkdir py ts
cp -r ~/Personulegt/coding/portfolio/skills/portfolio/scaffold/. py/
cp -r ~/Personulegt/coding/portfolio/skills/portfolio/scaffold/. ts/
python3 py/build_views.py --root py
node ts/build-views.mts --root ts
diff <(sed 's/build-views\.sh/build-views.mts/g' py/BOARD.md) ts/BOARD.md
diff <(sed 's/build-views\.sh/build-views.mts/g' py/ROADMAP.md) ts/ROADMAP.md
diff <(sed 's/build-views\.sh/build-views.mts/g' py/BRAGLOG.md) ts/BRAGLOG.md
diff <(sed 's/build-views\.sh/build-views.mts/g' py/portfolio.html) ts/portfolio.html
```

Expected: all four diffs empty (the scaffold's template placeholder items are the fixture). Investigate and fix any difference before committing.

- [ ] **Step 6: Commit**

```bash
git add skills/portfolio/scaffold/build-views.mts skills/portfolio/scaffold/build-views.test.mts
git commit -m "Add CLI entry point to build-views.mts"
```

---

### Task 6: jot.mts — capture command; delete the bash/Python originals

**Files:**
- Create: `skills/portfolio/scaffold/jot.mts`
- Create (test): `skills/portfolio/scaffold/jot.test.mts`
- Delete: `skills/portfolio/scaffold/jot.sh`, `skills/portfolio/scaffold/build-views.sh`, `skills/portfolio/scaffold/build_views.py`, `skills/portfolio/scaffold/test_build_views.py`

**Interfaces:**
- Consumes: spawns `build-views.mts` via `process.execPath` (no import).
- Produces (exported for tests): `slugify(s: string): string`, `nextId(root: string, letter: string, width: number): string`, `epicDir(root: string, eid: string): string | null`, `jot(root: string, argv: string[]): { out: string; code: number }` (pure-ish core: writes files, returns message + exit code, does NOT regen), `main(): void` (calls `jot` with `root = import.meta.dirname`, regens views on success, prints, exits).

- [ ] **Step 1: Write the failing tests**

Create `skills/portfolio/scaffold/jot.test.mts`:

```ts
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { slugify, nextId, epicDir, jot } from "./jot.mts";

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
});

test("jot refuses duplicate file", (t) => {
  const root = makeRoot(t);
  assert.equal(jot(root, ["Same title"]).code, 0);
  const again = jot(root, ["Same title"]);
  assert.equal(again.code, 1);
  assert.ok(again.out.includes("already exists"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test skills/portfolio/scaffold/`
Expected: FAIL — `Cannot find module … jot.mts`

- [ ] **Step 3: Write the implementation**

Create `skills/portfolio/scaffold/jot.mts`:

```ts
// Capture work into the portfolio.
//   node jot.mts "Title" ["desc"]                          -> inbox idea (I##)
//   node jot.mts --epic [E##] [--story S##] "Title" ["desc"] -> task (T###) under epic
//   node jot.mts --set-epic E##                            -> set the current-epic marker
//   node jot.mts --clear-epic                              -> clear the marker
//   node jot.mts --next-id E|S|T|I                         -> print the next free id
// Node >= 22.18; node: stdlib only.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const USAGE = 'usage: node jot.mts [--epic [E##] [--story S##]] "Title" ["desc"]';
const ID_WIDTHS: Record<string, number> = { E: 2, S: 2, T: 3, I: 2 };

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function itemFiles(root: string): string[] {
  const out: string[] = [];
  for (const sub of ["inbox", "epics"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) out.push(p);
      }
    };
    walk(dir);
  }
  return out;
}

export function nextId(root: string, letter: string, width: number): string {
  let last = 0;
  const re = new RegExp(`^id: ${letter}(\\d+)\\r?$`, "gm");
  for (const f of itemFiles(root)) {
    for (const m of readFileSync(f, "utf8").matchAll(re)) {
      const n = parseInt(m[1], 10);
      if (n > last) last = n;
    }
  }
  return letter + String(last + 1).padStart(width, "0");
}

export function epicDir(root: string, eid: string): string | null {
  const epics = join(root, "epics");
  if (!existsSync(epics)) return null;
  const re = new RegExp(`^id: ${eid}\\r?$`, "m");
  for (const sub of readdirSync(epics, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const f = join(epics, sub, "_epic.md");
    if (existsSync(f) && re.test(readFileSync(f, "utf8"))) return join(epics, sub);
  }
  return null;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`;
}

// Core logic; writes item files but does not regenerate views (main does).
export function jot(root: string, argvIn: string[]): { out: string; code: number } {
  const argv = [...argvIn];
  const marker = join(root, ".current-epic");

  if (argv[0] === "--next-id") {
    const letter = argv[1] ?? "";
    if (!(letter in ID_WIDTHS)) return { out: "usage: node jot.mts --next-id E|S|T|I", code: 1 };
    return { out: nextId(root, letter, ID_WIDTHS[letter]), code: 0 };
  }
  if (argv[0] === "--set-epic") {
    if (!argv[1]) return { out: "usage: node jot.mts --set-epic E##", code: 1 };
    if (!epicDir(root, argv[1])) return { out: `error: epic ${argv[1]} not found`, code: 1 };
    writeFileSync(marker, argv[1] + "\n", "utf8");
    return { out: `Current epic set to ${argv[1]}`, code: 0 };
  }
  if (argv[0] === "--clear-epic") {
    rmSync(marker, { force: true });
    return { out: "Current epic cleared", code: 0 };
  }

  let epic = "";
  let story = "";
  let mode: "idea" | "epic" = "idea";
  if (argv[0] === "--epic") {
    mode = "epic";
    argv.shift();
    if (argv[0] && /^E\d/.test(argv[0])) epic = argv.shift()!;
  }
  if (argv[0] === "--story") {
    if (mode !== "epic") return { out: "error: --story requires --epic", code: 1 };
    story = argv[1] ?? "";
    if (!story) return { out: "usage: --story S##", code: 1 };
    argv.splice(0, 2);
  }
  if (argv.length < 1) return { out: USAGE, code: 1 };

  const title = argv[0];
  const desc = argv[1] ?? title;
  const today = todayISO();
  const slug = slugify(title);

  if (mode === "idea") {
    mkdirSync(join(root, "inbox"), { recursive: true });
    const id = nextId(root, "I", 2);
    const file = join(root, "inbox", `${today}-${slug}.md`);
    if (existsSync(file)) return { out: `error: ${file} already exists`, code: 1 };
    writeFileSync(file,
      `---\nid: ${id}\ntype: idea\ntitle: ${title}\nstatus: future\n` +
      `horizon: later\ncreated: ${today}\n---\n\n${desc}\n`, "utf8");
    return { out: `Created ${file} (${id})`, code: 0 };
  }

  if (!epic) {
    if (!existsSync(marker)) return { out: `error: no epic given and no ${marker} set`, code: 1 };
    epic = readFileSync(marker, "utf8").trim();
  }
  const dir = epicDir(root, epic);
  if (!dir) return { out: `error: epic ${epic} not found`, code: 1 };
  const id = nextId(root, "T", 3);
  const file = join(dir, `${today}-${slug}.md`);
  if (existsSync(file)) return { out: `error: ${file} already exists`, code: 1 };
  const storyLine = story ? `story: ${story}\n` : "";
  writeFileSync(file,
    `---\nid: ${id}\ntype: task\ntitle: ${title}\nstatus: future\n` +
    `created: ${today}\nupdated: ${today}\nepic: ${epic}\n${storyLine}---\n\n${desc}\n`, "utf8");
  return { out: `Created ${file} (${id})`, code: 0 };
}

export function main(): void {
  const root = import.meta.dirname;
  const { out, code } = jot(root, process.argv.slice(2));
  if (code !== 0) {
    console.error(out);
    process.exit(code);
  }
  const created = out.startsWith("Created ");
  if (created) {
    spawnSync(process.execPath, [join(root, "build-views.mts")], { stdio: "inherit" });
  }
  console.log(out);
}

if (process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  main();
}
```

Behavior notes preserved from jot.sh: regen runs only after a file was created (`--set-epic`/`--clear-epic`/`--next-id` don't regen — same as the shell version, where `./build-views.sh` was only reached at the bottom); "Created …" prints **after** the regen output, matching the shell order.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test skills/portfolio/scaffold/`
Expected: PASS (64 tests)

- [ ] **Step 5: End-to-end smoke via the real CLI**

```bash
cd "$(mktemp -d)" && cp -r ~/Personulegt/coding/portfolio/skills/portfolio/scaffold/. .
node jot.mts "Smoke test idea" "Just checking."
grep -l "Smoke test idea" inbox/*.md && grep -q "Smoke test idea" BOARD.md ROADMAP.md; echo "roadmap: $?"
node jot.mts --next-id I
```

Expected: `Wrote …` then `Created inbox/… (I01)`; the idea shows in ROADMAP.md (ideas don't get BOARD cards); `--next-id I` prints `I02`.

- [ ] **Step 6: Delete the originals and commit**

```bash
cd ~/Personulegt/coding/portfolio
git rm skills/portfolio/scaffold/jot.sh skills/portfolio/scaffold/build-views.sh \
       skills/portfolio/scaffold/build_views.py skills/portfolio/scaffold/test_build_views.py
node --test skills/portfolio/scaffold/
git add skills/portfolio/scaffold/jot.mts skills/portfolio/scaffold/jot.test.mts
git commit -m "Port jot to TypeScript, drop bash/Python originals"
```

---

### Task 7: hooks/regen.mts and cross-shell hooks.json

**Files:**
- Create: `hooks/regen.mts`
- Create (test): `hooks/regen.test.mts`
- Modify: `hooks/hooks.json` (full rewrite)

**Interfaces:**
- Consumes: spawns `<portfolio-root>/build-views.mts` via `process.execPath`.
- Produces: `portfolioRootFor(filePath: string | undefined | null): string | null` (exported, pure); `main()` reading stdin. `hooks.json` invokes the script.

- [ ] **Step 1: Write the failing tests**

Create `hooks/regen.test.mts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test hooks/`
Expected: FAIL — `Cannot find module … regen.mts`

- [ ] **Step 3: Write the implementation**

Create `hooks/regen.mts`:

```ts
// PostToolUse hook: regenerate portfolio views after an Edit/Write to a
// portfolio item. Reads the hook JSON from stdin. Never fails the tool
// call: always exits 0. Node >= 22.18.

import { readFileSync, existsSync, realpathSync } from "node:fs";
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

if (process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test hooks/`
Expected: PASS (8 tests)

- [ ] **Step 5: Rewrite hooks.json**

Replace the whole file with:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/regen.mts"],
            "timeout": 15,
            "statusMessage": "Regenerating portfolio views..."
          }
        ]
      }
    ]
  }
}
```

The `command` + `args` form executes without any shell, so there is nothing
for cmd/PowerShell/bash quoting to break, and backslashes in the substituted
plugin path survive untouched.

**Fallback** (only if live verification in Step 6 shows this Claude Code
version rejects `args` on hooks): revert to the shell form
`"command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/regen.mts\""` — regen.mts
itself has no other shell dependence.

- [ ] **Step 6: Live verification**

In a Claude Code session with this plugin installed from the local marketplace: create `/tmp/hooktest/portfolio/` by copying the scaffold, ask Claude to edit an item file under it, and confirm the "Regenerating portfolio views..." status fires and `BOARD.md` is rewritten (check mtime). If the hook errors on the `args` form, apply the fallback from Step 5 and re-verify.

- [ ] **Step 7: Commit**

```bash
git add hooks/regen.mts hooks/regen.test.mts hooks/hooks.json
git commit -m "Replace jq hook one-liner with Node regen script"
```

---

### Task 8: Documentation sweep and spec amendment

**Files:**
- Modify: `skills/portfolio/SKILL.md`
- Modify: `skills/portfolio/scaffold/README.md`
- Modify: `agents/portfolio-review.md`
- Modify: `docs/superpowers/specs/2026-07-21-windows-node-port-design.md`

- [ ] **Step 1: Update SKILL.md**

Every command swap, exactly:

- init block →

  ```bash
  mkdir -p portfolio
  cp -r <this-skill-dir>/scaffold/. portfolio/
  node portfolio/build-views.mts
  ```

  and add beneath it: “On Windows without Git Bash (PowerShell):
  `New-Item -ItemType Directory -Force portfolio; Copy-Item -Recurse -Force <this-skill-dir>/scaffold/* portfolio/` (PowerShell's `*` includes dot-named files).”
- Add after the init paragraph: “Requires Node.js ≥ 22.18 (`node --version`).”
- `portfolio/jot.sh "Title" ["description"]` → `node portfolio/jot.mts "Title" ["description"]`, and the epic-aware block:

  ```bash
  node portfolio/jot.mts --set-epic E##
  node portfolio/jot.mts --epic "Task title" ["desc"]
  node portfolio/jot.mts --epic E## "Task title" ["desc"]
  node portfolio/jot.mts --epic E## --story S## "Task title"
  node portfolio/jot.mts --clear-epic
  ```
- **new** operation id step: `` `grep -rho 'id: S[0-9]\+' portfolio | sort -V | tail -1` then +1 `` → `` `node portfolio/jot.mts --next-id S` (same for E/T/I) ``
- **regen**: `portfolio/build-views.sh` → `node portfolio/build-views.mts` (both occurrences, including the init verify line)
- Hard-rules line “generated by build-views.sh” wording if present → `.mts`.

- [ ] **Step 2: Update scaffold README.md**

- Layout block: `build-views.sh / build_views.py    regenerates …` → `build-views.mts    regenerates BOARD.md, ROADMAP.md, BRAGLOG.md, portfolio.html`; `jot.sh` → `jot.mts`; add `build-views.test.mts / jot.test.mts   tests (node --test)`.
- “Creating an item” step 1 → `node jot.mts --next-id T` (drop the grep pipe).
- Views section command → `node portfolio/build-views.mts` (drop `cd portfolio && ./build-views.sh`).
- Ideas section → `node jot.mts "Idea title" ["one-line description"]`; epic-aware block same swap as SKILL.md.
- Add a “Requirements” line under the intro: “Node.js ≥ 22.18 (the scripts are TypeScript run natively via Node's type stripping).”
- Note in Querying section: “(grep examples assume a POSIX shell — Git Bash on Windows works; or use `node jot.mts --next-id` for id allocation.)”

- [ ] **Step 3: Update agents/portfolio-review.md**

`run \`portfolio/build-views.sh\` and capture stderr` → `run \`node portfolio/build-views.mts\` and capture stderr`; same swap in the closing “Rules” line.

- [ ] **Step 4: Amend the spec**

Append to `docs/superpowers/specs/2026-07-21-windows-node-port-design.md`:

```markdown
## Amendments (2026-07-21, during planning)

- File extension is `.mts`, not `.ts`: the scaffold lands in user repos where
  a `"type": "commonjs"` package.json would make Node parse `.ts` as CJS;
  `.mts` is unconditionally ESM.
- hooks.json uses the shell-less `command` + `args` hook form instead of a
  shell one-liner; the `node -e` trampoline is no longer needed.
```

- [ ] **Step 5: Full-suite verification**

```bash
node --test skills/portfolio/scaffold/ hooks/
```

Expected: PASS, 0 failures. Then re-run the Task 6 Step 5 smoke end-to-end once more from a clean temp copy.

- [ ] **Step 6: Commit**

```bash
git add skills/portfolio/SKILL.md skills/portfolio/scaffold/README.md \
        agents/portfolio-review.md docs/superpowers/specs/2026-07-21-windows-node-port-design.md
git commit -m "Update docs for the Node/TS tooling"
```

---

## Acceptance checklist (after all tasks)

- [ ] `node --test skills/portfolio/scaffold/ hooks/` — all green
- [ ] `git grep -l 'jot\.sh\|build-views\.sh\|build_views\.py'` returns only the spec/plan docs
- [ ] Scaffold copy → `node build-views.mts` → open `portfolio.html` in a browser: three tabs render
- [ ] Live hook verification done (Task 7 Step 6)
- [ ] On a real Windows machine (when available): copy scaffold, `node jot.mts "Win test"`, confirm views regenerate — the only step that cannot be verified on Linux
