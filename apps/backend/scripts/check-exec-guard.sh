#!/usr/bin/env bash
#
# Exec / spawn-policy lint guard (Standards S1 + S2).
#
# Three structural gates over apps/backend/src, all sourced from the
# spawn-policy registry (helpers/spawn-policy.ts):
#
#   1. Bare-exec guard — fails if a shell-interpolated exec template literal —
#      execP(`...`) or execPNR(`...`) — appears outside the two files that
#      legitimately define the raw exec primitives (helpers/exec.ts) and the
#      allowlisted argv-only runner (helpers/run.ts). These backtick patterns
#      build a shell command string from interpolated values and run it through
#      `sh -c`, the exact injection surface helpers/run.ts was built to remove.
#
#   2. Spawn-policy contract gate (S1/S2) — parses the SPAWN_POLICY registry and
#      enforces the per-class contract on every declared site:
#        - bounded-command / bounded-probe MUST be timed (or streamingExempt)
#          and MUST NOT be lifetime-timeout-exempt or carry supervision flags.
#        - supervised-worker MUST NOT carry a process-lifetime timeout (a
#          lifetime cap would kill the live stream), MUST be lifetime-exempt,
#          and MUST declare a startup timeout + shutdown cleanup.
#        - watcher MUST NOT be timed, MUST be lifetime-exempt, MUST register a
#          shutdown-abort.
#        - terminal-spawnSync MUST carry no timeout/supervision contract.
#      This mirrors validateSpawnSite() in spawn-policy.ts so a drifted registry
#      fails CI, not just the unit test.
#
#   3. Registration gate (S1/S2) — every production source file that spawns via a
#      managed primitive (spawnWatcher / superviseWorker / Bun.spawnSync — the
#      watcher, supervised-worker and terminal-spawnSync surfaces) MUST appear in
#      the registry's `file:` set. A watcher/terminal spawn that is not registered
#      is an unaccounted-for child process and fails the gate.
#
# New OS calls must go through run()/runWithStdin() (helpers/run.ts) and every
# child-process site must be classified in spawn-policy.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../src"
POLICY_FILE="$SRC_DIR/helpers/spawn-policy.ts"

if [ ! -f "$POLICY_FILE" ]; then
	echo "✗ spawn-policy guard: registry not found at $POLICY_FILE" >&2
	exit 1
fi

# ── 1. Bare-exec guard ────────────────────────────────────────────────────────
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

# ── 2. Spawn-policy contract gate (S1/S2) ─────────────────────────────────────
# Parse the SPAWN_POLICY array and validate each site's DECLARED contract against
# its class invariants — the same rules validateSpawnSite() enforces in TS.
policy_errs="$(awk '
	function val(line,   v) {
		v = line
		sub(/^[^:]*:[[:space:]]*/, "", v)
		sub(/,.*$/, "", v)
		gsub(/[[:space:]]/, "", v)
		gsub(/"/, "", v)
		return v
	}
	function emit(m) { print id ": " m }
	function validate(   ) {
		if (id == "") return
		if (cls == "bounded-command" || cls == "bounded-probe") {
			if (timed != "true" && streaming != "true")
				emit(cls " must be timed (or explicitly streamingExempt)")
			if (life == "true")
				emit(cls " must NOT be lifetime-timeout-exempt")
			if (startup == "true" || cleanup == "true" || abort == "true")
				emit("bounded site must not carry supervision flags")
		} else if (cls == "supervised-worker") {
			if (timed == "true")
				emit("supervised-worker must NOT carry a process-lifetime timeout")
			if (life != "true")
				emit("supervised-worker must be lifetime-timeout-exempt")
			if (startup != "true")
				emit("supervised-worker must declare a startup/readiness timeout")
			if (cleanup != "true")
				emit("supervised-worker must declare shutdown cleanup")
		} else if (cls == "watcher") {
			if (timed == "true") emit("watcher must NOT carry a timeout")
			if (life != "true") emit("watcher must be lifetime-timeout-exempt")
			if (abort != "true") emit("watcher must register a shutdown-abort")
		} else if (cls == "terminal-spawnSync") {
			if (timed == "true" || startup == "true" || cleanup == "true" || abort == "true" || life == "true")
				emit("terminal-spawnSync must carry no timeout/supervision contract")
		} else if (cls != "") {
			emit("unknown spawn class: " cls)
		}
	}
	/export const SPAWN_POLICY/ { in_array = 1; next }
	in_array && /^\] as const;/ { validate(); in_array = 0 }
	!in_array { next }
	/^[[:space:]]*id:[[:space:]]*"/ {
		validate()
		id = val($0); cls = ""; timed = ""; startup = ""
		cleanup = ""; abort = ""; life = ""; streaming = ""
		in_contract = 0
		next
	}
	/^[[:space:]]*class:[[:space:]]*"/ { cls = val($0); next }
	/^[[:space:]]*contract:[[:space:]]*\{/ { in_contract = 1; next }
	in_contract && /^[[:space:]]*\},/ { in_contract = 0; next }
	in_contract && /^[[:space:]]*timed:/ { timed = val($0); next }
	in_contract && /^[[:space:]]*startupTimeout:/ { startup = val($0); next }
	in_contract && /^[[:space:]]*shutdownCleanup:/ { cleanup = val($0); next }
	in_contract && /^[[:space:]]*shutdownAbort:/ { abort = val($0); next }
	in_contract && /^[[:space:]]*lifetimeTimeoutExempt:/ { life = val($0); next }
	in_contract && /^[[:space:]]*streamingExempt:/ { streaming = val($0); next }
' "$POLICY_FILE")"

if [ -n "$policy_errs" ]; then
	echo "✗ spawn-policy contract gate: registry contract violations:" >&2
	echo "$policy_errs" | sed 's/^/    /' >&2
	echo >&2
	echo "Fix the site's contract in helpers/spawn-policy.ts to honour its class invariants." >&2
	exit 1
fi

echo "✓ spawn-policy contract gate: every registered site honours its class contract"

# ── 3. Registration gate (S1/S2) ──────────────────────────────────────────────
# Every production file that spawns a watcher / supervised-worker / terminal
# spawnSync child must be registered in spawn-policy.ts. Test spawns and the
# registry's own primitive definitions are excluded by design.
registered_files="$(grep -oE 'file:[[:space:]]*"[^"]+"' "$POLICY_FILE" \
	| sed -E 's/.*"([^"]+)".*/\1/' | sort -u)"

unregistered=""
while IFS= read -r f; do
	[ -n "$f" ] || continue
	rel="${f#"$SRC_DIR/"}"
	case "$rel" in
		helpers/spawn-policy.ts) continue ;; # the managed primitives are DEFINED here
		tests/*) continue ;;                 # test-only spawns are excluded by design
	esac
	if ! printf '%s\n' "$registered_files" | grep -qxF "$rel"; then
		unregistered+="$rel"$'\n'
	fi
done < <(grep -rlE 'spawnWatcher\(|superviseWorker\(|Bun\.spawnSync\(' "$SRC_DIR" --include='*.ts' || true)

if [ -n "$unregistered" ]; then
	echo "✗ spawn-policy registration gate: watcher/supervised/spawnSync sites missing from the registry:" >&2
	printf '%s' "$unregistered" | sed '/^$/d; s/^/    /' >&2
	echo >&2
	echo "Classify every child-process site in helpers/spawn-policy.ts (SPAWN_POLICY)." >&2
	exit 1
fi

echo "✓ spawn-policy registration gate: every managed-spawn site is registered"
