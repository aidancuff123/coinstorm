// Simulation worker: runs off the main thread so the page stays responsive.
// Message in:  { n }
// Messages out: { type: "progress", done, n } (at most every ~100 ms),
//               { type: "done", result, duration_ms } or { type: "error", message }
importScripts("engine.js");

self.onmessage = (e) => {
  const { n } = e.data;
  const t0 = performance.now();
  let last = 0;
  try {
    const result = CoinEngine.simulate(n, {
      randomBytes: (buf) => crypto.getRandomValues(buf),  // the browser's CSPRNG, ≤ 65,536 bytes per call
      progress(done, total) {
        const now = performance.now();
        if (now - last > 100 || done === total) { last = now; self.postMessage({ type: "progress", done, n: total }); }
      },
    });
    self.postMessage({ type: "done", result, duration_ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ type: "error", message: err.message || String(err) });
  }
};
