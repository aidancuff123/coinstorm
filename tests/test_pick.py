import os
import sqlite3

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import pick
from app.db import DB
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path / "t.db"))


def naive_resolve(pairs_text, picks):
    """Reference: pairs_text is 'AB' per round as H/T characters."""
    kept, choices, chose_heads, raw = [], 0, 0, 0
    for i, p in enumerate(picks):
        a, b = pairs_text[2 * i], pairs_text[2 * i + 1]
        k = b if p else a
        kept.append(k)
        raw += (a == "H") + (b == "H")
        if a != b:
            choices += 1
            chose_heads += k == "H"
    return "".join(kept), {"rounds": len(picks), "choices": choices, "chose_heads": chose_heads,
                           "chose_b": sum(picks), "raw_heads": raw}


@pytest.mark.parametrize("seed", range(20))
def test_resolve_matches_naive(seed):
    rng = np.random.default_rng(seed)
    n = int(rng.integers(1, 3000))
    blob = pick.make_pairs(n)
    m = int(rng.integers(1, n + 1))
    picks = rng.integers(0, 2, m).tolist()
    kept, summary = pick.resolve(blob, n, picks)
    ref_kept, ref_summary = naive_resolve(pick.pairs_text(blob, n), picks)
    assert "".join("H" if b else "T" for b in kept) == ref_kept
    assert summary == ref_summary


def test_make_pairs_uses_rng_bytes():
    data = bytes([0b10110100, 0b01000000])  # coins: H T H H T H T T | T H
    blob = pick.make_pairs(5, rand_bytes=lambda k: data[:k])
    assert pick.pairs_text(blob, 5) == "HTHHTHTTTH"


@pytest.mark.parametrize("n", [0, -1, pick.MAX_ROUNDS + 1, 1.0, True, "5"])
def test_validate_rounds_rejects(n):
    with pytest.raises(ValueError):
        pick.validate_rounds(n)


@pytest.mark.parametrize("picks", [[], [0] * 11, [2], [-1], [True], [0.0], "01", None])
def test_validate_picks_rejects(picks):
    with pytest.raises(ValueError):
        pick.validate_picks(picks, 10)


def test_analyze_choices_no_choice():
    a = pick.analyze_choices({"rounds": 3, "choices": 0, "chose_heads": 0, "chose_b": 1, "raw_heads": 4})
    assert a["choice_z"] is None and "never had a real choice" in a["choice_verdict"]
    assert a["raw_total"] == 6 and a["raw_heads_pct"] == pytest.approx(400 / 6)


def test_analyze_choices_bias():
    a = pick.analyze_choices({"rounds": 100, "choices": 100, "chose_heads": 90, "chose_b": 50, "raw_heads": 100})
    assert a["choice_z"] == pytest.approx(8.0) and "strongly favour heads" in a["choice_verdict"]


# ---------- API ----------

def start(client, n, label=None):
    r = client.post("/api/picks", json={"n": n} | ({"label": label} if label else {}))
    assert r.status_code == 201, r.text
    return r.json()


def test_pick_roundtrip(client):
    d = start(client, 50, "  picky  ")
    assert d["n"] == 50 and d["label"] == "picky" and len(d["pairs"]) == 100
    assert client.get(f"/api/picks/{d['draft_id']}").json() == d
    picks = [i % 2 for i in range(30)]  # finish early: 30 of 50 rounds
    r = client.post(f"/api/picks/{d['draft_id']}/finish", json={"picks": picks})
    assert r.status_code == 201, r.text
    s = r.json()
    ref_kept, ref = naive_resolve(d["pairs"], picks)
    assert s["mode"] == "pick" and s["n_tosses"] == 30 and s["label"] == "picky"
    assert s["sequence"] == ref_kept and s["heads"] == ref_kept.count("H")
    p = s["pick"]
    assert p["pairs"] == d["pairs"][:60] and p["picks"] == "".join("AB"[x] for x in picks)
    for k, v in ref.items():
        assert p[k] == v, k
    assert s["duration_ms"] >= 0
    # Stored and redrawn identically; draft is gone.
    assert client.get(f"/api/sessions/{s['id']}").json() == s
    assert client.get(f"/api/picks/{d['draft_id']}").status_code == 404
    assert client.post(f"/api/picks/{d['draft_id']}/finish", json={"picks": picks}).status_code == 404


def test_finish_uses_server_pairs_not_client(client):
    d = start(client, 4)
    s = client.post(f"/api/picks/{d['draft_id']}/finish", json={"picks": [0, 0, 0, 0]}).json()
    assert s["sequence"] == d["pairs"][0::2]  # always coin A, from the server's stored pairs


