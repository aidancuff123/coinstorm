"""SQLite storage. One short-lived connection per operation; WAL mode."""
import json
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id                  INTEGER PRIMARY KEY,
    created_at          TEXT    NOT NULL,          -- ISO 8601 UTC
    label               TEXT,
    n_tosses            INTEGER NOT NULL,
    heads               INTEGER NOT NULL,
    tails               INTEGER NOT NULL,
    longest_heads       INTEGER NOT NULL,
    longest_heads_start INTEGER,                   -- 1-based toss index
    longest_tails       INTEGER NOT NULL,
    longest_tails_start INTEGER,
    runs                INTEGER NOT NULL,
    z_score             REAL    NOT NULL,
    p_value             REAL    NOT NULL,
    duration_ms         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS sessions_size ON sessions(n_tosses);

CREATE TABLE IF NOT EXISTS session_series (
    session_id  INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    series      TEXT NOT NULL,   -- JSON [[toss_count, heads_proportion], ...]
    hist_heads  TEXT NOT NULL,   -- JSON list, index = streak length
    hist_tails  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_sequence (
    session_id  INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    bits        BLOB NOT NULL    -- np.packbits, 1 = heads; only when n_tosses <= 10,000
);
"""

SORTS = {
    "date_desc": "created_at DESC, id DESC",
    "date_asc": "created_at ASC, id ASC",
    "size_desc": "n_tosses DESC, id DESC",
    "size_asc": "n_tosses ASC, id ASC",
}


class DB:
    def __init__(self, path):
        self.path = path
        with self.connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(SCHEMA)

    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        return c

    def insert_session(self, label, result, z_score, p_value, duration_ms):
        r = result
        with self.connect() as c:
            cur = c.execute(
                """INSERT INTO sessions (created_at, label, n_tosses, heads, tails,
                       longest_heads, longest_heads_start, longest_tails, longest_tails_start,
                       runs, z_score, p_value, duration_ms)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (datetime.now(timezone.utc).isoformat(timespec="milliseconds"), label,
                 r["n"], r["heads"], r["tails"], r["longest_heads"], r["longest_heads_start"],
                 r["longest_tails"], r["longest_tails_start"], r["runs"], z_score, p_value,
                 duration_ms))
            sid = cur.lastrowid
            c.execute("INSERT INTO session_series VALUES (?,?,?,?)",
                      (sid, json.dumps(r["series"]), json.dumps(r["hist_heads"]),
                       json.dumps(r["hist_tails"])))
            if r["sequence"] is not None:
                c.execute("INSERT INTO session_sequence VALUES (?,?)", (sid, r["sequence"]))
        return sid

    def get_session(self, sid):
        with self.connect() as c:
            row = c.execute(
                """SELECT s.*, ss.series, ss.hist_heads, ss.hist_tails, q.bits
                   FROM sessions s
                   JOIN session_series ss ON ss.session_id = s.id
                   LEFT JOIN session_sequence q ON q.session_id = s.id
                   WHERE s.id = ?""", (sid,)).fetchone()
        return dict(row) if row else None

    def list_sessions(self, limit, offset, sort, min_n=None, max_n=None):
        where, args = [], []
        if min_n is not None:
            where.append("n_tosses >= ?")
            args.append(min_n)
        if max_n is not None:
            where.append("n_tosses <= ?")
            args.append(max_n)
        w = ("WHERE " + " AND ".join(where)) if where else ""
        with self.connect() as c:
            total = c.execute(f"SELECT COUNT(*) FROM sessions {w}", args).fetchone()[0]
            rows = c.execute(
                f"""SELECT id, created_at, label, n_tosses, heads, tails,
                           longest_heads, longest_tails, z_score, p_value
                    FROM sessions {w} ORDER BY {SORTS[sort]} LIMIT ? OFFSET ?""",
                args + [limit, offset]).fetchall()
        return total, [dict(r) for r in rows]

    def delete_session(self, sid):
        with self.connect() as c:
            return c.execute("DELETE FROM sessions WHERE id = ?", (sid,)).rowcount > 0

    def all_session_summaries(self):
        """Columns needed for lifetime stats, oldest first."""
        with self.connect() as c:
            rows = c.execute(
                """SELECT id, created_at, label, n_tosses, heads, longest_heads,
                          longest_heads_start, longest_tails, longest_tails_start,
                          z_score, p_value
                   FROM sessions ORDER BY created_at, id""").fetchall()
        return [dict(r) for r in rows]
