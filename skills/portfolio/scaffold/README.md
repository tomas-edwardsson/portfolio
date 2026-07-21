# Portfolio

A markdown-based tracker for all work on a product — every repo, pipeline, and
infra concern — sitting above any single repo. Plain files, no service, fully
greppable; four read-only views are generated from frontmatter.

## Hierarchy

**Epic → Story → Task.**

- **Epic** — a large initiative (e.g. "Video clock sync pipeline").
- **Story** — a mid-size deliverable within an epic (a.k.a. "project").
- **Task** — a leaf work item.
- **Idea** — a loose, unplanned item living in inbox/ (title + description only).

## Layout

```
portfolio/
  README.md                          this file
  BOARD.md                           GENERATED overview — do not hand-edit
  ROADMAP.md                         GENERATED direction view — do not hand-edit
  BRAGLOG.md                         GENERATED shipped history — do not hand-edit
  portfolio.html                     GENERATED styled page (Board/Roadmap/Braglog) — do not hand-edit
  build-views.sh / build_views.py    regenerates BOARD.md, ROADMAP.md, BRAGLOG.md, portfolio.html
  jot.sh                             one-command idea capture
  .title                             optional product name shown in portfolio.html
  templates/                         copy these to create new items
  inbox/
    YYYY-MM-DD-<idea-slug>.md        loose ideas (type: idea)
  epics/
    YYYY-MM-DD-<epic-slug>/
      _epic.md                       the epic descriptor (_ sorts to top)
      YYYY-MM-DD-<story-slug>.md     a story
      YYYY-MM-DD-<task-slug>.md      a task
```

- Epic folders and story/task files carry a `YYYY-MM-DD-` date prefix → chronological sort.
- `_epic.md` is a fixed filename so the epic descriptor is always easy to find.
- Stories and tasks for an epic are flat files inside that epic's folder.
- Any `.md` file dropped into an epic folder with no frontmatter block (no
  leading `---`) is treated as reference material (e.g. a `brief` doc) —
  `build_views.py` ignores it silently.

## Frontmatter schema

Every file starts with a YAML frontmatter block; the body below is free-form.

| Field | Applies to | Notes |
|-------|------------|-------|
| `id` | all | `E##` epic, `S##` story, `T###` task, `I##` idea. Stable — never changes. |
| `type` | all | `epic` \| `story` \| `task` \| `idea` |
| `title` | all | Human-readable title |
| `status` | all | `future` \| `active` \| `blocked` \| `parked` \| `done` \| `dropped`; ideas use `future` \| `promoted` \| `dropped`. `parked` is epics only; cascades to their stories. |
| `created` | all | `YYYY-MM-DD` |
| `updated` | epic, story, task | `YYYY-MM-DD` — bump on meaningful change |
| `completed` | epic, story (optional) | ISO date the item shipped; Braglog uses this over `updated`. |
| `tags` | all (optional) | e.g. `[sync, ocr]` |
| `epic` | story, task | Parent epic id |
| `story` | task | Parent story id (omit for epic-level tasks) |
| `branch` | story, task (optional) | Worktree/branch name when work is live |
| `spec` | story, task (optional) | Path to a Superpowers spec |
| `plan` | story, task (optional) | Path to a Superpowers plan |
| `horizon` | epic, idea | `now` \| `next` \| `later` (ideas: `later` \| `next` only) — drives ROADMAP.md placement |
| `blocked-by` | all (optional) | `[S05, E02]` — ids that must be `done` before this is ready |
| `brief` | epic, story (optional) | Repo-relative path to a one-page brief (self-contained HTML or Markdown) |
| `artifact` | epic, story (optional) | Published claude.ai artifact URL |
| `promoted-to` | idea | Id the idea became when promoted |

Optional fields (`branch`, `spec`, `plan`) are commented out in the templates;
uncomment and fill when a real value exists, otherwise leave them out.

## Status lifecycle

`future` → `active` → `done`; `active` ↔ `blocked`; any → `dropped` (kept for history).
`active → parked` sets a whole initiative aside (its stories cascade to parked in views only; each story's own `status:` field is untouched);
`parked → active` resumes it.
Ideas: future → promoted (kept, points at the successor) or dropped.

## Creating an item

1. Find the next id:

   ```bash
   grep -rho 'id: T[0-9]\+' portfolio | sort -V | tail -1   # highest task id, then +1
   ```

   (Same for `E` and `S`.)
2. Copy the matching template into the right epic folder with a `YYYY-MM-DD-<slug>.md` name.
3. Fill the frontmatter (id, title, status, parent links) and body.
4. Regenerate the views (see below).

## Querying

```bash
grep -rl 'status: active'   portfolio/epics      # everything active
grep -rl 'epic: E01'        portfolio/epics      # all items under an epic
grep -rl 'status: blocked'  portfolio/epics      # what's stuck
grep -rl 'status: future'   portfolio/epics      # the backlog of future work
```

## Views

Four views are generated from frontmatter by `./build-views.sh` — never hand-edit any:

- **`BOARD.md`** — the kanban view: story/task cards in lanes (Blocked / Ready to go /
  Active), plus a Shipped-epics section for epics that landed in the last 30 days.
- **`ROADMAP.md`** — the forward-only direction view: epics as an accordion grouped by
  horizon (Next / Later / Parked), with "ships after" lines showing `blocked-by`
  dependencies.
- **`BRAGLOG.md`** — the dated shipped history (epics and stories), newest first,
  grouped by month.
- **`portfolio.html`** — Board, Roadmap, and Braglog as tabs in one self-contained
  styled page; open it directly in a browser. Put a product name in `.title`
  to brand the header.

```bash
cd portfolio && ./build-views.sh
```

## Ideas & promotion

Capture a loose idea without planning it out:

```bash
./jot.sh "Idea title" ["one-line description"]
```

This creates `inbox/YYYY-MM-DD-<idea-slug>.md` (`type: idea`) and regenerates the views.

When an idea firms up into real work, create the epic/story from the templates as
usual, then mark the idea `status: promoted` and set `promoted-to: <new id>` —
keep the idea file for history, don't delete it.

### Epic-aware jotting

When you're mid-implementation on an epic and a smaller, in-scope task turns up,
file it as a task under that epic instead of an inbox idea:

```bash
./jot.sh --set-epic E##                           # remember "the epic I'm working in"
./jot.sh --epic "Task title" ["desc"]              # task under the remembered epic
./jot.sh --epic E## "Task title" ["desc"]          # task under a specific epic
./jot.sh --epic E## --story S## "Task title"       # task under a story within that epic
./jot.sh --clear-epic                              # forget the remembered epic
```

Routing rule: if the discovery is **in scope of the epic you're actively
implementing**, jot it as a task under that epic. If it's **broader or
unrelated**, jot it as a plain inbox idea (`./jot.sh "Title"`). Either way, a
jotted item is a sibling — never fold it into the current item's scope.

## Claude Code tooling

Prefer the `portfolio` skill for creating and updating items — it keeps ids,
frontmatter, and file placement consistent. The portfolio plugin's PostToolUse
hook regenerates the generated views (BOARD.md, ROADMAP.md, BRAGLOG.md,
portfolio.html) automatically on any portfolio edit, and the
`portfolio-review` agent periodically sweeps for staleness (stale `updated`
dates, orphaned links, ideas that should be promoted or dropped).

## Relationship to Superpowers

Superpowers writes specs and plans into your repo (typically `docs/plans/` or
`docs/superpowers/`). Portfolio items **link out** to those via the `spec:` /
`plan:` frontmatter fields — no duplication. The portfolio is the index of
*what*; Superpowers docs are the *how*.
