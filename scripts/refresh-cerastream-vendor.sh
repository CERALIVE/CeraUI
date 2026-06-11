#!/bin/bash
set -euo pipefail

# Refresh the vendored @ceralive/cerastream tarball to a published npm version.
# CeraUI consumes the bindings as a vendored file: dependency (ADR-0002 Decision
# 13 — standalone build, no sibling checkout). This script replaces the tarball
# with a freshly packed npm release so the baked-in bindings track the engine,
# instead of a developer remembering to do it by hand.
#
# Usage:
#   scripts/refresh-cerastream-vendor.sh [version]
#     version — an npm version (e.g. 2026.6.0-rc.2) or dist-tag (default: next)

VERSION="${1:-next}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/apps/backend/vendor"
TARGET="$VENDOR_DIR/ceralive-cerastream.tgz"

mkdir -p "$VENDOR_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching @ceralive/cerastream@${VERSION} from npm…"
( cd "$TMP" && npm pack "@ceralive/cerastream@${VERSION}" >/dev/null )

PACKED="$(ls "$TMP"/ceralive-cerastream-*.tgz 2>/dev/null | head -1)"
if [ -z "${PACKED:-}" ]; then
    echo "error: npm pack produced no tarball for @ceralive/cerastream@${VERSION}" >&2
    exit 1
fi

# The file: dependency points at a version-agnostic filename, so overwrite in place.
cp "$PACKED" "$TARGET"
echo "Vendored → $TARGET"

# Re-extract into the workspace so the file: dependency resolves the new contents.
( cd "$REPO_ROOT" && pnpm install )

echo "Done. Verify with: pnpm --filter backend test"
