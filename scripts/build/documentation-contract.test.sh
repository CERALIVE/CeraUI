#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

root_version="$(bun -p "require('./package.json').version")"
cerastream_version="$(bun -p "require('./apps/backend/package.json').dependencies['@ceralive/cerastream']")"
srtla_send_version="$(bun -p "require('./apps/backend/package.json').dependencies['@ceralive/srtla-send']")"

grep -Fq '"@ceralive/cerastream":  "'"$cerastream_version"'"' AGENTS.md
grep -Fq '"@ceralive/srtla-send":  "'"$srtla_send_version"'"' AGENTS.md
grep -Fq '"@ceralive/cerastream": "'"$cerastream_version"'"' apps/frontend/README.md
grep -Fq '"@ceralive/srtla-send": "'"$srtla_send_version"'"' apps/frontend/README.md
grep -Fq "CalVer, \`$root_version\` at time of writing" apps/frontend/AGENTS.md
grep -Fq 'src/lib/federation/{encoder-entry,audio-entry,server-entry}.ts' apps/frontend/AGENTS.md
grep -Fq '{ filename, integrity, kind, imports }' apps/frontend/AGENTS.md
grep -Fq "every emitted \`.js\` and \`.css\` asset" apps/frontend/AGENTS.md

if git grep -n -E 'test-results/(notepads/live-correctness-pass|evidence/task-19-ceraui-refinement-pass|reports/live-correctness-audit-A4)' -- '*.md'; then
  printf 'tracked documentation must not cite ignored test-results evidence\n' >&2
  exit 1
fi

printf 'PASS: dependency, federation, manifest, and durable documentation contracts are current\n'
