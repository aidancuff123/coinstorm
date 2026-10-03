"""Background runner for large sessions: one job at a time, progress in memory.

Job state is not persisted; if the server restarts mid-job the job is lost and
GET /api/jobs/{id} returns 404 (nothing is written to the DB until a job finishes).
"""
import threading
import time
import uuid


class Busy(Exception):
    pass


class JobRunner:
    def __init__(self, run_session):
        """run_session(n, label, progress) -> session_id; progress(done, total)."""
        self.run_session = run_session
        self.lock = threading.Lock()
        self.jobs = {}
        self.active = None

    def submit(self, n, label):
        with self.lock:
            if self.active is not None:
                raise Busy(self.active)
            jid = uuid.uuid4().hex[:12]
            self.jobs[jid] = {"id": jid, "status": "running", "n": n, "label": label,
                              "done": 0, "started": time.time(), "finished": None,
                              "session_id": None, "error": None}
            self.active = jid
            if len(self.jobs) > 50:  # keep recent history only
                for old in [k for k, j in self.jobs.items() if j["status"] != "running"][:-20]:
                    del self.jobs[old]
        threading.Thread(target=self._run, args=(jid, n, label), daemon=True).start()
        return jid

    def _run(self, jid, n, label):
        job = self.jobs[jid]

        def progress(done, total):
            job["done"] = done

        try:
            job["session_id"] = self.run_session(n, label, progress)
            job["done"] = n
            job["status"] = "done"
        except Exception as e:  # surfaced to the client via GET /api/jobs/{id}
            job["status"] = "failed"
            job["error"] = str(e) or type(e).__name__
        finally:
            job["finished"] = time.time()
            with self.lock:
                self.active = None

    def get(self, jid):
        job = self.jobs.get(jid)
        if job is None:
            return None
        out = dict(job)
        end = job["finished"] or time.time()
        out["elapsed_s"] = end - job["started"]
        d = job["done"]
        out["eta_s"] = (out["elapsed_s"] / d * (job["n"] - d)) if d and job["status"] == "running" else None
        return out
