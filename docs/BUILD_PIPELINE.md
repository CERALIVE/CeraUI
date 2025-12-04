# CeraUI Build Pipeline

This document describes the automated build pipeline for creating different CeraUI distributions.

## 📦 Distribution Types

### 1. CeraUI Frontend for CeraLive

- **Purpose**: CeraUI frontend distribution compatible with existing CeraLive devices
- **Target**: Devices already running CeraLive backend
- **Brand**: CeraLive
- **Script**: `scripts/build/build-ceraui-frontend-for-ceralive.sh`
- **Output**: `dist/ceralive-frontend/`

**Use Case**: Deploy CeraUI frontend on existing CeraLive devices without touching the backend.

### 2. CeraUI Full System (Compressed)

- **Purpose**: Complete CeraUI system replacement
- **Target**: Replace CeraLive or deploy on custom development devices (not specifically branded)
- **Brand**: CERALIVE
- **Script**: `scripts/build/build-ceraui-system.sh`
- **Output**: `dist/compressed/`

**Use Case**:

- Replace existing CeraLive installations completely
- Deploy on custom development hardware for testing
- Full system with installation/uninstallation scripts
- Development and testing environments

### 3. Debian Package

- **Purpose**: Easy installation via package manager
- **Target**: Debian/Ubuntu-based systems
- **Brand**: CERALIVE
- **Script**: `scripts/build/build-debian-package.sh`
- **Output**: `dist/debian/`

**Use Case**: Professional deployment with proper package management integration.

## 🚀 GitHub Actions Workflow

The build pipeline runs **manually only** via workflow dispatch with:

- **Version input**: Specify the version number (e.g., 1.2.3)
- **Release notes**: Optional description of changes

### Jobs

1. **build-ceraui-frontend-for-ceralive**

   - Builds CeraUI frontend distribution for CeraLive devices
   - Uploads artifact: `ceraui-frontend-for-ceralive`

2. **build-ceraui-system**

   - Builds full system with installation scripts
   - Creates compressed archives (.tar.gz, .zip)
   - Uploads artifact: `ceraui-system-compressed`

3. **build-debian-package**

   - Installs FPM (Effing Package Management)
   - Creates Debian package
   - Uploads artifact: `ceraui-debian-package`

4. **build-summary**
   - Provides build status summary with version information
   - Shows release notes and artifact information
   - Runs regardless of job success/failure

## 🛠️ Local Development

### Prerequisites

```bash
# Node.js 20+
node --version

# pnpm
pnpm --version

# Bun (for backend compilation)
bun --version

# Ruby + FPM (for Debian packages)
gem install fpm
```

### Running Build Scripts Locally

```bash
# CeraUI frontend for CeraLive
./scripts/build/build-ceraui-frontend-for-ceralive.sh

# Full CeraUI system
./scripts/build/build-ceraui-system.sh

# Debian package
./scripts/build/build-debian-package.sh
```

## 📋 Package.json Integration

The build scripts use existing package.json commands:

```json
{
  "scripts": {
    "build": "VITE_BRAND=CERALIVE pnpm --filter backend run build",
    "build:frontend": "VITE_BRAND=CERALIVE pnpm --filter frontend run build",
    "build:ceralive": "VITE_BRAND=CeraLive pnpm --filter backend run build"
  }
}
```

**Scripts DO NOT modify package.json** - they reuse existing build commands.

## 🏗️ Build Artifacts

### Frontend Distribution Structure

```
dist/ceralive-frontend/
├── index.html
├── assets/
├── manifest.webmanifest
├── README.md
└── build-info.json
```

### System Distribution Structure

```
dist/compressed/
├── ceraui-v1.0.0-abc123-20250101_120000.tar.gz
├── ceraui-v1.0.0-abc123-20250101_120000.zip
├── ceraui-v1.0.0-abc123-20250101_120000.tar.gz.sha256
└── ceraui-v1.0.0-abc123-20250101_120000.zip.sha256
```

### Debian Package Structure

```
dist/debian/
├── ceralive-device_1.0.0-1_arm64.deb
├── package-info.json
└── INSTALL.md
```

## 🔧 Configuration

### Environment Variables

- `VITE_BRAND`: Controls frontend branding (CERALIVE/CeraLive)
- `NODE_ENV`: Build environment (production for releases)

### Version Management

- **Version**: Manually provided via workflow input (e.g., `1.2.3`)
- **Commit**: Short commit hash (`git rev-parse --short HEAD`)
- **Build Date**: UTC timestamp

## 📦 Build Process

1. **Navigate to GitHub Actions**: Go to the repository's Actions tab

2. **Select Workflow**: Choose "Build Distributions"

3. **Run Workflow**: Click "Run workflow" and provide:

   - **Version**: e.g., `1.2.3` (required)
   - **Release Notes**: Optional description of changes

4. **Download Artifacts**: After build completion, download distributions from the workflow run artifacts

## 🎯 Use Cases Summary

| Distribution                | Use Case                    | Target              |
| --------------------------- | --------------------------- | ------------------- |
| CeraUI Frontend for CeraLive | Deploy CeraUI UI on CeraLive | CeraLive devices     |
| CeraUI System               | Replace CeraLive completely   | Development devices |
| Debian Package              | Professional deployment     | Production systems  |

## 🔍 Troubleshooting

### Common Issues

1. **Build fails on missing dependencies**

   - Ensure all prerequisites are installed
   - Check Node.js/Bun versions

2. **FPM not found**

   - Install Ruby development headers: `sudo apt install ruby-dev gcc g++`
   - Install FPM: `gem install fpm`

3. **Permission denied on scripts**
   - Make scripts executable: `chmod +x scripts/build/*.sh`

### Debug Information

All builds include debug information in `build-info.json`:

```json
{
  "version": "1.0.0",
  "commit": "abc123",
  "buildDate": "2025-01-01T12:00:00Z",
  "nodeVersion": "v20.x.x",
  "pnpmVersion": "8.x.x"
}
```
