#!/usr/bin/env bash
# shellcheck disable=SC2016 # Workflow expressions and shell snippets are matched literally.
set -euo pipefail

release_workflow=".github/workflows/publish-release.yml"
deb_workflow=".github/workflows/publish-deb.yml"
build_check_workflow=".github/workflows/build-check.yml"
package_manifest="package.json"
contract_runner="scripts/build/release-package-contracts.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

require_file_contract() {
  local file="$1"
  local pattern="$2"
  local failure="$3"
  if ! grep -Fq -- "$pattern" "$file"; then
    printf '%s\n' "$failure" >&2
    exit 1
  fi
}

require_deb_contract() {
  local pattern="$1"
  local failure="$2"
  if ! grep -Fq -- "$pattern" "$deb_workflow"; then
    printf '%s\n' "$failure" >&2
    exit 1
  fi
}

assert_release_quality_gate() {
  local workflow="$1"
  local next_job="$2"
  local gate_start
  local gate_end
  local lint_step
  local runtime_step
  local unit_step

  require_file_contract "$workflow" 'run: bun install --frozen-lockfile' \
    "$workflow release gate must install the locked dependency graph"
  require_file_contract "$workflow" '- name: Lint and typecheck' \
    "$workflow release gate must run lint and typecheck"
  require_file_contract "$workflow" 'run: bun run lint' \
    "$workflow release gate must invoke the repository lint/typecheck command"
  require_file_contract "$workflow" '- name: Prepare backend test runtime directories' \
    "$workflow release gate must prepare writable runtime directories"
  require_file_contract "$workflow" \
    'sudo install -d -o "$(id -u)" -g "$(id -g)" /run/ceralive /var/run/bcrpt' \
    "$workflow release gate must prepare the backend runtime paths as the runner user"
  require_file_contract "$workflow" '- name: Run unit tests' \
    "$workflow release gate must run unit tests"
  require_file_contract "$workflow" 'run: bun run test' \
    "$workflow release gate must invoke the repository unit-test command"

  gate_start="$(grep -n '^  release-package-contracts:' "$workflow" | cut -d: -f1)"
  gate_end="$(grep -n "^  ${next_job}:" "$workflow" | cut -d: -f1)"
  lint_step="$(grep -n -- '- name: Lint and typecheck' "$workflow" | cut -d: -f1)"
  runtime_step="$(grep -n -- '- name: Prepare backend test runtime directories' "$workflow" | cut -d: -f1)"
  unit_step="$(grep -n -- '- name: Run unit tests' "$workflow" | cut -d: -f1)"
  if ((lint_step <= gate_start || lint_step >= gate_end || runtime_step <= lint_step || unit_step <= runtime_step || unit_step >= gate_end)); then
    printf '%s lint, typecheck, and unit tests must run inside the release gate\n' "$workflow" >&2
    exit 1
  fi
}

extract_job_block() {
  local workflow="$1"
  local job="$2"
  awk -v job="$job" '
    $0 == "  " job ":" {
      in_job = 1
    }
    in_job && $0 ~ /^  [a-zA-Z0-9_-]+:$/ && $0 != "  " job ":" {
      exit
    }
    in_job {
      print
    }
  ' "$workflow"
}

assert_recovery_gate_uses_resolved_commit() {
  local gate_block
  local checkout_ref
  local repo="$temp_dir/recovery-gate-provenance"
  local dispatch_commit
  local release_commit
  local selected_commit
  local tested_commit

  gate_block="$(extract_job_block "$deb_workflow" 'release-package-contracts')"
  checkout_ref="$(awk '
    /^      - name: Checkout CeraUI$/ {
      in_checkout = 1
      next
    }
    in_checkout && /^      - name:/ {
      exit
    }
    in_checkout && /^          ref:/ {
      sub(/^[[:space:]]*ref:[[:space:]]*/, "")
      print
      exit
    }
  ' <<< "$gate_block")"

  git init -q "$repo"
  git -C "$repo" config user.name "release-contract-test"
  git -C "$repo" config user.email "release-contract-test@example.invalid"
  printf 'dispatch\n' > "$repo/source"
  git -C "$repo" add source
  git -C "$repo" commit -q -m dispatch
  dispatch_commit="$(git -C "$repo" rev-parse HEAD)"
  printf 'release\n' > "$repo/source"
  git -C "$repo" commit -q -am release
  release_commit="$(git -C "$repo" rev-parse HEAD)"

  case "$checkout_ref" in
    '${{ needs.resolve-version.outputs.commit }}') selected_commit="$release_commit" ;;
    '') selected_commit="$dispatch_commit" ;;
    *)
      printf 'manual recovery quality gate uses unsupported checkout ref: %s\n' "$checkout_ref" >&2
      return 1
      ;;
  esac

  git -C "$repo" checkout -q --detach "$selected_commit"
  tested_commit="$(git -C "$repo" rev-parse HEAD)"
  if [[ "$tested_commit" != "$release_commit" ]]; then
    printf 'manual recovery gates tested dispatch commit %s instead of resolved release commit %s\n' \
      "$tested_commit" "$release_commit" >&2
    return 1
  fi
  printf 'manual recovery gates tested resolved release commit %s\n' "$tested_commit"
}

