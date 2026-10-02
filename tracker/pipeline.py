"""One full refresh: discover -> fetch interest -> score -> rank -> regions for the top N."""

from __future__ import annotations

import logging
import sqlite3
from itertools import zip_longest
from typing import Callable

from pytrends.exceptions import TooManyRequestsError

from . import db
from .config import Config
from .ranking import Scored, momentum, rank_groups, score_all
from .suggest import SuggestClient, SuggestRateLimited, prefixes
from .trends import MAX_TERMS_PER_REQUEST, Related, TrendsClient

log = logging.getLogger(__name__)


class RateLimited(Exception):
    """Google kept returning 429 after all retries; stop making requests this run."""


class Cancelled(Exception):
    """Raised by a progress callback to stop a run between requests."""


# progress(phase, done, total, detail). Phases: discover, interest, regions, ideas.
# Always called outside the per-request try blocks, so a Cancelled it raises propagates.
Progress = Callable[[str, int, int, str], None]


def _no_progress(phase: str, done: int, total: int, detail: str) -> None:
    pass


def build_pool(
    pins: set[str],
    seeds: list[str],
    related: dict[str, Related],
    rising_per_seed: int,
    top_per_seed: int,
    max_candidates: int,
    blocklist: list[str],
) -> dict[str, str]:
    """Ordered {term: source}. Pins and seeds always get in; discovered terms fill the rest.

    Discovered terms are interleaved across seeds (round-robin) so one busy seed
    can't take every slot, and rising terms go before top terms.
    """
    pool: dict[str, str] = {}
    for t in sorted(pins):
        pool[t] = "pin"
    for t in seeds:
        pool.setdefault(t, "seed")

    def blocked(term: str) -> bool:
        return any(b in term for b in blocklist)

    for kind, limit in (("rising", rising_per_seed), ("top", top_per_seed)):
        per_seed = [[q for q, _ in getattr(related[s], kind)[:limit]] for s in seeds if s in related]
        for row in zip_longest(*per_seed):
            for term in row:
                if len(pool) >= max_candidates:
                    return pool
                if term and term not in pool and not blocked(term):
                    pool[term] = kind
    return pool


def _discover(
    conn: sqlite3.Connection, client: TrendsClient, run_id: int, seeds: list[str], progress: Progress
) -> tuple[dict[str, Related], list[str]]:
    related: dict[str, Related] = {}
    errors = []
    for i, seed in enumerate(seeds):
        progress("discover", i, len(seeds), seed)
        try:
            rel = client.related(seed)
        except TooManyRequestsError as e:
            raise RateLimited(f"related({seed!r})") from e
        except Exception as e:  # pytrends raises a grab bag of errors on odd responses
            log.warning("related(%r) failed: %s", seed, e)
            errors.append(f"related({seed!r}): {e}")
            continue
        related[seed] = rel
        with conn:
            conn.executemany(
                "INSERT OR REPLACE INTO related_queries VALUES (?, ?, ?, ?, ?)",
                [(run_id, seed, "rising", q, v) for q, v in rel.rising]
                + [(run_id, seed, "top", q, v) for q, v in rel.top],
            )
        log.info("seed %r: %d rising, %d top", seed, len(rel.rising), len(rel.top))
    return related, errors


# A series whose raw 0-100 values average below this is mostly rounding noise.
LOW_RESOLUTION = 5.0


