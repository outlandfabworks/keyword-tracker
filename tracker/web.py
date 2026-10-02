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
from .config import DEFAULT_CONFIG, TIMEFRAMES, WEEKDAYS, Config, config_from_dict, normalize_term
from .geo import visible_regions
from .trends import MAX_TERMS_PER_REQUEST

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"
PHASES = {"discover": "Finding related searches", "interest": "Measuring search interest", "regions": "Looking up countries"}


def estimate_requests(cfg: Config) -> dict:
    """Rough request count and duration for one run, shown in the UI."""
    seeds = len(cfg.discovery.seeds)
    batches = math.ceil(max(cfg.discovery.max_candidates - 1, 1) / (MAX_TERMS_PER_REQUEST - 1))
    total = seeds + batches + cfg.ranking.top_n
    per = (cfg.rate_limit.min_delay_s + cfg.rate_limit.max_delay_s) / 2 + 3  # delay + request time
    return {"discover": seeds, "interest": batches, "regions": cfg.ranking.top_n,
            "requests": total, "seconds": round(total * per)}


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

    def __init__(self, db_path: Path, defaults_path: Path):
        self.db_path = db_path
        self.defaults_path = defaults_path
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
                           "done": 0, "total": 0, "detail": "", "started_at": db.now(), "cancelling": False}
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

    def _progress(self, phase: str, done: int, total: int, detail: str) -> None:
        from .pipeline import Cancelled

        if self._cancel.is_set():
            raise Cancelled()
        with self._lock:
            self._state.update(phase=phase, phase_label=PHASES.get(phase, phase), done=done, total=total, detail=detail)

    def _work(self) -> None:
        from .pipeline import run
        from .trends import TrendsClient

        conn = db.connect(self.db_path)
        try:
            cfg = db.get_config(conn, self.defaults_path)
            with self._lock:
                self._state["estimate"] = estimate_requests(cfg)
            client = TrendsClient(cfg.trends, cfg.regions, cfg.rate_limit)
            run(conn, cfg, client, self._progress)
        except Exception:
            log.exception("run failed")
        finally:
            conn.close()
            with self._lock:
                self._state = {"running": False}


class Scheduler(threading.Thread):
    """Checks once a minute; starts a run if the latest weekly slot has passed with no run since."""

    def __init__(self, manager: RunManager, interval_s: int = 60):
        super().__init__(name="scheduler", daemon=True)
        self.manager = manager
        self.interval_s = interval_s

    def due(self, conn: sqlite3.Connection, now: datetime) -> bool:
        s = db.get_config(conn, self.manager.defaults_path).schedule
        if not s.enabled:
            return False
        last = db.last_attempted_run(conn)
        # Any attempt (even a failed one) counts, so a failing run doesn't retry every minute.
        return last is None or parse_ts(last["started_at"]) < last_slot(now, s.weekday, s.hour)

    def run(self) -> None:
        time.sleep(15)  # let the server come up first
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


