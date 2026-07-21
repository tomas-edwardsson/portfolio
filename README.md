# portfolio

A markdown-based product-portfolio tracker for Claude Code, packaged as a
plugin: one skill, one review agent, one hook. Work is tracked as
**Epic → Story → Task** plus an **idea inbox**, in plain markdown files with
YAML frontmatter — no service, fully greppable — and four read-only views are
generated from them:

- **BOARD.md** — kanban (Blocked / Ready to go / Active + recently shipped)
- **ROADMAP.md** — epics by horizon (Now / Next / Later / Parked) with
  "ships after" dependency lines
- **BRAGLOG.md** — dated shipped history, newest first
- **portfolio.html** — all three as tabs in one self-contained styled page

The tracker lives at `<workspace-root>/portfolio/`, a **sibling of your repo
checkout(s)** — it gives a higher-level view of the whole product (app,
pipelines, infra) than any single repo can.

## Pairs with Superpowers

This tracker is designed to sit on top of
[Superpowers](https://github.com/obra/superpowers): the portfolio is the index
of **what** (initiatives, status, ordering), while Superpowers specs and plans
are the **how**. Items link out via `spec:` / `plan:` frontmatter fields;
promoting an idea routes through `superpowers:brainstorming`, and
implementation routes through `superpowers:writing-plans`. Install both for
the full loop; the tracker also works standalone.

## Install

### As a plugin (recommended — skill + agent + hook)

```
/plugin marketplace add <this-repo-git-url>
/plugin install portfolio@portfolio-marketplace
```

### Manual (bare skill)

```bash
ln -s /path/to/this-repo/skills/portfolio ~/.claude/skills/portfolio   # or .claude/skills/ in a project
cp agents/portfolio-review.md ~/.claude/agents/                        # optional review agent
```

Then merge `hooks/hooks.json` into your settings if you want views regenerated
automatically after every portfolio edit.

## Quick start

Ask Claude to "set up a portfolio in this workspace" (the skill's **init**
copies `skills/portfolio/scaffold/` to `<workspace-root>/portfolio/`), or do
it by hand:

```bash
mkdir -p portfolio && cp -r skills/portfolio/scaffold/. portfolio/
echo "My Product" > portfolio/.title        # optional: brands portfolio.html
portfolio/jot.sh "First idea" "one-liner"   # capture an idea, views regenerate
open portfolio/portfolio.html
```

From then on: jot ideas as they occur, promote the ones that firm up into
epics/stories, flip `status:` as work starts and finishes, and let the braglog
accumulate. Conventions live in
[`skills/portfolio/scaffold/README.md`](skills/portfolio/scaffold/README.md);
agent-facing operations in
[`skills/portfolio/SKILL.md`](skills/portfolio/SKILL.md).

## Guardrails baked in

- Generated views are never hand-edited (hook regenerates them on edit).
- Discovered work is **jotted as a sibling** (inbox idea, or task under the
  active epic) — never folded into the current item's scope, and items are
  never split into subtasks without explicit user approval.
- Ids (`E##`/`S##`/`T###`/`I##`) are stable forever.

## Development

```bash
cd skills/portfolio/scaffold && python3 -m unittest test_build_views -v
shellcheck skills/portfolio/scaffold/*.sh
```

Python 3 stdlib only; the shell scripts are POSIX-ish bash.
