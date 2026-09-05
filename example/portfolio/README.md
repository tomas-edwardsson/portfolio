# Example portfolio: Tidepool

A small, entirely fictional portfolio for a bird-sighting logbook app. It
exists so the generated views, and `portfolio.html` in particular, can be
looked at without initialising a real portfolio, and so renderer changes show
up as diffs in committed output.

Everything under `epics/` and `inbox/` is hand-written test data. The four
views (`BOARD.md`, `ROADMAP.md`, `BRAGLOG.md`, `portfolio.html`) are generated
from those files and committed. They are rendered with a pinned date so the
output is stable:

```bash
node skills/portfolio/scaffold/build-views.mts --root example/portfolio --today 2026-09-01
```

`example/example.test.mts` fails if the committed views are out of date, so run
that command after changing either the item files or the renderer:

```bash
node --test 'example/*.test.mts'
```

The scripts are deliberately not copied in here; the repo's scaffold copy is
the one that renders this directory.
