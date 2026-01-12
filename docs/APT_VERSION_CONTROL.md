# APT Version Control for CeraUI Debian Packages

## Problem

Previously, all packages had hardcoded iteration "1", so APT would see rebuilds as identical versions and skip updates.

## Solution

Each build gets a unique timestamp-based iteration, ensuring APT always detects newer builds.

## Version Format

CeraUI uses **Calendar Versioning (CalVer)**: `YYYY.MINOR.PATCH[-beta.N]`

```
{package}_{version}-{iteration}_{architecture}.deb
```

Components:

| Part | Source | Example |
|------|--------|---------|
| package | Fixed | `ceralive-device` |
| version | Git tag or `BUILD_VERSION` | `2026.1.0`, `2026.1.1-beta.1` |
| iteration | Build timestamp + commit | `20260112_143022.abc1234` |
| architecture | `BUILD_ARCH` or auto-detect | `arm64`, `amd64` |

## How Versions Are Set

**GitHub Actions (production releases):**
- Workflow calculates next version from existing git tags
- `release_type`: `stable` or `beta`
- Creates tag and builds packages

**Local builds:**
```bash
# Uses latest git tag
./scripts/build/build-debian-package.sh

# Override version
BUILD_VERSION=2026.2.0 ./scripts/build/build-debian-package.sh
```

## APT Version Comparison

APT compares versions using these rules:

1. **Base versions**: `2026.1.0 < 2026.1.1 < 2026.2.0`
2. **Beta vs stable**: `2026.1.1-beta.1 < 2026.1.1-beta.2 < 2026.1.1`
3. **Same version, different iterations**: chronological by timestamp

### Example Progression

```
# Beta builds
ceralive-device_2026.1.1-beta.1-20260112_090000.abc123_arm64.deb
ceralive-device_2026.1.1-beta.2-20260113_140000.def456_arm64.deb

# Stable release (always newer than betas of same version)
ceralive-device_2026.1.1-20260115_100000.ghi789_arm64.deb

# Rebuilds of same version are ordered by timestamp
ceralive-device_2026.1.1-20260115_143022.jkl012_arm64.deb
```

## Build Metadata

Each package includes `package-info-{arch}.json`:

```json
{
  "package": "ceralive-device",
  "version": "2026.1.1",
  "iteration": "20260112_143022.abc1234",
  "fullVersion": "2026.1.1-20260112_143022.abc1234",
  "architecture": "arm64",
  "commit": "abc1234"
}
```

## APT Repository

When deployed to an APT repository:

1. `apt update` downloads package lists
2. `apt upgrade` detects newer timestamp iterations
3. Users get automatic updates as new builds are published

## See Also

- [BUILD_PIPELINE.md](BUILD_PIPELINE.md) - Full build system documentation and CalVer details
