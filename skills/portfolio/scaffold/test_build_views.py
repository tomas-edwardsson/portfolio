"""Tests for build_views.py. Run from portfolio/: python3 -m unittest test_build_views -v"""
import tempfile
import unittest
from pathlib import Path

import build_views as bv


def write_item(root, rel, **fm):
    body = fm.pop("body", "Some description.")
    lines = ["---"]
    for k, v in fm.items():
        lines.append(f"{k.replace('_', '-')}: {v}")
    lines.append("---")
    lines.append("")
    lines.append(body)
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def fixture(tmp):
    root = Path(tmp)
    write_item(root, "epics/2026-01-01-alpha/_epic.md", id="E01", type="epic",
               title="Alpha", status="active", horizon="now",
               body="Alpha epic summary line.")
    write_item(root, "epics/2026-01-01-alpha/2026-01-01-s1.md", id="S01",
               type="story", title="First story", status="active", epic="E01")
    write_item(root, "epics/2026-01-02-beta/_epic.md", id="E02", type="epic",
               title="Beta", status="future", horizon="next",
               body="Beta epic summary line that\ncontinues over two lines.")
    write_item(root, "epics/2026-01-02-beta/2026-01-02-s2.md", id="S02",
               type="story", title="Foundation", status="future", epic="E02")
    write_item(root, "epics/2026-01-02-beta/2026-01-02-s3.md", id="S03",
               type="story", title="Dependent", status="future", epic="E02",
               blocked_by="[S02]")
    write_item(root, "inbox/2026-01-03-idea.md", id="I01", type="idea",
               title="Loose idea", status="future", horizon="later",
               body="One-liner about the idea.")
    write_item(root, "inbox/2026-01-04-promoted.md", id="I02", type="idea",
               title="Old idea", status="promoted", promoted_to="E02")
    write_item(root, "inbox/2026-01-05-idea-next.md", id="I03", type="idea",
               title="Raised idea", status="future", horizon="next",
               body="Raised idea summary.")
    return root