require_file_contract "$package_manifest" \
  '"test:release-package-contracts": "bash scripts/build/release-package-contracts.sh"' \
  'package.json must expose the named release/package contract command'
require_file_contract "$contract_runner" 'bash scripts/build/build-provenance.test.sh' \
  'named release/package contract command must run the provenance test'
require_file_contract "$contract_runner" 'bash scripts/build/release-flow.test.sh' \
  'named release/package contract command must run the release-flow test'
require_file_contract "$contract_runner" 'bash scripts/build/release-input-security.test.sh' \
  'named release/package contract command must run the input-security test'
require_file_contract "$build_check_workflow" 'run: bun run test:release-package-contracts' \
  'required Build Check must run the named release/package contract command'
require_file_contract "$release_workflow" '  release-package-contracts:' \
  'primary release workflow must define a release/package contract gate'
require_file_contract "$release_workflow" '    needs: calculate-version' \
  'primary release/package contract gate must receive the calculated version'
require_file_contract "$release_workflow" 'needs: [calculate-version, release-package-contracts]' \
  'primary release builds must depend on the release/package contract gate'
require_file_contract "$release_workflow" 'run: bun run test:release-package-contracts' \
  'primary release contract gate must run the named package command'
require_file_contract "$release_workflow" '- name: Verify package version matches release' \
  'primary release contract gate must reject a package.json version mismatch'
require_file_contract "$release_workflow" 'PACKAGE_VERSION="$(bun -p' \
  'primary release package version must be read with the pinned Bun runtime'
require_file_contract "$release_workflow" 'FORCE_VERSION_INPUT: ${{ inputs.force_version }}' \
  'primary force_version must enter calculate-version through env'
require_file_contract "$release_workflow" 'RELEASE_TYPE_INPUT: ${{ inputs.release_type }}' \
  'primary release_type must enter calculate-version through env'
require_file_contract "$release_workflow" 'STABLE_VERSION_PATTERN=' \
  'primary force_version must use the strict stable CalVer pattern'
require_file_contract "$release_workflow" 'STABLE_TAG_PATTERN=' \
  'primary release tag must use the strict stable CalVer pattern'
require_file_contract "$release_workflow" 'mv "$f" "ceraui-${RELEASE_VERSION}-${RELEASE_ARCH}.tar.gz"' \
  'primary archive rename must use validated values transported through env'
require_file_contract "$release_workflow" 'target_commitish: ${{ github.sha }}' \
  'primary release tag must be created from the exact workflow dispatch commit'
require_file_contract "$release_workflow" '- name: Verify default-branch dispatch' \
  'primary releases must start only from the default branch'
require_file_contract "$release_workflow" '- name: Ensure release target is unused' \
  'primary release must reject a pre-existing tag or release before building'
require_file_contract "$release_workflow" 'repos/${GITHUB_REPOSITORY}/git/ref/tags/${TAG}' \
  'primary release must check whether the calculated tag already exists'
require_file_contract "$release_workflow" 'repos/${GITHUB_REPOSITORY}/releases/tags/${TAG}' \
  'primary release must check whether the calculated release already exists'
require_file_contract "$release_workflow" '- name: Verify release tag provenance' \
  'primary release must verify its new tag before stable APT dispatch'
require_file_contract "$release_workflow" 'test "$ACTUAL_COMMIT" = "$EXPECTED_COMMIT"' \
  'primary release tag must resolve to the workflow dispatch commit'
require_file_contract "$deb_workflow" '  release-package-contracts:' \
  'manual recovery must define a release/package contract gate'
require_file_contract "$deb_workflow" 'needs: [resolve-version, release-package-contracts]' \
  'manual recovery build must depend on the release/package contract gate'
require_deb_contract 'run: bun run test:release-package-contracts' \
  'manual recovery contract gate must run the named package command'
require_deb_contract '- name: Verify default-branch dispatch' \
  'manual recovery must start only from the default branch'

if grep -Fq 'github.ref_protected' "$release_workflow" "$deb_workflow"; then
  printf 'release workflows must not require protected-ref state that is absent on the repository default branch\n' >&2
  exit 1
fi

assert_release_quality_gate "$release_workflow" 'build-ceraui-system'
assert_release_quality_gate "$deb_workflow" 'build-deb'
assert_recovery_gate_uses_resolved_commit

primary_gated_builds="$(grep -Fc 'needs: [calculate-version, release-package-contracts]' "$release_workflow")"
if [[ "$primary_gated_builds" -ne 3 ]]; then
  printf 'all primary archive, Debian, and federation jobs must depend on the contract gate\n' >&2
  exit 1
fi

release_contract_job="$(grep -n '^  release-package-contracts:' "$release_workflow" | cut -d: -f1)"
first_release_build="$(grep -n '^  build-ceraui-system:' "$release_workflow" | cut -d: -f1)"
package_version_guard="$(grep -n -- '- name: Verify package version matches release' "$release_workflow" | cut -d: -f1)"
if ((package_version_guard <= release_contract_job || package_version_guard >= first_release_build)); then
  printf 'package.json version validation must run inside the primary release contract gate\n' >&2
  exit 1
