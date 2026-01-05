# CeraUI Build Pipeline

This document describes the automated build pipeline for creating CeraUI distributions.

## Distribution Types

### 1. CeraUI Full System

- **Purpose**: Complete CeraUI system deployment
- **Target**: Custom development devices or system replacement
- **Script**: `scripts/build/build-ceraui-system.sh`
- **Output**: `dist/compressed/`

**Use Cases**:
- Replace existing installations
- Deploy on custom development hardware
- Full system with installation/uninstallation scripts

### 2. Debian Package

- **Purpose**: Installation via package manager
- **Target**: Debian/Ubuntu-based systems
- **Script**: `scripts/build/build-debian-package.sh`
- **Output**: `dist/debian/`

**Use Case**: Professional deployment with package management integration.

## Versioning

CeraUI uses **Calendar Versioning (CalVer)** with automatic version detection.

### Version Format

| Release Type | Format | Example |
|--------------|--------|---------|
| Stable | `YYYY.M.patch` | `v2026.1.0`, `v2026.1.1` |
| Beta | `YYYY.M.patch-beta.N` | `v2026.1.1-beta.1` |

### Version Calculation

Versions are automatically calculated based on existing git tags:

```
January 2026:
  First stable release:     v2026.1.0
  Second stable release:    v2026.1.1
  First beta (next patch):  v2026.1.2-beta.1
  Second beta:              v2026.1.2-beta.2

February 2026 (new month):
  First stable release:     v2026.2.0
```

## GitHub Actions Workflow

The build pipeline runs manually via workflow dispatch.

### Workflow Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `release_type` | Yes | `stable` or `beta` |
| `release_notes` | No | Description of changes |
| `force_version` | No | Override auto-detected version |

### Jobs

1. **calculate-version**
   - Detects next version from existing git tags
   - Outputs version, tag, and beta status

2. **build-ceraui-system** (matrix: arm64, amd64)
   - Builds full system with installation scripts
   - Creates compressed archive (.tar.gz)
   - Uploads artifact: `ceraui-system-{arch}`

3. **build-debian-package** (matrix: arm64, amd64)
   - Creates Debian package for target architecture
   - Uploads artifact: `ceraui-debian-{arch}`

4. **create-release**
   - Creates GitHub release with all assets
   - Generates changelog from commit history
   - Marks beta releases as pre-release

## Local Development

### Prerequisites

```bash
# Node.js 24
node --version

# pnpm
pnpm --version

# Bun (for backend compilation)
bun --version

# Ruby + FPM (for Debian packages)
gem install fpm
```

### Running Build Scripts

```bash
# Full CeraUI system (auto-detect architecture)
./scripts/build/build-ceraui-system.sh

# Full CeraUI system for specific architecture
BUILD_ARCH=arm64 ./scripts/build/build-ceraui-system.sh
BUILD_ARCH=amd64 ./scripts/build/build-ceraui-system.sh

# Debian package (auto-detect architecture)
./scripts/build/build-debian-package.sh

# Debian package for specific architecture
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
```

## Build Artifacts

### Release Assets

After a successful workflow run, the following assets are attached to the GitHub release:

| File | Description |
|------|-------------|
| `ceraui-{version}-arm64.tar.gz` | System archive for ARM64 |
| `ceraui-{version}-amd64.tar.gz` | System archive for AMD64 |
| `ceralive-device_{version}_arm64.deb` | Debian package for ARM64 |
| `ceralive-device_{version}_amd64.deb` | Debian package for AMD64 |

### System Archive Contents

```
ceraui-2026.1.0-arm64.tar.gz
├── ceralive              # Backend binary
├── public/               # Frontend assets
├── ceralive.service      # Systemd service
├── ceralive.socket       # Systemd socket
├── *.rules               # Udev rules
├── config.json           # Default configuration
├── install.sh            # Installation script
├── uninstall.sh          # Uninstallation script
└── build-info.json       # Build metadata
```

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BUILD_VERSION` | Version string (set by workflow) |
| `BUILD_ARCH` | Target architecture: `arm64` or `amd64` |
| `VITE_BRAND` | Frontend branding |
| `NODE_ENV` | Build environment |

## Build Process

1. Navigate to **Actions** in the GitHub repository
2. Select **Build & Release** workflow
3. Click **Run workflow**
4. Select release type (`stable` or `beta`)
5. Optionally add release notes
6. Click **Run workflow**

The workflow will:
- Calculate the next version automatically
- Build for both ARM64 and AMD64
- Create system archives and Debian packages
- Publish a GitHub release with all assets

## Target Hardware

| Architecture | Recommended Devices |
|--------------|---------------------|
| **arm64** | Orange Pi 5+, Radxa Rock 5B+, NVIDIA Jetson Orin |
| **amd64** | Intel N100/N200 Mini PCs, AMD Ryzen, desktop computers |

## Troubleshooting

### Build fails on missing dependencies

- Verify all prerequisites are installed
- Check Node.js version (requires 24+)
- Verify Bun is installed

### FPM not found

```bash
sudo apt install ruby-dev gcc g++
gem install fpm
```

### Permission denied on scripts

```bash
chmod +x scripts/build/*.sh
```

### Build metadata

All builds include metadata in `build-info.json`:

```json
{
  "version": "2026.1.0",
  "commit": "abc123",
  "buildDate": "2026-01-04T12:00:00Z",
  "nodeVersion": "v24.x.x",
  "architecture": "arm64"
}
```
