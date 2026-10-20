#!/usr/bin/env bash
set -euo pipefail

# The selector invokes gpgv with the Debian archive keyring even when APT itself
# uses sqv. Lock both signature prerequisites without building a .deb or probing
# the host. This is not a complete inventory of capability-owned image tooling.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

declared_depends() {
    awk '
        /^fpm -s dir -t deb / { inside = 1; next }
        inside && /^[[:space:]]*\.[[:space:]]*$/ { exit }
        inside && /^[[:space:]]*--depends "[^"]+"/ {
            dependency = $0
            sub(/^[[:space:]]*--depends "/, "", dependency)
            sub(/".*/, "", dependency)
            sub(/[[:space:](].*/, "", dependency)
            print dependency
        }
    ' "$@"
}

has_dependency() {
    grep -Fxq -- "$1"
}

# Non-vacuity: similarly named packages, comments and Recommends cannot satisfy
# a mandatory runtime requirement. Versioned Depends still identifies its package.
fixture_depends="$(declared_depends <<'FIXTURE'
fpm -s dir -t deb \
    --recommends "gpgv" \
    --depends "gpgv-extra" \
    --depends "debian-archive-keyring (>= 2025.1)" \
    # --depends "gpgv" \
    .
FIXTURE
)"
if has_dependency gpgv <<< "$fixture_depends"; then
    fail 'dependency reader accepts Recommends, a comment or a prefix match'
fi
has_dependency debian-archive-keyring <<< "$fixture_depends" \
    || fail 'dependency reader lost a versioned mandatory dependency'

depends="$(declared_depends scripts/build/build-debian-package.sh)"
[[ -n "$depends" ]] || fail 'could not read the FPM Depends arguments'

# The repaired audited set is the verifier AND its hardcoded trust-anchor file.
# gpgv alone does not ship /usr/share/keyrings/debian-archive-keyring.gpg.
missing=0
for package in gpgv debian-archive-keyring; do
    if ! has_dependency "$package" <<< "$depends"; then
        printf 'FAIL: update signature verification requires Depends: %s\n' "$package" >&2
        missing=1
    fi
done
[[ "$missing" -eq 0 ]] || exit 1

printf 'PASS: update signature prerequisites are mandatory Depends: gpgv, debian-archive-keyring\n'
