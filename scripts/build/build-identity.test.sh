#!/usr/bin/env bash
set -euo pipefail

# Package-contract test: one checkout, one build identity.
#
# A UI page names the build it was served from (CERAUI_BUILD_ID, the bundle's
# __APP_VERSION__) and the backend compares it with its /opt/ceralive/build-id
# stamp, refusing Live writes from a page of another build. So every artifact a
# checkout produces must carry the same value in both places, including the
# amd64 package that reuses the arm64 build's cached frontend and the system
# archive. From a clean checkout (tracked files only: no cache, no generated
# files, no node_modules) this builds the arm64 package, then the amd64 package,
# then the system archive, installs each into a scratch root and compares the
# installed stamp with the identity the installed bundle carries.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

checkout="$work/checkout"
mkdir -p "$checkout"
git -C "$repo_root" ls-files -z | tar -C "$repo_root" --null -T - -cf - | tar -C "$checkout" -xf -
git -C "$checkout" init -q
git -C "$checkout" add -A

installed_identity() {
	local root="$1" name="$2" stamp bundle
	stamp="$(cat "$root/opt/ceralive/build-id")" || fail "$name installs no /opt/ceralive/build-id"
	[[ "$stamp" =~ ^ceraui-build-[0-9a-f]{64}$ ]] || fail "$name stamps an unexpected identity: '$stamp'"
	bundle="$(grep -rhoE 'ceraui-build-[0-9a-f]{64}' "$root/var/www/ceralive" | sort -u)"
	[[ "$bundle" == "$stamp" ]] || fail "$name: the installed bundle names '${bundle:-nothing}', its stamp '$stamp'"
	printf '%s\n' "$stamp"
}

(
	cd "$checkout"
	unset CERAUI_BUILD_ID
	BUILD_VERSION="$(bun -p "require('./package.json').version")"
	export BUILD_VERSION
	bun install --frozen-lockfile >"$work/install.log" 2>&1 || { cat "$work/install.log" >&2; fail "bun install"; }

	for arch in arm64 amd64; do
		BUILD_ARCH="$arch" ./scripts/build/build-debian-package.sh >"$work/deb-$arch.log" 2>&1 \
			|| { tail -40 "$work/deb-$arch.log" >&2; fail "the $arch package build failed"; }
		mkdir -p "$work/root-$arch"
		dpkg-deb -x dist/debian/*.deb "$work/root-$arch"
	done
	grep -Fq 'Frontend cache valid - reusing existing build' "$work/deb-amd64.log" \
		|| fail "the amd64 package did not reuse the arm64 build's cached frontend"

	BUILD_ARCH=amd64 ./scripts/build/build-ceraui-system.sh >"$work/system.log" 2>&1 \
		|| { tail -40 "$work/system.log" >&2; fail "the system archive build failed"; }
	mkdir -p "$work/archive" "$work/root-archive"
	tar -xzf dist/compressed/*.tar.gz -C "$work/archive"
	( cd "$work/archive" && DESTDIR="$work/root-archive" bash install.sh >"$work/install-archive.log" 2>&1 ) \
		|| { cat "$work/install-archive.log" >&2; fail "the archive installer failed under DESTDIR"; }
)

ids="$(
	installed_identity "$work/root-arm64" "the arm64 package"
	installed_identity "$work/root-amd64" "the amd64 package"
	installed_identity "$work/root-archive" "the system archive"
)"
[[ "$(sort -u <<<"$ids" | wc -l)" -eq 1 ]] || fail "one checkout produced different identities: $ids"

printf 'PASS: the arm64 and amd64 packages and the system archive install one build identity in stamp and bundle\n'
