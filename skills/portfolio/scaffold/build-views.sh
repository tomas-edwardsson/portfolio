#!/usr/bin/env bash
# Regenerate BOARD.md and ROADMAP.md from portfolio frontmatter.
# Run from anywhere: portfolio/build-views.sh
set -euo pipefail
cd "$(dirname "$0")"
exec python3 build_views.py "$@"
