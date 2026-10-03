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

-- Pick mode: every round flips two coins and the user keeps one.
CREATE TABLE IF NOT EXISTS pick_drafts (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    n           INTEGER NOT NULL,  -- rounds offered
    label       TEXT,
    pairs       BLOB NOT NULL      -- np.packbits of 2n coins: round i = coins 2i (A), 2i+1 (B)
);

CREATE TABLE IF NOT EXISTS session_picks (
    session_id  INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    pairs       BLOB NOT NULL,     -- the played rounds only, packed as in pick_drafts
    picks       BLOB NOT NULL,     -- np.packbits, 1 = kept coin B
    choices     INTEGER NOT NULL,  -- rounds where the two coins differed
    chose_heads INTEGER NOT NULL,  -- of those, rounds where heads was kept
    chose_b     INTEGER NOT NULL,
    raw_heads   INTEGER NOT NULL   -- heads among all coins shown
);
"""

MIGRATIONS = [
    # (column, DDL) added to sessions after v1
    ("mode", "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'simulate'"),
]
DRAFT_TTL_DAYS = 7

SORTS = {
    "date_desc": "created_at DESC, id DESC",
    "date_asc": "created_at ASC, id ASC",
    "size_desc": "n_tosses DESC, id DESC",
    "size_asc": "n_tosses ASC, id ASC",
}


class DraftGone(Exception):
    pass


class DB:
    def __init__(self, path):
        self.path = path
        with self.connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(SCHEMA)
            cols = {r["name"] for r in c.execute("PRAGMA table_info(sessions)")}
            for col, ddl in MIGRATIONS:
                if col not in cols:
                    c.execute(ddl)
            c.execute("DELETE FROM pick_drafts WHERE julianday(created_at) < julianday('now', ?)",
                      (f"-{DRAFT_TTL_DAYS} days",))

    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        return c

    def insert_session(self, label, result, z_score, p_value, duration_ms, pick=None,
                       draft_id=None):
        """pick: {"pairs", "picks", "choices", "chose_heads", "chose_b", "raw_heads"} for
        pick mode; draft_id is deleted in the same transaction."""
        r = result
        with self.connect() as c:
            # Claim the draft first; a concurrent finish of the same draft rolls back here.
            if draft_id and c.execute("DELETE FROM pick_drafts WHERE id = ?",
                                      (draft_id,)).rowcount == 0:
                raise DraftGone(draft_id)
            cur = c.execute(
                """INSERT INTO sessions (created_at, label, n_tosses, heads, tails,
                       longest_heads, longest_heads_start, longest_tails, longest_tails_start,
                       runs, z_score, p_value, duration_ms, mode)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (_now(), label,
                 r["n"], r["heads"], r["tails"], r["longest_heads"], r["longest_heads_start"],
                 r["longest_tails"], r["longest_tails_start"], r["runs"], z_score, p_value,
                 duration_ms, "pick" if pick else "simulate"))
            sid = cur.lastrowid
            c.execute("INSERT INTO session_series VALUES (?,?,?,?)",
                      (sid, json.dumps(r["series"]), json.dumps(r["hist_heads"]),
                       json.dumps(r["hist_tails"])))
            if r["sequence"] is not None:
                c.execute("INSERT INTO session_sequence VALUES (?,?)", (sid, r["sequence"]))
            if pick:
                c.execute("INSERT INTO session_picks VALUES (?,?,?,?,?,?,?)",
                          (sid, pick["pairs"], pick["picks"], pick["choices"],
                           pick["chose_heads"], pick["chose_b"], pick["raw_heads"]))
        return sid

    def get_session(self, sid):
        with self.connect() as c:
            row = c.execute(
                """SELECT s.*, ss.series, ss.hist_heads, ss.hist_tails, q.bits,
                          p.pairs, p.picks, p.choices, p.chose_heads, p.chose_b, p.raw_heads
                   FROM sessions s
                   JOIN session_series ss ON ss.session_id = s.id
                   LEFT JOIN session_sequence q ON q.session_id = s.id
                   LEFT JOIN session_picks p ON p.session_id = s.id
                   WHERE s.id = ?""", (sid,)).fetchone()
        return dict(row) if row else None

    def list_sessions(self, limit, offset, sort, min_n=None, max_n=None, mode=None):
        where, args = [], []
        if mode is not None:
            where.append("mode = ?")
            args.append(mode)
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
                           longest_heads, longest_tails, z_score, p_value, mode
                    FROM sessions {w} ORDER BY {SORTS[sort]} LIMIT ? OFFSET ?""",
                args + [limit, offset]).fetchall()
        return total, [dict(r) for r in rows]

    def delete_session(self, sid):
        with self.connect() as c:
            return c.execute("DELETE FROM sessions WHERE id = ?", (sid,)).rowcount > 0

    def all_session_summaries(self, mode="simulate"):
        """Columns needed for lifetime stats, oldest first."""
        with self.connect() as c:
            rows = c.execute(
                """SELECT id, created_at, label, n_tosses, heads, longest_heads,
                          longest_heads_start, longest_tails, longest_tails_start,
                          z_score, p_value
                   FROM sessions WHERE mode = ? ORDER BY created_at, id""", (mode,)).fetchall()
        return [dict(r) for r in rows]

    def pick_totals(self):
        with self.connect() as c:
            r = c.execute(
                """SELECT COUNT(*) AS sessions, COALESCE(SUM(s.n_tosses), 0) AS rounds,
                          COALESCE(SUM(s.heads), 0) AS kept_heads,
                          COALESCE(SUM(p.choices), 0) AS choices,
                          COALESCE(SUM(p.chose_heads), 0) AS chose_heads,
                          COALESCE(SUM(p.chose_b), 0) AS chose_b,
                          COALESCE(SUM(p.raw_heads), 0) AS raw_heads
                   FROM sessions s JOIN session_picks p ON p.session_id = s.id""").fetchone()
        return dict(r)

    # Pick-mode drafts: pairs are flipped up front and kept server-side until finish.
    def create_draft(self, did, n, label, pairs):
        with self.connect() as c:
            c.execute("INSERT INTO pick_drafts VALUES (?,?,?,?,?)", (did, _now(), n, label, pairs))

    def get_draft(self, did):
        with self.connect() as c:
            row = c.execute("SELECT * FROM pick_drafts WHERE id = ?", (did,)).fetchone()
        return dict(row) if row else None

    def delete_draft(self, did):
        with self.connect() as c:
            return c.execute("DELETE FROM pick_drafts WHERE id = ?", (did,)).rowcount > 0


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
