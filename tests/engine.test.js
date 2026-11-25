// Run with: node --test tests/   (Node 18+, no dependencies)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const E = require("../static/engine.js");

/* ---------- reference implementation: one toss at a time ---------- */
function naive(bits) {
  const n = bits.length;
  let heads = 0, runs = 0;
  const longest = { 1: [0, null], 0: [0, null] }, hist = { 1: {}, 0: {} };
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && bits[j] === bits[i]) j++;
    const v = bits[i], len = j - i;
    runs++;
    hist[v][len] = (hist[v][len] || 0) + 1;
    if (len > longest[v][0]) longest[v] = [len, i + 1];
    i = j;
  }
  const pts = E.samplePoints(n), series = [];
  let c = 0;
  for (let k = 1; k <= n; k++) {
    heads += bits[k - 1];
    if (c < pts.length && pts[c] === k) { series.push([k, heads / k]); c++; }
  }
  const asList = (h) => {
    const ks = Object.keys(h).map(Number);
    if (!ks.length) return [0];
    const out = new Array(Math.max(...ks) + 1).fill(0);
    for (const k of ks) out[k] = h[k];
    return out;
  };
  return { n, heads, tails: n - heads, runs,
    longest_heads: longest[1][0], longest_heads_start: longest[1][1],
    longest_tails: longest[0][0], longest_tails_start: longest[0][1],
    hist_heads: asList(hist[1]), hist_tails: asList(hist[0]), series };
}

function pack(bits) {
  const out = new Uint8Array((bits.length + 7) >> 3);
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}

/** Feed bits in pieces of the given sizes, alternating packed and bit-by-bit pieces. */
function chunked(bits, sizes, packedAll = false) {
  const acc = new E.Accumulator(bits.length);
  let pos = 0, k = 0;
  const feed = (piece) => {
    if (!piece.length) return;
    if (packedAll || k++ % 2 === 0) acc.feedBytes(pack(piece), piece.length);
    else acc.feedBits(piece);
  };
  for (const s of sizes) { feed(bits.slice(pos, pos + s)); pos += s; }
  feed(bits.slice(pos));
  return acc.finish();
}

function assertMatches(got, ref) {
  for (const [k, v] of Object.entries(ref)) {
    if (k === "series") {
      assert.deepEqual(got.series.map((p) => p[0]), v.map((p) => p[0]));
      got.series.forEach((p, i) => assert.ok(Math.abs(p[1] - v[i][1]) < 1e-12));
    } else {
      assert.deepEqual(got[k], v, k);
    }
  }
}

// Small seeded PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.choice = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

function randomSizes(r, n) {
  const sizes = [];
  let total = 0;
  while (total < n) {
    let s = r.choice([1, 1, 2, 3, 8, 16, r.int(1, 50), r.int(1, n)]);
    s = Math.min(s, n - total);
    sizes.push(s); total += s;
  }
  return sizes;
}

/* ---------- simulation ---------- */
test("chunked matches naive on random inputs (packed and bit pieces)", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    const n = r.choice([1, 2, 7, 8, 9, 100, 999, 1000, 1001, 5000, 10001, r.int(1, 40000)]);
    const p = r.choice([0.5, 0.5, 0.1, 0.9, 0.98, 0.02]);  // biased inputs make long runs cross boundaries
    const bits = Array.from({ length: n }, () => (r() < p ? 1 : 0));
    const ref = naive(bits);
    assertMatches(chunked(bits, randomSizes(r, n)), ref);
    assertMatches(chunked(bits, randomSizes(r, n), true), ref);
  }
});

test("streaks spanning many chunks", () => {
  const bits = [0, 1, ...Array(500).fill(1), ...Array(300).fill(0), 1, 0, 1];
  const ref = naive(bits);
  for (const size of [1, 2, 7, 8, 64]) {
    assertMatches(chunked(bits, Array(Math.floor(bits.length / size)).fill(size)), ref);
    assertMatches(chunked(bits, Array(Math.floor(bits.length / size)).fill(size), true), ref);
  }
  assert.equal(ref.longest_heads, 501); assert.equal(ref.longest_heads_start, 2);
  assert.equal(ref.longest_tails, 300); assert.equal(ref.longest_tails_start, 503);
});

test("streaks longer than the histogram's initial size", () => {
  const bits = [...Array(20000).fill(1), 0, ...Array(70).fill(0)];
  const ref = naive(bits);
  assert.ok(ref.n > E.SEQUENCE_LIMIT);  // exercises the fast packed path
  assertMatches(chunked(bits, [], true), ref);
  assertMatches(chunked(bits, [13, 8000, 3], true), ref);
});

test("edge sequences", () => {
  for (const bits of [[1], [0], Array(50).fill(1), Array(50).fill(0),
    Array.from({ length: 80 }, (_, i) => i % 2), Array.from({ length: 82 }, (_, i) => 1 - (i % 2))]) {
    const ref = naive(bits);
    assertMatches(chunked(bits, Array(bits.length).fill(1)), ref);
    assertMatches(chunked(bits, []), ref);
    assertMatches(chunked(bits, [], true), ref);
  }
});

