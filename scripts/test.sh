#!/bin/sh
# Run the engine tests (Node 18+, no dependencies).
cd "$(dirname "$0")/.." && exec node --test tests/*.test.js "$@"
