#!/usr/bin/env bash
# Run a memory-hungry tool (default: the visual harness) inside a bounded scope.
#
# Why: on this 3.8 GB VPS a Chromium run once triggered a global OOM that killed
# minutepapillons-print.service (see bead org-cmw). Two guards here:
#   - MemoryMax/MemorySwapMax bound the scope, so the kernel OOMs *inside* it;
#   - OOMScoreAdjust=900 makes the scope the preferred victim if the whole box
#     still runs out (the print service sits at -100).
#
# Usage:
#   scripts/run-visual.sh --mode baseline --base http://127.0.0.1:8081 --dir ...
#   MEM_MAX=1.5G scripts/run-visual.sh -- python3 heavy.py
set -euo pipefail

MEM_MAX="${MEM_MAX:-1G}"
SWAP_MAX="${SWAP_MAX:-1G}"
OOM_ADJ="${OOM_ADJ:-900}"
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--" ]; then
  shift
  CMD=("$@")
else
  CMD=(node scripts/check-visual.mjs "$@")
fi

if ! command -v systemd-run >/dev/null; then
  echo "systemd-run not available — running unbounded (RAM is the only limit)" >&2
  exec "${CMD[@]}"
fi

echo "scope: MemoryMax=$MEM_MAX MemorySwapMax=$SWAP_MAX OOMScoreAdjust=$OOM_ADJ" >&2
# A user *scope* rejects -p OOMScoreAdjust= ("Unknown assignment"), but any
# process may raise its own score for free; do that in the child, then exec.
exec systemd-run --user --scope --quiet \
  -p "MemoryMax=$MEM_MAX" \
  -p "MemorySwapMax=$SWAP_MAX" \
  -- bash -c 'echo "$1" > /proc/self/oom_score_adj; shift; exec "$@"' _ "$OOM_ADJ" "${CMD[@]}"
