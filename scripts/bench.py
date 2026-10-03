"""Benchmarks. Each case runs in a fresh process so peak RSS is per-case.

    .venv/bin/python scripts/bench.py rng          # entropy source throughput
    .venv/bin/python scripts/bench.py chunks       # chunk-size sweep at 256M tosses
    .venv/bin/python scripts/bench.py max          # full 2,147,483,647-toss run
"""
import json
import os
import resource
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def peak_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def case(kind, n, chunk):
    import numpy as np
    from app import sim, stats

    base = peak_mb()
    t = time.perf_counter()
    if kind == "urandom":
        left = (n + 7) // 8
        while left:
            k = min(left, chunk // 8)
            os.urandom(k)
            left -= k
    elif kind == "pcg64":
        import secrets
        g = np.random.Generator(np.random.PCG64(secrets.randbits(128)))
        left = (n + 7) // 8
        while left:
            k = min(left, chunk // 8)
            g.bytes(k)
            left -= k
    elif kind == "sim":
        r = sim.simulate(n, chunk=chunk)
        a = stats.analyze(r)
    dt = time.perf_counter() - t
    out = {"kind": kind, "n": n, "chunk": chunk, "seconds": round(dt, 2),
           "peak_rss_mb": round(peak_mb(), 1), "baseline_rss_mb": round(base, 1),
           "mflips_per_s": round(n / dt / 1e6, 1)}
    if kind == "sim":
        out.update(heads=r["heads"], longest_heads=r["longest_heads"],
                   longest_tails=r["longest_tails"], z=round(a["z_score"], 3))
    print(json.dumps(out))


def run(kind, n, chunk):
    subprocess.run([sys.executable, __file__, "_case", kind, str(n), str(chunk)], check=True)


if __name__ == "__main__":
    MAX = 2**31 - 1
    what = sys.argv[1]
    if what == "_case":
        case(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    elif what == "rng":
        for k in ("urandom", "pcg64"):
            run(k, MAX, 1 << 26)
    elif what == "chunks":
        for c in (1 << 20, 1 << 22, 1 << 23, 1 << 24, 1 << 26):
            run("sim", 1 << 28, c)
    elif what == "max":
        from app.sim import CHUNK
        run("sim", MAX, CHUNK)
