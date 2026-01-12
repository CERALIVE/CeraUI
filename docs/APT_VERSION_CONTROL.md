# APT Version Control for CeraUI Debian Packages

## Problem

Previously, all packages had hardcoded iteration "1", so APT would see all versions as identical:

- `ceralive-device_2026.1.0-1_amd64.deb`
- `ceralive-device_2026.1.0-1_amd64.deb` (same version!)

APT would NOT detect newer builds within the same version number.

## Solution

Each build now gets a unique timestamp-based iteration:

- `ceralive-device_2026.1.0-20260112090000.adb87b3_amd64.deb`
- `ceralive-device_2026.1.0-20260112140000.def5678_amd64.deb`

APT will always detect newer builds as updates.

## Version Format

CeraUI uses **Calendar Versioning (CalVer)**: `YYYY.MINOR.PATCH`

```
{package}_{version}-{iteration}_{architecture}.deb
```

Where:

- **package**: `ceralive-device`
- **version**: CalVer version (e.g., `2026.1.0`) from git tags or BUILD_VERSION
- **iteration**: `YYYYMMDDHHMMSS.{commit}` (e.g., `20260112140000.def5678`)
- **architecture**: `amd64` or `arm64`

## APT Version Comparison

APT compares versions using these rules:

1. **Version numbers**: `2026.1.0 < 2026.1.1 < 2026.2.0`
2. **Same version, different iterations**: `2026.1.0-20260112090000 < 2026.1.0-20260112140000`
3. **Timestamps ensure chronological ordering**

### Example Progression

```bash
# Morning build
ceralive-device_2026.1.0-20260112090000.adb87b3_amd64.deb

# Afternoon build (same day, new commit) - APT sees as NEWER
ceralive-device_2026.1.0-20260112140000.def5678_amd64.deb

# Next release with version bump - APT sees as NEWEST
ceralive-device_2026.1.1-20260115100000.ghi9abc_amd64.deb
```

## Build Script Changes

### Before

```bash
--iteration "1"  # Hardcoded - broken
```

### After

```bash
BUILD_DATE=$(date -u +"%Y%m%d%H%M%S")
ITERATION="${BUILD_DATE}.${COMMIT}"
--iteration "$ITERATION"  # Dynamic - works
```

## Generated Metadata

Each package includes comprehensive version information:

```json
{
  "version": "2026.1.0",
  "iteration": "20260112140000.def5678",
  "fullVersion": "2026.1.0-20260112140000.def5678",
  "apt": {
    "versionProgression": "Each build has unique timestamp-based iteration",
    "comparisonMethod": "APT compares: 2026.1.0-20260112140000.def5678"
  }
}
```

## Repository Implications

When you set up your APT repository:

1. `apt update` will download package lists with all available versions
2. `apt upgrade` will detect newer timestamp-based iterations
3. `apt install ceralive-device` will install the latest available version
4. Users get automatic updates as you publish newer builds

## Verification

Test the version progression:

```bash
# Build 1
BUILD_VERSION=2026.1.0 BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
# Produces: ceralive-device_2026.1.0-20260112090000.abc123_amd64.deb

# Build 2 (later same day)
BUILD_VERSION=2026.1.0 BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
# Produces: ceralive-device_2026.1.0-20260112140000.abc123_amd64.deb

# APT will see Build 2 as newer than Build 1
```

## Result

Your APT repository will now properly support incremental updates. Every build is guaranteed to have a unique, chronologically-ordered version that APT can compare correctly.

## See Also

- [BUILD_PIPELINE.md](BUILD_PIPELINE.md) - CalVer versioning details and automatic version calculation
