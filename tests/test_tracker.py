import math
import tempfile
import unittest
from pathlib import Path

from pytrends.exceptions import TooManyRequestsError

from tracker import db
from tracker.config import Config, DiscoverySettings, RankingSettings, RateLimitSettings, RegionSettings, TrendsSettings
from tracker.pipeline import build_pool, run
from tracker.ranking import Scored, momentum, percentile_ranks, score_all, select_top
from tracker.trends import Related, TimeSeries


class RankingTests(unittest.TestCase):
    def test_momentum_doubling_and_flat(self):
        flat = [10.0] * 16
        rising = [10.0] * 12 + [20.0] * 4
        self.assertAlmostEqual(momentum(flat, 4, 12, 0.0), 0.0)
        self.assertAlmostEqual(momentum(rising, 4, 12, 0.0), math.log(2))

    def test_momentum_floor_damps_tiny_terms(self):
        tiny = [0.0] * 12 + [0.01] * 4
        self.assertLess(momentum(tiny, 4, 12, 0.05), 0.2)

    def test_momentum_short_series(self):
        self.assertEqual(momentum([1.0, 2.0], 4, 12, 0.05), 0.0)

    def test_percentile_ranks_ties(self):
        self.assertEqual(percentile_ranks([5, 1, 5, 3]), [5 / 6, 0.0, 5 / 6, 1 / 3])
        self.assertEqual(percentile_ranks([7]), [1.0])

    def test_score_skips_missing(self):
        items = [Scored("a", 1.0, 0.1), Scored("b", 2.0, -0.1), Scored("c", None, None)]
        score_all(items, 0.5, 0.5)
        self.assertEqual([s.score for s in items], [0.5, 0.5, None])

    def test_select_top_keeps_pins(self):
        items = [Scored(f"t{i}", 0, 0, score=i / 10) for i in range(10)]
        items.append(Scored("low pin", 0, 0, score=-1.0))
        items.append(Scored("failed pin", None, None))
        top = select_top(items, {"low pin", "failed pin"}, top_n=4)
        self.assertEqual([s.term for s in top], ["t9", "t8", "low pin", "failed pin"])
        self.assertTrue(top[2].pinned)

    def test_select_top_more_pins_than_slots(self):
        items = [Scored(f"p{i}", 0, 0, score=i) for i in range(3)] + [Scored("x", 0, 0, score=99)]
        top = select_top(items, {"p0", "p1", "p2"}, top_n=2)
        self.assertEqual({s.term for s in top}, {"p0", "p1", "p2"})


class PoolTests(unittest.TestCase):
    def test_round_robin_blocklist_and_cap(self):
        related = {
            "a": Related(rising=[("a1", 500), ("a2", 300), ("a3", 100)], top=[("at", 100)]),
            "b": Related(rising=[("b1", 900), ("junk deal", 50)], top=[("bt", 100)]),
        }
        pool = build_pool({"pinned"}, ["a", "b"], related, 10, 1, 7, ["junk"])
        self.assertEqual(list(pool), ["pinned", "a", "b", "a1", "b1", "a2", "a3"])
        self.assertEqual(pool["pinned"], "pin")
        self.assertEqual(pool["a1"], "rising")

    def test_pins_and_seeds_exceed_cap(self):
        pool = build_pool({"p"}, ["a", "b"], {}, 10, 3, 1, [])
        self.assertEqual(list(pool), ["p", "a", "b"])


class PinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(Path(self.tmp.name) / "t.db")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_pin_unpin_normalizes(self):
        self.assertTrue(db.pin(self.conn, "  Tube   Bender ", note="core"))
        self.assertFalse(db.pin(self.conn, "tube bender"))
        self.assertEqual(db.pinned_terms(self.conn), {"tube bender"})
        self.assertEqual(db.list_pins(self.conn)[0]["note"], "core")
        self.assertTrue(db.unpin(self.conn, "TUBE BENDER"))
        self.assertFalse(db.unpin(self.conn, "tube bender"))

    def test_repin_updates_note(self):
        db.pin(self.conn, "x", note="old")
        db.pin(self.conn, "x", note="new")
        self.assertEqual(db.list_pins(self.conn)[0]["note"], "new")

    def test_empty_term_rejected(self):
        with self.assertRaises(ValueError):
            db.pin(self.conn, "   ")


