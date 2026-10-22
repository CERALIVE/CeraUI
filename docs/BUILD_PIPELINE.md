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

### Frontend link repair [EXISTS; host-tested, board proof owed]

The generated Bash `postinst configure` repairs `/opt/ceralive/public` before
the upgrade service-restart ladder. The exact link target is `/var/www/ceralive`,
where the package installs its frontend. A persistent real directory can survive
dpkg unpacking (and OS updates through the `/data/ceralive` bind) and otherwise
leave a new backend serving old assets.

- A correct symlink is a no-op, including its inode and timestamps. A missing
  link is created; a wrong symlink is replaced without following its target.
- A directory, regular file, socket or other non-link entry is renamed beside
  it to `public.stale-YYYYMMDDTHHMMSSZ` using UTC, with a numeric suffix on
  collision (including dangling symlinks at backup names), before linking. The
  suffix is the highest existing numeric suffix for that second plus one, not
  the first gap. Name matching uses the C locale, so digits are ASCII only.
- After a successful repair, retain at most three previous real backup directories
  plus the entry just displaced by this run (up to four directories). The new
  backup never consumes a previous-backup slot or gets pruned in its creating run,
  even if the clock moved backwards. Previous backups are ordered by timestamp
  name and numeric suffix, not content mtime; only exact timestamp-shaped names
  with optional numeric suffix qualify. Older eligible directories are removed.
  Non-directory backups and backup symlinks neither consume slots nor get pruned;
  nested, non-ASCII-digit, historic date-only and unrelated names are untouched.
  A correct-link no-op does not prune. Back up anything needed longer separately.
- Link creation uses `ln -sT`, so a concurrently appearing directory cannot receive
  a nested `ceralive` symlink. If creation fails after a rename, the repair attempts
  to move the displaced entry back before returning failure. Restoration can also
  fail (for example, when another writer placed a nonempty directory at `public`);
  in that case the displaced data stays in its backup.
- Pruning uses `rm --one-file-system`: it refuses descent into a nested different-
  filesystem mount and warns on incomplete deletion. This is **not** protection
  against a same-filesystem bind mount. Do not mount anything below a backup;
  privileged concurrent writers and power loss are not made transactional.
- Every repair error becomes one warning on stderr and does not fail configure
  or suppress its existing restart ladder, including when restoration also fails.
  A failed restoration can still leave a missing or incorrect public path; the
  warning asks for inspection, not a claim of repair success. Other existing
  maintainer-script failures are unchanged.

To check a device: `readlink /opt/ceralive/public` must print `/var/www/ceralive`.

**Manual recovery after the warning.** If configure prints
`ceralive-postinst: warning: could not fully repair /opt/ceralive/public, check
the link and public.stale-* backups`, run these as root:

1. Inspect:

   ```sh
   readlink /opt/ceralive/public; ls -ld /opt/ceralive/public /opt/ceralive/public.stale-*
   ```

2. If `public` is a real directory or file (the restored original, or a failed
   rename):

   ```sh
   mv -T /opt/ceralive/public /opt/ceralive/public.stale-manual && ln -s /var/www/ceralive /opt/ceralive/public && systemctl restart ceralive.service
   ```

3. If `public` is missing (restoration failed too):

   ```sh
   ln -s /var/www/ceralive /opt/ceralive/public && systemctl restart ceralive.service
   ```

   The newest `public.stale-*` holds the displaced entry.

The user troubleshooting page gives the same commands with `sudo` and ends them
with a reboot instead of the service restart; either way the backend serves the
linked frontend again. `public.stale-manual` does not match the timestamp shape,
so retention never prunes it.

**Before a drill or a manual upgrade:** `findmnt -R /opt/ceralive` must list only
the `/opt/ceralive` bind itself. Don't mount anything under `/opt/ceralive` and
don't create `public.stale-*` names by hand. Retention keeps only three previous
backups plus the newest, so copy a displaced directory out if you need it
(`cp -a /opt/ceralive/public.stale-<stamp> /data/<safe-name>`). Stray backup
symlinks are safe to remove with
`find /opt/ceralive -maxdepth 1 -name 'public.stale-*' -type l -delete`, which
removes only links.

`deb-public-link.test.sh` exercises the generated configure path over private
fake roots through the CI-run release/package contract harness; the optional
`bash scripts/build/deb-public-link-mutations.test.sh` checks its negative controls.
The hardening companion covers locale, rollback, race and retention cases plus
an unprivileged user/mount-namespace fixture when supported; otherwise it prints
an explicit mount-test skip and still checks the pruning command arguments.
`CERALIVE_PUBLIC_LINK_TEST_ROOT` is only a test prefix and is unset on devices;
it does not alter the absolute target. A real package upgrade and rollback on
both board models remain separate Wave-2 qualification, not host-test claims.

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
   - Federation compiles the complete catalog in an isolated Paraglide locale-module
     layout and fully minifies its final ES modules. It does not externalize i18n or
     change the SPA's lazy namespace graph. `bun run test:federation-abi` checks built
     mounts and frozen-catalog parity; after both builds,
     `bun scripts/ci/bundle-report.mjs` checks SPA, precache, and federation budgets.
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

### Pull Request Build Check frontend unit lane

