#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

package_script="$(bun -e 'const pkg = await Bun.file("package.json").json(); process.stdout.write(pkg.scripts?.["test:service-contract"] ?? "")')"
if [[ "$package_script" != "bash scripts/ci/run-service-contract.sh" ]]; then
  printf 'package.json must expose test:service-contract through the isolated runner\n' >&2
  exit 1
fi

test -x scripts/ci/run-service-contract.sh || {
  printf 'service contract runner must exist and be executable\n' >&2
  exit 1
}

grep -Fq -- '- name: Mock device attach service contract' .github/workflows/build-check.yml
grep -Fq 'run: bun run test:service-contract' .github/workflows/build-check.yml
grep -Fq -- '- name: Run service contract' .github/workflows/publish-release.yml

printf 'PASS: mock-device-attach service contract is package-addressable and CI-gated\n'
