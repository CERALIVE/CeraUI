#!/usr/bin/env bash
set -euo pipefail

# Package-contract test: the device SPA ships NO sourcemap.
#
# `build-debian-package.sh` copies `dist/public/*` verbatim into /var/www/ceralive,
# which the backend serves unauthenticated — a `.map` there is the original
# TypeScript/Svelte source of the whole control plane, published to every device.
# The SPA is still built with `sourcemap: "hidden"` so a production stack trace can
# be symbolicated locally; the maps are relocated to a NON-packaged sibling
# directory (`dist/sourcemaps/`) before packaging.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

vite_config="apps/frontend/vite.config.ts"
sourcemap_module="apps/frontend/vite.sourcemaps.ts"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# Lists a .deb payload without requiring dpkg (ar + tar are enough).
deb_payload() {
  local deb work
  deb="$(readlink -f "$1")"
  work="$(mktemp -d)"
  ( cd "$work" && ar x "$deb" )
  local data
  data="$(ls "$work"/data.tar.* 2>/dev/null | head -1)"
  [[ -n "$data" ]] || fail "no data.tar.* member in $deb"
  tar tf "$data"
  rm -rf "$work"
}

# --- Part A: the policy is configured, not merely absent by accident ------------

grep -Fq 'sourcemap: mode === "production" ? "hidden" : "inline"' "$vite_config" \
  || fail "SPA production sourcemap mode is not \"hidden\" in $vite_config"

grep -Fq 'spaSourcemapRelocationPlugin(' "$vite_config" \
  || fail "the sourcemap relocation plugin is not mounted in $vite_config"

[[ -f "$sourcemap_module" ]] || fail "missing $sourcemap_module"

grep -Fq 'order: "post"' "$sourcemap_module" \
  || fail "relocation must be a post hook — vite-plugin-pwa emits sw.js.map from its own post closeBundle"

# The relocation target must be a SIBLING of the packaged tree: the packaging copy
# is a recursive glob, so a subdirectory of dist/public would ship anyway.
grep -Fq 'cp -r dist/public/*' scripts/build/build-debian-package.sh \
  || fail "packaging no longer copies dist/public/* — re-check the relocation target"

grep -Fq '"../../dist",' "$vite_config" \
  || fail "the sourcemap directory is not resolved as a sibling of dist/public"

# --- Part B: real artifacts, when present, carry no map -------------------------

checked_artifact=0

if [[ -d dist/public ]]; then
  stray="$(find dist/public -name '*.map' -print -quit)"
  [[ -z "$stray" ]] || fail "built SPA still contains a sourcemap: $stray"
  checked_artifact=1
fi

shopt -s nullglob
for deb in dist/debian/*.deb; do
  stray="$(deb_payload "$deb" | grep -E '\.map$' | head -1 || true)"
  [[ -z "$stray" ]] || fail "packaged .deb ships a sourcemap: $stray ($deb)"
  checked_artifact=1
done

# --- Part C: prove the payload check has teeth ---------------------------------

command -v fpm >/dev/null 2>&1 || fail "fpm not on PATH (required build dependency)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/temp/var/www/ceralive/assets"
printf 'x' > "$work/temp/var/www/ceralive/assets/live-abc.js"
printf 'x' > "$work/temp/var/www/ceralive/assets/live-abc.js.map"

(
  cd "$work"
  fpm -s dir -t deb \
    -n ceralive-device-mapcontract \
    -v 0.0.0 \
    -a all \
    --iteration test \
    --maintainer 'contract@ceralive.tv' \
    --description 'sourcemap policy contract' \
    --deb-no-default-config-files \
    -C temp \
    . >/dev/null
)

planted=("$work"/*.deb)
[[ ${#planted[@]} -gt 0 ]] || fail "fpm did not emit the planted-violation .deb"
deb_payload "${planted[0]}" | grep -Eq '\.map$' \
  || fail "the payload check failed to detect a planted .map — the gate has no teeth"

if [[ "$checked_artifact" -eq 1 ]]; then
  printf 'PASS: SPA sourcemaps are hidden + relocated; no .map in the built SPA or any .deb\n'
else
  printf 'PASS: SPA sourcemap policy configured (no built artifact present to inspect)\n'
fi
