// Benchmark the engine in Node: node scripts/bench.js
const E = require("../static/engine.js");
const { webcrypto } = require("node:crypto");
for (const n of [1e6, 1e8, 2147483647]) {
  const t = performance.now();
  const r = E.simulate(n, { randomBytes: (b) => webcrypto.getRandomValues(b) });
  console.log(n, ((performance.now() - t) / 1000).toFixed(2) + " s", "heads", r.heads, "rss MB", (process.memoryUsage().rss / 1e6).toFixed(0), "longest", r.longest_heads, r.longest_tails);
}