class FakeClient:
    """Each term has a constant level, except 'hot' which jumps in the last 4 weeks."""

    LEVELS = {"anchor": 50, "seed1": 25, "hot": 10, "big": 100, "pinme": 5}

    def __init__(self, rate_limit_after=None):
        self.requests_made = 0
        self.rate_limit_after = rate_limit_after

    def _tick(self):
        self.requests_made += 1
        if self.rate_limit_after is not None and self.requests_made > self.rate_limit_after:
            raise TooManyRequestsError("429", None)

    def related(self, seed):
        self._tick()
        return Related(rising=[("hot", 5000)], top=[("big", 100)])

    def interest_over_time(self, terms):
        """Like Google: true levels rescaled so the batch's biggest value is 100, then rounded."""
        self._tick()
        self.batches = getattr(self, "batches", []) + [list(terms)]
        dates = [f"w{i}" for i in range(16)]
        true = {}
        for t in terms:
            lvl = self.LEVELS.get(t, 1)
            true[t] = [lvl] * 12 + [lvl * (3 if t == "hot" else 1)] * 4
        peak = max(max(v) for v in true.values())
        return TimeSeries(dates=dates, values={t: [round(x / peak * 100) for x in v] for t, v in true.items()})

    def interest_by_region(self, term):
        self._tick()
        return [("SH", "St. Helena", 100), ("CA", "Canada", 90), ("US", "United States", 80)]


def make_cfg(**ranking):
    return Config(
        trends=TrendsSettings(anchor="anchor"),
        discovery=DiscoverySettings(seeds=["seed1"], max_candidates=10),
        ranking=RankingSettings(top_n=3, **ranking),
        regions=RegionSettings(),
        rate_limit=RateLimitSettings(),
    )


class ResolutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(Path(self.tmp.name) / "t.db")
        self.run_id = db.start_run(self.conn, "anchor", "", "today 12-m")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def fetch(self, levels, pool):
        from tracker.pipeline import _fetch_interest
        client = FakeClient()
        client.LEVELS = {"anchor": 50, **levels}
        items, errors, _ = _fetch_interest(self.conn, client, make_cfg(), self.run_id, pool, lambda *a: None)
        return {i.term: i for i in items}, errors, client

    def test_drowned_term_is_refetched_with_peers(self):
        # big2 is 40x the anchor: in batch 1 tiny rounds to 0; pass 2 measures it properly.
        got, _, client = self.fetch({"big2": 2000, "tiny": 3}, {"big2": "seed", "tiny": "rising"})
        self.assertEqual(len(client.batches), 2)
        self.assertEqual(client.batches[1], ["anchor", "tiny"])
        self.assertAlmostEqual(got["tiny"].volume, 0.06, places=2)
        self.assertAlmostEqual(got["big2"].volume, 40, delta=10)   # coarse, but measured

    def test_giant_term_reported_and_neighbours_rescued(self):
        got, errors, _ = self.fetch({"giant": 100000, "tiny": 3}, {"giant": "seed", "tiny": "rising"})
        self.assertIsNone(got["giant"].volume)
        self.assertTrue(any("giant" in e and "100x" in e for e in errors))
        self.assertAlmostEqual(got["tiny"].volume, 0.06, places=2)
        self.assertFalse(any(e.startswith("tiny:") for e in errors))

    def test_no_recheck_when_anchor_is_biggest(self):
        _, _, client = self.fetch({"tiny": 1}, {"tiny": "rising"})
        self.assertEqual(len(client.batches), 1)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(Path(self.tmp.name) / "t.db")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_full_run(self):
        db.pin(self.conn, "pinme")
        run_id = run(self.conn, make_cfg(), FakeClient())

        r = self.conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        self.assertEqual(r["status"], "ok")

        cands = {c["term"]: c for c in self.conn.execute("SELECT * FROM candidates WHERE run_id = ?", (run_id,))}
        # pool = pin + seed + discovered + anchor (anchor is always fetched)
        self.assertEqual(set(cands), {"pinme", "seed1", "hot", "big", "anchor"})
        self.assertAlmostEqual(cands["big"]["volume"], 2.0)       # 100 / 50
        self.assertAlmostEqual(cands["anchor"]["volume"], 1.0)
        self.assertGreater(cands["hot"]["momentum"], 0.5)

        ranked = [x["term"] for x in db.ranking_for_run(self.conn, run_id)]
        self.assertEqual(len(ranked), 3)
        self.assertIn("pinme", ranked)          # lowest volume, still listed
        self.assertIn("hot", ranked)            # momentum wins it a slot

        region_terms = {x["term"] for x in self.conn.execute("SELECT term FROM regions WHERE run_id = ?", (run_id,))}
        self.assertEqual(region_terms, set(ranked))   # regions only for the top N

    def test_rate_limited_is_partial_but_ranked(self):
        # discovery + the one interest batch succeed, then 429 forever on regions
        run_id = run(self.conn, make_cfg(), FakeClient(rate_limit_after=2))
        r = self.conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        self.assertEqual(r["status"], "partial")
        self.assertIn("rate limited", r["error"])
        self.assertTrue(db.ranking_for_run(self.conn, run_id))
        self.assertIsNotNone(db.last_completed_run(self.conn))


