"""Coinstorm API and static file server.

Run with: uvicorn --factory app.main:create_app
"""
import json
import os
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StrictInt

from . import sim, stats
from .db import DB
from .jobs import Busy, JobRunner

ROOT = Path(__file__).resolve().parent.parent
SYNC_LIMIT = 1_000_000  # larger runs go to the background job runner


class NewSession(BaseModel):
    n: StrictInt = Field(ge=sim.MIN_TOSSES, le=sim.MAX_TOSSES)
    label: str | None = Field(default=None, max_length=80)


def session_payload(row):
    """Full analytics for a stored session. Derived stats are recomputed from
    stored counts (cheap, deterministic); tosses are never re-simulated."""
    n = row["n_tosses"]
    out = {k: row[k] for k in (
        "id", "created_at", "label", "n_tosses", "heads", "tails", "longest_heads",
        "longest_heads_start", "longest_tails", "longest_tails_start", "duration_ms")}
    out.update(stats.analyze({"n": n, "heads": row["heads"], "runs": row["runs"]}))
    out["series"] = json.loads(row["series"])
    out["hist_heads"] = json.loads(row["hist_heads"])
    out["hist_tails"] = json.loads(row["hist_tails"])
    bits = row.get("bits")
    out["sequence"] = ("".join("H" if b else "T" for b in sim.unpack_sequence(bits, n))
                       if bits is not None else None)
    return out


def lifetime(rows):
    if not rows:
        return {"sessions": 0, "tosses": 0, "heads": 0, "tails": 0, "heads_pct": None,
                "z_score": None, "p_value": None, "cumulative": [], "z_scores": [],
                "longest_streak": None, "records": {}}
    tosses = heads = 0
    cumulative = []
    for r in rows:
        tosses += r["n_tosses"]
        heads += r["heads"]
        cumulative.append({"session_id": r["id"], "created_at": r["created_at"],
                           "tosses": tosses, "heads_pct": 100 * heads / tosses})
    f = stats.fairness(tosses, heads)

    def brief(r, **extra):
        return {"session_id": r["id"], "created_at": r["created_at"], "label": r["label"],
                "n_tosses": r["n_tosses"], **extra}

    # max() keeps the first (oldest) row on ties.
    lh = max(rows, key=lambda r: r["longest_heads"])
    lt = max(rows, key=lambda r: r["longest_tails"])
    if lh["longest_heads"] >= lt["longest_tails"]:
        longest = brief(lh, side="H", length=lh["longest_heads"], start=lh["longest_heads_start"])
    else:
        longest = brief(lt, side="T", length=lt["longest_tails"], start=lt["longest_tails_start"])
    big = max(rows, key=lambda r: r["n_tosses"])
    lopsided = max(rows, key=lambda r: abs(r["z_score"]))
    pct = [r for r in rows if r["n_tosses"] >= 100]
    records = {
        "biggest": brief(big),
        "most_lopsided": brief(lopsided, z_score=lopsided["z_score"], p_value=lopsided["p_value"],
                               heads_pct=100 * lopsided["heads"] / lopsided["n_tosses"]),
        "longest_heads": brief(lh, length=lh["longest_heads"], start=lh["longest_heads_start"]),
        "longest_tails": brief(lt, length=lt["longest_tails"], start=lt["longest_tails_start"]),
    }
    if pct:
        e = max(pct, key=lambda r: abs(r["heads"] / r["n_tosses"] - 0.5))
        records["most_extreme_pct"] = brief(e, heads_pct=100 * e["heads"] / e["n_tosses"])
    return {"sessions": len(rows), "tosses": tosses, "heads": heads, "tails": tosses - heads,
            "heads_pct": 100 * heads / tosses, "z_score": f["z_score"], "p_value": f["p_value"],
            "cumulative": cumulative, "z_scores": [r["z_score"] for r in rows],
            "longest_streak": longest, "records": records}


def create_app(db_path=None, sync_limit=SYNC_LIMIT, simulate=sim.simulate):
    db = DB(db_path or os.environ.get("COINSTORM_DB", ROOT / "coinstorm.db"))

    def run_session(n, label, progress=None):
        t = time.perf_counter()
        r = simulate(n, progress=progress)
        f = stats.fairness(n, r["heads"])
        ms = round((time.perf_counter() - t) * 1000)
        return db.insert_session(label, r, f["z_score"], f["p_value"], ms)

    runner = JobRunner(run_session)
    app = FastAPI(title="Coinstorm", docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.db, app.state.runner = db, runner

    @app.post("/api/sessions", status_code=201)
    def create_session(body: NewSession, response: Response):
        label = (body.label or "").strip() or None
        if body.n > sync_limit:
            try:
                jid = runner.submit(body.n, label)
            except Busy as e:
                return JSONResponse(status_code=409, content={
                    "detail": "Another large run is in progress. Wait for it to finish.",
                    "job_id": str(e)})
            response.status_code = 202
            return {"job_id": jid}
        return session_payload(db.get_session(run_session(body.n, label)))

    @app.get("/api/jobs/{jid}")
    def get_job(jid: str):
        job = runner.get(jid)
        if job is None:
            raise HTTPException(404, "Job not found (it may have been lost in a server restart)")
        if job["status"] == "done":
            job["session"] = session_payload(db.get_session(job["session_id"]))
        return job

    @app.get("/api/jobs")
    def active_job():
        """The running job, if any; lets a reopened app resume its progress bar."""
        return {"active": runner.get(runner.active) if runner.active else None}

    @app.get("/api/sessions")
    def list_sessions(limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
                      sort: Literal["date_desc", "date_asc", "size_desc", "size_asc"] = "date_desc",
                      min_n: int | None = Query(None, ge=0), max_n: int | None = Query(None, ge=0)):
        total, rows = db.list_sessions(limit, offset, sort, min_n, max_n)
        for r in rows:
            r["heads_pct"] = 100 * r["heads"] / r["n_tosses"]
            r["longest_streak"] = max(r["longest_heads"], r["longest_tails"])
        return {"total": total, "items": rows}

    @app.get("/api/sessions/{sid}")
    def get_session(sid: int):
        row = db.get_session(sid)
        if row is None:
            raise HTTPException(404, "Session not found")
        return session_payload(row)

    @app.delete("/api/sessions/{sid}", status_code=204)
    def delete_session(sid: int):
        if not db.delete_session(sid):
            raise HTTPException(404, "Session not found")

    @app.get("/api/stats/lifetime")
    def lifetime_stats():
        return lifetime(db.all_session_summaries())

    static = ROOT / "static"
    if static.is_dir():
        app.mount("/", StaticFiles(directory=static, html=True), name="static")
    return app

