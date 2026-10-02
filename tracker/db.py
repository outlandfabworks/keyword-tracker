"""SQLite storage: run history, raw observations, rankings, regions, and pins."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import DEFAULT_CONFIG, Config, config_from_dict, load_toml_defaults, normalize_term

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT NOT NULL DEFAULT 'running',   -- running | ok | partial | failed | cancelled
    anchor        TEXT NOT NULL,
    geo           TEXT NOT NULL,
    timeframe     TEXT NOT NULL,
    requests_made INTEGER,
    error         TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL              -- JSON
);

CREATE TABLE IF NOT EXISTS pins (
    term       TEXT PRIMARY KEY,
    pinned_at  TEXT NOT NULL,
    note       TEXT
);

-- Every related query Google suggested for a seed, kept or not.
CREATE TABLE IF NOT EXISTS related_queries (
    run_id  INTEGER NOT NULL REFERENCES runs(id),
    seed    TEXT NOT NULL,
    kind    TEXT NOT NULL,          -- rising | top
    term    TEXT NOT NULL,
    value   INTEGER,
    PRIMARY KEY (run_id, seed, kind, term)
);

-- One row per candidate per run: the whole pool, not just the top N.
CREATE TABLE IF NOT EXISTS candidates (
    run_id    INTEGER NOT NULL REFERENCES runs(id),
    term      TEXT NOT NULL,
    source    TEXT NOT NULL,        -- pin | seed | rising | top
    volume    REAL,                 -- mean interest relative to the anchor (anchor = 1.0)
    momentum  REAL,
    score     REAL,
    error     TEXT,
    PRIMARY KEY (run_id, term)
);

-- Anchor-scaled weekly interest for every candidate.
CREATE TABLE IF NOT EXISTS interest (
    run_id  INTEGER NOT NULL REFERENCES runs(id),
    term    TEXT NOT NULL,
    date    TEXT NOT NULL,
    raw     INTEGER NOT NULL,       -- as returned, relative within its batch
    scaled  REAL,                   -- raw / mean(anchor in same batch)
    PRIMARY KEY (run_id, term, date)
);

CREATE TABLE IF NOT EXISTS rankings (
    run_id  INTEGER NOT NULL REFERENCES runs(id),
    rank    INTEGER NOT NULL,
    term    TEXT NOT NULL,
    score   REAL,
    pinned  INTEGER NOT NULL,
    PRIMARY KEY (run_id, rank)
);

-- Google autocomplete phrases per seed (the Deep dive tab).
CREATE TABLE IF NOT EXISTS suggestions (
    run_id    INTEGER NOT NULL REFERENCES runs(id),
    seed      TEXT NOT NULL,
    prefix    TEXT NOT NULL,        -- what was typed: "alh i"
    term      TEXT NOT NULL,
    position  INTEGER NOT NULL,     -- 0 = first suggestion
    PRIMARY KEY (run_id, seed, prefix, term)
);

CREATE TABLE IF NOT EXISTS regions (
    run_id    INTEGER NOT NULL REFERENCES runs(id),
    term      TEXT NOT NULL,
    geo_code  TEXT NOT NULL,
    name      TEXT NOT NULL,
    value     INTEGER NOT NULL,     -- 0-100, 100 = this term's strongest region
    PRIMARY KEY (run_id, term, geo_code)
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


# --- settings ---------------------------------------------------------------

def get_config(conn: sqlite3.Connection, defaults_path: Path = DEFAULT_CONFIG) -> Config:
    """Settings saved from the UI; on first use, seeded from config.toml."""
    row = conn.execute("SELECT value FROM settings WHERE key = 'config'").fetchone()
    if row:
        return config_from_dict(json.loads(row["value"]))
    cfg = load_toml_defaults(defaults_path)
    save_config(conn, cfg)
    return cfg


def save_config(conn: sqlite3.Connection, cfg: Config) -> None:
    with conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('config', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (json.dumps(cfg.to_dict()),),
        )


# --- pins -------------------------------------------------------------------

def pin(conn: sqlite3.Connection, term: str, note: str | None = None) -> bool:
    """Returns False if the term was already pinned (note is updated if given)."""
    term = normalize_term(term)
    if not term:
        raise ValueError("empty term")
    with conn:
        cur = conn.execute(
            "INSERT INTO pins (term, pinned_at, note) VALUES (?, ?, ?) ON CONFLICT(term) DO NOTHING",
            (term, now(), note),
        )
        if cur.rowcount == 0 and note is not None:
            conn.execute("UPDATE pins SET note = ? WHERE term = ?", (note, term))
    return cur.rowcount == 1


def unpin(conn: sqlite3.Connection, term: str) -> bool:
    with conn:
        cur = conn.execute("DELETE FROM pins WHERE term = ?", (normalize_term(term),))
    return cur.rowcount == 1


def list_pins(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT term, pinned_at, note FROM pins ORDER BY term").fetchall()


def pinned_terms(conn: sqlite3.Connection) -> set[str]:
    return {r["term"] for r in conn.execute("SELECT term FROM pins")}


# --- runs -------------------------------------------------------------------

def start_run(conn: sqlite3.Connection, anchor: str, geo: str, timeframe: str) -> int:
    with conn:
        cur = conn.execute(
            "INSERT INTO runs (started_at, anchor, geo, timeframe) VALUES (?, ?, ?, ?)",
            (now(), anchor, geo, timeframe),
        )
    return cur.lastrowid


def finish_run(conn: sqlite3.Connection, run_id: int, status: str, requests_made: int, error: str | None = None) -> None:
    with conn:
        conn.execute(
            "UPDATE runs SET finished_at = ?, status = ?, requests_made = ?, error = ? WHERE id = ?",
            (now(), status, requests_made, error, run_id),
        )


def mark_interrupted(conn: sqlite3.Connection) -> int:
    """Runs left 'running' by a container restart will never finish; close them out."""
    with conn:
        cur = conn.execute(
            "UPDATE runs SET status = 'failed', finished_at = ?, "
            "error = COALESCE(error || char(10), '') || 'interrupted (app restarted mid-run); a new refresh starts automatically' "
            "WHERE status = 'running'",
            (now(),),
        )
    return cur.rowcount


def last_attempted_run(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()


def last_completed_run(conn: sqlite3.Connection, geo: str | None = None) -> sqlite3.Row | None:
    """Latest usable run, optionally for one market ("" = worldwide)."""
    if geo is None:
        return conn.execute(
            "SELECT * FROM runs WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return conn.execute(
        "SELECT * FROM runs WHERE status IN ('ok', 'partial') AND geo = ? ORDER BY id DESC LIMIT 1", (geo,)
    ).fetchone()


def ranking_for_run(conn: sqlite3.Connection, run_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT r.rank, r.term, r.score, r.pinned, c.volume, c.momentum, c.source
           FROM rankings r LEFT JOIN candidates c USING (run_id, term)
           WHERE r.run_id = ? ORDER BY r.rank""",
        (run_id,),
    ).fetchall()


