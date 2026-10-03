#!/bin/sh
# Run the test suite in a memory-capped scope (default 512M, override with
# COINSTORM_TEST_MEM) so a runaway allocation is OOM-killed on its own instead
# of taking down the whole VM (an e2-micro with 1 GB RAM).
cd "$(dirname "$0")/.." && exec systemd-run --user --scope --quiet \
    -p MemoryMax="${COINSTORM_TEST_MEM:-512M}" -p MemorySwapMax=0 .venv/bin/pytest -q "$@"
