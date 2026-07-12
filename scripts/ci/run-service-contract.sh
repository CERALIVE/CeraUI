#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state_dir="$(mktemp -d)"
trap 'rm -rf "$state_dir"' EXIT

cp "$repo_root/config.json" "$state_dir/config.json"
cp "$repo_root/apps/backend/setup.json" "$state_dir/setup.json"

cd "$state_dir"
bun test \
  "$repo_root/scripts/ceralive-service.test.mjs" \
  "$repo_root/apps/backend/src/tests/mock-device-attach.test.ts"