The vitest suite is the workflow's longest job, so `test-fe` runs as a four-way
static shard matrix (`shard: [1, 2, 3, 4]`, `fail-fast: false`, `timeout-minutes:
15`). Each leg exports `VITEST_SHARD: <n>/4` and runs `test:ci-shard`, which adds
`--shard` and the blob reporter to the ordinary run; vitest writes
`apps/frontend/.vitest/blob/blob-<n>-4.json`, so the per-shard filenames never
collide. `.vitest/` is a dot-directory, so the upload needs
`include-hidden-files: true` — without it the artifact is silently empty. Uploads
run on `!cancelled()` rather than `always()`, because a failing shard's blob is
exactly what the merged report has to carry.

`merge-fe-reports` downloads every `vitest-blob-*` artifact back into that one
directory with `merge-multiple: true` and runs `test:ci-merge`
(`vitest run --merge-reports`), which prints the union file and test counts for
the whole suite.

`guardrails` carries the seconds-long gates that used to sit behind the vitest
lane: the tech-debt register, the three spec guardrails, the workflow shape gate,
and the input-picker hardware preflight. That last one is not optional bookkeeping
— `test:ci-shard` runs vitest alone, so nothing else in CI chains it.

The local `test` script is deliberately unchanged: it still runs the full
unsharded suite plus the preflight, so a developer's `bun run --filter frontend
test` behaves exactly as before.

### Pull Request Build Check E2E

`.github/workflows/build-check.yml` builds the frontend once in `setup-e2e`, uploads
the resulting `frontend-dist`, and fans functional E2E coverage across the
desktop/mobile × two-shard matrix. The setup job caches only Playwright browser
binaries, keyed by the exact version reported by the installed Playwright CLI;
it does not install runner-local OS packages.

The same setup job downloads the immutable `srtla` 4.1.0 amd64 release
package, pinned to SHA-256
`496217e93cde36eeac0bde1b742c21fed6347a198f05a8cd898be116946b1eb8`.
Before extraction it verifies the Debian `Package`, `Version`, and `Architecture`
fields, then uploads only the extracted runtime as the one-day
`srtla-send-runtime-amd64-v4.1.0` artifact. This proves the backend against the
released executable without a test stub, system-wide install, sibling checkout,
or weakened production preflight.

The backend unit lane runs the same pinned fetch against one shared command plan
and then exports `SRTLA_SEND_BIN`, which is what lets the live-producer contract
test spawn the real sender rather than skip itself. It deliberately fetches its
own copy instead of consuming the E2E setup artifact: taking that dependency
would serialize the backend lane behind the entire frontend build.

Each isolated matrix runner runs `test:e2e:install-deps` for its own Ubuntu image,
restores the versioned browser cache, and installs the browser only on a cache
miss. It also downloads the runtime artifact, restores `srtla_send` execute
permission, adds its `usr/bin` to `PATH`, rewrites the lane-local backend
`setup.json` `srtla_path`, and asserts the resolved binary before starting the
servers.

The frontend server in every functional lane is `vite preview` on port 6173,
serving the frontend artifact built by `setup-e2e`; the Vite dev server is not a
CI fallback. The device-host development proxy and CI preview share the same
path-scoped WebSocket matcher. The production bundle opens same-origin `/ws` and
`/preview` sockets, and Vite forwards only those literal raw upgrade paths,
optionally followed by a query. Local functional E2E bypasses that Vite proxy by
selecting a worker backend through `window.__ceraSocketPort`. Dot-segment,
encoded-path, authority-like, fragment, and child-path
request targets are rejected before URL normalization. In CI preview only, the
page fixture installs an HttpOnly SameSite=Strict cookie whose exact value
combines a worker port from 3100 through 3199 with a random per-worker proxy
secret. The proxy consumes and strips the routing value, injects the secret as a
proxy-only backend admission header, and fails closed on missing, malformed,
duplicate, encoded, or out-of-range values and explicit query/header steering.
E2E worker
backends require the exact header before either WebSocket upgrade, preventing
direct browser access across workers. This preserves per-worker backend, mock
preview upstream, and `MOCK_SCENARIO` isolation without adding an application
global or production test API. Before the reference backend starts, the lane
seeds its password and persistent token; CI global setup therefore never relies
on a missing-cookie route to port 3002, while local global setup remains
browser-driven. Runtime E2E tests use fixture RPC/socket seams rather than
importing `/src` modules,
which are not served by a production preview. Local Vite dev retains
`window.__ceraSocketPort` and does not enable cookie routing.

Each lane uploads a unique blob report, which `merge-e2e-reports` combines into
the final HTML report.

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
directories. (The legacy `bcrpt` streaming helper was retired as dead code in
PR #199 — it is no longer spawned or packaged; the independent BCRPT/proto-v16
relay socket in `modules/remote/remote.ts` is a separate, still-present component.)

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
# Notification bundle coverage [EXISTS]

The frontend build runs `scripts/ci/notification-bundle.ts` on its real
`dist/public/assets` output; the existing CI/release build gates inherit this
check. Debian/system packaging also checks a restored frontend cache before
accepting it, even when its input hash matches. The release-package contract
suite runs the scanner tests and cache-path refusal/acceptance test.

The guard derives complete notification keys from backend production source and
executes the built message functions for every shipped locale, comparing against
the catalogs with deterministic interpolation inputs. Missing keys or mismatched
text fail the build; source-only registry tests are not a substitute. See the
[guard's coverage and layout contract](../scripts/ci/NOTIFICATION-BUNDLE.md).
This does not prove deployed static-file or browser-cache provenance. No labels
or translations change, so EN/es-419 user documentation is unaffected.
