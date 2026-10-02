"""CLI: python -m tracker {serve,run,pin,unpin,pins,top}"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import db
from .config import DEFAULT_CONFIG, DEFAULT_DB, normalize_term


def cmd_run(args, conn) -> int:
    if args.if_stale is not None:
        last = db.last_completed_run(conn)
        if last:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(last["started_at"])
            if age < timedelta(days=args.if_stale):
                logging.info("last run %d is %s old (< %s days); skipping", last["id"], age, args.if_stale)
                return 0

    from .pipeline import run_markets  # deferred so pin/unpin work without importing pandas

    cfg = db.get_config(conn, args.config)
    for run_id in run_markets(conn, cfg):
        print_top(conn, run_id)
    return 0


def cmd_serve(args, conn) -> int:
    from .web import serve

    conn.close()
    serve(args.db, args.config, args.host, args.port)
    return 0


def cmd_pin(args, conn) -> int:
    for term in args.terms:
        added = db.pin(conn, term, args.note)
        print(f"{'pinned' if added else 'already pinned'}: {normalize_term(term)}")
    return 0


def cmd_unpin(args, conn) -> int:
    missing = 0
    for term in args.terms:
        if db.unpin(conn, term):
            print(f"unpinned: {term}")
        else:
            print(f"not pinned: {term}", file=sys.stderr)
            missing += 1
    return 1 if missing else 0


def cmd_pins(args, conn) -> int:
    rows = db.list_pins(conn)
    if not rows:
        print("no pinned keywords")
    for r in rows:
        print(f"{r['term']:<40} {r['pinned_at'][:10]}  {r['note'] or ''}")
    return 0


def print_top(conn, run_id: int) -> None:
    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    print(f"\nrun {run['id']}  {run['geo'] or 'worldwide'}  {run['started_at']}  status={run['status']}  anchor={run['anchor']!r}")
    print(f"{'#':>3}  {'keyword':<38} {'score':>6} {'volume':>8} {'momentum':>9}")
    for r in db.ranking_for_run(conn, run_id):
        fmt = lambda v, spec: format(v, spec) if v is not None else "-"
        pin = " 📌" if r["pinned"] else ""
        print(f"{r['rank']:>3}  {r['term'] + pin:<38} {fmt(r['score'], '6.3f'):>6} "
              f"{fmt(r['volume'], '8.2f'):>8} {fmt(r['momentum'], '+9.2f'):>9}")


def cmd_top(args, conn) -> int:
    run_id = args.run
    if run_id is None:
        last = db.last_completed_run(conn)
        if not last:
            print("no completed runs yet", file=sys.stderr)
            return 1
        run_id = last["id"]
    print_top(conn, run_id)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="tracker", description="Google Trends keyword tracker")
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="first-boot defaults")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    sv = sub.add_parser("serve", help="web UI + weekly scheduler (the container's main process)")
    sv.add_argument("--host", default="0.0.0.0")
    sv.add_argument("--port", type=int, default=8090)
    sv.set_defaults(fn=cmd_serve)

    r = sub.add_parser("run", help="discover, fetch, rank, and store a new snapshot")
    r.add_argument("--if-stale", type=float, metavar="DAYS",
                   help="only run if the last completed run is at least DAYS old")
    r.set_defaults(fn=cmd_run)

    pn = sub.add_parser("pin", help="always include these keywords in the ranked list")
    pn.add_argument("terms", nargs="+")
    pn.add_argument("--note")
    pn.set_defaults(fn=cmd_pin)

    up = sub.add_parser("unpin", help="remove pinned keywords")
    up.add_argument("terms", nargs="+")
    up.set_defaults(fn=cmd_unpin)

    sub.add_parser("pins", help="list pinned keywords").set_defaults(fn=cmd_pins)

    t = sub.add_parser("top", help="show the ranked list from a run (default: latest)")
    t.add_argument("--run", type=int)
    t.set_defaults(fn=cmd_top)

    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    conn = db.connect(args.db)
    try:
        return args.fn(args, conn)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