class TestBuildViews(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = fixture(self.tmp.name)
        self.items, warns = bv.load_items(self.root)
        self.assertEqual(warns, [])

    def tearDown(self):
        self.tmp.cleanup()

    def test_idea_appears_in_later(self):
        roadmap = bv.render_roadmap(self.items, "2026-01-05")
        self.assertIn("[I01] Loose idea", roadmap)
        self.assertIn("One-liner about the idea.", roadmap)

    def test_next_horizon_idea_appears_in_next(self):
        roadmap = bv.render_roadmap(self.items, "2026-01-05")
        nxt = roadmap.index("## ⏭️ Next")
        later = roadmap.index("## 🌅 Later")
        self.assertIn("[I03] Raised idea 💡 — Raised idea summary.", roadmap)
        idx = roadmap.index("[I03] Raised idea")
        self.assertTrue(nxt < idx < later)
        # must not also appear after the Later heading
        self.assertNotIn("[I03]", roadmap[later:])
        # a horizon: later idea still lands in Later, after the heading
        self.assertTrue(later < roadmap.index("[I01] Loose idea"))

    def test_promoted_idea_hidden(self):
        roadmap = bv.render_roadmap(self.items, "2026-01-05")
        self.assertNotIn("I02", roadmap)

    def test_ships_after_rendered_for_pending_blocker(self):
        roadmap = bv.render_roadmap(self.items, "2026-01-05")
        board = bv.render_board(self.items, "2026-01-05")
        self.assertIn("after S02", roadmap)
        self.assertIn("after S02", board)

    def test_ships_after_dropped_when_blocker_done(self):
        self.items["S02"]["status"] = "done"
        roadmap = bv.render_roadmap(self.items, "2026-01-05")
        self.assertNotIn("after S02", roadmap)

    def test_unknown_blocked_by_warns(self):
        self.items["S03"]["blocked_by"] = ["S99"]
        warns = bv.validate(self.items)
        self.assertTrue(any("unknown blocked-by id S99" in w for w in warns))

    def test_cycle_warns(self):
        self.items["S02"]["blocked_by"] = ["S03"]
        warns = bv.validate(self.items)
        self.assertTrue(any("cycle" in w for w in warns))

    def test_now_next_later_sections(self):
        roadmap = bv.render_roadmap(self.items, "2026-01-05")
        # Roadmap is forward-only: no "Now" section, no active epics.
        self.assertNotIn("## 🎯 Now", roadmap)
        self.assertNotIn("[E01] Alpha", roadmap)
        nxt = roadmap.index("## ⏭️ Next")
        later = roadmap.index("## 🌅 Later")
        self.assertTrue(nxt < roadmap.index("[E02] Beta") < later)
        self.assertIn("Beta epic summary line that continues over two lines.",
                       roadmap)
        # Next should render every non-done story under its epic, not just
        # ones with a pending blocker — unblocked siblings must appear too.
        self.assertTrue(nxt < roadmap.index("[S02] Foundation") < later)
        dependent_idx = roadmap.index("[S03] Dependent")
        self.assertTrue(nxt < dependent_idx < later)
        self.assertIn("after S02", roadmap[dependent_idx:later])

    def test_idempotent(self):
        a = bv.render_roadmap(self.items, "2026-01-05")
        b = bv.render_roadmap(self.items, "2026-01-05")
        self.assertEqual(a, b)
        self.assertEqual(bv.render_board(self.items, "2026-01-05"),
                         bv.render_board(self.items, "2026-01-05"))

    def test_board_keeps_status_sections(self):
        board = bv.render_board(self.items, "2026-01-05")
        for heading in ("## ⛔ Blocked", "## 🎬 Ready for Dev", "## 🏃 Active", "## 🏆 Shipped"):
            self.assertIn(heading, board)
        self.assertIn("[S01] First story — E01 Alpha", board)

    def test_frontmatterless_file_skipped_silently(self):
        # A reference doc dropped into an epic folder with no frontmatter
        # block at all (e.g. a linked brief) must be ignored, not warned on.
        marker = "Sentinel text unique to the reference doc."
        path = self.root / "epics" / "2026-01-01-alpha" / "cost-analysis.md"
        path.write_text(f"# Cost Analysis\n\n{marker}\n", encoding="utf-8")

        items, warns = bv.load_items(self.root)

        self.assertEqual(warns, [])
        self.assertNotIn(marker, repr(items))
        ids = {it["id"] for it in items.values()}
        self.assertEqual(ids, set(self.items.keys()))

    def test_idea_horizon_now_warns(self):
        self.items["I01"]["horizon"] = "now"
        warns = bv.validate(self.items)
        self.assertTrue(
            any("I01" in w and "horizon" in w for w in warns), warns)

    def test_first_body_line_joins_paragraph(self):
        body = (
            "# Heading\n"
            "\n"
            "<!-- a comment -->\n"
            "First line of the paragraph\n"
            "continues on a second line\n"
            "and a third line.\n"
            "\n"
            "Second paragraph, must not be included.\n"
        )
        self.assertEqual(
            bv.first_body_line(body),
            "First line of the paragraph continues on a second line and a "
            "third line.",
        )

    def test_frontmatter_without_id_warns(self):
        # A file that *does* have a frontmatter block but omits `id` is a
        # malformed portfolio item, not a reference doc — must warn.
        path = self.root / "epics" / "2026-01-01-alpha" / "orphan.md"
        path.write_text(
            "---\ntype: task\ntitle: Orphan task\n---\n\nNo id set.\n",
            encoding="utf-8",
        )

        items, warns = bv.load_items(self.root)

        self.assertTrue(any("missing id" in w for w in warns), warns)
        self.assertNotIn("Orphan task", repr(items))

    def test_loads_updated_completed_story(self):
        self.assertIn("updated", self.items["S01"])
        self.assertIn("completed", self.items["S01"])
        self.assertIn("story", self.items["S01"])

    def test_ship_date_prefers_completed(self):
        it = {"completed": "2026-02-01", "updated": "2026-01-01"}
        self.assertEqual(bv.ship_date(it), "2026-02-01")
        self.assertEqual(bv.ship_date({"completed": "", "updated": "2026-01-01"}),
                         "2026-01-01")

    def test_is_parked_cascades_from_epic(self):
        self.items["E02"]["status"] = "parked"
        self.assertTrue(bv.is_parked(self.items["S02"], self.items))
        self.assertFalse(bv.is_parked(self.items["S01"], self.items))

    def test_within_days(self):
        self.assertTrue(bv.within_days("2026-01-20", "2026-02-01", 30))
        self.assertFalse(bv.within_days("2025-12-01", "2026-02-01", 30))
        self.assertFalse(bv.within_days("", "2026-02-01", 30))

    def test_active_epic_nonnow_horizon_no_warning(self):
        self.items["E01"]["horizon"] = "next"
        warns = bv.validate(self.items)
        self.assertFalse(any("expected now" in w for w in warns))

    def test_templates_have_no_inline_frontmatter_comments(self):
        # parse_frontmatter keeps everything after ':' as the value, so an
        # inline '# ...' comment on a value line poisons it (e.g. status
        # becomes "future    # future | active | ..."). Comments in templates
        # must be full lines, which the parser skips.
        tdir = Path(__file__).resolve().parent / "templates"
        for tpl in sorted(tdir.glob("*.md")):
            lines = tpl.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0].strip(), "---", tpl)
            for line in lines[1:]:
                if line.strip() == "---":
                    break
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                self.assertNotIn("#", line,
                                 f"{tpl.name}: inline comment on value line: {line!r}")

    def test_parked_status_is_valid(self):
        self.items["E01"]["status"] = "parked"
        warns = bv.validate(self.items)
        self.assertEqual([w for w in warns if "status" in w and "E01" in w], [])

    def test_board_lane_assignment(self):
        self.assertEqual(bv.board_lane(self.items["S01"], self.items), "active")
        self.assertEqual(bv.board_lane(self.items["S02"], self.items), "ready")
        self.assertEqual(bv.board_lane(self.items["S03"], self.items), "blocked")

    def test_board_done_story_not_a_card(self):
        self.items["S02"]["status"] = "done"
        self.assertIsNone(bv.board_lane(self.items["S02"], self.items))

    def test_board_parked_story_excluded(self):
        self.items["E02"]["status"] = "parked"
        self.assertIsNone(bv.board_lane(self.items["S02"], self.items))
        self.assertIsNone(bv.board_lane(self.items["S03"], self.items))

    def test_board_shipped_lane_recent_done_epic(self):
        self.items["E02"]["status"] = "done"
        self.items["E02"]["updated"] = "2026-06-20"
        board = bv.render_board(self.items, "2026-07-01")
        shipped = board.index("🏆 Shipped")
        self.assertIn("[E02]", board[shipped:])

    def test_board_shipped_excludes_old_done_epic(self):
        self.items["E02"]["status"] = "done"
        self.items["E02"]["updated"] = "2026-01-01"
        board = bv.render_board(self.items, "2026-07-01")
        shipped = board.index("🏆 Shipped")
        self.assertNotIn("[E02]", board[shipped:])

    def test_roadmap_excludes_active_epic(self):
        roadmap = bv.render_roadmap(self.items, "2026-07-01")
        self.assertNotIn("[E01]", roadmap)          # E01 is active
        self.assertNotIn("## 🎯 Now", roadmap)

    def test_roadmap_future_epic_in_next(self):
        roadmap = bv.render_roadmap(self.items, "2026-07-01")
        self.assertIn("[E02]", roadmap)             # E02 future, horizon next
        nxt = roadmap.index("## ⏭️ Next")
        self.assertIn("[E02]", roadmap[nxt:roadmap.index("## 🌅 Later")])

    def test_roadmap_uses_details_accordion(self):
        roadmap = bv.render_roadmap(self.items, "2026-07-01")
        self.assertIn("<details>", roadmap)
        self.assertIn("<summary>", roadmap)

    def test_roadmap_parked_section(self):
        self.items["E02"]["status"] = "parked"
        roadmap = bv.render_roadmap(self.items, "2026-07-01")
        parked = roadmap.index("## ⏸️ Parked")
        self.assertIn("[E02]", roadmap[parked:])
        # parked epic must not also appear under Next
        self.assertNotIn("[E02]", roadmap[:parked])

    def test_braglog_groups_and_orders(self):
        self.items["S01"]["status"] = "done"
        self.items["S01"]["updated"] = "2026-06-15"
        self.items["S02"]["status"] = "done"
        self.items["S02"]["updated"] = "2026-07-02"
        brag = bv.render_braglog(self.items, "2026-07-10")
        self.assertIn("## July 2026", brag)
        self.assertIn("## June 2026", brag)
        # newest month first
        self.assertLess(brag.index("## July 2026"), brag.index("## June 2026"))
        self.assertIn("[S01]", brag)
        self.assertIn("[S02]", brag)

    def test_braglog_excludes_dropped_and_open(self):
        self.items["S01"]["status"] = "dropped"
        brag = bv.render_braglog(self.items, "2026-07-10")
        self.assertNotIn("[S01]", brag)   # dropped
        self.assertNotIn("[S03]", brag)   # still future

    def test_braglog_uses_completed_override(self):
        self.items["S01"]["status"] = "done"
        self.items["S01"]["updated"] = "2026-01-01"
        self.items["S01"]["completed"] = "2026-07-05"
        brag = bv.render_braglog(self.items, "2026-07-10")
        self.assertIn("2026-07-05", brag)
        self.assertIn("## July 2026", brag)

    def test_html_has_three_tabs(self):
        htm = bv.render_html(self.items, "2026-07-10")
        self.assertIn('id="board"', htm)
        self.assertIn('id="roadmap"', htm)
        self.assertIn('id="braglog"', htm)
        self.assertIn('data-tab="board"', htm)

    def test_html_board_has_lanes_and_roadmap_details(self):
        htm = bv.render_html(self.items, "2026-07-10")
        self.assertIn("Ready for Dev", htm)
        self.assertIn("<details", htm)   # roadmap accordions

    def test_html_board_has_epic_rail(self):
        htm = bv.render_html(self.items, "2026-07-10")
        # left rail with an "All work" entry plus a per-epic nav + pane
        self.assertIn('class="rail"', htm)
        self.assertIn('data-epic-nav="all"', htm)
        self.assertIn('data-epic-nav="E01"', htm)   # active epic in fixture
        self.assertIn('data-epic="E01"', htm)       # its pane
        self.assertIn('data-epic="all"', htm)

    def test_html_rail_hides_epic_with_no_open_work(self):
        # Finish E01's only open story -> E01 has no open work -> drops from rail.
        self.items["S01"]["status"] = "done"
        htm = bv.render_html(self.items, "2026-07-10")
        self.assertNotIn('data-epic-nav="E01"', htm)
        self.assertNotIn('data-epic="E01"', htm)
        self.assertIn('data-epic-nav="all"', htm)   # All work still present

    def test_html_self_contained(self):
        htm = bv.render_html(self.items, "2026-07-10")
        self.assertNotIn("http://", htm)
        self.assertNotIn("https://", htm)  # fixture has no artifact links
        self.assertNotIn("<link", htm)


