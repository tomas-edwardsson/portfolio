// Guards the committed example portfolio: the generated views checked in
// under example/portfolio/ must match what build-views.mts renders from the
// item files with the pinned date. Regenerate with:
//
//   node skills/portfolio/scaffold/build-views.mts --root example/portfolio --today 2026-09-01
//
// Run: node --test 'example/*.test.mts'

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as bv from "../skills/portfolio/scaffold/build-views.mts";

export const EXAMPLE_TODAY = "2026-09-01";
const ROOT = join(import.meta.dirname, "portfolio");
const REGEN = "node skills/portfolio/scaffold/build-views.mts --root example/portfolio " +
  `--today ${EXAMPLE_TODAY}`;

function load(): bv.Items {
  const [items, warnings] = bv.loadItems(ROOT);
  assert.deepEqual(warnings.concat(bv.validate(items)), []);
  return items;
}

const VIEWS: [string, (items: bv.Items) => string][] = [
  ["BOARD.md", (i) => bv.renderBoard(i, EXAMPLE_TODAY)],
  ["ROADMAP.md", (i) => bv.renderRoadmap(i, EXAMPLE_TODAY)],
  ["BRAGLOG.md", (i) => bv.renderBraglog(i, EXAMPLE_TODAY)],
  ["portfolio.html", (i) => bv.renderHtml(i, EXAMPLE_TODAY, bv.portfolioName(ROOT))],
];

for (const [name, render] of VIEWS) {
  test(`example ${name} is up to date`, () => {
    const committed = readFileSync(join(ROOT, name), "utf8");
    assert.equal(committed, render(load()),
      `example/portfolio/${name} is stale — regenerate with:\n  ${REGEN}`);
  });
}

test("example exercises every board lane and roadmap group", () => {
  const items = load();
  const lanes = new Set([...items.values()].map((x) => bv.boardLane(x, items)));
  for (const lane of ["blocked", "ready", "active"]) assert.ok(lanes.has(lane), lane);
  const epics = [...items.values()].filter((x) => x.type === "epic");
  for (const st of ["done", "active", "future", "parked"]) {
    assert.ok(epics.some((e) => e.status === st), `an epic with status ${st}`);
  }
  const done = epics.filter((e) => e.status === "done");
  assert.ok(done.some((e) => bv.withinDays(bv.shipDate(e), EXAMPLE_TODAY, 30)),
    "a recently shipped epic");
  assert.ok(done.some((e) => !bv.withinDays(bv.shipDate(e), EXAMPLE_TODAY, 30)),
    "an epic shipped more than 30 days ago");
});
