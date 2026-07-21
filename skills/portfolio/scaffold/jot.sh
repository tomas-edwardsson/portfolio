#!/usr/bin/env bash
# Capture work into the portfolio.
#   jot.sh "Title" ["desc"]                      -> inbox idea (I##)
#   jot.sh --epic [E##] [--story S##] "Title" ["desc"]  -> task (T###) under epic
#   jot.sh --set-epic E##                        -> set the current-epic marker
#   jot.sh --clear-epic                          -> clear the marker
set -euo pipefail
cd "$(dirname "$0")"

marker=".current-epic"

slugify() {
  printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//'
}

next_id() {  # $1 = letter (I/T), $2 = printf width
  local last
  last=$(grep -rho "^id: $1[0-9]*" inbox epics 2>/dev/null \
    | sed "s/^id: $1//" | sort -n | tail -1 || true)
  printf "$1%0${2}d" $(( 10#${last:-0} + 1 ))
}

epic_dir() {  # $1 = epic id -> prints its folder, or exits 1
  local f
  f=$(grep -rl "^id: $1\$" epics/*/_epic.md 2>/dev/null | head -1 || true)
  [ -n "$f" ] || { echo "error: epic $1 not found" >&2; return 1; }
  dirname "$f"
}

# --- subcommands ---------------------------------------------------------
if [ "${1:-}" = "--set-epic" ]; then
  [ -n "${2:-}" ] || { echo "usage: jot.sh --set-epic E##" >&2; exit 1; }
  epic_dir "$2" >/dev/null
  printf '%s\n' "$2" > "$marker"
  echo "Current epic set to $2"
  exit 0
fi
if [ "${1:-}" = "--clear-epic" ]; then
  rm -f "$marker"
  echo "Current epic cleared"
  exit 0
fi

# --- flag parsing --------------------------------------------------------
epic=""
story=""
mode="idea"
if [ "${1:-}" = "--epic" ]; then
  mode="epic"
  shift
  # optional explicit id (starts with E)
  case "${1:-}" in
    E[0-9]*) epic="$1"; shift ;;
  esac
fi
if [ "${1:-}" = "--story" ]; then
  [ "$mode" = "epic" ] || { echo "error: --story requires --epic" >&2; exit 1; }
  story="${2:-}"
  [ -n "$story" ] || { echo "usage: --story S##" >&2; exit 1; }
  shift 2
fi

[ $# -ge 1 ] || { echo "usage: jot.sh [--epic [E##] [--story S##]] \"Title\" [\"desc\"]" >&2; exit 1; }
title="$1"
desc="${2:-$title}"
today=$(date +%F)
slug=$(slugify "$title")

if [ "$mode" = "idea" ]; then
  mkdir -p inbox
  id=$(next_id I 2)
  file="inbox/${today}-${slug}.md"
  [ ! -e "$file" ] || { echo "error: $file already exists" >&2; exit 1; }
  cat > "$file" <<EOF
---
id: $id
type: idea
title: $title
status: future
horizon: later
created: $today
---

$desc
EOF
else
  # resolve epic from flag or marker
  if [ -z "$epic" ]; then
    [ -f "$marker" ] || { echo "error: no epic given and no $marker set" >&2; exit 1; }
    epic=$(cat "$marker")
  fi
  dir=$(epic_dir "$epic")
  id=$(next_id T 3)
  file="${dir}/${today}-${slug}.md"
  [ ! -e "$file" ] || { echo "error: $file already exists" >&2; exit 1; }
  {
    echo "---"
    echo "id: $id"
    echo "type: task"
    echo "title: $title"
    echo "status: future"
    echo "created: $today"
    echo "updated: $today"
    echo "epic: $epic"
    [ -n "$story" ] && echo "story: $story"
    echo "---"
    echo ""
    echo "$desc"
  } > "$file"
fi

./build-views.sh
echo "Created $file ($id)"