class TestFrontmatterQuotes(unittest.TestCase):
    def test_quoted_title_is_unquoted(self):
        fm, _ = bv.parse_frontmatter(
            '---\nid: S99\ntitle: "Decision: pick a policy"\n---\nbody\n')
        self.assertEqual(fm["title"], "Decision: pick a policy")

    def test_single_quotes_and_bare_values_untouched(self):
        fm, _ = bv.parse_frontmatter(
            "---\nid: S98\ntitle: 'Quoted single'\nstatus: future\n---\n")
        self.assertEqual(fm["title"], "Quoted single")
        self.assertEqual(fm["status"], "future")


class TestRenderHtml(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = fixture(self.tmp.name)
        self.items, warns = bv.load_items(self.root)
        self.assertEqual(warns, [])

    def tearDown(self):
        self.tmp.cleanup()

    def test_html_contains_both_views(self):
        html = bv.render_html(self.items, "2026-01-05")
        for token in ("Roadmap", "Board", "E01", "Alpha", "I01",
                      "Loose idea", "after S02", "2026-01-05"):
            self.assertIn(token, html)

    def test_html_escapes_titles(self):
        self.items["S01"]["title"] = 'Evil <script>alert(1)</script> & co'
        html = bv.render_html(self.items, "2026-01-05")
        self.assertNotIn("<script>alert", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("&amp; co", html)

    def test_html_idempotent(self):
        self.assertEqual(bv.render_html(self.items, "2026-01-05"),
                         bv.render_html(self.items, "2026-01-05"))

    def test_html_brief_link_relative_to_portfolio_dir(self):
        # Marks (brief/artifact links) on an epic only render in the roadmap
        # accordion, which lists future/parked epics — flip E01 to future so
        # its brief link actually appears somewhere in the tabbed HTML.
        self.items["E01"]["status"] = "future"
        self.items["E01"]["brief"] = "portfolio/epics/2026-01-01-alpha/brief.html"
        html = bv.render_html(self.items, "2026-01-05")
        self.assertIn('href="epics/2026-01-01-alpha/brief.html"', html)
        self.assertNotIn('href="portfolio/epics', html)


if __name__ == "__main__":
    unittest.main()
