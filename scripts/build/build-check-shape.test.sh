#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$repo_root/.github/workflows/build-check.yml"

fail() {
	printf 'build-check workflow shape: %s\n' "$1" >&2
	exit 1
}

assert_contains() {
	local haystack="$1"
	local needle="$2"
	local description="$3"
	if ! grep -Fq -- "$needle" <<<"$haystack"; then
		fail "$description"
	fi
}

assert_not_contains() {
	local haystack="$1"
	local needle="$2"
	local description="$3"
	if grep -Fq -- "$needle" <<<"$haystack"; then
		fail "$description"
	fi
}

assert_count() {
	local haystack="$1"
	local needle="$2"
	local expected="$3"
	local description="$4"
	local actual
	actual="$(grep -Foc -- "$needle" <<<"$haystack" || true)"
	if [[ "$actual" != "$expected" ]]; then
		fail "$description (expected $expected, got $actual)"
	fi
}

extract_job() {
	local job="$1"
	awk -v target="$job" '
		$0 == "  " target ":" { in_job = 1; print; next }
		in_job && /^  [A-Za-z0-9_-]+:/ { exit }
		in_job { print }
	' "$workflow"
}

[[ -f "$workflow" ]] || fail "missing $workflow"

workflow_text="$(< "$workflow")"
setup_job="$(extract_job setup-e2e)"
e2e_job="$(extract_job test-e2e)"

[[ -n "$setup_job" ]] || fail "setup-e2e job not found"
[[ -n "$e2e_job" ]] || fail "test-e2e job not found"

assert_contains "$workflow_text" 'TOTAL_SHARDS: "2"' \
	"the functional matrix must use two shards"
assert_contains "$workflow_text" 'run: bun run test:build-check-shape' \
	"the Build Check must run its workflow shape gate"
assert_contains "$workflow_text" 'needs: setup-e2e' \
	"the matrix must depend on setup-e2e"
assert_contains "$e2e_job" 'project: [desktop, mobile]' \
	"the matrix must retain desktop and mobile projects"
assert_contains "$e2e_job" 'shard: [1, 2]' \
	"the matrix must retain two shards"

assert_count "$setup_job" 'test:e2e:install-deps' 0 \
	"setup-e2e must not install runner-local Playwright OS dependencies"
assert_count "$e2e_job" 'test:e2e:install-deps' 1 \
	"each isolated matrix lane must install Playwright OS dependencies"

assert_count "$workflow_text" 'id: playwright-version' 2 \
	"setup and every matrix lane must resolve the Playwright version"
assert_count "$workflow_text" 'bunx --bun playwright --version' 2 \
	"Playwright cache version derivation must use the installed CLI"
assert_count "$workflow_text" 'key: ${{ runner.os }}-ms-playwright-${{ steps.playwright-version.outputs.version }}' 2 \
	"setup and matrix browser caches must use the exact Playwright version"
if awk '/ms-playwright-/ && /hashFiles.*bun.lock/ { found = 1 } END { exit !found }' "$workflow"; then
	fail "the Playwright browser cache key must not hash the whole Bun lockfile"
fi
assert_count "$workflow_text" 'path: ~/.cache/ms-playwright' 2 \
	"setup and matrix lanes must model the browser binary cache"
assert_count "$setup_job" 'if: steps.playwright-cache.outputs.cache-hit != '\''true'\''' 1 \
	"setup must install browsers only on a cache miss"
assert_count "$e2e_job" 'if: steps.playwright-cache.outputs.cache-hit != '\''true'\''' 1 \
	"matrix lanes must install browsers only on a cache miss"

assert_contains "$e2e_job" 'name: blob-report-${{ matrix.project }}-${{ matrix.shard }}' \
	"functional blob artifacts must remain unique per project and shard"
assert_contains "$e2e_job" 'PLAYWRIGHT_BLOB_OUTPUT_DIR: test-results/blob-report-e2e-${{ matrix.project }}-${{ matrix.shard }}' \
	"functional blob output directories must remain unique per project and shard"
assert_contains "$workflow_text" 'pattern: blob-report-*' \
	"the merge job must continue downloading all blob artifacts"
assert_contains "$workflow_text" 'merge-multiple: true' \
	"the merge job must continue combining the matrix blobs"
assert_contains "$e2e_job" 'matrix.project == '\''desktop'\'' && matrix.shard == 1' \
	"the a11y gate must remain desktop shard 1 only"

printf 'PASS: Build Check setup/cache/matrix/report workflow shape\n'
