#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts/build" "$fixture/bin" "$fixture/dist"
cp "$repo_root/scripts/build/shared-build-functions.sh" "$fixture/scripts/build/"

cat > "$fixture/bin/bun" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "$EXPECTED_GUARD" ]]; then
  printf 'unexpected Bun invocation: %s\n' "$*" >&2
  exit 90
fi
test -f dist/public/index.html
printf 'guard-ran\n' >> "$GUARD_LOG"
exit "$GUARD_RESULT"
STUB
chmod +x "$fixture/bin/bun"
export PATH="$fixture/bin:$PATH"
export GUARD_LOG="$fixture/guard.log"
export EXPECTED_GUARD="$fixture/scripts/ci/notification-bundle.ts"

(
  cd "$fixture"
  # shellcheck source=scripts/build/shared-build-functions.sh
  source scripts/build/shared-build-functions.sh
  mkdir -p "$FRONTEND_CACHE/public"
  printf 'cached-public\n' > "$FRONTEND_CACHE/public/index.html"
  get_frontend_hash > "$FRONTEND_CACHE/hash.txt"

  # Given a matching input hash but a notification-incomplete cached artifact
  export GUARD_RESULT=1
  # When restoring the frontend cache, then propagate the guard's refusal
  if build_frontend_only; then
    printf 'FAIL: incomplete cached frontend was accepted without a passing guard\n' >&2
    exit 1
  fi
  grep -Fxq guard-ran "$GUARD_LOG"

  # Given the same cache with a passing artifact guard
  export GUARD_RESULT=0
  # When restoring it, then preserve the cache fast path and run the guard again
  build_frontend_only
  test "$(wc -l < "$GUARD_LOG")" -eq 2
)
printf 'PASS: cached frontend notification guard rejects bad artifacts and accepts good ones\n'
