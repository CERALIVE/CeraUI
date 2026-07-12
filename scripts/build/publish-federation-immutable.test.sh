#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
publisher="$repo_root/scripts/build/publish-federation-immutable.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

test -x "$publisher" || {
  printf 'immutable federation publisher must exist and be executable\n' >&2
  exit 1
}

mkdir -p "$temp_dir/bin" "$temp_dir/r2" "$temp_dir/federation"
cat > "$temp_dir/bin/aws" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$MOCK_AWS_LOG"
[[ "$1" == "s3api" ]]
operation="$2"
shift 2
bucket=""
key=""
body=""
metadata=""
output_file=""

while (($#)); do
  case "$1" in
    --bucket) bucket="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    --metadata) metadata="$2"; shift 2 ;;
    --endpoint-url|--content-type|--if-none-match|--query|--output) shift 2 ;;
    --no-cli-pager) shift ;;
    *) output_file="$1"; shift ;;
  esac
done

object="$MOCK_R2_ROOT/$bucket/$key"
meta="$object.meta"
case "$operation" in
  head-object)
    if [[ ! -f "$object" ]]; then
      printf 'An error occurred (404) when calling HeadObject\n' >&2
      exit 254
    fi
    sed -n 's/^release-digest=//p' "$meta"
    ;;
  get-object)
    test -n "$output_file"
    cp "$object" "$output_file"
    ;;
  put-object)
    if [[ -n "${MOCK_FAIL_KEY:-}" && "$key" == *"$MOCK_FAIL_KEY" ]]; then
      printf 'injected put failure for %s\n' "$key" >&2
      exit 90
    fi
    if [[ -e "$object" ]]; then
      printf 'An error occurred (PreconditionFailed) 412\n' >&2
      exit 255
    fi
    mkdir -p "$(dirname "$object")"
    cp "$body" "$object"
    printf '%s\n' "$metadata" > "$meta"
    ;;
  delete-object)
    rm -f "$object" "$meta"
    ;;
  *)
    printf 'unsupported mock aws operation: %s\n' "$operation" >&2
    exit 2
    ;;
esac
MOCK
chmod +x "$temp_dir/bin/aws"

fed_dir="$temp_dir/federation"
printf 'encoder-v1\n' > "$fed_dir/encoder.js"
printf 'css-v1\n' > "$fed_dir/frontend.css"
printf 'sha384-encoder\n' > "$fed_dir/encoder.js.sri"
printf 'sha384-css\n' > "$fed_dir/frontend.css.sri"
printf 'gpg-signature-encoder-run-1\n' > "$fed_dir/encoder.js.sig"
printf 'gpg-signature-css-run-1\n' > "$fed_dir/frontend.css.sig"
printf '{"ceraUiVersion":"2026.7.0","files":[]}\n' > "$fed_dir/manifest.json"
printf 'ed25519-signature\n' > "$fed_dir/manifest.json.sig"

export PATH="$temp_dir/bin:$PATH"
export MOCK_R2_ROOT="$temp_dir/r2"
export MOCK_AWS_LOG="$temp_dir/aws.log"
export R2_BUCKET="federation"
export R2_ENDPOINT="https://example.r2.cloudflarestorage.com"

bash "$publisher" "$fed_dir" "ui-bundle/2026.7.0"
remote_prefix="$temp_dir/r2/federation/ui-bundle/2026.7.0"
test -f "$remote_prefix/encoder.js"
test -f "$remote_prefix/manifest.json.sig"

asset_put_line="$(grep -n 'put-object.*ui-bundle/2026.7.0/encoder.js ' "$MOCK_AWS_LOG" | tail -1 | cut -d: -f1)"
manifest_put_line="$(grep -n 'put-object.*ui-bundle/2026.7.0/manifest.json ' "$MOCK_AWS_LOG" | tail -1 | cut -d: -f1)"
if ((manifest_put_line <= asset_put_line)); then
  printf 'manifest must be committed after signed assets\n' >&2
  exit 1
fi

remote_signature_before="$(sha256sum "$remote_prefix/encoder.js.sig" | cut -d' ' -f1)"
printf 'gpg-signature-encoder-run-2\n' > "$fed_dir/encoder.js.sig"
bash "$publisher" "$fed_dir" "ui-bundle/2026.7.0"
remote_signature_after="$(sha256sum "$remote_prefix/encoder.js.sig" | cut -d' ' -f1)"
test "$remote_signature_before" = "$remote_signature_after"

remote_asset_before="$(sha256sum "$remote_prefix/encoder.js" | cut -d' ' -f1)"
printf 'changed-signed-payload\n' >> "$fed_dir/encoder.js"
if bash "$publisher" "$fed_dir" "ui-bundle/2026.7.0"; then
  printf 'changed signed bytes must not reuse a published version\n' >&2
  exit 1
fi
remote_asset_after="$(sha256sum "$remote_prefix/encoder.js" | cut -d' ' -f1)"
test "$remote_asset_before" = "$remote_asset_after"
sed -i '$d' "$fed_dir/encoder.js"

export MOCK_FAIL_KEY="frontend.css"
if bash "$publisher" "$fed_dir" "ui-bundle/2026.7.1"; then
  printf 'injected upload failure must fail the publication\n' >&2
  exit 1
fi
unset MOCK_FAIL_KEY
if find "$temp_dir/r2/federation/ui-bundle/2026.7.1" -type f -print -quit 2>/dev/null | grep -q .; then
  printf 'failed fresh publication must roll back every newly-created object\n' >&2
  exit 1
fi

printf 'PASS: federation publication is immutable, idempotent, ordered, and rollback-safe\n'
