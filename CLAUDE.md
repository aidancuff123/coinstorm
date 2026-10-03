# Coin Toss Simulator — Project Spec

iPhone-first installable PWA that simulates coin tosses, analyzes results, logs every session, and tracks analytics across sessions over time. Hosted standalone on this VM (`coinstorm-dev`, GCP project coinstorm-sim-2026, public IP 34.138.75.129).

## Ground rules
- This VM is dedicated to coinstorm (4 vCPU, 15 GiB RAM, no swap, Ubuntu 24.04). Poopmap lives elsewhere and is out of scope.
- Caddy is not installed yet; it will be installed here (with approval) to serve the app.
- Ask for my approval before: editing the Caddyfile, reloading Caddy, creating/enabling systemd units, or installing system packages. Run `caddy validate` before any reload.
- Minimal dependencies (numpy is fine). No frontend framework or build step: vanilla HTML/CSS/JS.
- Write pytest tests for the simulation and stats modules and run them before calling a feature done.
- Use git; commit at each working milestone.

## Stack
- FastAPI + uvicorn in a project venv
- SQLite (WAL mode), single file in the project dir
- Chart.js vendored into static/vendor/ (no runtime CDN)
- Caddy (to be installed on this VM) with a coinstorm site block (automatic HTTPS)
- systemd unit with restart on failure
- DuckDNS subdomain: coinstorm.duckdns.org → 34.138.75.129.

## Features

1. Run a session
- Input: number of tosses, 1 to 2,147,483,647 (max signed 32-bit int), plus an optional label
- Every toss is simulated individually with a cryptographic RNG (`secrets` / `os.urandom`, or numpy PCG64 seeded from `secrets` if urandom is a bottleneck; benchmark and tell me which you chose). No statistical shortcuts: all stats are exact.
- ≤20 tosses: short coin-flip animation revealing results one by one
- Large runs: process in chunks (~64M flips each) with numpy, carrying streak and run state across chunk boundaries. Peak memory must stay under ~200 MB; this VM may be small.
- Runs above ~1,000,000 tosses execute as a background job: POST returns a job id, the frontend polls a progress endpoint (or uses SSE) and shows a progress bar with flips done / total and an ETA. One job at a time; reject or queue a second.

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

## Data model (suggested)
- sessions: id, created_at, label, n_tosses, heads, tails, longest_heads, longest_tails, streak start positions, runs, z_score, p_value, duration_ms
- session_series: downsampled running proportion (JSON), streak histograms (JSON)
- session_sequence: packed bit blob, only stored when n_tosses ≤ 10,000
- Every session screen must redraw from stored data. Never re-simulate.

## API (suggested)
- POST /api/sessions {n, label?} → full result (small n) or job id (large n)
- GET /api/jobs/{id} → progress, then result when done
- GET /api/sessions?limit&offset&sort
- GET /api/sessions/{id}
- DELETE /api/sessions/{id}
- GET /api/stats/lifetime
- Validate server-side: integer, 1 ≤ n ≤ 2,147,483,647

## iPhone / PWA
- manifest.webmanifest (display: standalone, theme color, icons). Generate a simple coin icon: 180px apple-touch-icon plus 192/512 PNGs.
- Apple web-app meta tags; respect env(safe-area-inset-*)
- Bottom tab bar: Toss · Log · Stats
- Dark mode via prefers-color-scheme, large tap targets, inputmode="numeric", thousands separators on large numbers
- Quick-pick buttons: 10 / 100 / 1K / 1M / 100M / MAX
- Service worker caching the app shell

## Access
Single user, no accounts, public by default. If light protection is possible without breaking standalone PWA mode (Caddy basic auth often misbehaves there), propose it and let me decide.

## Later (not v1)
Biased-coin mode, CSV export, coin-edge easter egg (~1 in 6,000), side-by-side session comparison.

## Done means
- Tests pass, including: chunked streak/runs logic matches a naive implementation on random inputs (with streaks spanning chunk boundaries), and input validation at the limits
- Benchmark of a max-size run on this VM, reporting time and peak memory
- Live over HTTPS on the new subdomain
- Installs to the iPhone home screen and runs standalone
- systemd unit enabled and survives reboot
- README.md covering run, deploy, and SQLite backup
