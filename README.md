# Coinstorm

An iPhone-first PWA coin toss simulator. It tosses up to 2,147,483,647 cryptographically random coins
per session, computes exact statistics, logs every session, and tracks lifetime analytics.

Live at **https://coinstorm.duckdns.org**. Source: https://github.com/aidancuff123/coinstorm (private). The VM pushes
with a repo-only deploy key, `~/.ssh/coinstorm_deploy`. Runs on the GCP VM `coinstorm-dev` (project
`coinstorm-sim-2026`, static IP 34.138.75.129).

## How it works

- **Randomness:** each toss is one bit from `os.urandom` (the kernel CSPRNG). On this VM urandom
  supplies 2.0 billion flips/s, so it is not the bottleneck and the seeded-PCG64 fallback is unused.
- **Exact stats in bounded memory:** tosses are generated and analysed in 128K-flip chunks
  (`app/sim.py`). The run in progress at a chunk boundary is carried into the next chunk, so streaks,
  runs and histograms are exact. The tests check this against a naive one-toss-at-a-time implementation.
- **Benchmark (max run, 2,147,483,647 tosses):** 10.1 s and 36 MB peak RSS standalone; 14.0 s and
  70 MB peak for the whole server when run through the API. 128K chunks were both fastest and smallest:
  64M chunks used 747 MB and ran 2.8× slower. Re-run with `.venv/bin/python scripts/bench.py max`
  (other modes: `rng`, `chunks`).
- **Background jobs:** runs over 1,000,000 tosses return a job id. The page polls `GET /api/jobs/{id}`
  for progress and an ETA. Only one job runs at a time; a second large request gets `409`. Job state
  lives in memory, so a restart mid-job loses that job (nothing partial is saved).
- **Storage:** SQLite in WAL mode, `coinstorm.db` in the project directory. The raw sequence is stored
  only for runs of 10,000 tosses or fewer. Every screen redraws from stored data; nothing is re-simulated.

```
app/        sim.py (simulation), stats.py (z, p, runs test), db.py, jobs.py, main.py (API)
static/     index.html, app.js, app.css, sw.js, manifest, icons/, vendor/chart.umd.min.js (Chart.js 4.5.1)
tests/      pytest suite (sim, stats, API)
scripts/    test.sh, bench.py, backup.py, make_icons.py
deploy/     coinstorm.service, Caddyfile (copies of what is installed in /etc)
```

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/sessions` | `{"n": int, "label"?: str}`. `201` with full result if n ≤ 1M, otherwise `202 {"job_id"}`. `409` if a job is running. `422` unless n is a JSON integer with 1 ≤ n ≤ 2,147,483,647. |
| GET | `/api/jobs/{id}` | `status`, `done`, `n`, `eta_s`; adds `session` when done |
| GET | `/api/jobs` | the running job, if any |
| GET | `/api/sessions` | `limit`, `offset`, `sort` (`date_desc`/`date_asc`/`size_desc`/`size_asc`), `min_n`, `max_n` |
| GET / DELETE | `/api/sessions/{id}` | |
| GET | `/api/stats/lifetime` | totals, cumulative series, z-scores, longest streak, records |

Interactive docs: https://coinstorm.duckdns.org/api/docs

## Run locally

```sh
sudo apt install python3.12-venv            # once, Ubuntu only
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
COINSTORM_DB=/tmp/dev.db .venv/bin/uvicorn --factory app.main:create_app --port 8011 --reload
```

Run the tests with `scripts/test.sh`. It runs pytest in a 2 GB memory-capped scope. The VM has no swap,
and an uncapped runaway test once OOM-killed the whole login session.

## Deploy

One-time setup (already done on `coinstorm-dev`):

1. **GCP:** reserve the IP as static (`coinstorm-ip`). Open tcp:80,443 with the firewall rule
   `coinstorm-allow-web`, which targets network tag `coinstorm-web`, and add that tag to the VM.
2. **DuckDNS:** point `coinstorm` at 34.138.75.129.
3. **App service:**
   ```sh
   sudo install -m 644 deploy/coinstorm.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now coinstorm
   ```
   Uvicorn listens on 127.0.0.1:8010 with exactly one worker (job state is in-process), runs as
   `tv1109`, restarts on failure, and has a 512 MB memory cap.
4. **Caddy:** installed from the official apt repo (`/etc/apt/sources.list.d/caddy-stable.list`).
   ```sh
   sudo install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
   sudo -u caddy caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
   Caddy obtains and renews the Let's Encrypt certificate and redirects HTTP to HTTPS.
   The stock config is saved at `/etc/caddy/Caddyfile.default.bak`.

Updating the app:

```sh
git pull                                    # or commit locally
scripts/test.sh
sudo systemctl restart coinstorm            # interrupts a running job, if any
```

If you change anything in `static/`, also bump `VERSION` in `static/sw.js`. Installed copies of the
app pick up the new shell on their next launch.

Logs: `journalctl -u coinstorm -f` (app), `/var/log/caddy/coinstorm.log` (access).

## Backup and restore

`scripts/backup.py` uses SQLite's online backup API, so it is safe while the app is running. It writes
`backups/coinstorm-YYYYmmdd-HHMMSS.db`, runs an integrity check, and keeps the newest 14 copies:

```sh
.venv/bin/python scripts/backup.py              # --dest DIR, --keep N
```

Don't back up by copying `coinstorm.db` alone while the service is running: recent writes may still
be in `coinstorm.db-wal`.

To run it nightly, add this line with `crontab -e`:

```
15 3 * * * cd /home/tv1109/projects/coinstorm && .venv/bin/python scripts/backup.py >> backups/backup.log 2>&1
```

Backups stay on the VM's disk, so copy them off the VM too, e.g.
`gcloud storage cp backups/*.db gs://<bucket>/`.

Restore:

```sh
sudo systemctl stop coinstorm
cp backups/coinstorm-YYYYmmdd-HHMMSS.db coinstorm.db && rm -f coinstorm.db-wal coinstorm.db-shm
sudo systemctl start coinstorm
```

## Install on iPhone

Open https://coinstorm.duckdns.org in Safari → Share → **Add to Home Screen**. It launches standalone
(no Safari UI) and caches the app shell for fast startup. Tossing still needs the network.

## Later

Biased-coin mode, CSV export, coin-edge easter egg (~1 in 6,000), side-by-side session comparison,
optional light access protection.