fi

test_be_job="$(grep -n '^  test-be:' "$build_check_workflow" | cut -d: -f1)"
setup_e2e_job="$(grep -n '^  setup-e2e:' "$build_check_workflow" | cut -d: -f1)"
build_check_contract="$(grep -n 'run: bun run test:release-package-contracts' "$build_check_workflow" | cut -d: -f1)"
build_check_runtime="$(grep -n -- '- name: Prepare backend test runtime directories' "$build_check_workflow" | cut -d: -f1)"
build_check_units="$(grep -n -- '- name: Unit tests (bun)' "$build_check_workflow" | cut -d: -f1)"
if ((build_check_contract <= test_be_job || build_check_contract >= setup_e2e_job)); then
  printf 'named release/package contracts must run inside the required test-be Build Check job\n' >&2
  exit 1
fi
if ((build_check_runtime <= test_be_job || build_check_runtime >= build_check_units || build_check_units >= setup_e2e_job)); then
  printf 'Build Check must prepare writable backend runtime directories before backend unit tests\n' >&2
  exit 1
fi

grep -Fq 'needs: [calculate-version, build-ceraui-system, build-debian-package, publish-federation]' "$release_workflow"
grep -Fq 'needs: [calculate-version, create-release]' "$release_workflow"
grep -Fq 'event-type: apt-reindex' "$release_workflow"
grep -Fq '"channel":"stable"' "$release_workflow"
grep -Fq 'if: needs.calculate-version.outputs.is_beta !=' "$release_workflow"
grep -Fq 'test "$PACKAGE_VERSION" = "$RELEASE_VERSION"' "$release_workflow"
grep -Fq 'workflow_dispatch:' "$deb_workflow"
grep -Fq 'tag must equal v<version>' "$deb_workflow"
require_deb_contract 'commit: ${{ steps.release.outputs.commit }}' \
  'manual recovery must resolve the existing release tag to one immutable commit'
require_deb_contract 'ref: ${{ needs.resolve-version.outputs.commit }}' \
  'manual recovery builds must check out the resolved release commit'
require_deb_contract 'fetch-depth: 0' \
  'manual recovery must fetch complete tag history'
require_deb_contract 'git fetch --force origin "refs/tags/${TAG}:refs/tags/${TAG}"' \
  'manual recovery must explicitly fetch the supplied tag'
require_deb_contract 'git checkout --detach "$EXPECTED_COMMIT"' \
  'manual recovery must explicitly detach at the resolved release commit'
require_deb_contract 'refs/tags/${TAG}^{commit}' \
  'manual recovery must verify HEAD resolves to the supplied tag commit'
require_deb_contract 'test "$TAG_COMMIT" = "$EXPECTED_COMMIT"' \
  'manual recovery must reject a tag that moves after commit resolution'
require_deb_contract 'test "$HEAD_COMMIT" = "$EXPECTED_COMMIT"' \
  'manual recovery must build exactly the resolved release commit'
require_deb_contract 'test "$PACKAGE_VERSION" = "$VERSION"' \
  'manual recovery must verify package.json matches the supplied tag version'
require_deb_contract 'gh release view "$TAG"' \
  'manual recovery must require an existing matching GitHub release'
require_deb_contract '--repo "$GITHUB_REPOSITORY"' \
  'manual recovery must verify the release in the dispatched repository'

release_checks="$(grep -Fc 'gh release view "$TAG"' "$deb_workflow")"
if [[ "$release_checks" -lt 2 ]]; then
  printf 'manual recovery must verify the existing release before build and again before upload\n' >&2
  exit 1
fi

first_release_check="$(grep -Fn 'gh release view "$TAG"' "$deb_workflow" | sed -n '1s/:.*//p')"
second_release_check="$(grep -Fn 'gh release view "$TAG"' "$deb_workflow" | sed -n '2s/:.*//p')"
build_job="$(grep -n '^  build-deb:' "$deb_workflow" | cut -d: -f1)"
publish_job="$(grep -n '^  publish:' "$deb_workflow" | cut -d: -f1)"
attach_step="$(grep -n 'name: Attach .debs to GitHub release' "$deb_workflow" | cut -d: -f1)"

if ((first_release_check >= build_job)); then
  printf 'manual recovery must verify the existing release before starting build-deb\n' >&2
  exit 1
fi

if ((second_release_check <= publish_job || second_release_check >= attach_step)); then
  printf 'manual recovery must re-verify the existing release immediately before attachment\n' >&2
  exit 1
fi

recovery_commit_checks="$(grep -Fc 'test "$RELEASE_COMMIT" = "$EXPECTED_COMMIT"' "$deb_workflow")"
if [[ "$recovery_commit_checks" -lt 1 ]]; then
  printf 'manual recovery must re-verify the immutable release commit before attachment\n' >&2
  exit 1
fi

if grep -Eq '^[[:space:]]+push:' "$deb_workflow"; then
  printf 'publish-deb.yml must not automatically publish duplicate .deb assets from a tag push\n' >&2
  exit 1
fi
