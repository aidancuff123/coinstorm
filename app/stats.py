"""Statistics on a finished simulation: fairness test, runs test, verdict."""
import math


def two_sided_p(z):
    return math.erfc(abs(z) / math.sqrt(2))


def fairness(n, heads):
    """z-score of the heads count vs. a fair coin (exact integer numerator)."""
    z = (2 * heads - n) / math.sqrt(n)
    return {
        "heads_pct": 100 * heads / n,
        "deviation": heads / n - 0.5,          # absolute, as a proportion
        "deviation_heads": heads - n / 2,      # in tosses
        "sigma": math.sqrt(n) / 2,             # SD of the heads count
        "z_score": z,                          # deviation measured in σ
        "p_value": two_sided_p(z),
    }


def runs_test(n, heads, runs):
    """Wald–Wolfowitz runs test. Returns expected runs, z and p (None if undefined)."""
    n1, n2 = heads, n - heads
    if n1 == 0 or n2 == 0:
        return {"runs": runs, "expected_runs": float(n and 1), "runs_z": None, "runs_p": None}
    a = 2 * n1 * n2  # exact integers; can exceed 2**62 for max-size runs
    expected = a / n + 1
    var = (a * (a - n)) / (n * n * (n - 1))
    z = (runs - expected) / math.sqrt(var) if var > 0 else None
    return {
        "runs": runs,
        "expected_runs": expected,
        "runs_z": z,
        "runs_p": two_sided_p(z) if z is not None else None,
    }


def verdict(p):
    if p is None:
        return "Not enough tosses to test."
    if p >= 0.05:
        return "Consistent with a fair coin."
    if p >= 0.01:
        return "Mildly unusual (p < 0.05), but this happens about 1 in 20 fair sessions."
    if p >= 0.001:
        return "Unusual (p < 0.01) for a fair coin: about 1 in 100 sessions or rarer."
    return "Very unusual (p < 0.001) for a fair coin. Rare luck, or something is off."


def analyze(result):
    """Combine a simulate() result with derived statistics."""
    n, heads = result["n"], result["heads"]
    f = fairness(n, heads)
    r = runs_test(n, heads, result["runs"])
    return {
        **f,
        **r,
        "verdict": verdict(f["p_value"]),
        "runs_verdict": verdict(r["runs_p"]),
        "expected_longest": math.log2(n / 2) if n >= 2 else 1.0,  # rough typical longest streak
    }
