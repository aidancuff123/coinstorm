import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import sim
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path / "t.db", sync_limit=1000))


def make(client, n, label=None):
    body = {"n": n} if label is None else {"n": n, "label": label}
    return client.post("/api/sessions", json=body)


def wait_job(client, jid, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        j = client.get(f"/api/jobs/{jid}").json()
        if j["status"] != "running":
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_small_session_roundtrip(client):
    r = make(client, 150, "  first  ")
    assert r.status_code == 201
    s = r.json()
    assert s["label"] == "first" and s["n_tosses"] == 150
    assert s["heads"] + s["tails"] == 150
    assert len(s["sequence"]) == 150 and set(s["sequence"]) <= {"H", "T"}
    assert s["sequence"].count("H") == s["heads"]
    assert len(s["series"]) == 150 and s["series"][-1][0] == 150
    assert sum(k * c for k, c in enumerate(s["hist_heads"])) == s["heads"]
    assert sum(k * c for k, c in enumerate(s["hist_tails"])) == s["tails"]
    # Stored copy is identical: redrawn from the DB, never re-simulated.
    assert client.get(f"/api/sessions/{s['id']}").json() == s


def test_sequence_streaks_consistent(client):
    s = make(client, 1000).json()
    seq = s["sequence"]
    i = s["longest_heads_start"] - 1
    assert seq[i:i + s["longest_heads"]] == "H" * s["longest_heads"]
    assert "H" * (s["longest_heads"] + 1) not in seq
    runs = 1 + sum(seq[k] != seq[k - 1] for k in range(1, len(seq)))
    assert s["runs"] == runs


@pytest.mark.parametrize("body", [
    {"n": 0}, {"n": -5}, {"n": sim.MAX_TOSSES + 1}, {"n": 2**64}, {"n": 1.5}, {"n": 10.0},
    {"n": "100"}, {"n": True}, {"n": None}, {}, {"n": 10, "label": "x" * 81},
])
def test_validation_rejects(client, body):
    assert client.post("/api/sessions", json=body).status_code == 422


def test_validation_accepts_min(client):
    s = make(client, 1).json()
    assert s["n_tosses"] == 1 and s["runs"] == 1


def test_max_n_accepted_as_job(tmp_path):
    calls = []

    def fake(n, progress=None):
        calls.append(n)
        # Stand-in result (only checks plumbing); no sequence, since n is huge.
        return sim.simulate(10) | {"n": n, "sequence": None}

    c = TestClient(create_app(tmp_path / "t.db", sync_limit=1000, simulate=fake))
    r = make(c, sim.MAX_TOSSES)
    assert r.status_code == 202
    assert wait_job(c, r.json()["job_id"])["status"] == "done"
    assert calls == [sim.MAX_TOSSES]


def test_large_session_runs_as_job(client):
    r = make(client, 50_000, "big")
    assert r.status_code == 202
    j = wait_job(client, r.json()["job_id"])
    assert j["status"] == "done" and j["done"] == 50_000
    s = j["session"]
    assert s["n_tosses"] == 50_000 and s["label"] == "big" and s["sequence"] is None
    assert len(s["series"]) == 1000


def test_second_job_rejected_while_busy(tmp_path):
    gate = threading.Event()

    def slow(n, progress=None):
        if n <= 1000:  # synchronous runs are not gated
            return sim.simulate(n)
        progress(n // 2, n)
        gate.wait(5)
        return sim.simulate(2000)

    c = TestClient(create_app(tmp_path / "t.db", sync_limit=1000, simulate=slow))
    jid = make(c, 2000).json()["job_id"]
    j = c.get(f"/api/jobs/{jid}").json()
    assert j["status"] == "running" and j["done"] == 1000 and j["eta_s"] is not None
    assert c.get("/api/jobs").json()["active"]["id"] == jid
    r = make(c, 2000)
    assert r.status_code == 409 and r.json()["job_id"] == jid
    assert make(c, 10).status_code == 201  # small runs still allowed
    gate.set()
    assert wait_job(c, jid)["status"] == "done"
    assert make(c, 2000).status_code == 202


def test_failed_job_reports_error(tmp_path):
    def boom(n, progress=None):
        raise RuntimeError("disk on fire")

    c = TestClient(create_app(tmp_path / "t.db", sync_limit=1000, simulate=boom))
    j = wait_job(c, make(c, 5000).json()["job_id"])
    assert j["status"] == "failed" and "disk on fire" in j["error"]
    assert c.get("/api/sessions").json()["total"] == 0


def test_unknown_job_404(client):
    assert client.get("/api/jobs/nope").status_code == 404


def test_list_sort_filter_delete(client):
    ids = [make(client, n).json()["id"] for n in (10, 500, 50)]
    lst = client.get("/api/sessions").json()
    assert lst["total"] == 3 and [i["id"] for i in lst["items"]] == ids[::-1]
    assert [i["n_tosses"] for i in client.get("/api/sessions?sort=size_desc").json()["items"]] == [500, 50, 10]
    assert [i["id"] for i in client.get("/api/sessions?sort=date_asc&limit=2&offset=1").json()["items"]] == ids[1:]
    f = client.get("/api/sessions?min_n=20&max_n=100").json()
    assert f["total"] == 1 and f["items"][0]["n_tosses"] == 50
    item = lst["items"][0]
    assert item["longest_streak"] == max(item["longest_heads"], item["longest_tails"])
    assert client.get("/api/sessions?sort=bogus").status_code == 422
    assert client.delete(f"/api/sessions/{ids[0]}").status_code == 204
    assert client.get(f"/api/sessions/{ids[0]}").status_code == 404
    assert client.delete(f"/api/sessions/{ids[0]}").status_code == 404
    assert client.get("/api/sessions").json()["total"] == 2


def test_delete_cascades(client):
    sid = make(client, 20).json()["id"]
    client.delete(f"/api/sessions/{sid}")
    db = client.app.state.db
    with db.connect() as c:
        assert c.execute("SELECT COUNT(*) FROM session_series").fetchone()[0] == 0
        assert c.execute("SELECT COUNT(*) FROM session_sequence").fetchone()[0] == 0


def test_lifetime_empty(client):
    lt = client.get("/api/stats/lifetime").json()
    assert lt["sessions"] == 0 and lt["records"] == {}


def test_lifetime_totals(client):
    ss = [make(client, n).json() for n in (10, 200, 999)]
    lt = client.get("/api/stats/lifetime").json()
    assert lt["sessions"] == 3 and lt["tosses"] == 1209
    assert lt["heads"] == sum(s["heads"] for s in ss)
    assert lt["cumulative"][-1]["tosses"] == 1209
    assert lt["cumulative"][-1]["heads_pct"] == pytest.approx(lt["heads_pct"])
    assert lt["z_scores"] == pytest.approx([s["z_score"] for s in ss])
    assert lt["records"]["biggest"]["n_tosses"] == 999
    best = max(max(s["longest_heads"], s["longest_tails"]) for s in ss)
    assert lt["longest_streak"]["length"] == best
    assert abs(lt["records"]["most_lopsided"]["z_score"]) == pytest.approx(max(abs(s["z_score"]) for s in ss))
