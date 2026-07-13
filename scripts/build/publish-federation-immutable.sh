#!/usr/bin/env bash
set -euo pipefail

fed_dir="${1:?federation directory is required}"
dest_prefix="${2:?destination prefix is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required}"

test -d "$fed_dir"
test -f "$fed_dir/manifest.json"
test -f "$fed_dir/manifest.json.sig"

shopt -s nullglob
assets=("$fed_dir"/*.js "$fed_dir"/*.css)
sri_files=("$fed_dir"/*.sri)
gpg_signatures=("$fed_dir"/*.js.sig "$fed_dir"/*.css.sig)
artifacts=(
  "${assets[@]}"
  "${sri_files[@]}"
  "${gpg_signatures[@]}"
  "$fed_dir/manifest.json"
  "$fed_dir/manifest.json.sig"
)

((${#assets[@]} > 0))
((${#gpg_signatures[@]} == ${#assets[@]}))
((${#sri_files[@]} == ${#assets[@]}))

release_digest="$({
  for file in "${assets[@]}" "${sri_files[@]}" "$fed_dir/manifest.json"; do
    printf '%s\0' "$(basename "$file")"
    sha256sum "$file"
  done
} | sha256sum | cut -d' ' -f1)"

R2_ENDPOINT="$(printf '%s' "$R2_ENDPOINT" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]+).*#\1#')"
temp_dir="$(mktemp -d)"
declare -a created_keys=()
declare -A existing_keys=()
committed=false

cleanup() {
  local status=$?
  local key

  if [[ "$status" -ne 0 && "$committed" != true ]]; then
    for key in "${created_keys[@]}"; do
      aws s3api delete-object \
        --bucket "$R2_BUCKET" \
        --key "$key" \
        --endpoint-url "$R2_ENDPOINT" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "$temp_dir"
  exit "$status"
}
trap cleanup EXIT

content_type_for() {
  case "$1" in
    *.sri) printf 'text/plain; charset=utf-8\n' ;;
    manifest.json) printf 'application/json; charset=utf-8\n' ;;
    *.sig) printf 'application/octet-stream\n' ;;
    *.js) printf 'application/javascript; charset=utf-8\n' ;;
    *.css) printf 'text/css; charset=utf-8\n' ;;
    *) printf 'application/octet-stream\n' ;;
  esac
}

is_missing_error() {
  grep -Eq '(^|[ (])404([ )]|$)|NoSuchKey|Not Found' "$1"
}

remote_digest_for() {
  local key="$1"
  aws s3api head-object \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    --endpoint-url "$R2_ENDPOINT" \
    --query 'Metadata."release-digest"' \
    --output text
}

compare_remote_payload() {
  local file="$1"
  local key="$2"
  local name
  local downloaded

  name="$(basename "$file")"
  [[ "$name" == *.sig ]] && return 0
  downloaded="$temp_dir/$name"
  aws s3api get-object \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    --endpoint-url "$R2_ENDPOINT" \
    "$downloaded" >/dev/null
  cmp -s "$file" "$downloaded" || {
    printf 'immutable federation object differs: %s\n' "$key" >&2
    return 1
  }
}

for file in "${artifacts[@]}"; do
  name="$(basename "$file")"
  key="${dest_prefix}/${name}"
  error_file="$temp_dir/head-${name}.err"
  if remote_digest="$(remote_digest_for "$key" 2>"$error_file")"; then
    if [[ "$remote_digest" != "$release_digest" ]]; then
      printf 'federation version already contains different signed bytes: %s\n' "$key" >&2
      exit 1
    fi
    compare_remote_payload "$file" "$key"
    existing_keys["$key"]=true
  elif ! is_missing_error "$error_file"; then
    cat "$error_file" >&2
    exit 1
  fi
done

for file in "${artifacts[@]}"; do
  name="$(basename "$file")"
  key="${dest_prefix}/${name}"
  if [[ "${existing_keys[$key]:-false}" == true ]]; then
    printf '= %s\n' "$key"
    continue
  fi

  error_file="$temp_dir/put-${name}.err"
  if aws s3api put-object \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    --body "$file" \
    --content-type "$(content_type_for "$name")" \
    --metadata "release-digest=${release_digest}" \
    --if-none-match '*' \
    --endpoint-url "$R2_ENDPOINT" >/dev/null 2>"$error_file"; then
    created_keys+=("$key")
    printf '+ %s\n' "$key"
    continue
  fi

  if grep -Eq 'PreconditionFailed|412' "$error_file"; then
    remote_digest="$(remote_digest_for "$key")"
    if [[ "$remote_digest" == "$release_digest" ]]; then
      compare_remote_payload "$file" "$key"
      printf '= %s\n' "$key"
      continue
    fi
  fi
  cat "$error_file" >&2
  exit 1
done

for file in "${artifacts[@]}"; do
  key="${dest_prefix}/$(basename "$file")"
  remote_digest="$(remote_digest_for "$key")"
  [[ "$remote_digest" == "$release_digest" ]] || {
    printf 'federation publish verification failed: %s\n' "$key" >&2
    exit 1
  }
done

committed=true
printf 'published immutable federation version %s (%s artifacts, digest %s)\n' \
  "$dest_prefix" "${#artifacts[@]}" "$release_digest"
