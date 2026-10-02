"""Desktop launcher for the Windows and Mac apps.

Double-clicking the app runs the tracker on this computer only (127.0.0.1) and
opens it in the default browser. Data lives in the user's app-data folder.
Opening the app again while it's running just reopens the browser tab.
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "Keyword Tracker"
DEFAULT_PORT = 8090


def data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "KeywordTracker"


def bundled(name: str) -> Path:
    """A file shipped inside the app (PyInstaller unpacks them to sys._MEIPASS)."""
    base = getattr(sys, "_MEIPASS", None)
    return Path(base) / name if base else Path(__file__).resolve().parent.parent / name


def is_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1.5) as r:
            return r.read() == b"ok"
    except OSError:
        return False


def pick_port(preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("no free port")


def say(text: str = "") -> None:
    """Print to the console window if there is one (the Mac app has none)."""
    if sys.stdout is not None:
        try:
            print(text, flush=True)
        except OSError:
            pass


def wait_until_running(port: int, seconds: float = 90) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if is_running(port):
            return True
        time.sleep(0.5)
    return False


def open_when_ready(url: str, port: int, lock: Path, browser: bool) -> None:
    if wait_until_running(port):
        lock.unlink(missing_ok=True)
        if browser:
            webbrowser.open(url)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog=APP_NAME)
    p.add_argument("--data-dir", type=Path, help="where to keep the database (default: your app-data folder)")
    p.add_argument("--no-browser", action="store_true", help="don't open the browser")
    p.add_argument("--no-schedule", action="store_true", help="don't run automatic refreshes (for testing)")
    args = p.parse_args(argv)

    folder = args.data_dir or data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    port_file = folder / "port"
    try:
        saved = int(port_file.read_text().strip())
    except (OSError, ValueError):
        saved = DEFAULT_PORT

    # Already open, or another copy is still starting up (a second double-click): just show it.
    lock = folder / "starting.lock"
    starting = lock.exists() and time.time() - lock.stat().st_mtime < 90
    if is_running(saved) or (starting and wait_until_running(saved)):
        say(f"{APP_NAME} is already running. Opening it in your browser…")
        if not args.no_browser:
            webbrowser.open(f"http://127.0.0.1:{saved}")
        return 0

    say(f"Starting {APP_NAME}…")
    port = pick_port(saved)
    port_file.write_text(str(port))
    lock.write_text(str(os.getpid()))
    url = f"http://127.0.0.1:{port}"

    os.environ["KWT_DESKTOP"] = "1"
    logging.basicConfig(
        filename=folder / "keyword-tracker.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    from .web import serve  # imported late: it's the slow part (pandas)

    say(f"  {APP_NAME} is running.\n")
    say(f"  Open it in your browser at:  {url}")
    say("  Keep this window open. Closing it stops Keyword Tracker,")
    say("  and weekly updates only happen while it's running.\n")
    say(f"  Your data is saved in:  {folder}")

    threading.Thread(target=open_when_ready, args=(url, port, lock, not args.no_browser), daemon=True).start()
    serve(folder / "keywords.db", bundled("config.toml"), "127.0.0.1", port, schedule=not args.no_schedule)
    return 0


if __name__ == "__main__":
    sys.exit(main())
