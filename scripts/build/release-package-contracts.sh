#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

bash scripts/build/build-provenance.test.sh
bash scripts/build/release-input-security.test.sh
bash scripts/build/release-flow.test.sh
