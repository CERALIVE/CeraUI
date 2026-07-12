#!/usr/bin/env bash
# shellcheck disable=SC2016 # Workflow expressions and hostile payloads must remain literal.
set -euo pipefail

recovery_workflow=".github/workflows/publish-deb.yml"
primary_workflow=".github/workflows/publish-release.yml"

extract_named_step() {
  local workflow="$1"
  local target="$2"
  awk -v target="$target" '
    {
      line = $0
      sub(/^[ ]*/, "", line)
      if (line == "- name: " target) in_step = 1
      else if (in_step && line ~ /^- name:/) exit
      if (in_step) print
    }
  ' "$workflow"
}

extract_run_block() {
  awk '
    function indentation(line, prefix) {
      prefix = line
      sub(/[^ ].*$/, "", prefix)
      return length(prefix)
    }
    /^[[:space:]]+run:[[:space:]]*\|[+-]?[[:space:]]*$/ {
      in_run = 1
      run_indent = indentation($0)
      next
    }
    in_run {
      if ($0 !~ /^[[:space:]]*$/ && indentation($0) <= run_indent) exit
      if ($0 ~ /^[[:space:]]*$/) print ""
      else print substr($0, run_indent + 3)
    }
  '
}

extract_all_run_blocks() {
  local workflow="$1"
  awk '
    function indentation(line, prefix) {
      prefix = line
      sub(/[^ ].*$/, "", prefix)
      return length(prefix)
    }
    {
      current_indent = indentation($0)
      if (in_run) {
        if ($0 !~ /^[[:space:]]*$/ && current_indent <= run_indent) in_run = 0
        else {
          print
          next
        }
      }
      if ($0 ~ /^[[:space:]]+run:[[:space:]]*\|[+-]?[[:space:]]*$/) {
        in_run = 1
        run_indent = current_indent
      } else if ($0 ~ /^[[:space:]]+run:[[:space:]]+/) {
        line = $0
        sub(/^[[:space:]]+run:[[:space:]]*/, "", line)
        print line
      }
    }
  ' "$workflow"
}

validation_step="$(extract_named_step "$recovery_workflow" 'Validate stable tag and version')"

input_expression_count="$(grep -Fc '${{ inputs.' "$recovery_workflow")"
if [[ "$input_expression_count" -ne 2 ]]; then
  printf 'workflow_dispatch inputs must not be interpolated directly inside run blocks\n' >&2
  exit 1
fi

if ! grep -Fq 'INPUT_TAG: ${{ inputs.tag }}' <<< "$validation_step" || \
  ! grep -Fq 'INPUT_VERSION: ${{ inputs.version }}' <<< "$validation_step"; then
  printf 'tag and version workflow_dispatch inputs must enter the validation step through env\n' >&2
  exit 1
fi

validation_run="$(extract_run_block <<< "$validation_step")"
if [[ -z "$validation_run" ]]; then
  printf 'stable tag/version validation run block is missing\n' >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

primary_run_blocks="$(extract_all_run_blocks "$primary_workflow")"
if grep -Eq '\$\{\{[[:space:]]*(github\.event\.inputs|inputs|steps\.calver\.outputs|needs\.calculate-version\.outputs)\.' \
  <<< "$primary_run_blocks"; then
  printf 'primary release inputs and derived outputs must not be interpolated directly inside run blocks\n' >&2
  exit 1
fi

calver_step="$(extract_named_step "$primary_workflow" 'Calculate CalVer version')"
if ! grep -Fq 'FORCE_VERSION_INPUT: ${{ inputs.force_version }}' <<< "$calver_step" || \
  ! grep -Fq 'RELEASE_TYPE_INPUT: ${{ inputs.release_type }}' <<< "$calver_step"; then
  printf 'primary release inputs must enter calculate-version through env\n' >&2
  exit 1
fi
calver_run="$(extract_run_block <<< "$calver_step")"
if [[ -z "$calver_run" ]]; then
  printf 'primary stable CalVer validation run block is missing\n' >&2
  exit 1
fi

safe_output="$temp_dir/safe-output"
INPUT_TAG="v2026.7.0" INPUT_VERSION="2026.7.0" GITHUB_OUTPUT="$safe_output" \
  bash -euo pipefail -c "$validation_run"
if ! grep -qx 'version=2026.7.0' "$safe_output" || ! grep -qx 'tag=v2026.7.0' "$safe_output"; then
  printf 'valid stable tag/version did not produce the expected outputs\n' >&2
  exit 1
fi

assert_rejected_without_execution() {
  local label="$1"
  local tag="$2"
  local version="$3"
  local marker="$4"
  local output="$temp_dir/${label}-output"
  local log="$temp_dir/${label}-log"

  set +e
  INPUT_TAG="$tag" INPUT_VERSION="$version" GITHUB_OUTPUT="$output" \
    bash -euo pipefail -c "$validation_run" >"$log" 2>&1
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    printf '%s payload was accepted unexpectedly\n' "$label" >&2
    exit 1
  fi
  if [[ -e "$marker" ]]; then
    printf '%s payload executed shell code\n' "$label" >&2
    exit 1
  fi
  if [[ -s "$output" ]]; then
    printf '%s payload wrote workflow outputs before validation\n' "$label" >&2
    exit 1
  fi
}

