---
name: portfolio
description: Use when the user wants to track, jot, or plan product work (ideas, epics, stories, tasks), asks what's on the board/roadmap/braglog or what to work on next, wants a portfolio tracker set up in a workspace, or when starting/finishing project work that should be reflected on the board.
---

# Portfolio skill

A markdown work tracker — Epic → Story → Task plus an idea inbox — living in
a `portfolio/` directory. By default that is the **root of the git checkout**,
committed with the code. Multi-repo or worktree-based workspaces may instead
keep it one level up, as a sibling of the checkout(s) — locate it before
assuming (`ls portfolio ../portfolio`). All commands below run from the
directory that contains `portfolio/`. Full conventions:
`portfolio/README.md`.

## Relationship to Superpowers

The portfolio is the index of **what**; Superpowers docs are the **how**.

- Shaping a promoted idea into an epic or story? Use superpowers:brainstorming
  first; put the resulting design in the item body or a `brief:` doc.
- Ready to implement a story/task? Use superpowers:writing-plans, then record
  the doc paths in the item's `spec:` / `plan:` frontmatter fields — link,
  never duplicate content.
- When superpowers:finishing-a-development-branch completes work, set the
  matching item `done` (see **status**).

## Operations

**init** — no `portfolio/` exists yet. Location: the repo root by default;
the workspace root (parent of the checkouts) only if the user tracks several
repos/worktrees as one product. From that directory, copy the scaffold from
this skill's directory (dotfiles included), then verify:

```bash
mkdir -p portfolio
cp -r <this-skill-dir>/scaffold/. portfolio/
portfolio/build-views.sh
```

Optionally write the product name into `portfolio/.title` (brands the HTML
view). Suggest the PostToolUse regen hook from the plugin's `hooks/hooks.json`
if the plugin isn't installed.

**jot** — capture a loose idea (title + optional one-liner). Never requires
planning:

```bash
portfolio/jot.sh "Title" ["description"]
```

**jot (epic-aware)** — mid-implementation, new work turns up. If it's within
scope of the epic you're actively implementing, file it as a task under that
epic instead of an inbox idea; if it's broader or unrelated, jot it as a plain
inbox idea (the command above). A jotted task is a **sibling** under the epic,
not a subtask — never fold it into the current item's scope:

```bash
portfolio/jot.sh --set-epic E##                     # once per session
portfolio/jot.sh --epic "Task title" ["desc"]       # task under the remembered epic
portfolio/jot.sh --epic E## "Task title" ["desc"]   # task under a specific epic
portfolio/jot.sh --epic E## --story S## "Task title" # task under a story in that epic
portfolio/jot.sh --clear-epic                       # forget the remembered epic
```

**new** — create an epic/story/task:

1. Copy the matching file from `portfolio/templates/` into the epic folder
   (`epics/YYYY-MM-DD-<slug>/`, epics use filename `_epic.md`).
2. Allocate the next id: `grep -rho 'id: S[0-9]\+' portfolio | sort -V | tail -1`
   then +1 (same for E/T/I; the templates' `00` placeholders seed each
   sequence, so this always returns something).
3. Fill frontmatter: id, title, status, created/updated (today), parent
   `epic:`/`story:` links, `horizon:` for epics (now/next/later).

**promote** — an idea firmed up:

1. Create the epic/story via **new** (carry the idea's title/description).
2. In the idea file set `status: promoted` and `promoted-to: <new id>`. Keep
   the file.
3. Note: the Board shows story/task cards, not bare epics, and the Roadmap
   shows only future/parked epics — so if work starts now, create the first
   story too, or the promoted epic won't appear on any view yet.

**status** — edit the item's `status:` (future|active|blocked|done|dropped)
and/or `horizon:`, and bump `updated:` to today. An active epic should have
`horizon: now`. Starting work? Set the matching item `active`. Finishing?
Set it `done`. Stalled externally? `blocked`.

**park an epic** — set the epic's `_epic.md` `status: parked`; its stories
cascade to parked automatically at view-generation time (do NOT edit each
story — their own `status:` field is untouched). Parked epics leave the Board
and appear in the Roadmap's Parked section. Resume by setting the epic back
to `active`.

**block** — record ordering: add `blocked-by: [S05, S09]` (ids, bracket list)
to the dependent item. An item is _ready_ when all its blockers are done.

**regen** — after any manual portfolio edit, regenerates all four views
(`BOARD.md` kanban, `ROADMAP.md` accordion, `BRAGLOG.md`, `portfolio.html`
tabs):

```bash
portfolio/build-views.sh
```

(The plugin's PostToolUse hook also runs this automatically after Edit/Write
to portfolio markdown.)

**Braglog** — done epics/stories show up in `BRAGLOG.md` (dated, newest
first, grouped by month) with no manual step. The ship date shown is
`updated` unless the item sets a `completed:` date.

**review** — for staleness sweeps ("what's stale", "what's ready to start"),
dispatch the `portfolio-review` agent instead of scanning inline.

## Hard rules

- NEVER hand-edit `BOARD.md`, `ROADMAP.md`, `BRAGLOG.md`, or `portfolio.html`
  — they are generated.
- NEVER split an item into subtasks without explicit user approval
  (runaway-decomposition guardrail). Discovered work → **jot** it instead.
- Ids are stable forever; never renumber or reuse.
- Heed generator warnings on stderr (unknown ids/statuses, dependency
  cycles, unsupported idea horizons). Status/horizon drift is NOT warned
  about — the `portfolio-review` agent catches it.