def create_app(db_path: Path, defaults_path: Path = DEFAULT_CONFIG, start_background: bool = True) -> Flask:
    app = Flask(__name__, static_folder=None)
    password = os.environ.get("KWT_PASSWORD", "")

    conn = db.connect(db_path)
    if n := db.mark_interrupted(conn):
        log.warning("marked %d interrupted run(s) as failed", n)
    db.get_config(conn, defaults_path)  # seed settings from config.toml on first boot
    conn.close()

    manager = RunManager(db_path, defaults_path)
    app.config["manager"] = manager
    if start_background:
        Scheduler(manager).start()

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

    def run_id_arg() -> int | None:
        if (rid := request.args.get("run", type=int)) is not None:
            return rid
        last = db.last_completed_run(g.db)
        return last["id"] if last else None

    def config() -> Config:
        return db.get_config(g.db, defaults_path)

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
        return jsonify(
            run=manager.state(),
            last_completed=rowdict(db.last_completed_run(g.db)),
            last_attempted=rowdict(db.last_attempted_run(g.db)),
            next_run=next_run,
            schedule={"enabled": s.enabled, "weekday": WEEKDAYS[s.weekday], "hour": s.hour},
            anchor=cfg.trends.anchor,
            geo=cfg.trends.geo,
            estimate=estimate_requests(cfg),
            pins=len(db.pinned_terms(g.db)),
        )

    @app.post("/api/runs")
    def start_run():
        if not manager.start("manual"):
            return jsonify(error="A refresh is already running."), 409
        return jsonify(ok=True), 202

    @app.post("/api/runs/cancel")
    def cancel_run():
        return jsonify(ok=manager.cancel())

    @app.get("/api/runs")
    def runs():
        return jsonify([dict(r) for r in db.list_runs(g.db)])

    # --- rankings & keywords ------------------------------------------------------

    @app.get("/api/ranking")
    def ranking():
        rid = run_id_arg()
        if rid is None:
            return jsonify(run=None, items=[])
        run = g.db.execute("SELECT * FROM runs WHERE id = ?", (rid,)).fetchone()
        if run is None:
            return jsonify(error="No such run."), 404
        rows = db.ranking_for_run(g.db, rid)
        prev = db.previous_completed_run(g.db, rid)
        prev_ranks = {r["term"]: r["rank"] for r in db.ranking_for_run(g.db, prev["id"])} if prev else {}
        series = db.series(g.db, rid, [r["term"] for r in rows])
        notes = {p["term"]: p["note"] for p in db.list_pins(g.db)}
        hide_small = config().regions.hide_small_countries
        items = []
        for r in rows:
            regions = visible_regions(db.regions_for(g.db, rid, r["term"]), run["geo"], hide_small)
            items.append({
                **dict(r),
                "prev_rank": prev_ranks.get(r["term"]),
                "series": [v for _, v in series[r["term"]]],
                "top_regions": [dict(x) for x in regions[:3]],
                "pinned_now": r["term"] in notes,
            })
        dates = next((([d for d, _ in s]) for s in series.values() if s), [])
        return jsonify(run=dict(run), prev_run_id=prev["id"] if prev else None, items=items, dates=dates)

    @app.get("/api/keyword")
    def keyword():
        term = normalize_term(request.args.get("term", ""))
        rid = run_id_arg()
        if not term or rid is None:
            return jsonify(error="Missing keyword."), 400
        run = g.db.execute("SELECT * FROM runs WHERE id = ?", (rid,)).fetchone()
        cand = g.db.execute("SELECT * FROM candidates WHERE run_id = ? AND term = ?", (rid, term)).fetchone()
        rank = g.db.execute("SELECT rank FROM rankings WHERE run_id = ? AND term = ?", (rid, term)).fetchone()
        series = db.series(g.db, rid, [term, run["anchor"]])
        pin = g.db.execute("SELECT * FROM pins WHERE term = ?", (term,)).fetchone()
        return jsonify(
            term=term,
            run=dict(run),
            candidate=rowdict(cand),
            rank=rank["rank"] if rank else None,
            dates=[d for d, _ in series[term]],
            values=[v for _, v in series[term]],
            anchor_values=[v for _, v in series[run["anchor"]]] if term != run["anchor"] else [],
            regions=[dict(r) for r in visible_regions(
                db.regions_for(g.db, rid, term), run["geo"], config().regions.hide_small_countries)],
            small_hidden=not run["geo"] and config().regions.hide_small_countries,
            region_kind="country" if not run["geo"] else "region",
            discovered_from=[dict(r) for r in db.discovered_from(g.db, rid, term)],
            history=[dict(r) for r in db.rank_history(g.db, term)],
            pin=rowdict(pin),
        )

    @app.get("/api/candidates")
    def candidates():
        rid = run_id_arg()
        if rid is None:
            return jsonify(run=None, items=[])
        run = g.db.execute("SELECT * FROM runs WHERE id = ?", (rid,)).fetchone()
        pins = db.pinned_terms(g.db)
        items = [{**dict(r), "pinned_now": r["term"] in pins} for r in db.candidates_for_run(g.db, rid)]
        return jsonify(run=rowdict(run), items=items)

    # --- pins ---------------------------------------------------------------------

    @app.get("/api/pins")
    def pins():
        rid = run_id_arg()
        ranks = {r["term"]: r["rank"] for r in db.ranking_for_run(g.db, rid)} if rid else {}
        return jsonify([{**dict(p), "rank": ranks.get(p["term"])} for p in db.list_pins(g.db)])

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
        return jsonify(config=cfg.to_dict(), timeframes=TIMEFRAMES, weekdays=WEEKDAYS, estimate=estimate_requests(cfg))

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


def serve(db_path: Path, defaults_path: Path, host: str, port: int) -> None:
    from waitress import serve as waitress_serve

    app = create_app(db_path, defaults_path)
    log.info("serving on http://%s:%d", host, port)
    waitress_serve(app, host=host, port=port, threads=8, ident="keyword-tracker")
