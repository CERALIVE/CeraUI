#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

bash scripts/build/build-provenance.test.sh
bash scripts/build/shared-build-functions.test.sh
bash scripts/build/frontend-cache-notifications.test.sh
bun test scripts/ci/notification-bundle.test.ts
bun scripts/tsc.mjs --project scripts/ci/tsconfig.json --noEmit
bash scripts/build/deb-reconciler-staging.test.sh
bash scripts/build/deb-file-modes.test.sh
bash scripts/build/deb-os-stage-guard.test.sh
bash scripts/build/deb-nbd-release.test.sh
bash scripts/build/deb-maintainer-scripts.test.sh
bash scripts/build/deb-public-link.test.sh
bash scripts/build/deb-update-runtime-dependencies.test.sh
bash scripts/build/deb-version-stamp.test.sh
bash scripts/build/deb-sourcemap-policy.test.sh
bash scripts/build/documentation-contract.test.sh
bash scripts/build/publish-federation-immutable.test.sh
bash scripts/ci/service-contract-wiring.test.sh
bash scripts/build/release-input-security.test.sh
bash scripts/build/release-flow.test.sh
