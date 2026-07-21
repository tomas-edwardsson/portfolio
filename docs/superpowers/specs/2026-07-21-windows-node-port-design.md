# Windows-native Node/TypeScript port — design

**Date:** 2026-07-21
**Status:** approved design, pre-implementation

## Problem

The portfolio plugin must work on native Windows (no WSL). Today it does not:

1. **PostToolUse hook** (`hooks/hooks.json`) is a POSIX one-liner that needs
   `jq` (not shipped with Git Bash), `case`/`[ ]`/`${P%%/portfolio/*}`
   expansion, and `basename`. On Windows, hooks run under Git Bash *if
   installed*, otherwise PowerShell — where the line is meaningless. Even
   under Git Bash, `tool_input.file_path` arrives with backslashes (known
   Claude Code issue), so the `*/portfolio/*.md` match and the prefix-strip
   both fail. `[ -x … ]` plus executing a `.sh` file is unreliable on NTFS.
2. **`build-views.sh`** is bash + `exec python3`; `python3` is not a reliable
   command name on Windows (python.org installs give `python`/`py`; Git Bash
   ships no Python).
3. **`jot.sh`** is full bash (tr/sed/grep/date) — dead on PowerShell-only
   machines.
4. **`build_views.py` itself is portable** (stdlib, UTF-8, pathlib); only its
   launchers are not.
5. **Docs** (`SKILL.md`, scaffold `README.md`) hardcode bash-isms
   (`cp -r scaffold/. portfolio/`, `grep -rho … | sort -V | tail -1`,
   `./jot.sh`).

## Decisions (made with the user)

| Decision | Choice |
|---|---|
| Runtime baseline | **Node.js in PATH** (documented requirement; not bundled by Claude Code) |
| Language | **TypeScript run natively** — erasable-syntax-only TS, executed by Node's built-in type stripping. **Requires Node ≥ 22.18 (LTS) / ≥ 23.6** |
| Scope | **Full replacement** — delete `jot.sh`, `build-views.sh`, `build_views.py`, `test_build_views.py`; no wrappers, no dual implementations |
| Structure | **Approach A** — mirror the current layout: separate `build-views.ts` and `jot.ts` in the scaffold; hook logic moves into a Node script in the plugin |

## Components

### `skills/portfolio/scaffold/build-views.ts`

1:1 port of `build_views.py`.

- CLI: `node build-views.ts [--root DIR]`; root defaults to the script's own
  directory (`import.meta.dirname`).
- Outputs unchanged: `BOARD.md`, `ROADMAP.md`, `BRAGLOG.md`,
  `portfolio.html`. Rendered bytes kept identical to the Python version where
  practical:
  - month labels via a `["January", …]` lookup table (no `strftime`);
  - HTML escaping replicates Python's `html.escape(quote=True)` exactly
    (`&`, `<`, `>`, `"` → `&quot;`, `'` → `&#x27;`);
  - the `GENERATED` marker and footer text still say `build-views.sh` →
    **change to `build-views.ts`** (intentional output diff).
- `node:` stdlib only (`node:fs`, `node:path`, `node:process`). Explicit
  UTF-8 on every read/write.