test("earliest longest streak wins a tie", () => {
  const got = chunked([1, 1, 1, 0, 1, 1, 1, 0], [4]);
  assert.equal(got.longest_heads, 3); assert.equal(got.longest_heads_start, 1);
});

test("simulate() uses the random bytes exactly", () => {
  for (const [n, chunkBytes] of [[1, 1], [13, 1], [10000, 3], [50000, 512], [50001, 97], [200003, 8192]]) {
    const recorded = [];
    const got = E.simulate(n, { chunkBytes, randomBytes: (buf) => { crypto.randomFillSync(buf); recorded.push(Uint8Array.from(buf)); } });
    const bits = [];
    let remaining = n;
    for (const data of recorded) {
      const m = Math.min(chunkBytes * 8, remaining);
      for (let i = 0; i < m; i++) bits.push((data[i >> 3] >> (7 - (i & 7))) & 1);
      remaining -= m;
    }
    assertMatches(got, naive(bits));
    if (n <= E.SEQUENCE_LIMIT) assert.equal(got.sequence, bits.map((b) => (b ? "H" : "T")).join(""));
    else assert.equal(got.sequence, null);
  }
});

test("series is downsampled and ends at n", () => {
  const r = E.simulate(1000000, { randomBytes: crypto.randomFillSync });
  assert.equal(r.series.length, E.SERIES_POINTS);
  assert.deepEqual(r.series.at(-1), [1000000, r.heads / 1000000]);
});

test("progress is reported after each chunk", () => {
  const seen = [];
  E.simulate(100, { chunkBytes: 4, randomBytes: crypto.randomFillSync, progress: (d) => seen.push(d) });
  assert.deepEqual(seen, [32, 64, 96, 100]);
});

test("validation accepts the limits", () => {
  for (const n of [1, 2, E.MAX_TOSSES]) assert.equal(E.validateN(n), n);
});

test("validation rejects everything else", () => {
  for (const n of [0, -1, E.MAX_TOSSES + 1, 2 ** 63, 10.5, "10", null, undefined, true, NaN, Infinity]) {
    assert.throws(() => E.validateN(n), RangeError, String(n));
  }
});

test("sample points", () => {
  assert.deepEqual(E.samplePoints(5), [1, 2, 3, 4, 5]);
  const pts = E.samplePoints(E.MAX_TOSSES);
  assert.equal(pts.length, 1000);
  assert.equal(pts.at(-1), E.MAX_TOSSES);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i] > pts[i - 1]);
});

/* ---------- statistics ---------- */
test("erfc matches reference values", () => {
  // Python math.erfc(z / sqrt(2)).
  const ref = [[0, 1.0], [0.5, 0.6170750774519738], [1, 0.31731050786291415], [1.96, 0.04999579029644087],
    [2.5, 0.012419330651552278], [3, 0.0026997960632601913], [5, 5.733031437583892e-07],
    [10, 1.5239706048321186e-23], [20, 5.507248237212663e-89], [30, 9.813427854297528e-198],
    [37.5, 9.210706019165167e-308]];
  for (const [z, p] of ref) {
    const got = E.twoSidedP(z);
    assert.ok(Math.abs(got - p) / p < 1e-13, `z=${z}: ${got} vs ${p}`);
    assert.ok(Math.abs(E.twoSidedP(-z) - p) / p < 1e-13);
  }
  assert.equal(E.twoSidedP(60), 0);
});

test("fair exact half", () => {
  const f = E.fairness(100, 50);
  assert.equal(f.z_score, 0); assert.equal(f.p_value, 1); assert.equal(f.deviation, 0);
});

test("known z and p", () => {
  const f = E.fairness(100, 60);
  assert.ok(Math.abs(f.z_score - 2) < 1e-12);
  assert.ok(Math.abs(f.p_value - 0.0455003) / 0.0455003 < 1e-5);
  assert.equal(f.sigma, 5); assert.equal(f.deviation_heads, 10);
});

test("runs test known values", () => {
  let r = E.runsTest(20, 10, 11);
  assert.ok(Math.abs(r.expected_runs - 11) < 1e-12); assert.ok(Math.abs(r.runs_z) < 1e-12);
  r = E.runsTest(20, 10, 2);
  assert.ok(Math.abs(r.runs_z - (2 - 11) / Math.sqrt((200 * 180) / (400 * 19))) < 1e-12);
});

test("runs test: all one side, single toss, max size", () => {
  const r = E.runsTest(5, 5, 1);
  assert.equal(r.runs_z, null); assert.equal(r.runs_p, null); assert.equal(r.expected_runs, 1);
  const a = E.analyze({ n: 1, heads: 1, runs: 1 });
  assert.ok(Math.abs(a.z_score - 1) < 1e-12); assert.equal(a.runs_z, null);
  const n = E.MAX_TOSSES, big = E.runsTest(n, Math.floor(n / 2), Math.floor(n / 2) + 1);
  assert.ok(Number.isFinite(big.runs_z) && Math.abs(big.runs_z) < 1);
});

