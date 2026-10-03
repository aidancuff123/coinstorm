"""Pick mode: each round flips two coins and the user keeps one.

The server flips every pair when the session starts and stores them in a
draft. On finish it rebuilds the kept sequence from its own stored pairs plus
the user's picks, so the client can't invent coins.
"""
import os

import numpy as np

from . import sim, stats

MAX_ROUNDS = sim.SEQUENCE_LIMIT  # manual tapping; also guarantees the sequence is stored


def validate_rounds(n):
    if isinstance(n, bool) or not isinstance(n, int):
        raise ValueError("n must be an integer")
    if not 1 <= n <= MAX_ROUNDS:
        raise ValueError(f"n must be between 1 and {MAX_ROUNDS:,}")
    return n


def make_pairs(n, rand_bytes=os.urandom):
    """2n cryptographically random coins, packed. Round i is coins 2i (A) and 2i+1 (B)."""
    validate_rounds(n)
    bits = np.unpackbits(np.frombuffer(rand_bytes((2 * n + 7) // 8), np.uint8), count=2 * n)
    return np.packbits(bits).tobytes()


def unpack_pairs(blob, n):
    """(n, 2) uint8 array; column 0 = coin A, column 1 = coin B, 1 = heads."""
    if len(blob) != (2 * n + 7) // 8:
        raise ValueError("stored pairs do not match n")
    return np.unpackbits(np.frombuffer(blob, np.uint8), count=2 * n).reshape(n, 2)


def pairs_text(blob, n):
    """'HT' per round, concatenated: coin A then coin B."""
    return "".join("H" if b else "T" for b in unpack_pairs(blob, n).ravel())


def validate_picks(picks, n):
    """picks: list of 0 (coin A) / 1 (coin B); between 1 and n of them."""
    if not isinstance(picks, list) or not 1 <= len(picks) <= n:
        raise ValueError(f"picks must be a list of 1 to {n:,} choices")
    if any(type(p) is not int or p not in (0, 1) for p in picks):
        raise ValueError("each pick must be 0 (coin A) or 1 (coin B)")
    return picks


def resolve(blob, n, picks):
    """Kept sequence and choice summary for the first len(picks) rounds."""
    validate_picks(picks, n)
    m = len(picks)
    pairs = unpack_pairs(blob, n)[:m]
    p = np.array(picks, dtype=np.intp)
    kept = pairs[np.arange(m), p]
    differ = pairs[:, 0] != pairs[:, 1]
    summary = {
        "rounds": m,
        "choices": int(differ.sum()),                 # rounds where the coins differed
        "chose_heads": int(kept[differ].sum()),       # ...and the user kept heads
        "chose_b": int(p.sum()),                      # kept coin B (right)
        "raw_heads": int(pairs.sum()),                # heads among all 2m coins shown
    }
    return kept.astype(np.uint8), summary


def analyze_choices(s):
    """Derived stats for a stored pick summary."""
    out = dict(s)
    c, raw_total = s["choices"], 2 * s["rounds"]
    if c:
        f = stats.fairness(c, s["chose_heads"])
        out.update(chose_heads_pct=100 * s["chose_heads"] / c, choice_z=f["z_score"],
                   choice_p=f["p_value"], choice_verdict=_choice_verdict(f["p_value"], f["z_score"]))
    else:
        out.update(chose_heads_pct=None, choice_z=None, choice_p=None,
                   choice_verdict="The coins always matched, so you never had a real choice.")
    raw = stats.fairness(raw_total, s["raw_heads"])
    out.update(raw_total=raw_total, raw_heads_pct=100 * s["raw_heads"] / raw_total,
               raw_z=raw["z_score"], raw_p=raw["p_value"], raw_verdict=stats.verdict(raw["p_value"]))
    out["chose_b_pct"] = 100 * s["chose_b"] / s["rounds"]
    return out


def _choice_verdict(p, z):
    side = "heads" if z > 0 else "tails"
    if p >= 0.05:
        return "No clear preference: your picks look like a coin flip."
    if p >= 0.001:
        return f"You lean towards {side} (p < 0.05)."
    return f"You strongly favour {side} (p < 0.001)."
