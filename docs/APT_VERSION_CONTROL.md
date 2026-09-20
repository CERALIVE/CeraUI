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

When publishing to npm, `-rc.N` versions go to the `next` dist-tag; stable versions go to `latest`, following the `@ceralive/cerastream` publish flow (tag `bindings-vYYYY.M.P-rc.N` → `next`; `bindings-vYYYY.M.P` → `latest`).

### Per-Repo Bump Artifact

Each repo owns its version in one place. Bump that file, commit, then tag:

| Repo | Version file | Field |
|------|-------------|-------|
| `cerastream` | `Cargo.toml` | `[workspace.package] version` |
| `srtla` (Rust sender) | `Cargo.toml` | `[workspace.package] version` (Rust crate) |
| `CeraUI` | `package.json` (root workspace) | `"version"` |
| `srtla` (C receiver) | CMakeLists.txt | `project(VERSION ...)` |
| `srt` | CMakeLists.txt | `project(VERSION ...)` |

Never hand-bump individual crate versions inside a Cargo workspace — they share `[workspace.package]`.

### Tag Namespaces

Two tag namespaces coexist in repos that ship both a binary `.deb` and an npm binding. They are **intentionally separate** and must not be merged:

| Namespace | Purpose | Artifact |
|-----------|----------|----------|
| `v*` (e.g. `v2026.6.1`) | Binary release identity | Debian package attached to GitHub release |
| `bindings-v*` (e.g. `bindings-v2026.6.1`) | npm binding release | `@ceralive/*` package on npmjs.org |

Keeping them separate means a `.deb` release and a binding release can happen independently, on their own cadence, without triggering each other's CI jobs.

### CeraUI Release Trigger

CeraUI's normal `.deb` release is **not** tag-triggered. Run
`publish-release.yml` with `workflow_dispatch`; it builds the ARM64 and AMD64
system archives and Debian packages, verifies the federation bundle version,
publishes the GitHub release, then dispatches stable `apt-reindex` to
`CERALIVE/apt-worker`. This direct handoff is required because a tag created
with `GITHUB_TOKEN` does not trigger another workflow. `publish-deb.yml` is
manual recovery for an existing release and is not a second normal release path.
Both workflows must be dispatched from the default branch. Recovery
resolves the supplied tag to one commit, checks out that commit in detached mode,
uses it for the release/package contracts, lint/typecheck, unit tests, and package
build, verifies the tag has not moved and `package.json` matches, and fails unless
that release exists before build and upload.
Tag and version inputs are transported through step environment variables and
validated as canonical stable CalVer before workflow outputs or commands run.
`bun run test:release-package-contracts` is the required local and CI gate for
these release, package-provenance, and input-security contracts.
Both release workflows also install from the frozen lockfile and run
`bun run lint` plus `bun run test` before any build or publication job.
The primary release workflow accepts `force_version` only for stable canonical
CalVer, transports all input-derived version/tag values through step env, and
fails before any build unless the calculated version matches `package.json`.
An empty current-month stable-tag set is a valid first-release state for both
automatic stable and beta calculation; it does not terminate the shell pipeline.
It also rejects an existing tag or release before builds and rechecks immediately
before publication. The release action creates the tag from the workflow dispatch
SHA and verifies the resulting tag, so the tag and every attached asset identify
the same source commit.

### Cross-References

- `cerastream/Cargo.toml` — `[workspace.package]` comment cites this file as the convention anchor.
- `cerastream`'s binding publish workflow — implements the `-rc.N` → `next` dist-tag rule.
- `versions.yaml` — pins component versions; header links here for the format spec.

---

## Exception: srtla (Rust sender, upstream semver)

The Debian package `srtla` — the Rust SRTLA **sender**, installed at
`/usr/bin/srtla_send` — is the **one** first-party component that does NOT use CalVer
for its package version.

**Why:** it is a CERALIVE hard fork of the upstream
[irlserver/srtla_send](https://github.com/irlserver/srtla_send) Rust sender, which
uses conventional semver (`MAJOR.MINOR.PATCH`). Keeping the upstream version line in
`Cargo.toml` preserves direct traceability to the upstream release a build came from,
and avoids a confusing divergence between the fork's package version and its upstream
base.

**Where it lives:** releases are published at
[`CERALIVE/srtla-send-rs/releases`](https://github.com/CERALIVE/srtla-send-rs/releases).
The repository kept its name through the fork; only the package identity changed, so
the repository name and the package name deliberately differ, and neither is derivable
from the other — resolve a component to its repository through an explicit mapping,
never by assuming they share a name.

**Package version source:** `ci/build-deb.sh` derives the `.deb` version directly from
`Cargo.toml` `[workspace.package] version`. The current package version is `4.1.0`,
and `versions.yaml` pins it at `v4.1.0`.

**Tag namespace:** GitHub release tags are `v<package-version>` (currently `v4.1.0`).
The tag triggers the `.deb` build workflow and the build refuses a tag that disagrees
with `Cargo.toml`, so tag and package version move together.

**npm binding version:** there is none. The sender's TypeScript binding was
absorbed into CeraUI as the private workspace package `packages/srtla-send`
(`@ceraui/srtla-send`) and is never published, so no binding tag namespace or
binding version exists. Only the Rust crate / `.deb` version applies.

**Rename history:** before the 4.x hard fork this package was published as
`srtla-send-rs`; the `srtla` package declares `Conflicts`/`Replaces` against that
retired name, so APT migrates an already-deployed device in place on upgrade.

**Debian version ordering:** APT's version comparison still works correctly across the
mixed scheme. A future CalVer release of any other component (e.g. `2026.7.1`) sorts
above `4.1.0` as expected — but nothing compares the two, because each package's
version is only ever compared against its own stream.

**All other first-party packages** (`ceralive-device`, `cerastream`,
`gstreamer1.0-libuvcsrc`) remain on CalVer (`YYYY.MINOR.PATCH`) as described
above.
