#!/usr/bin/env python3
"""Convert the old server's SQLite database (coinstorm.db) into a Coinstorm export file.

Import the result on the Stats tab (Your data → Import…). Standard library only.

    python3 scripts/export_db.py coinstorm.db coinstorm-export.json

Safe while the old server is running: it reads through SQLite, which sees
writes still sitting in coinstorm.db-wal.
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone


def unpack(blob, count, one="H", zero="T"):
    """np.packbits layout: MSB first. Returns a string of `count` characters."""
    out = []
    for i in range(count):
        out.append(one if (blob[i >> 3] >> (7 - (i & 7))) & 1 else zero)
    return "".join(out)


def main(src, dst):
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    has_mode = any(r["name"] == "mode" for r in con.execute("PRAGMA table_info(sessions)"))
    has_picks = con.execute("SELECT 1 FROM sqlite_master WHERE name = 'session_picks'").fetchone()
    rows = con.execute(
        f"""SELECT s.*, ss.series, ss.hist_heads, ss.hist_tails, q.bits
                   {", p.pairs, p.picks, p.choices, p.chose_heads, p.chose_b, p.raw_heads" if has_picks else ""}
            FROM sessions s
            JOIN session_series ss ON ss.session_id = s.id
            LEFT JOIN session_sequence q ON q.session_id = s.id
            {"LEFT JOIN session_picks p ON p.session_id = s.id" if has_picks else ""}
            ORDER BY s.created_at, s.id""").fetchall()
    sessions = []
    for r in rows:
        n = r["n_tosses"]
        pick = None
        if has_picks and r["pairs"] is not None:
            pick = {"choices": r["choices"], "chose_heads": r["chose_heads"], "chose_b": r["chose_b"],
                    "raw_heads": r["raw_heads"], "pairs": unpack(r["pairs"], 2 * n),
                    "picks": unpack(r["picks"], n, "B", "A")}
        sessions.append({
            "created_at": r["created_at"], "label": r["label"], "n_tosses": n,
            "heads": r["heads"], "tails": r["tails"],
            "longest_heads": r["longest_heads"], "longest_heads_start": r["longest_heads_start"],
            "longest_tails": r["longest_tails"], "longest_tails_start": r["longest_tails_start"],
            "runs": r["runs"], "z_score": r["z_score"], "p_value": r["p_value"],
            "duration_ms": r["duration_ms"], "mode": (r["mode"] if has_mode else "simulate"),
            "series": json.loads(r["series"]), "hist_heads": json.loads(r["hist_heads"]),
            "hist_tails": json.loads(r["hist_tails"]),
            "sequence": unpack(r["bits"], n) if r["bits"] is not None else None,
            "pick": pick,
        })
    out = {"format": "coinstorm-export", "version": 1,
           "exported_at": datetime.now(timezone.utc).isoformat(), "sessions": sessions}
    with open(dst, "w") as f:
        json.dump(out, f)
    print(f"Wrote {len(sessions)} sessions to {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
