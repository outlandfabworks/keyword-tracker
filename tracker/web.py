"""Web UI + JSON API, the weekly scheduler, and the background run worker, all in one process."""

from __future__ import annotations

import base64
import hmac
import logging
import math
import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_from_directory

from . import db
from .config import DEFAULT_CONFIG, MAX_MARKETS, TIMEFRAMES, WEEKDAYS, Config, config_from_dict, normalize_term
from .geo import visible_regions
from .ideas import Phrase, group_ideas
from .ranking import Scored, is_ignored, rank_groups
from .trends import MAX_TERMS_PER_REQUEST

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"
PHASES = {"discover": "Finding related searches", "interest": "Measuring search interest",
          "regions": "Looking up countries", "ideas": "Deep dive: collecting searches"}
PHASE_ORDER = ["discover", "interest", "regions", "ideas"]


def estimate_requests(cfg: Config) -> dict:
    """Rough request count and duration for a full refresh (every market), shown in the UI.

    `phases` is per market: {phase: {"requests": n, "seconds": s}}, used to weight the progress bar.
    """
    seeds = len(cfg.discovery.seeds)
    batches = math.ceil(max(cfg.discovery.max_candidates - 1, 1) / (MAX_TERMS_PER_REQUEST - 1)) + 2  # + re-checks
    trends_s = (cfg.rate_limit.min_delay_s + cfg.rate_limit.max_delay_s) / 2 + 3  # delay + request time
    ideas_s = 2.2
    counts = {"discover": seeds, "interest": batches, "regions": cfg.ranking.top_n,
              "ideas": seeds * 27 if cfg.discovery.part_ideas else 0}
    phases = {k: {"requests": n, "seconds": round(n * (ideas_s if k == "ideas" else trends_s))} for k, n in counts.items()}
    markets = len(cfg.trends.geos)
    return {"markets": markets, "phases": phases,
            "requests": markets * sum(counts.values()),
            "seconds": markets * sum(p["seconds"] for p in phases.values())}


def last_slot(now: datetime, weekday: int, hour: int) -> datetime:
    """Most recent scheduled moment at or before `now` (local time)."""
    slot = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    slot -= timedelta(days=(now.weekday() - weekday) % 7)
    if slot > now:
        slot -= timedelta(days=7)
    return slot


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s).astimezone()


class RunManager:
    """Owns the single background run; the UI polls state()."""

    def __init__(self, db_path: Path, defaults_path: Path, make_clients=None):
        self.db_path = db_path
        self.defaults_path = defaults_path
        self.make_clients = make_clients  # tests swap in fakes
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._state: dict = {"running": False}

    def state(self) -> dict:
        with self._lock:
            return dict(self._state)

    def start(self, trigger: str) -> bool:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return False
            self._cancel.clear()
            self._state = {"running": True, "trigger": trigger, "phase": "starting", "phase_label": "Starting",
                           "done": 0, "total": 0, "detail": "", "started_at": db.now(), "cancelling": False,
                           "market_index": 0, "market_count": 1, "market": ""}
            self._thread = threading.Thread(target=self._work, name="run", daemon=True)
            self._thread.start()
            return True

    def cancel(self) -> bool:
        with self._lock:
            if not self._state.get("running"):
                return False
            self._state["cancelling"] = True
        self._cancel.set()
        return True

    def _progress(self, index: int, count: int, geo: str, phase: str, done: int, total: int, detail: str) -> None:
        from .pipeline import Cancelled

        if self._cancel.is_set():
            raise Cancelled()
        with self._lock:
            self._state.update(market_index=index, market_count=count, market=geo, phase=phase,
                               phase_label=PHASES.get(phase, phase), done=done, total=total, detail=detail)

    def _work(self) -> None:
        from .pipeline import default_clients, run_markets

        conn = db.connect(self.db_path)
        try:
            cfg = db.get_config(conn, self.defaults_path)
            with self._lock:
                self._state["estimate"] = estimate_requests(cfg)
                self._state["market_count"] = len(cfg.trends.geos)
            run_markets(conn, cfg, self.make_clients or default_clients, self._progress)
        except Exception:
            log.exception("run failed")
        finally:
            conn.close()
            with self._lock:
                self._state = {"running": False}