def _fetch_interest(
    conn: sqlite3.Connection, client: TrendsClient, cfg: Config, run_id: int, pool: dict[str, str], progress: Progress
) -> tuple[list[Scored], list[str], bool]:
    """Fetch every candidate in batches of (anchor + 4) and put them on the anchor's scale.

    Google scales each request so its biggest term peaks at 100, so a small term
    batched with a giant one comes back as 0s and 1s. Pass 2 re-fetches those
    terms grouped with similar-sized ones and keeps whichever series is sharper.

    Returns (items, errors, rate_limited). Items include failed terms with volume=None.
    """
    anchor = cfg.trends.anchor
    rk = cfg.ranking
    step = MAX_TERMS_PER_REQUEST - 1

    results: dict[str, Scored] = {}
    resolution: dict[str, float] = {}  # raw mean of the kept series; higher = less rounding noise
    errors: dict[str, str] = {}
    recheck: set[str] = set()
    rate_limited = False

    def keep(term: str, dates: list[str], raw: list[int], anchor_mean: float) -> None:
        res = sum(raw) / len(raw) if raw else 0.0
        if term in resolution and res <= resolution[term]:
            return
        scaled = [v / anchor_mean for v in raw]
        with conn:
            conn.execute("DELETE FROM interest WHERE run_id = ? AND term = ?", (run_id, term))
            conn.executemany(
                "INSERT INTO interest VALUES (?, ?, ?, ?, ?)",
                [(run_id, term, d, r, s) for d, r, s in zip(dates, raw, scaled)],
            )
        resolution[term] = res
        errors.pop(term, None)
        results[term] = Scored(
            term=term,
            volume=sum(scaled) / len(scaled) if scaled else 0.0,
            momentum=momentum(scaled, rk.recent_weeks, rk.baseline_weeks, rk.momentum_floor),
        )

    def fail(batch: list[str], msg: str) -> None:
        for t in batch:
            if t not in results:  # a pass-2 failure keeps the pass-1 data
                errors.setdefault(t, msg)

    def fetch(batches: list[list[str]], done_before: int, total: int) -> None:
        nonlocal rate_limited
        for i, batch in enumerate(batches):
            terms = [anchor] + batch
            progress("interest", done_before + i, total, ", ".join(batch))
            if rate_limited:
                fail(batch, "skipped: rate limited")
                continue
            try:
                ts = client.interest_over_time(terms)
            except TooManyRequestsError:
                log.error("rate limited for good; skipping remaining batches")
                rate_limited = True
                fail(batch, "rate limited")
                continue
            except Exception as e:
                log.warning("interest_over_time(%s) failed: %s", terms, e)
                fail(batch, str(e))
                continue

            means = {t: (sum(v) / len(v) if v else 0.0) for t, v in ts.values.items()}
            peak = max(means, key=means.get) if means else anchor
            anchor_mean = means.get(anchor, 0.0)
            if anchor_mean < 1:
                # One term is so much bigger than the anchor that the anchor rounded to ~0.
                for t in batch:
                    if t == peak:
                        errors.setdefault(t, f"over ~100x more popular than {anchor!r}, so it can't be measured against it")
                    else:
                        errors.setdefault(t, f"batched with {peak!r}, which drowned it out")
                        recheck.add(t)
                continue
            log.info("batch ok: %s", ", ".join(batch))
            keep(anchor, ts.dates, ts.values.get(anchor) or [], anchor_mean)
            for t in batch:
                keep(t, ts.dates, ts.values.get(t) or [], anchor_mean)
                if means.get(t, 0.0) < LOW_RESOLUTION and peak not in (anchor, t):
                    recheck.add(t)

    others = [t for t in pool if t != anchor]
    first = [others[i:i + step] for i in range(0, len(others), step)] or [[]]
    fetch(first, 0, len(first))

    # Pass 2: regroup the drowned-out terms by size so they're compared with their peers.
    todo = sorted(recheck, key=lambda t: results[t].volume if t in results else -1.0, reverse=True)
    if todo and not rate_limited:
        log.info("re-checking %d low-resolution keywords", len(todo))
        second = [todo[i:i + step] for i in range(0, len(todo), step)]
        fetch(second, len(first), len(first) + len(second))

    items = list(results.values())
    items += [Scored(term=t, volume=None, momentum=None) for t in pool if t not in results]
    for s in items:
        s.source = pool.get(s.term, "anchor")
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO candidates (run_id, term, source, volume, momentum, error) VALUES (?, ?, ?, ?, ?, ?)",
            [(run_id, s.term, pool.get(s.term, "anchor"), s.volume, s.momentum, errors.get(s.term)) for s in items],
        )
    return items, [f"{t}: {e}" for t, e in errors.items()], rate_limited


def _fetch_regions(
    conn: sqlite3.Connection, client: TrendsClient, run_id: int, top: list[Scored], progress: Progress
) -> list[str]:
    errors = []
    for i, s in enumerate(top):
        progress("regions", i, len(top), s.term)
        try:
            rows = client.interest_by_region(s.term)
        except TooManyRequestsError as e:
            raise RateLimited(f"interest_by_region({s.term!r})") from e
        except Exception as e:
            log.warning("interest_by_region(%r) failed: %s", s.term, e)
            errors.append(f"regions({s.term!r}): {e}")
            continue
        with conn:
            conn.executemany(
                "INSERT OR REPLACE INTO regions VALUES (?, ?, ?, ?, ?)",
                [(run_id, s.term, code, name, v) for code, name, v in rows],
            )
    return errors


def _save_ranking(conn: sqlite3.Connection, run_id: int, items: list[Scored], top: list[Scored]) -> None:
    with conn:
        conn.executemany(
            "UPDATE candidates SET score = ? WHERE run_id = ? AND term = ?",
            [(s.score, run_id, s.term) for s in items],
        )
        conn.executemany(
            "INSERT INTO rankings VALUES (?, ?, ?, ?, ?)",
            [(run_id, i, s.term, s.score, int(s.pinned)) for i, s in enumerate(top, 1)],
        )


