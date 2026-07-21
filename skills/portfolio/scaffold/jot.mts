// Capture work into the portfolio.
//   node jot.mts "Title" ["desc"]                          -> inbox idea (I##)
//   node jot.mts --epic [E##] [--story S##] "Title" ["desc"] -> task (T###) under epic
//   node jot.mts --set-epic E##                            -> set the current-epic marker
//   node jot.mts --clear-epic                              -> clear the marker
//   node jot.mts --next-id E|S|T|I                         -> print the next free id
// Node >= 22.18; node: stdlib only.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const USAGE = 'usage: node jot.mts [--epic [E##] [--story S##]] "Title" ["desc"]';
const ID_WIDTHS: Record<string, number> = { E: 2, S: 2, T: 3, I: 2 };

// Render a path for display: relative to root, forward slashes (Windows-safe).
function rel(root: string, p: string): string {
  return relative(root, p).replaceAll(sep, "/");
}

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
    if (existsSync(file)) return { out: `error: ${rel(root, file)} already exists`, code: 1 };
    writeFileSync(file,
      `---\nid: ${id}\ntype: idea\ntitle: ${title}\nstatus: future\n` +
      `horizon: later\ncreated: ${today}\n---\n\n${desc}\n`, "utf8");
    return { out: `Created ${rel(root, file)} (${id})`, code: 0 };
  }

  if (!epic) {
    if (!existsSync(marker)) {
      return { out: `error: no epic given and no ${rel(root, marker)} set`, code: 1 };
    }
    epic = readFileSync(marker, "utf8").trim();
  }
  const dir = epicDir(root, epic);
  if (!dir) return { out: `error: epic ${epic} not found`, code: 1 };
  const id = nextId(root, "T", 3);
  const file = join(dir, `${today}-${slug}.md`);
  if (existsSync(file)) return { out: `error: ${rel(root, file)} already exists`, code: 1 };
  const storyLine = story ? `story: ${story}\n` : "";
  writeFileSync(file,
    `---\nid: ${id}\ntype: task\ntitle: ${title}\nstatus: future\n` +
    `created: ${today}\nupdated: ${today}\nepic: ${epic}\n${storyLine}---\n\n${desc}\n`, "utf8");
  return { out: `Created ${rel(root, file)} (${id})`, code: 0 };
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
    const regen = spawnSync(process.execPath, [join(root, "build-views.mts")], { stdio: "inherit" });
    if (regen.error || regen.status !== 0) {
      process.exit(regen.status ?? 1);
    }
  }
  console.log(out);
}

if (import.meta.main) {
  main();
}
