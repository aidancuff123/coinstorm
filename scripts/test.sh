#!/bin/sh
# Run the test suite in a 2 GB memory-capped scope so a runaway allocation is
# OOM-killed on its own instead of taking down the whole VM (there is no swap).
cd "$(dirname "$0")/.." && exec systemd-run --user --scope --quiet \
    -p MemoryMax=2G -p MemorySwapMax=0 .venv/bin/pytest -q "$@"
