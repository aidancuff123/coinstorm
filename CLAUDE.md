# Coin Toss Simulator — Project Spec

iPhone-first installable PWA that simulates coin tosses, analyzes results, logs every session, and tracks analytics across sessions over time. Hosted as a static site on GitHub Pages: https://aidancuff123.github.io/coinstorm/. No server; everything runs in the browser.

## Ground rules
- Static files only, in `static/`. No backend, no build step, no frontend framework: vanilla HTML/CSS/JS.
- Minimal dependencies. Chart.js stays vendored in static/vendor/ (no runtime CDN).
- All paths relative, so the app works under /coinstorm/. Bump `VERSION` in static/sw.js when a shell file changes.
- Write tests (node:test, `scripts/test.sh`) for the engine and run them before calling a feature done.
- Use git; commit at each working milestone. Pushing to main deploys.

## Stack
- static/engine.js: simulation, statistics, pick mode, lifetime analytics (pure functions; also loaded by Node tests)
- static/worker.js: runs simulations in a Web Worker with crypto.getRandomValues
- static/store.js: IndexedDB storage (stores `sessions` and `details`), pick drafts in localStorage, export/import
- GitHub Actions workflow tests and publishes static/ to GitHub Pages

## Features

1. Run a session
- Input: number of tosses, 1 to 2,147,483,647 (max signed 32-bit int), plus an optional label
- Every toss is simulated individually with a cryptographic RNG (`crypto.getRandomValues`). No statistical shortcuts: all stats are exact.
- ≤20 tosses: short coin-flip animation revealing results one by one
- Large runs: process in chunks, carrying streak and run state across chunk boundaries. Peak memory must stay small (phones).
- All runs execute in a Web Worker. Runs above 1,000,000 tosses show a progress bar with flips done / total and an ETA. One run at a time.

2. Session analytics
- Heads/tails counts and %, deviation from 50% (absolute and in σ)
- z-score and two-sided p-value vs. a fair coin, with a plain-language verdict
- Longest heads streak and longest tails streak, with positions
- Runs count vs. expected (Wald–Wolfowitz runs test)
- Charts: running proportion of heads with a 0.5 line and ±2σ band (~1,000 downsampled points, recorded during simulation); streak-length histogram for heads and tails
- ≤200 tosses: show the sequence as a strip of H/T chips

3. Session log
- List of sessions: date/time, label, toss count, heads %, longest streak
- Tap to reopen full analytics; delete with confirmation; sort/filter by date or size

4. Lifetime analytics
- Totals: sessions, tosses, heads, tails, overall heads %
- Cumulative heads % over time (line chart)
- Longest streak ever and which session it came from
- Distribution of per-session z-scores vs. the standard normal curve
- Records: biggest session, most lopsided session, etc.

## Data model
- IndexedDB `sessions`: id, created_at, label, n_tosses, heads, tails, longest_heads(+_start), longest_tails(+_start), runs, z_score, p_value, duration_ms, mode, pick summary
- IndexedDB `details` (same id): series, hist_heads, hist_tails, sequence (H/T string, only when n_tosses ≤ 10,000), pick pairs/picks
- Every session screen must redraw from stored data. Never re-simulate.
- Export/import as a single JSON file (Stats tab). scripts/export_db.py converts the old server's SQLite DB to that format.

## iPhone / PWA
- manifest.webmanifest (display: standalone, theme color, icons). Generate a simple coin icon: 180px apple-touch-icon plus 192/512 PNGs.
- Apple web-app meta tags; respect env(safe-area-inset-*)
- Bottom tab bar: Toss · Log · Stats
- Dark mode via prefers-color-scheme, large tap targets, inputmode="numeric", thousands separators on large numbers
- Quick-pick buttons: 10 / 100 / 1K / 1M / 100M / MAX
- Service worker caching the app shell

## Access
Single user, no accounts. Data is per device (IndexedDB), so nothing is shared publicly.

## Later (not v1)
Biased-coin mode, CSV export, coin-edge easter egg (~1 in 6,000), side-by-side session comparison.

## Done means
- Tests pass, including: chunked streak/runs logic matches a naive implementation on random inputs (with streaks spanning chunk boundaries), and input validation at the limits
- Benchmark of a max-size run (`node scripts/bench.js`), reporting time and peak memory
- Live on GitHub Pages over HTTPS
- Installs to the iPhone home screen, runs standalone and offline
- README.md covering run, deploy, and backup/export
