import os
import random

import numpy as np
import pytest

from app import sim


def naive(bits):
    """Reference implementation: one pass over a Python list, 1 = heads."""
    n = len(bits)
    heads = sum(bits)
    runs = 0
    longest = {1: (0, None), 0: (0, None)}
    hist = {1: {}, 0: {}}
    i = 0
    while i < n:
        j = i
        while j < n and bits[j] == bits[i]:
            j += 1
        v, length = bits[i], j - i
        runs += 1
        hist[v][length] = hist[v].get(length, 0) + 1
        if length > longest[v][0]:
            longest[v] = (length, i + 1)
        i = j
    pts = sim.sample_points(n).tolist()
    prefix, series, c = 0, [], 0
    for k, x in enumerate(bits, 1):
        prefix += x
        if c < len(pts) and pts[c] == k:
            series.append((k, prefix / k))
            c += 1

    def as_list(h):
        if not h:
            return [0]
        out = [0] * (max(h) + 1)
        for k, v in h.items():
            out[k] = v
        return out

    return {
        "n": n, "heads": heads, "tails": n - heads, "runs": runs,
        "longest_heads": longest[1][0], "longest_heads_start": longest[1][1],
        "longest_tails": longest[0][0], "longest_tails_start": longest[0][1],
        "hist_heads": as_list(hist[1]), "hist_tails": as_list(hist[0]),
        "series": series,
    }


def chunked(bits, sizes):
    acc = sim.Accumulator(len(bits))
    arr = np.array(bits, dtype=np.uint8)
    pos = 0
    for s in sizes:
        acc.feed(arr[pos:pos + s])
        pos += s
    acc.feed(arr[pos:])
    return acc.finish()


def random_sizes(rng, n):
    sizes, total = [], 0
    while total < n:
        s = rng.choice([1, 1, 2, 3, rng.randint(1, 50), rng.randint(1, n)])
        s = min(s, n - total)
        sizes.append(s)
        total += s
    return sizes


def assert_matches(got, ref):
    for k, v in ref.items():
        if k == "series":
            assert [p for p, _ in got[k]] == [p for p, _ in v]
            assert np.allclose([q for _, q in got[k]], [q for _, q in v])
        else:
            assert got[k] == v, k


@pytest.mark.parametrize("seed", range(40))
def test_chunked_matches_naive_random(seed):
    rng = random.Random(seed)
    n = rng.choice([1, 2, 7, 100, 999, 1000, 1001, 5000, rng.randint(1, 20000)])
    p = rng.choice([0.5, 0.5, 0.1, 0.9, 0.98])  # biased inputs make long runs cross boundaries
    bits = [1 if rng.random() < p else 0 for _ in range(n)]
    assert_matches(chunked(bits, random_sizes(rng, n)), naive(bits))


def test_streak_spanning_many_chunks():
    bits = [0, 1] + [1] * 500 + [0] * 300 + [1, 0, 1]
    ref = naive(bits)
    for size in (1, 2, 7, 64):
        got = chunked(bits, [size] * (len(bits) // size))
        assert_matches(got, ref)
    assert ref["longest_heads"] == 501 and ref["longest_heads_start"] == 2
    assert ref["longest_tails"] == 300 and ref["longest_tails_start"] == 503


@pytest.mark.parametrize("bits", [[1], [0], [1] * 50, [0] * 50, [0, 1] * 40, [1, 0] * 41])
def test_edge_sequences(bits):
    ref = naive(bits)
    assert_matches(chunked(bits, [1] * len(bits)), ref)
    assert_matches(chunked(bits, []), ref)


def test_earliest_longest_streak_wins_tie():
    bits = [1, 1, 1, 0, 1, 1, 1, 0]
    got = chunked(bits, [4])
    assert got["longest_heads"] == 3 and got["longest_heads_start"] == 1


def test_simulate_uses_rng_bytes_exactly():
    """simulate() over recorded random bytes equals naive() over the same bits."""
    for n, chunk in [(1, 8), (13, 8), (10_000, 24), (50_000, 4096), (50_001, 777)]:
        recorded = []

        def rb(k):
            data = os.urandom(k)
            recorded.append(data)
            return data

        got = sim.simulate(n, chunk=chunk, rand_bytes=rb)
        bits = []
        remaining = n
        for data in recorded:
            m = min(chunk, remaining)
            bits += np.unpackbits(np.frombuffer(data, np.uint8), count=m).tolist()
            remaining -= m
        assert_matches(got, naive(bits))
        if n <= sim.SEQUENCE_LIMIT:
            assert sim.unpack_sequence(got["sequence"], n) == bits
        else:
            assert got["sequence"] is None


def test_series_downsampled():
    r = sim.simulate(1_000_000, chunk=65_536)
    assert len(r["series"]) == sim.SERIES_POINTS
    assert r["series"][-1] == (1_000_000, r["heads"] / 1_000_000)


def test_progress_and_cancel():
    seen = []
    sim.simulate(100, chunk=30, progress=lambda d, n: seen.append(d))
    assert seen == [30, 60, 90, 100]
    with pytest.raises(sim.Cancelled):
        sim.simulate(100, chunk=30, cancel=lambda: True)


@pytest.mark.parametrize("n", [1, 2, sim.MAX_TOSSES])
def test_validate_accepts_limits(n):
    assert sim.validate_n(n) == n


@pytest.mark.parametrize("n", [0, -1, sim.MAX_TOSSES + 1, 2**63, 1.0, 10.5, "10", None, True])
def test_validate_rejects(n):
    with pytest.raises(ValueError):
        sim.validate_n(n)


def test_sample_points():
    assert sim.sample_points(5).tolist() == [1, 2, 3, 4, 5]
    pts = sim.sample_points(sim.MAX_TOSSES)
    assert len(pts) == 1000 and pts[-1] == sim.MAX_TOSSES and np.all(np.diff(pts) > 0)


def test_unpack_sequence_rejects_mismatched_length():
    blob = sim.simulate(10)["sequence"]
    with pytest.raises(ValueError):
        sim.unpack_sequence(blob, sim.MAX_TOSSES)
    with pytest.raises(ValueError):
        sim.unpack_sequence(blob, 100)