- Erasable-syntax TS only: type annotations and interfaces, **no** enums,
  namespaces, or parameter properties (nothing type stripping can't erase).
- Warnings to stderr, exit 0 unless the portfolio dir itself is missing
  (same contract as the Python version).

### `skills/portfolio/scaffold/jot.ts`

Port of `jot.sh`, same CLI surface:

- `node jot.ts "Title" ["desc"]` → inbox idea (I##)
- `node jot.ts --epic [E##] [--story S##] "Title" ["desc"]` → task under epic
- `node jot.ts --set-epic E##` / `--clear-epic` → `.current-epic` marker
- **New:** `node jot.ts --next-id E|S|T|I` prints the next free id —
  cross-platform replacement for the docs' `grep -rho … | sort -V | tail -1`
  recipe.
- Slugify / next-id / epic-dir lookup as plain string ops over the same
  files; behavior matches the shell version (duplicate-file refusal, error
  messages to stderr, non-zero exit on usage errors).
- After a successful write, regenerates views by spawning
  `process.execPath` (the running Node binary) on `build-views.ts` — no PATH
  lookup, no shell, no chmod.

### `hooks/regen.ts` (plugin, not scaffold)

Replaces the jq one-liner. Logic, in order:

1. Read the PostToolUse JSON from stdin.
2. Take `tool_input.file_path`; **normalize `\` → `/`** before any matching.
3. Apply today's rules: path contains `/portfolio/`, ends `.md`, basename is
   not `BOARD.md`/`ROADMAP.md`/`BRAGLOG.md`.
4. Portfolio root = path prefix up to the **first** `/portfolio/` segment
   plus `/portfolio` (same semantics as `${P%%/portfolio/*}`).
5. If `<root>/build-views.ts` exists, spawn `node <root>/build-views.ts`
   (via `process.execPath`), output discarded.
6. **Always exit 0**, wrap everything in try/catch — the hook must never
   block or spam Claude.

### `hooks/hooks.json`

Same matcher (`Edit|Write`), timeout 15, statusMessage. Command becomes a
single Node invocation, portable across sh / Git Bash / PowerShell:

- **Preferred:** a single-quoted `node -e` trampoline that imports
  `regen.ts` from the `CLAUDE_PLUGIN_ROOT` **environment variable**
  (single-quoted strings are literal in both bash and PowerShell, so one
  command line works under every hook shell).
- **Verify during implementation:** whether `CLAUDE_PLUGIN_ROOT` is exported
  as an env var to hook processes (docs only document the `${…}` template).
  If it is not, fall back to `node "${CLAUDE_PLUGIN_ROOT}/hooks/regen.ts"`
  (template substitution) and rely on regen.ts's backslash tolerance.

### Deletions

`skills/portfolio/scaffold/jot.sh`, `…/build-views.sh`, `…/build_views.py`,
`…/test_build_views.py`.

## Data flow (unchanged)

Frontmatter files → item map → validate (warnings to stderr) → render the
four views. The port changes the runtime, not the model. Templates,
frontmatter schema, ids, and statuses are untouched.

## Error handling & Windows specifics

- All path handling through `node:path`; any path arriving from hook JSON is
  slash-normalized before matching.
- Console (stdout/stderr) output stays ASCII; emoji appear only inside
  generated files, written as UTF-8 (avoids cp1252 console garbling).
- No reliance on executable bits or shebangs — every documented invocation
  is explicitly `node <script>`.
- Old-Node failure mode: type stripping absent → syntax error before our
  code runs, so the version requirement lives in README + SKILL.md (no
  runtime guard is possible in-file).

## Testing (TDD — tests ported/written first)

| Suite | Contents |
|---|---|
| `scaffold/build_views.test.ts` | Full port of the ~45 `test_build_views.py` cases, on `node:test` + `node:assert/strict` |
| `hooks/regen.test.ts` | Fixture JSON via stdin: fires on a portfolio item edit, skips generated files and non-portfolio paths, **fires on a backslash `C:\…` Windows path**, exits 0 on garbage input |
| `scaffold/jot.test.ts` | New: slugify, next-id scanning, epic resolution, `--next-id`, duplicate-file refusal |

Run: `node --test` (from `portfolio/` for scaffold tests; repo root or
`hooks/` for hook tests). Verified on Linux during development; the same
command is the acceptance smoke test on a real Windows machine.

## Docs

- `skills/portfolio/SKILL.md`, `skills/portfolio/scaffold/README.md`,
  `agents/portfolio-review.md`: every `./jot.sh` / `build-views.sh`
  reference becomes `node portfolio/jot.ts` / `node portfolio/build-views.ts`.
- Id-allocation recipe → `node portfolio/jot.ts --next-id S`.
- Init copy step documented in both bash (`cp -r`) and PowerShell
  (`Copy-Item -Recurse`) variants.
- Layout tables / file lists updated to the new filenames; Node ≥ 22.18
  requirement stated in both READMEs.

## Out of scope

- No behavior changes to views, schema, or workflow beyond `--next-id`.
- No backport to the veeball origin repo (this repo is a standalone
  extraction).
- No package.json / npm packaging; the scaffold stays copy-paste files.
