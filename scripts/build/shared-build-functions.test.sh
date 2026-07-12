#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script_under_test="$repo_root/scripts/build/shared-build-functions.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

create_fixture() {
  local fixture="$1"

  mkdir -p \
    "$fixture/scripts/build" \
    "$fixture/apps/frontend/src" \
    "$fixture/apps/backend/src" \
    "$fixture/packages/rpc/src" \
    "$fixture/deployment"
  cp "$script_under_test" "$fixture/scripts/build/shared-build-functions.sh"
  printf '{"scripts":{"build:frontend":"vite build"}}\n' > "$fixture/package.json"
  printf 'lockfile-v1\n' > "$fixture/bun.lock"
  printf '1.3.14\n' > "$fixture/.bun-version"
  printf '{"compilerOptions":{"strict":true}}\n' > "$fixture/tsconfig.json"
  printf '{"name":"frontend"}\n' > "$fixture/apps/frontend/package.json"
  printf '{"extends":"../../tsconfig.json"}\n' > "$fixture/apps/frontend/tsconfig.json"
  printf '{"extends":"./tsconfig.json"}\n' > "$fixture/apps/frontend/tsconfig.app.json"
  printf '{"name":"backend"}\n' > "$fixture/apps/backend/package.json"
  printf '{"extends":"../../tsconfig.json"}\n' > "$fixture/apps/backend/tsconfig.json"
  printf '{"name":"rpc"}\n' > "$fixture/packages/rpc/package.json"
  printf 'frontend-source\n' > "$fixture/apps/frontend/src/main.ts"
  printf 'backend-source\n' > "$fixture/apps/backend/src/main.ts"
  printf 'shared-source\n' > "$fixture/packages/rpc/src/shared.ts"
  printf 'vite-config\n' > "$fixture/apps/frontend/vite.config.ts"
  printf 'build-input\n' > "$fixture/scripts/build/build-debian-package.sh"
  printf 'deployment-input\n' > "$fixture/deployment/ceralive.service"
  printf 'setup-input\n' > "$fixture/apps/backend/setup.json"
}

assert_hash_changes() (
  local hash_function="$1"
  local changed_path="$2"
  local fixture="$temp_dir/hash-${hash_function}-${changed_path//\//-}"
  local before
  local after

  create_fixture "$fixture"
  cd "$fixture"
  # shellcheck source=scripts/build/shared-build-functions.sh
  source scripts/build/shared-build-functions.sh
  before="$($hash_function)"
  printf 'mutation\n' >> "$changed_path"
  after="$($hash_function)"
  if [[ "$before" == "$after" ]]; then
    printf '%s did not change after mutating %s\n' "$hash_function" "$changed_path" >&2
    return 1
  fi
)

assert_root_tsconfig_invalidates_cache() (
  local component="$1"
  local fixture="$temp_dir/cache-${component}-root-tsconfig"

  create_fixture "$fixture"
  cd "$fixture"
  # shellcheck source=scripts/build/shared-build-functions.sh
  source scripts/build/shared-build-functions.sh

  case "$component" in
    frontend)
      mkdir -p "$FRONTEND_CACHE/public"
      get_frontend_hash > "$FRONTEND_CACHE/hash.txt"
      is_frontend_cache_valid
      ;;
    backend)
      mkdir -p "$BACKEND_CACHE/amd64"
      get_backend_hash > "$BACKEND_CACHE/amd64/hash.txt"
      : > "$BACKEND_CACHE/amd64/ceralive"
      is_backend_cache_valid amd64
      ;;
  esac

  printf '\n' >> tsconfig.json
  if [[ "$component" == "frontend" ]] && is_frontend_cache_valid; then
    printf 'frontend cache remained valid after mutating inherited root tsconfig.json\n' >&2
    return 1
  fi
  if [[ "$component" == "backend" ]] && is_backend_cache_valid amd64; then
    printf 'backend cache remained valid after mutating inherited root tsconfig.json\n' >&2
    return 1
  fi
)

for path in \
  package.json \
  tsconfig.json \
  apps/frontend/package.json \
  apps/frontend/tsconfig.json \
  apps/frontend/tsconfig.app.json \
  bun.lock \
  apps/frontend/vite.config.ts \
  packages/rpc/src/shared.ts \
  scripts/build/build-debian-package.sh \
  deployment/ceralive.service \
  apps/backend/setup.json; do
  assert_hash_changes get_frontend_hash "$path"
done

for path in \
  package.json \
  tsconfig.json \
  apps/backend/package.json \
  apps/backend/tsconfig.json \
  bun.lock \
  packages/rpc/src/shared.ts \
  scripts/build/build-debian-package.sh \
  deployment/ceralive.service \
  apps/backend/setup.json; do
  assert_hash_changes get_backend_hash "$path"
done

assert_root_tsconfig_invalidates_cache frontend
assert_root_tsconfig_invalidates_cache backend

build_fixture="$temp_dir/bun-build"
create_fixture "$build_fixture"
mkdir -p "$build_fixture/bin"
cat > "$build_fixture/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > ../../npm-invocation.txt
exit 91
STUB
cat > "$build_fixture/bin/bun" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > ../../bun-invocation.txt
mkdir -p ../../dist/public
printf 'built-with-bun\n' > ../../dist/public/index.html
STUB
chmod +x "$build_fixture/bin/npm" "$build_fixture/bin/bun"

(
  cd "$build_fixture"
  PATH="$build_fixture/bin:$PATH"
  export PATH
  # shellcheck source=scripts/build/shared-build-functions.sh
  source scripts/build/shared-build-functions.sh
  build_frontend_only
)

test ! -e "$build_fixture/npm-invocation.txt" || {
  printf 'frontend build invoked npm instead of Bun\n' >&2
  exit 1
}
grep -Fxq 'run build' "$build_fixture/bun-invocation.txt"
grep -Fxq 'built-with-bun' "$build_fixture/.build-cache/frontend/public/index.html"

printf 'PASS: smart-build hashes all production inputs and builds the frontend with Bun\n'
