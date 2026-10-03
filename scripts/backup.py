"""Online SQLite backup (safe while the app is running, WAL included).

    .venv/bin/python scripts/backup.py [--dest DIR] [--keep N]

Writes DIR/coinstorm-YYYYmmdd-HHMMSS.db (default DIR: ./backups) and deletes
all but the newest N backups (default 14).
"""
import argparse
import os
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("COINSTORM_DB", ROOT / "coinstorm.db"))
    ap.add_argument("--dest", default=ROOT / "backups")
    ap.add_argument("--keep", type=int, default=14)
    a = ap.parse_args()

    dest = Path(a.dest)
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"coinstorm-{datetime.now():%Y%m%d-%H%M%S}.db"
    src = sqlite3.connect(a.db)
    dst = sqlite3.connect(out)
    with dst:
        src.backup(dst)
    ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
    n = dst.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    src.close()
    dst.close()
    if ok != "ok":
        raise SystemExit(f"integrity check failed on {out}: {ok}")
    for old in sorted(dest.glob("coinstorm-*.db"))[:-a.keep]:
        old.unlink()
    print(f"{out} ({n} sessions, integrity ok)")