if __name__ == "__main__":
    unittest.main()


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(Path(self.tmp.name) / "t.db")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_seeded_from_toml_then_db_wins(self):
        toml = Path(self.tmp.name) / "c.toml"
        toml.write_text('[trends]\nanchor = "Jeep  Wrangler"\n[discovery]\nseeds = ["A", "a", "b"]\n')
        cfg = db.get_config(self.conn, toml)
        self.assertEqual(cfg.trends.anchor, "jeep wrangler")
        self.assertEqual(cfg.discovery.seeds, ["a", "b"])        # normalized + deduped
        toml.write_text('[discovery]\nseeds = ["ignored"]\n')
        self.assertEqual(db.get_config(self.conn, toml).discovery.seeds, ["a", "b"])

    def test_validation(self):
        from tracker.config import config_from_dict
        with self.assertRaises(ValueError):
            config_from_dict({"discovery": {"seeds": []}})
        with self.assertRaises(ValueError):
            config_from_dict({"discovery": {"seeds": ["x"]}, "trends": {"geo": "USA"}})
        with self.assertRaises(ValueError):
            config_from_dict({"discovery": {"seeds": ["x"]}, "ranking": {"volume_weight": 0, "momentum_weight": 0}})
        cfg = config_from_dict({"discovery": {"seeds": ["x"]}, "trends": {"geo": "ca"}, "unknown": 1})
        self.assertEqual(cfg.trends.region_resolution, "REGION")
        self.assertEqual(cfg.trends.geo, "CA")


class ScheduleTests(unittest.TestCase):
    def test_last_slot(self):
        from datetime import datetime
        from tracker.web import last_slot
        wed = datetime(2026, 9, 30, 10, 0)                   # a Wednesday
        self.assertEqual(last_slot(wed, 0, 4), datetime(2026, 9, 28, 4, 0))   # Monday before
        self.assertEqual(last_slot(wed, 2, 4), datetime(2026, 9, 30, 4, 0))   # earlier today
        self.assertEqual(last_slot(wed, 2, 11), datetime(2026, 9, 23, 11, 0))  # later today -> last week

    def test_due(self):
        from datetime import datetime, timedelta
        from tracker.web import RunManager, Scheduler
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        conn = db.connect(Path(tmp.name) / "t.db")
        self.addCleanup(conn.close)
        db.save_config(conn, make_cfg())
        sched = Scheduler(RunManager(Path(tmp.name) / "t.db", Path("/nonexistent")))
        now = datetime.now().astimezone()
        self.assertTrue(sched.due(conn, now))                 # never run
        db.start_run(conn, "a", "", "today 12-m")             # attempted just now
        self.assertFalse(sched.due(conn, now))
        self.assertTrue(sched.due(conn, now + timedelta(days=8)))


class ResumeTests(unittest.TestCase):
    def test_restart_mid_run_resumes(self):
        from unittest import mock
        from tracker.web import Scheduler, create_app
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "t.db"
        conn = db.connect(path)
        db.save_config(conn, make_cfg())
        db.start_run(conn, "anchor", "", "today 12-m")      # left 'running' by a "crash"
        conn.close()
        with mock.patch.object(Scheduler, "start") as start, mock.patch("tracker.web.Scheduler.__init__", return_value=None) as init:
            create_app(path, Path("/nonexistent"))
        self.assertTrue(init.call_args.kwargs["resume"])
        start.assert_called_once()
        conn = db.connect(path)
        self.addCleanup(conn.close)
        self.assertEqual(db.last_attempted_run(conn)["status"], "failed")