def previous_completed_run(conn: sqlite3.Connection, run_id: int) -> sqlite3.Row | None:
    """The usable run before `run_id` for the same market."""
    return conn.execute(
        """SELECT * FROM runs WHERE status IN ('ok', 'partial') AND id < ?
           AND geo = (SELECT geo FROM runs WHERE id = ?) ORDER BY id DESC LIMIT 1""",
        (run_id, run_id),
    ).fetchone()


def list_runs(conn: sqlite3.Connection, limit: int = 100) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT r.*,
                  (SELECT COUNT(*) FROM candidates c WHERE c.run_id = r.id) AS candidates,
                  (SELECT COUNT(*) FROM rankings k WHERE k.run_id = r.id) AS ranked
           FROM runs r ORDER BY r.id DESC LIMIT ?""",
        (limit,),
    ).fetchall()


def series(conn: sqlite3.Connection, run_id: int, terms: list[str]) -> dict[str, list[tuple[str, float]]]:
    out: dict[str, list[tuple[str, float]]] = {t: [] for t in terms}
    if not terms:
        return out
    q = ",".join("?" * len(terms))
    for r in conn.execute(
        f"SELECT term, date, scaled FROM interest WHERE run_id = ? AND term IN ({q}) ORDER BY date",
        (run_id, *terms),
    ):
        out[r["term"]].append((r["date"], r["scaled"]))
    return out


def regions_for(conn: sqlite3.Connection, run_id: int, term: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT geo_code, name, value FROM regions WHERE run_id = ? AND term = ? ORDER BY value DESC, name",
        (run_id, term),
    ).fetchall()


def candidates_for_run(conn: sqlite3.Connection, run_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT c.*, k.rank FROM candidates c
           LEFT JOIN rankings k ON k.run_id = c.run_id AND k.term = c.term
           WHERE c.run_id = ? ORDER BY c.score IS NULL, c.score DESC, c.term""",
        (run_id,),
    ).fetchall()


def discovered_from(conn: sqlite3.Connection, run_id: int, term: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT seed, kind, value FROM related_queries WHERE run_id = ? AND term = ? ORDER BY kind DESC, value DESC",
        (run_id, term),
    ).fetchall()


def rank_history(conn: sqlite3.Connection, term: str, geo: str, limit: int = 26) -> list[sqlite3.Row]:
    """Rank and score of a term across recent completed runs in one market (unranked runs give rank NULL)."""
    return conn.execute(
        """SELECT r.id AS run_id, r.started_at, k.rank, c.score, c.volume, c.momentum
           FROM runs r
           LEFT JOIN rankings k ON k.run_id = r.id AND k.term = ?
           LEFT JOIN candidates c ON c.run_id = r.id AND c.term = ?
           WHERE r.status IN ('ok', 'partial') AND r.geo = ?
           ORDER BY r.id DESC LIMIT ?""",
        (term, term, geo, limit),
    ).fetchall()


def suggestion_phrases(conn: sqlite3.Connection, run_id: int, seed: str) -> list[sqlite3.Row]:
    """One row per distinct phrase: best position and how many prefixes surfaced it."""
    return conn.execute(
        """SELECT term, MIN(position) AS position, COUNT(*) AS hits FROM suggestions
           WHERE run_id = ? AND seed = ? GROUP BY term""",
        (run_id, seed),
    ).fetchall()


def suggestion_seeds(conn: sqlite3.Connection, run_id: int) -> list[str]:
    return [r["seed"] for r in conn.execute(
        "SELECT seed, MIN(rowid) AS first FROM suggestions WHERE run_id = ? GROUP BY seed ORDER BY first", (run_id,))]


def last_run_with_suggestions(conn: sqlite3.Connection, geo: str, before_id: int | None = None) -> sqlite3.Row | None:
    """Latest run in a market that collected deep-dive searches (optionally before a given run)."""
    return conn.execute(
        """SELECT r.* FROM runs r WHERE r.geo = ? AND r.id < ? AND r.status IN ('ok', 'partial', 'cancelled')
           AND EXISTS (SELECT 1 FROM suggestions s WHERE s.run_id = r.id) ORDER BY r.id DESC LIMIT 1""",
        (geo, before_id if before_id is not None else 2**62),
    ).fetchone()