class Scheduler(threading.Thread):
    """Checks once a minute; starts a run if the latest weekly slot has passed with no run since.

    With resume=True (the app was restarted mid-refresh), it first starts that refresh over.
    """

    def __init__(self, manager: RunManager, interval_s: int = 60, resume: bool = False):
        super().__init__(name="scheduler", daemon=True)
        self.manager = manager
        self.interval_s = interval_s
        self.resume = resume

    def due(self, conn: sqlite3.Connection, now: datetime) -> bool:
        s = db.get_config(conn, self.manager.defaults_path).schedule
        if not s.enabled:
            return False
        last = db.last_attempted_run(conn)
        # Any attempt (even a failed one) counts, so a failing run doesn't retry every minute.
        return last is None or parse_ts(last["started_at"]) < last_slot(now, s.weekday, s.hour)

    def run(self) -> None:
        time.sleep(15)  # let the server come up first
        if self.resume and self.manager.start("resume"):
            log.info("restarting the refresh that was interrupted by the restart")
        while True:
            try:
                conn = db.connect(self.manager.db_path)
                try:
                    if not self.manager.state()["running"] and self.due(conn, datetime.now().astimezone()):
                        log.info("scheduled run starting")
                        self.manager.start("schedule")
                finally:
                    conn.close()
            except Exception:
                log.exception("scheduler check failed")
            time.sleep(self.interval_s)


def rowdict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def market_code(geo: str) -> str:
    """URL/API code for a market: 'WW' for worldwide, else the country code."""
    return geo or "WW"


def scored_from_candidates(conn: sqlite3.Connection, run_id: int) -> list[Scored]:
    return [Scored(c["term"], c["volume"], c["momentum"], score=c["score"], source=c["source"])
            for c in db.candidates_for_run(conn, run_id)]


def display_ranking(conn: sqlite3.Connection, run_id: int, cfg: Config, pins: set[str]) -> list[dict]:
    """A run's list as it should look *now*: today's ignore list, pins, list size and grouping
    applied to everything that run measured. Editing any of those takes effect immediately.

    regions_fetched is False for keywords that weren't in the list when the run happened
    (their countries get looked up on the next refresh).
    """
    items = scored_from_candidates(conn, run_id)
    present = {s.term for s in items}
    heads = rank_groups(items, {p for p in pins if p in present}, cfg.ranking.top_n,
                        cfg.discovery.blocklist, cfg.ranking.group_similar)
    fetched = {r["term"] for r in db.ranking_for_run(conn, run_id)}
    brief = lambda s: {"term": s.term, "score": s.score, "volume": s.volume, "momentum": s.momentum, "source": s.source}
    return [{**brief(h), "rank": i, "pinned": h.pinned, "regions_fetched": h.term in fetched,
             "similar": [brief(m) for m in h.similar]}
            for i, h in enumerate(heads, 1)]


def rank_lookup(rows: list[dict]) -> dict[str, dict]:
    """term -> {rank, grouped_under}: heads map to themselves, folded variants to their head."""
    out = {}
    for r in rows:
        out[r["term"]] = {"rank": r["rank"], "grouped_under": None}
        for m in r["similar"]:
            out[m["term"]] = {"rank": r["rank"], "grouped_under": r["term"]}
    return out