test("verdicts", () => {
  for (const [p, word] of [[0.5, "Consistent"], [0.03, "Mildly"], [0.005, "Unusual"], [1e-9, "Very unusual"], [null, "Not enough"]]) {
    assert.ok(E.verdict(p).startsWith(word));
  }
});

/* ---------- pick mode ---------- */
test("resolvePicks matches a naive implementation", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed), n = r.int(1, 3000);
    const pairs = E.makePairs(n, crypto.randomFillSync);
    assert.equal(pairs.length, 2 * n);
    const m = r.int(1, n), picks = Array.from({ length: m }, () => r.int(0, 1));
    const { kept, summary } = E.resolvePicks(pairs, n, picks);
    let ref = "", choices = 0, choseHeads = 0, raw = 0;
    picks.forEach((p, i) => {
      const a = pairs[2 * i], b = pairs[2 * i + 1], k = p ? b : a;
      ref += k; raw += (a === "H") + (b === "H");
      if (a !== b) { choices++; choseHeads += k === "H"; }
    });
    assert.equal(Array.from(kept, (b) => (b ? "H" : "T")).join(""), ref);
    assert.deepEqual(summary, { rounds: m, choices, chose_heads: choseHeads, chose_b: picks.reduce((a, b) => a + b, 0), raw_heads: raw });
  }
});

test("makePairs uses the random bytes", () => {
  const data = [0b10110100, 0b01000000];  // H T H H T H T T | T H
  assert.equal(E.makePairs(5, (buf) => buf.set(data.slice(0, buf.length))), "HTHHTHTTTH");
});

test("pick validation", () => {
  for (const n of [0, -1, E.PICK_MAX + 1, 1.5, true, "5"]) assert.throws(() => E.makePairs(n, crypto.randomFillSync), RangeError);
  for (const picks of [[], Array(11).fill(0), [2], [-1], [true], "01", null]) assert.throws(() => E.validatePicks(picks, 10), RangeError);
});

test("analyzeChoices with and without real choices", () => {
  const none = E.analyzeChoices({ rounds: 4, choices: 0, chose_heads: 0, chose_b: 2, raw_heads: 4 });
  assert.equal(none.choice_p, null); assert.match(none.choice_verdict, /never had a real choice/);
  const lean = E.analyzeChoices({ rounds: 100, choices: 100, chose_heads: 80, chose_b: 50, raw_heads: 100 });
  assert.match(lean.choice_verdict, /strongly favour heads/);
  assert.equal(lean.chose_b_pct, 50); assert.equal(lean.raw_total, 200);
});

/* ---------- lifetime ---------- */
test("lifetime totals, records and ties", () => {
  assert.equal(E.lifetime([]).sessions, 0);
  const row = (id, n, heads, lh, lt) => {
    const f = E.fairness(n, heads);
    return { id, created_at: `2026-01-0${id}T00:00:00Z`, label: null, n_tosses: n, heads,
      longest_heads: lh, longest_heads_start: 1, longest_tails: lt, longest_tails_start: 2, z_score: f.z_score, p_value: f.p_value };
  };
  const L = E.lifetime([row(1, 100, 50, 6, 7), row(2, 1000, 600, 7, 5), row(3, 10, 9, 7, 1)]);
  assert.equal(L.sessions, 3); assert.equal(L.tosses, 1110); assert.equal(L.heads, 659);
  assert.equal(L.records.biggest.session_id, 2);
  assert.equal(L.records.most_lopsided.session_id, 2);
  assert.equal(L.records.longest_heads.session_id, 2);  // tie with 3: oldest wins
  assert.equal(L.longest_streak.side, "H");
  assert.equal(L.records.most_extreme_pct.session_id, 2);  // session 3 has < 100 tosses
  assert.equal(L.cumulative.at(-1).tosses, 1110);
});

test("sessionPayload rebuilds the full view from stored data", () => {
  const r = E.simulate(50, { randomBytes: crypto.randomFillSync });
  const f = E.fairness(50, r.heads);
  const summary = { id: 1, created_at: "2026-01-01T00:00:00Z", label: "x", n_tosses: 50, heads: r.heads, tails: r.tails,
    longest_heads: r.longest_heads, longest_heads_start: r.longest_heads_start, longest_tails: r.longest_tails,
    longest_tails_start: r.longest_tails_start, runs: r.runs, z_score: f.z_score, p_value: f.p_value, duration_ms: 1, mode: "simulate" };
  const s = E.sessionPayload(summary, { series: r.series, hist_heads: r.hist_heads, hist_tails: r.hist_tails, sequence: r.sequence, pick: null });
  assert.equal(s.sequence.length, 50); assert.equal(s.pick, null);
  assert.ok(typeof s.verdict === "string" && typeof s.runs_verdict === "string");
});