class ApiTests(unittest.TestCase):
    def setUp(self):
        from tracker.web import create_app
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "t.db"
        conn = db.connect(path)
        db.save_config(conn, make_cfg())
        db.pin(conn, "pinme")
        self.run_id = run(conn, make_cfg(), FakeClient())
        conn.close()
        self.client = create_app(path, Path("/nonexistent"), start_background=False).test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_endpoints(self):
        c = self.client
        st = c.get("/api/status").get_json()
        self.assertFalse(st["run"]["running"])
        self.assertEqual(st["last_completed"]["id"], self.run_id)

        rk = c.get("/api/ranking").get_json()
        self.assertEqual(len(rk["items"]), 3)
        self.assertEqual(len(rk["items"][0]["series"]), 16)

        kw = c.get("/api/keyword?term=Hot").get_json()
        self.assertEqual(kw["discovered_from"][0]["seed"], "seed1")
        self.assertEqual(len(kw["anchor_values"]), 16)
        self.assertEqual([r["geo_code"] for r in kw["regions"]], ["CA", "US"])   # St. Helena hidden
        s = c.get("/api/settings").get_json()["config"]
        s["regions"]["hide_small_countries"] = False
        c.put("/api/settings", json=s)
        self.assertEqual(c.get("/api/keyword?term=hot").get_json()["regions"][0]["geo_code"], "SH")

        self.assertEqual(len(c.get("/api/candidates").get_json()["items"]), 5)

        self.assertTrue(c.post("/api/pins", json={"term": "New One"}).get_json()["added"])
        self.assertTrue(c.patch("/api/pins", json={"term": "new one", "note": "hi"}).get_json()["ok"])
        self.assertTrue(c.delete("/api/pins", json={"term": "new one"}).get_json()["removed"])
        self.assertEqual(c.post("/api/pins", json={"term": "  "}).status_code, 400)

        s = c.get("/api/settings").get_json()["config"]
        s["discovery"]["seeds"] = ["x", "y"]
        self.assertEqual(c.put("/api/settings", json=s).status_code, 200)
        self.assertEqual(c.get("/api/settings").get_json()["config"]["discovery"]["seeds"], ["x", "y"])
        s["discovery"]["seeds"] = []
        self.assertEqual(c.put("/api/settings", json=s).status_code, 400)

        self.assertEqual(c.get("/").status_code, 200)
        self.assertEqual(c.get("/static/app.js").status_code, 200)

    def test_ignore_list_applies_immediately(self):
        c = self.client
        before = [i["term"] for i in c.get("/api/ranking").get_json()["items"]]
        self.assertIn("hot", before)
        s = c.get("/api/settings").get_json()["config"]
        s["discovery"]["blocklist"] = ["hot", "seed", "pin"]   # seeds and pins are exempt
        c.put("/api/settings", json=s)

        items = c.get("/api/ranking").get_json()["items"]
        terms = [i["term"] for i in items]
        self.assertNotIn("hot", terms)
        self.assertEqual(len(items), len(before))               # gap filled from the pool
        self.assertIn("pinme", terms)                            # pins are never hidden
        self.assertEqual([i["rank"] for i in items], list(range(1, len(items) + 1)))
        filled = [i for i in items if i["term"] not in before]
        self.assertEqual(len(filled), 1)
        self.assertFalse(filled[0]["regions_fetched"])
        self.assertEqual(filled[0]["top_regions"], [])

        cands = {i["term"]: i for i in c.get("/api/candidates").get_json()["items"]}
        self.assertTrue(cands["hot"]["ignored"])
        self.assertIsNone(cands["hot"]["rank"])
        self.assertFalse(cands["seed1"]["ignored"])
        self.assertTrue(c.get("/api/keyword?term=hot").get_json()["ignored"])

    def test_password(self):
        import base64, os
        from tracker.web import create_app
        os.environ["KWT_PASSWORD"] = "s3cret"
        try:
            c = create_app(Path(self.tmp.name) / "t.db", Path("/nonexistent"), start_background=False).test_client()
        finally:
            del os.environ["KWT_PASSWORD"]
        self.assertEqual(c.get("/api/status").status_code, 401)
        self.assertEqual(c.get("/healthz").status_code, 200)
        auth = {"Authorization": "Basic " + base64.b64encode(b"any:s3cret").decode()}
        self.assertEqual(c.get("/api/status", headers=auth).status_code, 200)
