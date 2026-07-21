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