def _collect_ideas(
    conn: sqlite3.Connection, suggester: SuggestClient, run_id: int, seeds: list[str], progress: Progress
) -> list[str]:
    """Autocomplete every seed + ' a'..' z'. Failures here never affect the rankings."""
    jobs = [(seed, p) for seed in seeds for p in prefixes(seed)]
    errors = []
    for i, (seed, prefix) in enumerate(jobs):
        progress("ideas", i, len(jobs), prefix.strip())
        try:
            found = suggester.complete(prefix)
        except SuggestRateLimited:
            errors.append(f"autocomplete rate limited at {prefix!r}; part ideas incomplete")
            break
        except Exception as e:
            log.warning("autocomplete(%r) failed: %s", prefix, e)
            errors.append(f"autocomplete({prefix!r}): {e}")
            continue
        with conn:
            conn.executemany(
                "INSERT OR IGNORE INTO suggestions VALUES (?, ?, ?, ?, ?)",
                [(run_id, seed, prefix.strip(), t, pos) for pos, t in enumerate(found)],
            )
    return errors


def run(
    conn: sqlite3.Connection,
    cfg: Config,
    client: TrendsClient,
    progress: Progress = _no_progress,
    suggester: SuggestClient | None = None,
) -> int:
    """One refresh for one market (cfg.trends.geo)."""
    run_id = db.start_run(conn, cfg.trends.anchor, cfg.trends.geo, cfg.trends.timeframe)
    errors: list[str] = []
    status = "ok"
    d = cfg.discovery
    try:
        pins = db.pinned_terms(conn)
        related, errs = _discover(conn, client, run_id, d.seeds, progress)
        errors += errs

        pool = build_pool(pins, d.seeds, related, d.rising_per_seed, d.top_per_seed, d.max_candidates, d.blocklist)
        log.info("candidate pool: %d terms (%d pinned)", len(pool), len(pins))

        items, errs, rate_limited = _fetch_interest(conn, client, cfg, run_id, pool, progress)
        errors += errs

        # Rank whatever we got, even if Google cut us off partway.
        score_all(items, cfg.ranking.volume_weight, cfg.ranking.momentum_weight)
        top = rank_groups(items, pins, cfg.ranking.top_n, group=cfg.ranking.group_similar)
        _save_ranking(conn, run_id, items, top)
        if not rate_limited:
            errors += _fetch_regions(conn, client, run_id, [s for s in top if s.score is not None], progress)
        if d.part_ideas and suggester is not None:
            errors += _collect_ideas(conn, suggester, run_id, d.seeds, progress)
        if rate_limited:
            raise RateLimited("interest_over_time")
        if errors:
            status = "partial"
    except RateLimited as e:
        status = "partial"
        errors.append(f"rate limited at {e}; run stopped early")
    except Cancelled:
        status = "cancelled"
        errors.append("cancelled by user")
    except Exception as e:
        status = "failed"
        errors.append(repr(e))
        raise
    finally:
        total = client.requests_made + (suggester.requests_made if suggester else 0)
        db.finish_run(conn, run_id, status, total, "\n".join(errors) or None)
        log.info("run %d (%s) finished: %s (%d requests)", run_id, cfg.trends.geo or "worldwide", status, total)
    return run_id


# make_clients(market_cfg) -> (TrendsClient, SuggestClient | None)
ClientFactory = Callable[[Config], "tuple[TrendsClient, SuggestClient | None]"]
# market_progress(market_index, market_count, geo, phase, done, total, detail)
MarketProgress = Callable[[int, int, str, str, int, int, str], None]


def default_clients(cfg: Config) -> tuple[TrendsClient, SuggestClient | None]:
    t = cfg.trends
    suggester = SuggestClient(t.hl, t.geo, cfg.rate_limit) if cfg.discovery.part_ideas else None
    return TrendsClient(t, cfg.regions, cfg.rate_limit), suggester


def run_markets(
    conn: sqlite3.Connection,
    cfg: Config,
    make_clients: ClientFactory = default_clients,
    progress: MarketProgress | None = None,
) -> list[int]:
    """A full refresh: one run per tracked market, in order. Stops early if a run is cancelled."""
    ids = []
    geos = cfg.trends.geos
    for i, geo in enumerate(geos):
        mcfg = cfg.for_market(geo)
        client, suggester = make_clients(mcfg)
        cb = (lambda ph, d, tot, det, i=i, geo=geo: progress(i, len(geos), geo, ph, d, tot, det)) if progress else _no_progress
        run_id = run(conn, mcfg, client, cb, suggester)
        ids.append(run_id)
        if conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()["status"] == "cancelled":
            break
    return ids
