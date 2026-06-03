#!/usr/bin/env bash
#
# Bare-exec lint guard.
#
# Fails (exit 1) if a shell-interpolated exec template literal — execP(`...`)
# or execPNR(`...`) — appears anywhere under apps/backend/src, outside the two
# files that legitimately define the raw exec primitives (helpers/exec.ts) and
# the allowlisted argv-only runner (helpers/run.ts).
#
# These backtick patterns build a shell command string from interpolated
# values and run it through `sh -c`, which is the exact injection surface
# helpers/run.ts was built to eliminate. New OS calls must go through
# run()/runWithStdin().
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../src"

# GNU grep ERE: matches `execP(` or `execPNR(` immediately followed by a backtick.
PATTERN='execP(NR)?\(`'

matches="$(grep -rnE "$PATTERN" "$SRC_DIR" --include='*.ts' \
	| grep -v -e 'helpers/exec.ts' -e 'helpers/run.ts' || true)"

if [ -n "$matches" ]; then
	echo "✗ bare-exec guard: shell-interpolated exec template literals found:" >&2
	echo "$matches" >&2
	echo >&2
	echo "Route OS calls through helpers/run.ts run()/runWithStdin() instead." >&2
	exit 1
fi

echo "✓ bare-exec guard: no shell-interpolated exec template literals"
