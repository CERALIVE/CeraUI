#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

bash scripts/build/build-provenance.test.sh
bash scripts/build/shared-build-functions.test.sh
bash scripts/build/deb-reconciler-staging.test.sh
bash scripts/build/documentation-contract.test.sh
bash scripts/build/publish-federation-immutable.test.sh
bash scripts/ci/service-contract-wiring.test.sh
bash scripts/build/release-input-security.test.sh
bash scripts/build/release-flow.test.sh
