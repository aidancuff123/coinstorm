"""Chunked coin-toss simulation with exact streak and run statistics.

Every toss is one bit from the OS CSPRNG (1 = heads). Large runs are processed
in fixed-size chunks; the run in progress at the end of a chunk is carried into
the next one, so streaks spanning chunk boundaries are counted exactly.
"""
import os

import numpy as np

MIN_TOSSES = 1
MAX_TOSSES = 2**31 - 1
CHUNK = 1 << 17          # flips per chunk; fastest on benchmark (stays in CPU cache), ~4 MB peak
SERIES_POINTS = 1000     # downsampled running-proportion points
SEQUENCE_LIMIT = 10_000  # store the raw sequence only up to this many tosses


class Cancelled(Exception):
    pass


def validate_n(n):
    """Return n if it is an integer in [MIN_TOSSES, MAX_TOSSES], else raise ValueError."""
    if isinstance(n, bool) or not isinstance(n, int):
        raise ValueError("n must be an integer")
    if not MIN_TOSSES <= n <= MAX_TOSSES:
        raise ValueError(f"n must be between {MIN_TOSSES} and {MAX_TOSSES:,}")
    return n


def sample_points(n, k=SERIES_POINTS):
    """1-based toss counts at which the running heads proportion is recorded."""
    if n <= k:
        return np.arange(1, n + 1, dtype=np.int64)
    pts = np.rint(np.linspace(n / k, n, k)).astype(np.int64)
    return np.unique(np.clip(pts, 1, n))


class Accumulator:
    """Consumes a toss sequence in arbitrary-sized chunks and keeps exact stats."""

    def __init__(self, n):
        self.n = n
        self.done = 0
        self.heads = 0
        self.runs = 0                # completed runs
        self.cur_val = -1            # run in progress (carried across chunks)
        self.cur_len = 0
        self.cur_start = 0           # 0-based global index
        self.longest = {1: [0, 0], 0: [0, 0]}  # value -> [length, 0-based start]
        self.hist = {1: np.zeros(2, np.int64), 0: np.zeros(2, np.int64)}
        self.points = sample_points(n)
        self.pi = 0
        self.series = []
        self.seq = [] if n <= SEQUENCE_LIMIT else None

    def _record(self, val, lengths, starts):
        if len(lengths) == 0:
            return
        bc = np.bincount(lengths)
        h = self.hist[val]
        if len(bc) > len(h):
            h = np.concatenate([h, np.zeros(len(bc) - len(h), np.int64)])
            self.hist[val] = h
        h[: len(bc)] += bc
        i = int(np.argmax(lengths))  # first occurrence = earliest start
        if lengths[i] > self.longest[val][0]:
            self.longest[val] = [int(lengths[i]), int(starts[i])]

    def feed(self, b):
        """b: uint8 array of 0/1 (1 = heads)."""
        m = len(b)
        if m == 0:
            return
        off = self.done
        if self.done + m > self.n:
            raise ValueError("fed more tosses than n")
        if self.seq is not None:
            self.seq.append(np.array(b, dtype=np.uint8))

        # Running proportion at the sample points that fall inside this chunk.
        hi = int(np.searchsorted(self.points, off + m, side="right"))
        if hi > self.pi:
            pts = self.points[self.pi:hi]
            local = pts - off
            cuts = np.empty(len(local), np.int64)
            cuts[0] = 0
            cuts[1:] = local[:-1]
            seg = np.add.reduceat(b[: local[-1]], cuts, dtype=np.int64)
            heads_at = self.heads + np.cumsum(seg)
            self.series.extend(zip(pts.tolist(), (heads_at / pts).tolist()))
            self.pi = hi

        self.heads += int(np.count_nonzero(b))

        # Run starts within the chunk, then run lengths.
        change = b[1:] != b[:-1]
        idx = np.flatnonzero(change)
        del change
        starts = np.empty(len(idx) + 1, np.int64)
        starts[0] = 0
        np.add(idx, 1, out=starts[1:])
        del idx
        lengths = np.empty_like(starts)
        np.subtract(starts[1:], starts[:-1], out=lengths[:-1])
        lengths[-1] = m - starts[-1]
        starts += off

        first = int(b[0])
        if self.cur_len and first == self.cur_val:
            lengths[0] += self.cur_len
            starts[0] = self.cur_start
        elif self.cur_len:
            self._record(self.cur_val, np.array([self.cur_len]), np.array([self.cur_start]))
            self.runs += 1

        # Every run but the last is complete. Runs alternate H/T, so each side is a strided view.
        if len(lengths) > 1:
            cl, cs = lengths[:-1], starts[:-1]
            k = 0 if first == 1 else 1
            self._record(1, cl[k::2], cs[k::2])
            self._record(0, cl[1 - k::2], cs[1 - k::2])
            self.runs += len(cl)

        self.cur_val = int(b[-1])
        self.cur_len = int(lengths[-1])
        self.cur_start = int(starts[-1])
        self.done += m

    def finish(self):
        if self.done != self.n:
            raise ValueError("finish() before all tosses were fed")
        self._record(self.cur_val, np.array([self.cur_len]), np.array([self.cur_start]))
        self.runs += 1
        sequence = None
        if self.seq is not None:
            sequence = np.packbits(np.concatenate(self.seq)).tobytes()
        lh, lt = self.longest[1], self.longest[0]
        return {
            "n": self.n,
            "heads": self.heads,
            "tails": self.n - self.heads,
            "runs": self.runs,
            "longest_heads": lh[0],
            "longest_heads_start": lh[1] + 1 if lh[0] else None,  # 1-based toss index
            "longest_tails": lt[0],
            "longest_tails_start": lt[1] + 1 if lt[0] else None,
            "hist_heads": _trim(self.hist[1]),
            "hist_tails": _trim(self.hist[0]),
            "series": self.series,
            "sequence": sequence,
        }


def _trim(h):
    """Histogram as a list indexed by streak length (index 0 unused), trailing zeros removed."""
    nz = np.flatnonzero(h)
    return h[: nz[-1] + 1].tolist() if len(nz) else [0]


def unpack_sequence(blob, n):
    """Inverse of the stored packed sequence: list of 0/1, 1 = heads."""
    if n > SEQUENCE_LIMIT or len(blob) != (n + 7) // 8:
        raise ValueError(f"stored sequence ({len(blob)} bytes) does not match n={n}")
    return np.unpackbits(np.frombuffer(blob, np.uint8), count=n).tolist()


def simulate(n, chunk=CHUNK, rand_bytes=os.urandom, progress=None, cancel=None):
    """Toss n fair coins. progress(done, n) is called after each chunk."""
    validate_n(n)
    acc = Accumulator(n)
    remaining = n
    while remaining:
        m = min(chunk, remaining)
        raw = np.frombuffer(rand_bytes((m + 7) // 8), np.uint8)
        acc.feed(np.unpackbits(raw, count=m))
        del raw
        remaining -= m
        if progress:
            progress(acc.done, n)
        if cancel and cancel():
            raise Cancelled()
    return acc.finish()
