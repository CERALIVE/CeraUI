#!/usr/bin/env bash
#
# RC-pin merge gate (coherence-contract-pass — @ceralive/control-protocol RC hygiene).
#
# Fails (exit non-zero) when any committed package.json / bun.lock still pins a
# PRERELEASE (`-rc.`) of a shared @ceralive schema/engine package. An rc pin is
# legitimate ONLY on the short-lived W2/W3 integration-bridge branch; before a PR
# merges into a canonical branch the pin MUST be swapped for the exact STABLE
# CalVer version. See control-protocol/README.md -> "RC hygiene / merge gate".
#
# Covers BOTH @ceralive/control-protocol AND @ceralive/cerastream. The `-rc.`
# anchor matches `2026.7.0-rc.1` but never a stable `2026.7.0`.
#
# This is the SAME guard documented in the coherence-contract-pass todo-3 notepad;
# `!`-inverting `git grep` means "no rc pin found" (grep exit 1) is a PASS, and any
# match (grep exit 0) is a FAIL.
set -euo pipefail

# The single source-of-truth pattern (todo-3 notepad). Matches a package spec line
# `"@ceralive/control-protocol": "...-rc..."` (or cerastream) in package.json/bun.lock.
PATTERN='"@ceralive/(control-protocol|cerastream)"[^"]*"[^"]*-rc\.'

if git grep -nE "$PATTERN" -- '**/package.json' '**/bun.lock' 'bun.lock' 'package.json'; then
	echo "::error::RC pin of a shared @ceralive schema/engine package found (see above)."
	echo "Swap the -rc. prerelease pin for the exact stable CalVer version before merging."
	exit 1
fi

echo "OK: no @ceralive/{control-protocol,cerastream} -rc. prerelease pins."
