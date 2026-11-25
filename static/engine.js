/* Coinstorm engine: simulation, statistics, pick mode and lifetime analytics.
 *
 * Pure functions, no DOM. Loaded by the page (<script>), the simulation worker
 * (importScripts) and the Node test suite (require). Everything lands on
 * globalThis.CoinEngine.
 *
 * Bit order matches the old Python/numpy version (np.packbits, MSB first):
 * bit 7 of a byte is the earliest toss. 1 = heads.
 */
(function (root) {
  "use strict";

  const MIN_TOSSES = 1;
  const MAX_TOSSES = 2147483647;  // 2**31 - 1
  const SERIES_POINTS = 1000;     // downsampled running-proportion points
  const SEQUENCE_LIMIT = 10000;   // keep the raw H/T sequence only up to this many tosses
  const PICK_MAX = SEQUENCE_LIMIT;

  /* ---------- validation ---------- */
  function validateN(n, max = MAX_TOSSES) {
    if (typeof n !== "number" || !Number.isInteger(n)) throw new RangeError("n must be an integer");
    if (n < MIN_TOSSES || n > max) throw new RangeError(`n must be between 1 and ${max.toLocaleString("en-US")}`);
    return n;
  }

  /* ---------- sample points (same as np.unique(np.rint(np.linspace(n/k, n, k)))) ---------- */
  function roundHalfEven(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  function samplePoints(n, k = SERIES_POINTS) {
    const out = [];
    if (n <= k) { for (let i = 1; i <= n; i++) out.push(i); return out; }
    const start = n / k, step = (n - start) / (k - 1);
    let prev = 0;
    for (let i = 0; i < k; i++) {
      const v = i === k - 1 ? n : roundHalfEven(start + i * step);
      const c = Math.min(n, Math.max(1, v));
      if (c > prev) { out.push(c); prev = c; }
    }
    return out;
  }

  /* ---------- byte lookup tables (MSB first) ---------- */
  // For each byte: popcount, prefix popcounts, leading/trailing run, and the
  // complete runs strictly inside it (at most 6: lead 1 + 6 alternating + trail 1).
  const POP = new Uint8Array(256);
  const PREFIX = new Uint8Array(256 * 9);   // PREFIX[b*9 + j] = heads among the first j bits
  const LEAD = new Uint8Array(256);
  const TRAIL = new Uint8Array(256);
  const INNER_N = new Uint8Array(256);
  const INNER_LEN = new Uint8Array(256 * 6);
  const INNER_OFF = new Uint8Array(256 * 6);  // offset of the run's first bit within the byte
  for (let b = 0; b < 256; b++) {
    const bits = [];
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    let p = 0;
    PREFIX[b * 9] = 0;
    for (let j = 0; j < 8; j++) { p += bits[j]; PREFIX[b * 9 + j + 1] = p; }
    POP[b] = p;
    const runs = [];  // [value, length, offset]
    for (let i = 0; i < 8;) {
      let j = i;
      while (j < 8 && bits[j] === bits[i]) j++;
      runs.push([bits[i], j - i, i]);
      i = j;
    }
    LEAD[b] = runs[0][1];
    TRAIL[b] = runs[runs.length - 1][1];
    const inner = runs.length > 2 ? runs.slice(1, -1) : [];
    INNER_N[b] = inner.length;
    inner.forEach(([, len, off], i) => { INNER_LEN[b * 6 + i] = len; INNER_OFF[b * 6 + i] = off; });
  }

  /* ---------- accumulator ---------- */
  // Consumes tosses in any number of pieces (packed bytes or single bits) and
  // keeps exact counts. The run in progress is carried between pieces, so
  // streaks across chunk boundaries are counted exactly.
  class Accumulator {
    constructor(n) {
      this.n = n;
      this.done = 0;
      this.heads = 0;
      this.runs = 0;           // completed runs
      this.curVal = -1;        // run in progress
      this.curLen = 0;
      this.curStart = 0;       // 0-based
      this.longest = [[0, 0], [0, 0]];  // [tails, heads] -> [length, 0-based start]
      this.hist = [new Float64Array(64), new Float64Array(64)];
      this.points = samplePoints(n);
      this.pi = 0;
      this.next = this.points[0];
      this.series = [];
      this.seq = n <= SEQUENCE_LIMIT ? [] : null;
    }

    _close() {
      const v = this.curVal, len = this.curLen;
      if (!len) return;
      let h = this.hist[v];
      if (len >= h.length) { const g = new Float64Array(len * 2); g.set(h); this.hist[v] = h = g; }
      h[len]++;
      if (len > this.longest[v][0]) this.longest[v] = [len, this.curStart];
      this.runs++;
    }

    _point(headsAtPoint) {
      this.series.push([this.next, headsAtPoint / this.next]);
      this.next = this.points[++this.pi];
    }

    /** bits: array-like of 0/1. */
    feedBits(bits) {
      const m = bits.length;
      if (this.done + m > this.n) throw new RangeError("fed more tosses than n");
      for (let i = 0; i < m; i++) {
        const v = bits[i] ? 1 : 0, pos = this.done;
        if (v === this.curVal) this.curLen++;
        else { this._close(); this.curVal = v; this.curLen = 1; this.curStart = pos; }
        this.heads += v;
        this.done = pos + 1;
        if (this.done === this.next) this._point(this.heads);
        if (this.seq) this.seq.push(v ? "H" : "T");
      }
    }

    /** bytes: Uint8Array of packed tosses (MSB first); uses the first nbits bits. */
    feedBytes(bytes, nbits = bytes.length * 8) {
      if (this.done + nbits > this.n) throw new RangeError("fed more tosses than n");
      const full = nbits >> 3;
      if (this.seq) {  // small runs: the simple path also records the sequence
        const bits = new Uint8Array(nbits);
        for (let i = 0; i < nbits; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
        this.feedBits(bits);
        return;
      }
      let heads = this.heads, off = this.done;
      let curVal = this.curVal, curLen = this.curLen, curStart = this.curStart;
      let runs = this.runs;
      let hH = this.hist[1], hT = this.hist[0];
      let lH = this.longest[1][0], lHs = this.longest[1][1], lT = this.longest[0][0], lTs = this.longest[0][1];
      let next = this.next;
      const pts = this.points, series = this.series;
      let pi = this.pi;
      for (let i = 0; i < full; i++, off += 8) {
        const b = bytes[i];
        while (next <= off + 8) {  // a sample point falls inside this byte
          series.push([next, (heads + PREFIX[b * 9 + (next - off)]) / next]);
          next = pts[++pi];
        }
        heads += POP[b];
        const first = b >> 7, lead = LEAD[b];
        if (first === curVal) curLen += lead;
        else {
          if (curLen) {  // close the run in progress
            if (curVal === 1) { if (curLen >= hH.length) hH = grow(hH, curLen); hH[curLen]++; if (curLen > lH) { lH = curLen; lHs = curStart; } }
            else { if (curLen >= hT.length) hT = grow(hT, curLen); hT[curLen]++; if (curLen > lT) { lT = curLen; lTs = curStart; } }
            runs++;
          }
          curVal = first; curLen = lead; curStart = off;
        }
        if (lead === 8) continue;  // uniform byte: the run stays open
        // The current run ends inside this byte.
        if (curVal === 1) { if (curLen >= hH.length) hH = grow(hH, curLen); hH[curLen]++; if (curLen > lH) { lH = curLen; lHs = curStart; } }
        else { if (curLen >= hT.length) hT = grow(hT, curLen); hT[curLen]++; if (curLen > lT) { lT = curLen; lTs = curStart; } }
        // Complete runs strictly inside the byte alternate in value, starting with !first.
        const k = INNER_N[b];
        let v = first ^ 1;
        for (let j = 0; j < k; j++, v ^= 1) {
          const len = INNER_LEN[b * 6 + j];
          if (v === 1) { hH[len]++; if (len > lH) { lH = len; lHs = off + INNER_OFF[b * 6 + j]; } }
          else { hT[len]++; if (len > lT) { lT = len; lTs = off + INNER_OFF[b * 6 + j]; } }
        }
        runs += k + 1;
        curVal = b & 1; curLen = TRAIL[b]; curStart = off + 8 - curLen;
      }
      this.pi = pi;
      this.heads = heads; this.done = off;
      this.curVal = curVal; this.curLen = curLen; this.curStart = curStart; this.runs = runs;
      this.hist[1] = hH; this.hist[0] = hT;
      this.longest[1] = [lH, lHs]; this.longest[0] = [lT, lTs];
      this.next = next;
      const rest = nbits - full * 8;
      if (rest) {
        const b = bytes[full], bits = new Uint8Array(rest);
        for (let i = 0; i < rest; i++) bits[i] = (b >> (7 - i)) & 1;
        this.feedBits(bits);
      }
    }

    finish() {
      if (this.done !== this.n) throw new RangeError("finish() before all tosses were fed");
      this._close();
      const [lt, lh] = this.longest;
      return {
        n: this.n,
        heads: this.heads,
        tails: this.n - this.heads,
        runs: this.runs,
        longest_heads: lh[0],
        longest_heads_start: lh[0] ? lh[1] + 1 : null,  // 1-based toss index
        longest_tails: lt[0],
        longest_tails_start: lt[0] ? lt[1] + 1 : null,
        hist_heads: trim(this.hist[1]),
        hist_tails: trim(this.hist[0]),
        series: this.series,
        sequence: this.seq ? this.seq.join("") : null,
      };
    }
  }

  function grow(h, len) { const g = new Float64Array(Math.max(len + 1, h.length * 2)); g.set(h); return g; }

  /** Histogram as a plain list indexed by streak length (index 0 unused), trailing zeros removed. */
  function trim(h) {
    let last = h.length - 1;
    while (last > 0 && h[last] === 0) last--;
    return last > 0 ? Array.from(h.subarray(0, last + 1)) : [0];
  }

  /** Toss n coins. randomBytes(buf) fills a Uint8Array (max 65,536 bytes per call). */
  function simulate(n, { randomBytes, progress, chunkBytes = 65536 } = {}) {
    validateN(n);
    const acc = new Accumulator(n);
    const buf = new Uint8Array(chunkBytes);
    let remaining = n;
    while (remaining) {
      const m = Math.min(chunkBytes * 8, remaining);
      const view = buf.subarray(0, (m + 7) >> 3);
      randomBytes(view);
      acc.feedBytes(view, m);
      remaining -= m;
      if (progress) progress(acc.done, n);
    }
    return acc.finish();
  }

  /* ---------- statistics ---------- */
  const SQRT_PI = Math.sqrt(Math.PI);

  /** Complementary error function, relative error ~1e-15 across the range. */
  function erfc(x) {
    if (x < 0) return 2 - erfc(-x);
    if (x < 2.5) {
      // erf(x) = 2/√π · e^(−x²) · Σ (2x²)^k x / (1·3·…·(2k+1)); all terms positive.
      let term = x, sum = x;
      const x2 = 2 * x * x;
      for (let k = 1; k < 200; k++) {
        term *= x2 / (2 * k + 1);
        sum += term;
        if (term < sum * 1e-17) break;
      }
      return 1 - (2 / SQRT_PI) * Math.exp(-x * x) * sum;
    }
    if (x > 27.3) {
      // e^(−x²) underflows; work in logs.
      const logv = -x * x - Math.log(x * SQRT_PI) + Math.log(cfTail(x) * x);
      return Math.exp(logv);
    }
    return (Math.exp(-x * x) / SQRT_PI) * cfTail(x);
  }
  // Continued fraction 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + ...)))), evaluated with modified Lentz.
  function cfTail(x) {
    const tiny = 1e-300;
    let f = x, C = x, D = 0;
    for (let k = 1; k < 500; k++) {
      const a = k / 2;
      D = x + a * D; if (Math.abs(D) < tiny) D = tiny; D = 1 / D;
      C = x + a / C; if (Math.abs(C) < tiny) C = tiny;
      const delta = C * D;
      f *= delta;
      if (Math.abs(delta - 1) < 1e-16) break;
    }
    return 1 / f;
  }

  const twoSidedP = (z) => erfc(Math.abs(z) / Math.SQRT2);

  function fairness(n, heads) {
    const z = (2 * heads - n) / Math.sqrt(n);
    return {
      heads_pct: (100 * heads) / n,
      deviation: heads / n - 0.5,
      deviation_heads: heads - n / 2,
      sigma: Math.sqrt(n) / 2,
      z_score: z,
      p_value: twoSidedP(z),
    };
  }

  /** Wald–Wolfowitz runs test. */
  function runsTest(n, heads, runs) {
    const n1 = heads, n2 = n - heads;
    if (n1 === 0 || n2 === 0) return { runs, expected_runs: n ? 1 : 0, runs_z: null, runs_p: null };
    const a = 2 * n1 * n2;  // up to ~2.3e18: not exact as a double, but its relative error (~1e-16) is negligible here
    const expected = a / n + 1;
    const v = (a * (a - n)) / (n * n * (n - 1));
    const z = v > 0 ? (runs - expected) / Math.sqrt(v) : null;
    return { runs, expected_runs: expected, runs_z: z, runs_p: z == null ? null : twoSidedP(z) };
  }

  function verdict(p) {
    if (p == null) return "Not enough tosses to test.";
    if (p >= 0.05) return "Consistent with a fair coin.";
    if (p >= 0.01) return "Mildly unusual (p < 0.05), but this happens about 1 in 20 fair sessions.";
    if (p >= 0.001) return "Unusual (p < 0.01) for a fair coin: about 1 in 100 sessions or rarer.";
    return "Very unusual (p < 0.001) for a fair coin. Rare luck, or something is off.";
  }

  function analyze({ n, heads, runs }) {
    const f = fairness(n, heads), r = runsTest(n, heads, runs);
    return {
      ...f, ...r,
      verdict: verdict(f.p_value),
      runs_verdict: verdict(r.runs_p),
      expected_longest: n >= 2 ? Math.log2(n / 2) : 1,
    };
  }

  /* ---------- pick mode ---------- */
  // Each round shows two coins (A, B) and the user keeps one.
  // pairs: string of 2n "H"/"T", round i = characters 2i (A) and 2i+1 (B).
  function makePairs(n, randomBytes) {
    validateN(n, PICK_MAX);
    const bytes = new Uint8Array((2 * n + 7) >> 3);
    randomBytes(bytes);
    let s = "";
    for (let i = 0; i < 2 * n; i++) s += (bytes[i >> 3] >> (7 - (i & 7))) & 1 ? "H" : "T";
    return s;
  }

  function validatePicks(picks, n) {
    if (!Array.isArray(picks) || picks.length < 1 || picks.length > n) throw new RangeError(`picks must be a list of 1 to ${n} choices`);
    if (picks.some((p) => p !== 0 && p !== 1)) throw new RangeError("each pick must be 0 (coin A) or 1 (coin B)");
    return picks;
  }

  /** Kept sequence (0/1) and choice summary for the first picks.length rounds. */
  function resolvePicks(pairs, n, picks) {
    validatePicks(picks, n);
    const m = picks.length, kept = new Uint8Array(m);
    let choices = 0, choseHeads = 0, choseB = 0, rawHeads = 0;
    for (let i = 0; i < m; i++) {
      const a = pairs[2 * i] === "H" ? 1 : 0, b = pairs[2 * i + 1] === "H" ? 1 : 0;
      const k = picks[i] ? b : a;
      kept[i] = k;
      rawHeads += a + b;
      choseB += picks[i];
      if (a !== b) { choices++; choseHeads += k; }
    }
    return { kept, summary: { rounds: m, choices, chose_heads: choseHeads, chose_b: choseB, raw_heads: rawHeads } };
  }

  function choiceVerdict(p, z) {
    const side = z > 0 ? "heads" : "tails";
    if (p >= 0.05) return "No clear preference: your picks look like a coin flip.";
    if (p >= 0.001) return `You lean towards ${side} (p < 0.05).`;
    return `You strongly favour ${side} (p < 0.001).`;
  }

  function analyzeChoices(s) {
    const out = { ...s }, c = s.choices, rawTotal = 2 * s.rounds;
    if (c) {
      const f = fairness(c, s.chose_heads);
      Object.assign(out, { chose_heads_pct: (100 * s.chose_heads) / c, choice_z: f.z_score, choice_p: f.p_value,
        choice_verdict: choiceVerdict(f.p_value, f.z_score) });
    } else {
      Object.assign(out, { chose_heads_pct: null, choice_z: null, choice_p: null,
        choice_verdict: "The coins always matched, so you never had a real choice." });
    }
    const raw = fairness(rawTotal, s.raw_heads);
    Object.assign(out, { raw_total: rawTotal, raw_heads_pct: (100 * s.raw_heads) / rawTotal,
      raw_z: raw.z_score, raw_p: raw.p_value, raw_verdict: verdict(raw.p_value) });
    out.chose_b_pct = (100 * s.chose_b) / s.rounds;
    return out;
  }

  /* ---------- stored sessions ---------- */
  /** Session record (as stored) -> full payload for the UI. Derived stats are recomputed; tosses never are. */
  function sessionPayload(summary, detail) {
    const n = summary.n_tosses;
    const out = { ...summary, ...analyze({ n, heads: summary.heads, runs: summary.runs }) };
    out.series = detail.series;
    out.hist_heads = detail.hist_heads;
    out.hist_tails = detail.hist_tails;
    out.sequence = detail.sequence ?? null;
    out.pick = null;
    if (detail.pick) {
      const p = detail.pick;
      out.pick = { ...analyzeChoices({ rounds: n, choices: p.choices, chose_heads: p.chose_heads, chose_b: p.chose_b, raw_heads: p.raw_heads }),
        pairs: p.pairs, picks: p.picks };
    }
    return out;
  }

  function lifetime(rows) {
    if (!rows.length) {
      return { sessions: 0, tosses: 0, heads: 0, tails: 0, heads_pct: null, z_score: null, p_value: null,
        cumulative: [], z_scores: [], longest_streak: null, records: {} };
    }
    let tosses = 0, heads = 0;
    const cumulative = [];
    for (const r of rows) {
      tosses += r.n_tosses; heads += r.heads;
      cumulative.push({ session_id: r.id, created_at: r.created_at, tosses, heads_pct: (100 * heads) / tosses });
    }
    const f = fairness(tosses, heads);
    const brief = (r, extra = {}) => ({ session_id: r.id, created_at: r.created_at, label: r.label, n_tosses: r.n_tosses, ...extra });
    const maxBy = (arr, key) => arr.reduce((best, r) => (key(r) > key(best) ? r : best));  // first (oldest) wins ties
    const lh = maxBy(rows, (r) => r.longest_heads), lt = maxBy(rows, (r) => r.longest_tails);
    const longest = lh.longest_heads >= lt.longest_tails
      ? brief(lh, { side: "H", length: lh.longest_heads, start: lh.longest_heads_start })
      : brief(lt, { side: "T", length: lt.longest_tails, start: lt.longest_tails_start });
    const big = maxBy(rows, (r) => r.n_tosses), lop = maxBy(rows, (r) => Math.abs(r.z_score));
    const records = {
      biggest: brief(big),
      most_lopsided: brief(lop, { z_score: lop.z_score, p_value: lop.p_value, heads_pct: (100 * lop.heads) / lop.n_tosses }),
      longest_heads: brief(lh, { length: lh.longest_heads, start: lh.longest_heads_start }),
      longest_tails: brief(lt, { length: lt.longest_tails, start: lt.longest_tails_start }),
    };
    const pct = rows.filter((r) => r.n_tosses >= 100);
    if (pct.length) {
      const e = maxBy(pct, (r) => Math.abs(r.heads / r.n_tosses - 0.5));
      records.most_extreme_pct = brief(e, { heads_pct: (100 * e.heads) / e.n_tosses });
    }
    return { sessions: rows.length, tosses, heads, tails: tosses - heads, heads_pct: (100 * heads) / tosses,
      z_score: f.z_score, p_value: f.p_value, cumulative, z_scores: rows.map((r) => r.z_score),
      longest_streak: longest, records };
  }

  /** pickRows: [{n_tosses, heads, pick: {choices, chose_heads, chose_b, raw_heads}}] */
  function pickLifetime(pickRows) {
    if (!pickRows.length) return null;
    const t = { rounds: 0, kept_heads: 0, choices: 0, chose_heads: 0, chose_b: 0, raw_heads: 0 };
    for (const r of pickRows) {
      t.rounds += r.n_tosses; t.kept_heads += r.heads;
      for (const k of ["choices", "chose_heads", "chose_b", "raw_heads"]) t[k] += r.pick[k];
    }
    return { ...analyzeChoices(t), sessions: pickRows.length, kept_heads: t.kept_heads,
      kept_heads_pct: (100 * t.kept_heads) / t.rounds };
  }

  const api = {
    MIN_TOSSES, MAX_TOSSES, SERIES_POINTS, SEQUENCE_LIMIT, PICK_MAX,
    validateN, samplePoints, Accumulator, simulate,
    erfc, twoSidedP, fairness, runsTest, verdict, analyze,
    makePairs, validatePicks, resolvePicks, analyzeChoices,
    sessionPayload, lifetime, pickLifetime,
  };
  root.CoinEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