primary_safe_output="$temp_dir/primary-safe-output"
RELEASE_TYPE_INPUT="stable" FORCE_VERSION_INPUT="2026.7.0" GITHUB_OUTPUT="$primary_safe_output" \
  bash -euo pipefail -c "$calver_run"
if ! grep -qx 'version=2026.7.0' "$primary_safe_output" || \
  ! grep -qx 'tag=v2026.7.0' "$primary_safe_output" || \
  ! grep -qx 'is_beta=false' "$primary_safe_output"; then
  printf 'valid primary stable force_version did not produce consistent outputs\n' >&2
  exit 1
fi

assert_force_version_rejected_without_execution() {
  local label="$1"
  local release_type="$2"
  local force_version="$3"
  local marker="$4"
  local output="$temp_dir/primary-${label}-output"
  local log="$temp_dir/primary-${label}-log"

  set +e
  RELEASE_TYPE_INPUT="$release_type" FORCE_VERSION_INPUT="$force_version" GITHUB_OUTPUT="$output" \
    bash -euo pipefail -c "$calver_run" >"$log" 2>&1
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    printf 'primary %s force_version was accepted unexpectedly\n' "$label" >&2
    exit 1
  fi
  if [[ -e "$marker" ]]; then
    printf 'primary %s force_version executed shell code\n' "$label" >&2
    exit 1
  fi
  if [[ -s "$output" ]]; then
    printf 'primary %s force_version wrote outputs before validation\n' "$label" >&2
    exit 1
  fi
}

primary_quote_marker="$temp_dir/primary-quote-executed"
primary_quote_payload='2026.7.0"; touch '"$primary_quote_marker"'; #'
assert_force_version_rejected_without_execution \
  "quote" "stable" "$primary_quote_payload" "$primary_quote_marker"

primary_newline_marker="$temp_dir/primary-newline-executed"
primary_newline_payload="$(printf '2026.7.0\ntouch %s' "$primary_newline_marker")"
assert_force_version_rejected_without_execution \
  "newline" "stable" "$primary_newline_payload" "$primary_newline_marker"

primary_substitution_marker="$temp_dir/primary-substitution-executed"
primary_substitution_payload='$(touch '"$primary_substitution_marker"')'
assert_force_version_rejected_without_execution \
  "substitution" "stable" "$primary_substitution_payload" "$primary_substitution_marker"

primary_grammar_marker="$temp_dir/primary-grammar-executed"
assert_force_version_rejected_without_execution \
  "leading-zero-month" "stable" "2026.07.0" "$primary_grammar_marker"
assert_force_version_rejected_without_execution \
  "beta-force" "beta" "2026.7.0" "$primary_grammar_marker"

quote_version_marker="$temp_dir/quote-version-executed"
quote_version_payload='2026.7.0"; touch '"$quote_version_marker"'; #'
assert_rejected_without_execution \
  "quote-version" "v2026.7.0" "$quote_version_payload" "$quote_version_marker"

quote_tag_marker="$temp_dir/quote-tag-executed"
quote_tag_payload='v2026.7.0"; touch '"$quote_tag_marker"'; #'
assert_rejected_without_execution \
  "quote-tag" "$quote_tag_payload" "2026.7.0" "$quote_tag_marker"

newline_version_marker="$temp_dir/newline-version-executed"
newline_version_payload="$(printf '2026.7.0\ntouch %s' "$newline_version_marker")"
assert_rejected_without_execution \
  "newline-version" "v2026.7.0" "$newline_version_payload" "$newline_version_marker"

newline_tag_marker="$temp_dir/newline-tag-executed"
newline_tag_payload="$(printf 'v2026.7.0\ntouch %s' "$newline_tag_marker")"
assert_rejected_without_execution \
  "newline-tag" "$newline_tag_payload" "2026.7.0" "$newline_tag_marker"

substitution_version_marker="$temp_dir/substitution-version-executed"
substitution_version_payload='$(touch '"$substitution_version_marker"')'
assert_rejected_without_execution \
  "substitution-version" "v2026.7.0" "$substitution_version_payload" "$substitution_version_marker"

substitution_tag_marker="$temp_dir/substitution-tag-executed"
substitution_tag_payload='$(touch '"$substitution_tag_marker"')'
assert_rejected_without_execution \
  "substitution-tag" "$substitution_tag_payload" "2026.7.0" "$substitution_tag_marker"

grammar_marker="$temp_dir/grammar-executed"
assert_rejected_without_execution \
  "leading-zero-month" "v2026.07.0" "2026.07.0" "$grammar_marker"
assert_rejected_without_execution \
  "beta-version" "v2026.7.0-beta.1" "2026.7.0-beta.1" "$grammar_marker"

printf 'stable inputs accepted; 13 hostile or noncanonical cases rejected without execution or outputs\n'
