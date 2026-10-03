import math

import pytest

from app import stats


def test_fair_exact_half():
    f = stats.fairness(100, 50)
    assert f["z_score"] == 0 and f["p_value"] == 1.0 and f["deviation"] == 0


def test_known_z_and_p():
    f = stats.fairness(100, 60)  # z = (120 - 100) / 10 = 2
    assert f["z_score"] == pytest.approx(2.0)
    assert f["p_value"] == pytest.approx(0.0455003, rel=1e-5)
    assert f["sigma"] == 5
    assert f["deviation_heads"] == 10


def test_negative_z_symmetric():
    assert stats.fairness(100, 40)["p_value"] == pytest.approx(stats.fairness(100, 60)["p_value"])


def test_runs_test_known_values():
    # n1 = n2 = 10: E[R] = 11, Var = 200*180 / (400*19)
    r = stats.runs_test(20, 10, 11)
    assert r["expected_runs"] == pytest.approx(11)
    assert r["runs_z"] == pytest.approx(0)
    r = stats.runs_test(20, 10, 2)
    assert r["runs_z"] == pytest.approx((2 - 11) / math.sqrt(200 * 180 / (400 * 19)))


def test_runs_test_all_one_side():
    r = stats.runs_test(5, 5, 1)
    assert r["runs_z"] is None and r["runs_p"] is None and r["expected_runs"] == 1


def test_runs_test_max_size_no_overflow():
    n = 2**31 - 1
    r = stats.runs_test(n, n // 2, n // 2 + 1)
    assert math.isfinite(r["runs_z"]) and abs(r["runs_z"]) < 1


def test_single_toss():
    a = stats.analyze({"n": 1, "heads": 1, "runs": 1})
    assert a["z_score"] == pytest.approx(1.0) and a["runs_z"] is None


@pytest.mark.parametrize("p,word", [(0.5, "Consistent"), (0.03, "Mildly"), (0.005, "Unusual"),
                                    (1e-9, "Very unusual"), (None, "Not enough")])
def test_verdicts(p, word):
    assert stats.verdict(p).startswith(word)
