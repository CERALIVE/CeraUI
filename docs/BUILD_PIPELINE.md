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
- **Runtime payload**: ships the immutable backend `setup.json` at
  `/opt/ceralive/setup.json`; the device image seeds it into persistent
  `/data/ceralive` on first boot before CeraUI starts.
- **Output**: `dist/debian/`

**Use Case**: Professional deployment with package management integration.

### Smart-build cache inputs

The package builders reuse `.build-cache` only while the complete production
input set is unchanged. Both frontend and backend hashes cover the workspace
package manifest, Bun lockfile/runtime pin, root `tsconfig.json`, shared
packages, build scripts, deployment files, and backend setup data. Each hash
also covers its component tree, including component-local TypeScript configs;
therefore a change to an inherited compiler option invalidates the affected
cache before packaging.

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
| `force_version` | No | Override auto-detected stable version (`YYYY.M.PATCH`; must match `package.json`) |

### Jobs

1. **calculate-version**
   - Rejects dispatches that are not from the default branch
   - Detects next version from existing git tags
   - Treats an empty current-month stable-tag set as the first stable/beta release,
     rather than a shell error
   - Rejects a calculated tag or GitHub release that already exists
   - Outputs version, tag, and beta status

2. **release-package-contracts**
   - Installs dependencies from the frozen Bun lockfile
   - Runs `bun run test:release-package-contracts`
   - Gates provenance, release dependency ordering, and dispatch-input security
   - Verifies the calculated release version exactly matches `package.json`
   - Runs `bun run lint` (Biome + backend/frontend typechecks) and `bun run test`
   - Prepares the CI-only writable runtime directories required by backend tests
   - Must pass before archive builds, Debian builds, or federation publication

3. **build-ceraui-system** (matrix: arm64, amd64)
   - Builds full system with installation scripts
   - Creates compressed archive (.tar.gz)
   - Uploads artifact: `ceraui-system-{arch}`

4. **build-debian-package** (matrix: arm64, amd64)
   - Creates Debian package for target architecture
   - Uploads artifact: `ceraui-debian-{arch}`

5. **publish-federation**
   - Builds, signs, verifies, and conditionally uploads version-matched federation bundles
   - Reuses an existing version only when its signed payload digest matches
   - Rolls back keys created by a failed fresh attempt; never overwrites an existing key

6. **create-release**
   - Creates GitHub release with all assets
   - Creates the release tag from the exact workflow dispatch SHA
   - Rechecks that the tag/release is unused, then verifies the created tag commit
   - Generates changelog from commit history
   - Marks beta releases as pre-release

7. **dispatch-apt-reindex** (stable only)
   - Runs only after `create-release` attaches the ARM64 and AMD64 `.deb` assets
   - Dispatches `apt-reindex` to `CERALIVE/apt-worker`, the sole owner of R2
     uploads and signed APT metadata (`Packages`, `Release`, `InRelease`)

`publish-release.yml` is the only normal release entry point. It publishes the
system archives, both Debian packages, and the version-matched federation bundles,
then dispatches stable APT reindex explicitly. Do not rely on a tag created with
`GITHUB_TOKEN` to trigger `publish-deb.yml`; GitHub does not recursively trigger
that workflow. Both workflows must be dispatched from the default branch.
`publish-deb.yml` is manual recovery for an existing release only: it
resolves the supplied tag once, detaches at that immutable commit, rejects a tag
move, verifies the package version, and requires the matching GitHub release both
before build and upload. Its release/package contracts, lint/typecheck, unit tests,
and Debian build all check out that same resolved commit; the dispatch commit is
never used as a substitute quality gate for tagged package code.
Dispatch inputs enter shell steps only through environment variables and must
match canonical stable CalVer (`YYYY.M.PATCH` and `vYYYY.M.PATCH`).
The primary `force_version` override follows the same rule and is rejected for
beta releases; calculated stable and beta tags are validated before outputs, and
the release stops before builds if the selected version differs from `package.json`
or the tag/release identity is already in use.
Both the normal and recovery workflows require frozen install, lint/typecheck,
and unit tests before their build jobs can run.

### Pull Request Build Check E2E

`.github/workflows/build-check.yml` builds the frontend once in `setup-e2e`, uploads
the resulting `frontend-dist`, and fans functional E2E coverage across the
desktop/mobile × two-shard matrix. The setup job caches only Playwright browser
binaries, keyed by the exact version reported by the installed Playwright CLI;
it does not install runner-local OS packages. Each isolated matrix runner runs
`test:e2e:install-deps` for its own Ubuntu image, restores the versioned browser
cache, and installs the browser only on a cache miss. Each lane uploads a unique
blob report, which `merge-e2e-reports` combines into the final HTML report.

Run the structured YAML topology contract locally with:

```bash
bun run test:build-check-shape
```

## Local Development

### Prerequisites

```bash
# Node.js 24
node --version

# Bun (package manager + backend compilation)
bun --version

# Ruby + FPM (for Debian packages)
gem install fpm
```

### Running Build Scripts

```bash
# Required release/package contract gate
bun run test:release-package-contracts

# Root-owned service + mock attach contract in an isolated temporary state directory
bun run test:service-contract

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

The packaged `ceralive.service` runs as `root` because it manages device hardware
and privileged system controls. The unit and compiled backend both pin
`NODE_ENV=production`; development mock mode must never run on a device image.
Its boot identity uses the installed `srtla_send` binary and real `/dev` hardware
directories. The legacy BCRPT helper is opt-in and is not required to boot a
device image.

## Build Process

1. Navigate to **Actions** in the GitHub repository
2. Select **Publish Release** workflow
3. Click **Run workflow**
4. Select release type (`stable` or `beta`)
5. Optionally add release notes
6. Optionally set `force_version` to the stable version already recorded in
   `package.json`, then click **Run workflow**.

The workflow will:
- Calculate the next version automatically
- Verify that version matches `package.json` before starting builds
- Build for both ARM64 and AMD64
- Create system archives and Debian packages
- Publish the matching federation bundles and GitHub release with all assets
- Dispatch stable APT reindex only after the release assets exist

## Target Hardware

| Architecture | Recommended Devices |
|--------------|---------------------|
| **arm64** | Orange Pi 5+, Radxa Rock 5B+ |
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
