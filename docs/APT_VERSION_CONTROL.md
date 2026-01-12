# APT Version Control for CeraUI Debian Packages

## Problem

Previously, all packages had hardcoded iteration "1", so APT would see rebuilds as identical versions and skip updates.

## Solution

Each build gets a unique timestamp-based iteration, ensuring APT always detects newer builds.

## Version Format

CeraUI uses **Calendar Versioning (CalVer)**: `YYYY.MINOR.PATCH[-beta.N]`

Debian package naming:

```
{name}_{version}-{iteration}_{arch}.deb
```

| Component | Source | Example |
|-----------|--------|---------|
| name | Fixed | `ceralive-device` |
| version | Git tag or `BUILD_VERSION` | `2026.1.0` |
| iteration | `YYYYMMDD_HHMMSS.commit` | `20260112_143022.abc1234` |
| arch | `BUILD_ARCH` or auto-detect | `arm64` |

## How Versions Are Set

**GitHub Actions:**
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

APT compares versions:

1. Base version: `2026.1.0 < 2026.1.1 < 2026.2.0`
2. Same version: ordered by iteration timestamp

## Build Metadata

Generated in `package-info-{arch}.json`:

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

- [BUILD_PIPELINE.md](BUILD_PIPELINE.md) - Full build system and CalVer details
