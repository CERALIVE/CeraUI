# APT Version Control for CeraUI Debian Packages

## Problem

Previously, all packages had hardcoded iteration `1`, so APT would see rebuilds as identical versions and skip updates.

## Solution

Each build gets a unique timestamp-based iteration, ensuring APT always detects newer builds.

## Version Format

The Debian package name is `ceralive-device`. Versions follow a **Calendar Versioning** convention (`YYYY.MINOR.PATCH`), sourced from the latest git tag or the `BUILD_VERSION` env var. The build script falls back to `1.0.0` if no tag exists.

Debian package filename format:

```
{name}_{version}-{iteration}_{arch}.deb
```

| Component | Source | Example |
|-----------|--------|---------|
| `name` | Fixed | `ceralive-device` |
| `version` | Latest git tag or `BUILD_VERSION` | `2026.1.0` |
| `iteration` | `YYYYMMDD_HHMMSS.commit` | `20260112_143022.abc1234` |
| `arch` | `BUILD_ARCH` or auto-detect | `arm64` |

The iteration is built from two parts: a UTC timestamp (`get_build_date`) and the short git commit hash. Together they guarantee every build produces a unique, APT-comparable version string.

## How Versions Are Set

**CI / GitHub Actions:**
- Workflow calculates the next version from existing git tags
- `release_type`: `stable` or `beta`
- Creates the tag and builds packages

**Local builds:**
```bash
# Uses latest git tag
./scripts/build/build-debian-package.sh

# Override version
BUILD_VERSION=2026.2.0 ./scripts/build/build-debian-package.sh
```

## Example Filenames

```
# Stable release
ceralive-device_2026.1.0-20260112_090000.abc1234_arm64.deb

# Patch release
ceralive-device_2026.1.1-20260115_140000.def5678_arm64.deb

# Rebuild (same version, later timestamp)
ceralive-device_2026.1.1-20260115_160000.ghi9012_arm64.deb
```

## APT Version Comparison

APT compares versions in two stages:

1. Base version: `2026.1.0 < 2026.1.1 < 2026.2.0`
2. Same base version: ordered by iteration timestamp

This means a rebuild of the same tagged version still wins over an older build, because the timestamp advances.

## Build Metadata

The build script writes `package-info-{arch}.json` alongside the `.deb`:

```json
{
  "package": "ceralive-device",
  "version": "2026.1.0",
  "iteration": "20260112_143022.abc1234",
  "fullVersion": "2026.1.0-20260112_143022.abc1234",
  "architecture": "arm64",
  "commit": "abc1234"
}
```

## See Also

- [BUILD_PIPELINE.md](BUILD_PIPELINE.md) — full build system, CI workflow, and versioning details

---

## CalVer Convention (System-Wide)

This section is the **single source of truth** for the CalVer scheme used across all CeraLive components. Every repo that produces a versioned artifact (`.deb`, npm package, Cargo crate) follows these rules.

### Format

```
YYYY.MINOR.PATCH
```

| Field | Meaning | Example |
|-------|---------|---------|
| `YYYY` | Four-digit calendar year | `2026` |
| `MINOR` | Month number, no zero-padding | `6` (June), not `06` |
| `PATCH` | Monotonic counter within the same year+month | `1`, `2`, `3` |

Canonical example: **`2026.6.1`** (cerastream, first June 2026 release).

### Semver Compatibility

npm and Cargo both parse `YYYY.MINOR.PATCH` as `MAJOR.MINOR.PATCH` — it is valid semver. No special tooling is needed. Dependency ranges like `^2026.6.0` work as expected.

### Same-Period Re-release

If you need to cut a second release in the same month, increment `PATCH`:

```
2026.6.1  →  2026.6.2  →  2026.6.3
```

Never reset `PATCH` to `0` mid-month. The counter is monotonic within a `YYYY.MINOR` period.

### Prerelease Candidates

Append `-rc.N` (starting at `1`) for release candidates:

```
2026.6.1-rc.1
2026.6.1-rc.2
2026.6.1          ← stable release
```

When publishing to npm, `-rc.N` versions go to the `next` dist-tag; stable versions go to `latest`. This matches the trigger logic in `srtla-send-rs/.github/workflows/publish-bindings.yml` (tag `bindings-vYYYY.M.P-rc.N` → `next`; `bindings-vYYYY.M.P` → `latest`) and mirrors the `@ceralive/cerastream` publish flow.

### Per-Repo Bump Artifact

Each repo owns its version in one place. Bump that file, commit, then tag:

| Repo | Version file | Field |
|------|-------------|-------|
| `cerastream` | `Cargo.toml` | `[workspace.package] version` |
| `srtla-send-rs` | `Cargo.toml` | `[workspace.package] version` (Rust crate) |
| `srtla-send-rs` bindings | `bindings/typescript/package.json` | `"version"` |
| `CeraUI` | `package.json` (root workspace) | `"version"` |
| `srtla` | CMakeLists.txt | `project(VERSION ...)` |
| `srt` | CMakeLists.txt | `project(VERSION ...)` |

Never hand-bump individual crate versions inside a Cargo workspace — they share `[workspace.package]`.

### Tag Namespaces

Two tag namespaces coexist in repos that ship both a binary `.deb` and an npm binding. They are **intentionally separate** and must not be merged:

| Namespace | Triggers | Artifact |
|-----------|----------|----------|
| `v*` (e.g. `v2026.6.1`) | `.deb` release workflow | Debian package attached to GitHub release |
| `bindings-v*` (e.g. `bindings-v2026.6.1`) | npm publish workflow | `@ceralive/*` package on npmjs.org |

Keeping them separate means a `.deb` release and a binding release can happen independently, on their own cadence, without triggering each other's CI jobs.

### Cross-References

- `cerastream/Cargo.toml` — `[workspace.package]` comment cites this file as the convention anchor.
- `srtla-send-rs/.github/workflows/publish-bindings.yml` — implements the `-rc.N` → `next` dist-tag rule.
- `versions.yaml` — pins component versions; header links here for the format spec.
