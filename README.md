# Coinstorm

An iPhone-first PWA coin toss simulator. It tosses up to 2,147,483,647 cryptographically random coins
per session, computes exact statistics, logs every session, and tracks lifetime analytics.

Live at **https://aidancuff123.github.io/coinstorm/**, a static site on GitHub Pages. There is no
server: tossing, analysis and storage all happen in the browser on your device. It works offline once
it has loaded.

(It used to run as a FastAPI + SQLite server on the GCP VM `coinstorm-dev`. That version is in git
history up to commit `955d0d4`.)

## How it works

- **Randomness:** each toss is one bit from `crypto.getRandomValues`, the browser's CSPRNG.
- **Off the main thread:** every run happens in a Web Worker (`static/worker.js`), so the page stays
  responsive. Runs over 1,000,000 tosses show a progress bar with an ETA, and the app asks the phone
  to keep the screen on (Screen Wake Lock) because iOS pauses a backgrounded page.
- **Exact stats in bounded memory:** random bytes are processed 64 KB (524,288 tosses) at a time
  (`static/engine.js`), using per-byte lookup tables for run boundaries. The run in progress at a chunk
  boundary is carried into the next chunk, so streaks, runs and histograms are exact. The tests check
  this against a naive one-toss-at-a-time implementation, and the engine was checked against the old
  Python/numpy version on identical random bytes: every count, position and histogram matched.
- **Benchmark (max run, 2,147,483,647 tosses):** 8.7 s and about 53 MB in Node 22 (V8). Safari on an
  iPhone is typically slower. Re-run with `node scripts/bench.js`.
- **Storage:** IndexedDB in the browser, two object stores: `sessions` (one small summary row per
  session) and `details` (running-proportion series, streak histograms, and the H/T sequence for runs
  of 10,000 tosses or fewer). Every screen redraws from stored data; nothing is re-simulated.

```
static/     index.html, app.js (UI), engine.js (simulation, stats, pick mode, lifetime),
            store.js (IndexedDB + worker), worker.js, app.css, sw.js, manifest, icons/,
            vendor/chart.umd.min.js (Chart.js 4.5.1)
tests/      engine.test.js (node:test, no dependencies)
scripts/    test.sh, bench.js, export_db.py (old server DB → export file), make_icons.py
```

## Pick mode

Each round flips two coins and you tap the one to keep. A session is 1–10,000 rounds, and you can
finish early. When the session starts, every pair is flipped up front (`crypto.getRandomValues`) and
the unfinished session, pairs and picks so far, is saved in localStorage, so closing the app
mid-session offers **Resume**. Unfinished sessions expire after 7 days.

A pick session gets the usual analysis of the kept coins, plus:
- how many rounds were a real choice (the coins differed)
- how often you kept heads when they did, with a z-test for a heads preference
- coin A vs. coin B
- a fairness check on every coin shown

Your choices bias the kept results, so pick sessions are excluded from lifetime fairness stats
(totals, charts, records) and get their own summary card on the Stats tab.

## Your data

Sessions are stored **in this browser on this device only**. They don't sync between devices, and
clearing Safari's website data deletes them.

- **Add it to your Home Screen.** Safari can delete storage for websites you haven't opened in 7 days.
  Home Screen apps are exempt.
- **Stats → Your data → Export backup** saves everything as one JSON file (on iPhone through the share
  sheet: Save to Files, AirDrop, …). **Import…** merges a backup back in; sessions already present are
  skipped, so importing twice is harmless.

### Moving history over from the old server

```sh
python3 scripts/export_db.py coinstorm.db coinstorm-export.json   # standard library only
```

Then import `coinstorm-export.json` on the Stats tab.

## Run locally

Any static file server works, for example:

```sh
python3 -m http.server -d static 8011    # then open http://localhost:8011/
```

Run the tests with `scripts/test.sh` (Node 18+).

## Deploy

Every push to `main` runs the tests and publishes `static/` to GitHub Pages
(`.github/workflows/pages.yml`). One-time setup: **Settings → Pages → Source: GitHub Actions**.

If you change anything in `static/`, also bump `VERSION` in `static/sw.js`. Installed copies of the
app pick up the new shell on their next launch. All paths are relative, so the app works at any base
path.

## Install on iPhone

Open https://aidancuff123.github.io/coinstorm/ in Safari → Share → **Add to Home Screen**. It launches
standalone (no Safari UI) and works offline.

## Later

Biased-coin mode, CSV export, coin-edge easter egg (~1 in 6,000), side-by-side session comparison.