@pytest.mark.parametrize("body", [{"n": 0}, {"n": pick.MAX_ROUNDS + 1}, {"n": "10"}, {"n": 2.0}, {}])
def test_start_validation(client, body):
    assert client.post("/api/picks", json=body).status_code == 422


@pytest.mark.parametrize("picks", [[], [0, 1, 0, 1, 0, 1], [2, 0], [True], ["0"], [0.5]])
def test_finish_validation(client, picks):
    d = start(client, 5)
    assert client.post(f"/api/picks/{d['draft_id']}/finish", json={"picks": picks}).status_code == 422
    assert client.get(f"/api/picks/{d['draft_id']}").status_code == 200  # draft survives a bad finish


def test_max_rounds_allowed(client):
    d = start(client, pick.MAX_ROUNDS)
    s = client.post(f"/api/picks/{d['draft_id']}/finish", json={"picks": [1] * pick.MAX_ROUNDS}).json()
    assert s["n_tosses"] == pick.MAX_ROUNDS and len(s["sequence"]) == pick.MAX_ROUNDS


def test_discard(client):
    d = start(client, 5)
    assert client.delete(f"/api/picks/{d['draft_id']}").status_code == 204
    assert client.delete(f"/api/picks/{d['draft_id']}").status_code == 404
    assert client.get("/api/sessions").json()["total"] == 0


def test_lifetime_and_log_separate_modes(client):
    sim_s = client.post("/api/sessions", json={"n": 100}).json()
    d = start(client, 20)
    pick_s = client.post(f"/api/picks/{d['draft_id']}/finish", json={"picks": [0] * 20}).json()
    lt = client.get("/api/stats/lifetime").json()
    assert lt["sessions"] == 1 and lt["tosses"] == 100  # pick sessions excluded from fairness stats
    assert lt["pick"]["sessions"] == 1 and lt["pick"]["rounds"] == 20
    assert lt["pick"]["kept_heads"] == pick_s["heads"]
    log = client.get("/api/sessions").json()
    assert {i["mode"] for i in log["items"]} == {"simulate", "pick"}
    assert [i["id"] for i in client.get("/api/sessions?mode=pick").json()["items"]] == [pick_s["id"]]
    assert [i["id"] for i in client.get("/api/sessions?mode=simulate").json()["items"]] == [sim_s["id"]]
    assert client.get("/api/sessions?mode=bogus").status_code == 422
    assert sim_s["mode"] == "simulate" and sim_s["pick"] is None


def test_lifetime_no_pick_sessions(client):
    assert client.get("/api/stats/lifetime").json()["pick"] is None


def test_delete_pick_session_cascades(client):
    d = start(client, 5)
    sid = client.post(f"/api/picks/{d['draft_id']}/finish", json={"picks": [1] * 5}).json()["id"]
    client.delete(f"/api/sessions/{sid}")
    with client.app.state.db.connect() as c:
        assert c.execute("SELECT COUNT(*) FROM session_picks").fetchone()[0] == 0


def test_migrates_v1_database(tmp_path):
    """A database created before pick mode gains the mode column; old rows read as 'simulate'."""
    path = tmp_path / "old.db"
    c = sqlite3.connect(path)
    c.executescript("""
        CREATE TABLE sessions (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, label TEXT,
            n_tosses INTEGER NOT NULL, heads INTEGER NOT NULL, tails INTEGER NOT NULL,
            longest_heads INTEGER NOT NULL, longest_heads_start INTEGER,
            longest_tails INTEGER NOT NULL, longest_tails_start INTEGER, runs INTEGER NOT NULL,
            z_score REAL NOT NULL, p_value REAL NOT NULL, duration_ms INTEGER NOT NULL);
        INSERT INTO sessions VALUES (1, '2026-10-03T04:00:00.000+00:00', 'old', 10, 5, 5, 2, 1, 2, 3, 6, 0, 1, 1);
    """)
    c.commit()
    c.close()
    DB(path)
    DB(path)  # idempotent
    c = sqlite3.connect(path)
    assert c.execute("SELECT mode FROM sessions WHERE id = 1").fetchone() == ("simulate",)


def test_expired_drafts_purged(tmp_path):
    path = tmp_path / "t.db"
    db = DB(path)
    db.create_draft("old", 3, None, pick.make_pairs(3))
    db.create_draft("new", 3, None, pick.make_pairs(3))
    with db.connect() as c:
        c.execute("UPDATE pick_drafts SET created_at = '2020-01-01T00:00:00.000+00:00' WHERE id = 'old'")
    DB(path)
    assert db.get_draft("old") is None and db.get_draft("new") is not None
