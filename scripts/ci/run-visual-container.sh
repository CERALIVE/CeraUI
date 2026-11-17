#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Reuse CI artifacts in a source copy outside Bun's test discovery.
test -d dist/public
test -f dist/ci-runtime/usr/bin/srtla_send
bun_version="$(bun --version)"
expected_bun="$(tr -d '\n' < .bun-version)"
test "$bun_version" = "$expected_bun"
node_version="$(node -p 'process.versions.node.split(".")[0]')"
expected_node="$(bun scripts/ci/visual-container.mjs node)"
test "$node_version" = "$expected_node"
image="$(bun scripts/ci/visual-container.mjs image)"
identity="$(bun scripts/ci/visual-container.mjs identity)"
bun_binary="$(command -v bun)"
bun_binary="$(readlink -f "$bun_binary")"
node_binary="$(command -v node)"
node_binary="$(readlink -f "$node_binary")"
caller_uid="$(id -u)"
caller_gid="$(id -g)"
mkdir -p node_modules/.cache/visual-container
work="$(mktemp -d "$PWD/node_modules/.cache/visual-container/run.XXXXXX")"
GIT_MASTER=1 git ls-files --cached --others --exclude-standard -z |
  bun scripts/ci/visual-container.mjs existing-files |
  tar --null -T - -cf - | tar -xf - -C "$work"
mkdir -p "$work/dist"
cp -a dist/public dist/ci-runtime "$work/dist/"
mkdir -p "$work/.visual-home/.bun/bin"
: > "$work/.visual-home/.bun/bin/bun"
echo "Container workspace and retained reports: $work"

docker run --rm --platform=linux/amd64 --ipc=host --init \
  --user "$caller_uid:$caller_gid" \
  --mount "type=bind,src=$work,dst=/workspace/CeraUI" \
  --mount "type=bind,src=$bun_binary,dst=/workspace/CeraUI/.visual-home/.bun/bin/bun,readonly" \
  --mount "type=bind,src=$node_binary,dst=/opt/node/bin/node,readonly" \
  --workdir /workspace/CeraUI \
  --env HOME=/workspace/CeraUI/.visual-home \
  --env PATH=/workspace/CeraUI/.visual-home/.bun/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --env VISUAL_UID="$caller_uid" --env VISUAL_GID="$caller_gid" --env VISUAL_IDENTITY="$identity" \
  --env CI=true --env TZ=UTC --env LANG=C.UTF-8 --env LC_ALL=C.UTF-8 \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --env CHANGED_SNAPSHOTS='[]' \
  --env PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/visual-pr.json \
  --env PLAYWRIGHT_BLOB_OUTPUT_DIR=test-results/blob-report-visual-pr \
  "$image" bash -euo pipefail -c '
    test "$(id -u)" = "$VISUAL_UID"
    test "$(id -g)" = "$VISUAL_GID"
    test -w "$HOME"
    printf "Visual container uid=%s gid=%s HOME=%s\n" "$VISUAL_UID" "$VISUAL_GID" "$HOME"
    git init -q
    bun install --frozen-lockfile
    bash -euo pipefail -c "$VISUAL_IDENTITY"
    bash scripts/ci/run-visual-pr.sh
  '