def create_app(db_path: Path, defaults_path: Path = DEFAULT_CONFIG, start_background: bool = True) -> Flask:
    app = Flask(__name__, static_folder=None)
    password = os.environ.get("KWT_PASSWORD", "")
    desktop = os.environ.get("KWT_DESKTOP") == "1"  # running as the Windows/Mac app

    conn = db.connect(db_path)
    interrupted = db.mark_interrupted(conn)
    if interrupted:
        log.warning("marked %d interrupted run(s) as failed; will start a fresh refresh", interrupted)
    db.get_config(conn, defaults_path)  # seed settings from config.toml on first boot
    conn.close()

    manager = RunManager(db_path, defaults_path)
    app.config["manager"] = manager
    if start_background:
        Scheduler(manager, resume=bool(interrupted)).start()

    @app.before_request
    def auth():
        if not password or request.path == "/healthz":
            return None
        header = request.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                _, _, given = base64.b64decode(header[6:]).decode().partition(":")
                if hmac.compare_digest(given, password):
                    return None
            except Exception:
                pass
        return Response("Login required", 401, {"WWW-Authenticate": 'Basic realm="Keyword Tracker"'})

    @app.before_request
    def open_db():
        g.db = db.connect(db_path)

    @app.teardown_request
    def close_db(exc):
        if (c := g.pop("db", None)) is not None:
            c.close()

    @app.errorhandler(ValueError)
    def bad_value(e):
        return jsonify(error=str(e)), 400

    def config() -> Config:
        return db.get_config(g.db, defaults_path)

    def market() -> str:
        """Selected market from ?m= ('WW' = worldwide); defaults to the first tracked market."""
        m = request.args.get("m")
        if m is None:
            return config().trends.geos[0]
        return "" if m.upper() == "WW" else m.upper()

    def run_id_arg() -> int | None:
        if (rid := request.args.get("run", type=int)) is not None:
            return rid
        last = db.last_completed_run(g.db, market())
        return last["id"] if last else None

    def get_run(rid: int) -> sqlite3.Row:
        run = g.db.execute("SELECT * FROM runs WHERE id = ?", (rid,)).fetchone()
        if run is None:
            raise ValueError("No such snapshot.")
        return run

    # --- pages ------------------------------------------------------------------

    @app.get("/healthz")
    def healthz():
        return "ok"

    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(STATIC, name)

    # --- status & runs ------------------------------------------------------------

    @app.get("/api/status")
    def status():
        cfg = config()
        s = cfg.schedule
        now = datetime.now().astimezone()
        next_run = None
        if s.enabled:
            nxt = last_slot(now, s.weekday, s.hour) + timedelta(days=7)
            last = db.last_attempted_run(g.db)
            overdue = last is None or parse_ts(last["started_at"]) < last_slot(now, s.weekday, s.hour)
            next_run = now.isoformat() if overdue else nxt.isoformat()
        markets = [{"code": market_code(geo), "last_completed": rowdict(db.last_completed_run(g.db, geo))}
                   for geo in cfg.trends.geos]
        return jsonify(
            run=manager.state(),
            last_completed=rowdict(db.last_completed_run(g.db)),
            last_attempted=rowdict(db.last_attempted_run(g.db)),
            markets=markets,
            next_run=next_run,
            schedule={"enabled": s.enabled, "weekday": WEEKDAYS[s.weekday], "hour": s.hour},
            anchor=cfg.trends.anchor,
            desktop=desktop,
            estimate=estimate_requests(cfg),
            pins=len(db.pinned_terms(g.db)),
        )

    @app.post("/api/runs")
    def start_run():
        if not manager.start("manual"):
            return jsonify(error="A refresh is already running."), 409
        return jsonify(ok=True), 202

    @app.post("/api/quit")
    def quit_app():
        """Desktop app only: stop the program (the Mac app has no window to close)."""
        if not desktop:
            return jsonify(error="Only the desktop app can be quit from here."), 403
        manager.cancel()
        threading.Timer(0.5, os._exit, args=(0,)).start()
        return jsonify(ok=True)

    @app.post("/api/runs/cancel")
    def cancel_run():
        return jsonify(ok=manager.cancel())

    @app.get("/api/runs")
    def runs():
        return jsonify([{**dict(r), "market": market_code(r["geo"])} for r in db.list_runs(g.db)])

    # --- rankings & keywords ------------------------------------------------------

    @app.get("/api/ranking")
    def ranking():
        rid = run_id_arg()
        if rid is None:
            return jsonify(run=None, items=[])
        run = get_run(rid)
        cfg = config()
        pins = db.pinned_terms(g.db)
        rows = display_ranking(g.db, rid, cfg, pins)
        prev = db.previous_completed_run(g.db, rid)
        prev_ranks = {t: v["rank"] for t, v in rank_lookup(display_ranking(g.db, prev["id"], cfg, pins)).items()} if prev else {}
        series = db.series(g.db, rid, [r["term"] for r in rows])
        hide_small = cfg.regions.hide_small_countries
        items = []
        for r in rows:
            regions = visible_regions(db.regions_for(g.db, rid, r["term"]), run["geo"], hide_small)
            items.append({
                **r,
                "prev_rank": prev_ranks.get(r["term"]),
                "series": [v for _, v in series[r["term"]]],
                "top_regions": [dict(x) for x in regions[:3]],
                "pinned_now": r["term"] in pins,
            })
        return jsonify(run={**dict(run), "market": market_code(run["geo"])},
                       prev_run_id=prev["id"] if prev else None, items=items)

    @app.get("/api/keyword")
    def keyword():
        term = normalize_term(request.args.get("term", ""))
        rid = run_id_arg()
        if not term or rid is None:
            return jsonify(error="Missing keyword."), 400
        run = get_run(rid)
        cfg = config()
        cand = g.db.execute("SELECT * FROM candidates WHERE run_id = ? AND term = ?", (rid, term)).fetchone()
        rows = display_ranking(g.db, rid, cfg, db.pinned_terms(g.db))
        place = rank_lookup(rows).get(term)
        head = next((r for r in rows if r["term"] == term), None)
        series = db.series(g.db, rid, [term, run["anchor"]])
        pin = g.db.execute("SELECT * FROM pins WHERE term = ?", (term,)).fetchone()
        return jsonify(
            term=term,
            run={**dict(run), "market": market_code(run["geo"])},
            candidate=rowdict(cand),
            rank=place["rank"] if place else None,
            grouped_under=place["grouped_under"] if place else None,
            similar=head["similar"] if head else [],
            regions_fetched=head["regions_fetched"] if head else bool(db.regions_for(g.db, rid, term)),
            ignored=bool(cand) and is_ignored(term, cand["source"], cfg.discovery.blocklist),
            dates=[d for d, _ in series[term]],
            values=[v for _, v in series[term]],
            anchor_values=[v for _, v in series[run["anchor"]]] if term != run["anchor"] else [],
            regions=[dict(r) for r in visible_regions(
                db.regions_for(g.db, rid, term), run["geo"], cfg.regions.hide_small_countries)],
            small_hidden=not run["geo"] and cfg.regions.hide_small_countries,
            region_kind="country" if not run["geo"] else "region",
            discovered_from=[dict(r) for r in db.discovered_from(g.db, rid, term)],
            history=[dict(r) for r in db.rank_history(g.db, term, run["geo"])],
            pin=rowdict(pin),
        )

    @app.get("/api/candidates")
    def candidates():
        rid = run_id_arg()
        if rid is None:
            return jsonify(run=None, items=[])
        run = get_run(rid)
        cfg = config()
        pins = db.pinned_terms(g.db)
        places = rank_lookup(display_ranking(g.db, rid, cfg, pins))
        items = []
        for r in db.candidates_for_run(g.db, rid):
            place = places.get(r["term"], {})
            items.append({**dict(r), "rank": place.get("rank"), "grouped_under": place.get("grouped_under"),
                          "pinned_now": r["term"] in pins,
                          "ignored": is_ignored(r["term"], r["source"], cfg.discovery.blocklist)})
        return jsonify(run={**dict(run), "market": market_code(run["geo"])}, items=items)

    # --- deep dive (autocomplete) -----------------------------------------------------

    @app.get("/api/ideas")
    def ideas():
        cfg = config()
        geo = market()
        rid = request.args.get("run", type=int)
        run = get_run(rid) if rid else db.last_run_with_suggestions(g.db, geo)
        if run is None:
            return jsonify(run=None, seeds=[], enabled=cfg.discovery.part_ideas)
        seeds = db.suggestion_seeds(g.db, run["id"])
        seed = normalize_term(request.args.get("seed", "")) or (seeds[0] if seeds else "")
        prev = db.last_run_with_suggestions(g.db, run["geo"], before_id=run["id"])
        prev_terms = {r["term"] for r in db.suggestion_phrases(g.db, prev["id"], seed)} if prev else set()
        phrases = [Phrase(r["term"], r["position"], r["hits"], new=bool(prev) and r["term"] not in prev_terms)
                   for r in db.suggestion_phrases(g.db, run["id"], seed)]
        groups, singles, hidden = group_ideas(phrases, seed, [s for s in seeds if s != seed], cfg.discovery.blocklist)
        pins = db.pinned_terms(g.db)
        ph = lambda p: {"term": p.term, "position": p.position, "hits": p.hits, "new": p.new, "pinned": p.term in pins}
        return jsonify(
            run={**dict(run), "market": market_code(run["geo"])},
            enabled=cfg.discovery.part_ideas,
            has_previous=prev is not None,
            seeds=seeds,
            seed=seed,
            total=len(phrases),
            hidden=hidden,
            groups=[{"label": gr.label, "key": gr.key, "phrases": [ph(p) for p in gr.phrases]} for gr in groups],
            singles=[ph(p) for p in singles],
        )

    @app.post("/api/ignore")
    def add_ignore():
        """One-click 'Hide' from the Deep dive page: append a word to the ignore list."""
        word = normalize_term(str((request.get_json(force=True) or {}).get("word", "")))
        if not word:
            raise ValueError("Nothing to ignore.")
        cfg = config()
        if word not in cfg.discovery.blocklist:
            raw = cfg.to_dict()
            raw["discovery"]["blocklist"].append(word)
            db.save_config(g.db, config_from_dict(raw))
        return jsonify(word=word)

    @app.post("/api/ignore/undo")
    def undo_ignore():
        word = normalize_term(str((request.get_json(force=True) or {}).get("word", "")))
        raw = config().to_dict()
        raw["discovery"]["blocklist"] = [b for b in raw["discovery"]["blocklist"] if b != word]
        db.save_config(g.db, config_from_dict(raw))
        return jsonify(ok=True)

    # --- pins ---------------------------------------------------------------------

    @app.get("/api/pins")
    def pins():
        rid = run_id_arg()
        places = rank_lookup(display_ranking(g.db, rid, config(), db.pinned_terms(g.db))) if rid else {}
        return jsonify([{**dict(p), "rank": places.get(p["term"], {}).get("rank")} for p in db.list_pins(g.db)])

    @app.post("/api/pins")
    def add_pin():
        body = request.get_json(force=True) or {}
        term = normalize_term(str(body.get("term", "")))
        if len(term) > 100:
            raise ValueError("That keyword is too long.")
        note = (body.get("note") or "").strip() or None
        added = db.pin(g.db, term, note)
        return jsonify(term=term, added=added)

    @app.patch("/api/pins")
    def edit_pin():
        body = request.get_json(force=True) or {}
        term = normalize_term(str(body.get("term", "")))
        with g.db:
            cur = g.db.execute("UPDATE pins SET note = ? WHERE term = ?", ((body.get("note") or "").strip() or None, term))
        return jsonify(ok=cur.rowcount == 1)

    @app.delete("/api/pins")
    def remove_pin():
        body = request.get_json(force=True) or {}
        return jsonify(removed=db.unpin(g.db, str(body.get("term", ""))))

    # --- settings -----------------------------------------------------------------

    @app.get("/api/settings")
    def get_settings():
        cfg = config()
        return jsonify(config=cfg.to_dict(), timeframes=TIMEFRAMES, weekdays=WEEKDAYS, max_markets=MAX_MARKETS,
                       estimate=estimate_requests(cfg))

    @app.put("/api/settings")
    def put_settings():
        cfg = config_from_dict(request.get_json(force=True) or {})
        db.save_config(g.db, cfg)
        return jsonify(config=cfg.to_dict(), estimate=estimate_requests(cfg))

    @app.post("/api/settings/estimate")
    def estimate():
        try:
            cfg = config_from_dict(request.get_json(force=True) or {})
        except ValueError as e:
            return jsonify(error=str(e))
        return jsonify(estimate=estimate_requests(cfg))

    return app


def serve(db_path: Path, defaults_path: Path, host: str, port: int, schedule: bool = True) -> None:
    from waitress import serve as waitress_serve

    app = create_app(db_path, defaults_path, start_background=schedule)
    log.info("serving on http://%s:%d", host, port)
    waitress_serve(app, host=host, port=port, threads=8, ident="keyword-tracker")
