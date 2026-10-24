#!/bin/bash
# allow: SIZE_OK — package assembly envelope embeds maintainer scripts and install-guide templates; contract tests extract these exact heredocs.
set -e

# Load shared build functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/build/shared-build-functions.sh
source "$SCRIPT_DIR/shared-build-functions.sh"
cd "$BUILD_REPO_ROOT"

log_info "Building Debian Package using FPM (Modernized)"

# Validate required tools
if ! validate_tools fpm; then
    log_error "FPM is not installed. Installing..."
    echo "Please run: gem install fpm"
    echo "Or on Ubuntu/Debian: sudo apt install ruby-dev gcc g++ && gem install fpm"
    exit 1
fi

# Configuration using shared functions
PACKAGE_NAME="ceralive-device"
VERSION=$(get_version)
COMMIT=$(get_commit)
CERAUI_VERSION=$(get_ceraui_version)
ARCHITECTURE=$(get_architecture)
BUILD_DATE=$(get_build_date)

# Fail closed: an unstampable version leaves the device's Versions row with no
# CalVer to promote, which is the exact defect the stamp exists to remove.
if ! printf '%s' "$CERAUI_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
    log_error "Could not read a CalVer version from package.json (got: '${CERAUI_VERSION}')"
    exit 1
fi
if [ "$CERAUI_VERSION" != "$VERSION" ]; then
    log_warning "package.json version ($CERAUI_VERSION) differs from the package version ($VERSION); stamping package.json's"
fi

# Generate dynamic iteration for APT version detection
ITERATION="${BUILD_DATE}.${COMMIT}"

MAINTAINER="Andrés Cera <andres@ceralive.com>"
DESCRIPTION="CeraLive device software - live streaming hardware controller"
URL="https://github.com/CERALIVE/CeraUI"

# Engine protocol-major coupling (engine ↔ UI version-skew guard). The cerastream
# .deb Provides cerastream-ipc-<major>; we Depends on the major our installed
# bindings speak, so apt refuses a cross-protocol-major skew on-device and mkosi
# fails a mismatched pair at image-build time. Derived from the installed
# @ceralive/cerastream package (the single source of truth for what's compiled
# in) — never hardcoded. Requires `bun install` to have run first.
CERASTREAM_CONSTANTS="$BUILD_REPO_ROOT/apps/backend/node_modules/@ceralive/cerastream/dist/constants.js"
IPC_PROTOCOL="$(grep -oE 'cerastream-ipc/[0-9]+' "$CERASTREAM_CONSTANTS" 2>/dev/null | head -1)"
IPC_MAJOR="${IPC_PROTOCOL##*/}"
if ! printf '%s' "$IPC_MAJOR" | grep -qE '^[0-9]+$'; then
    log_error "Could not derive cerastream protocol major from installed bindings: $CERASTREAM_CONSTANTS"
    exit 1
fi
IPC_VPKG="cerastream-ipc-${IPC_MAJOR}"
log_info "Engine protocol coupling: Depends $IPC_VPKG"

# Clean previous builds
log_step "Cleaning previous builds"
rm -rf dist/debian
ensure_dir dist/debian

log_info "Building Debian package for $ARCHITECTURE architecture"
log_info "Package: $PACKAGE_NAME"
log_info "Full Version: $VERSION-$ITERATION"
log_info "Architecture: $ARCHITECTURE"

log_step "Building full CeraUI product for Debian packaging"

# Build the full product using smart build from shared functions
smart_build

# Create temporary packaging directory
TEMP_DIR="dist/debian/temp"
ensure_dir "$TEMP_DIR"

log_step "Preparing package structure"

# Create directory structure
mkdir -p "$TEMP_DIR/usr/local/bin"
mkdir -p "$TEMP_DIR/usr/bin"
mkdir -p "$TEMP_DIR/usr/sbin" "$TEMP_DIR/usr/libexec/ceralive"
mkdir -p "$TEMP_DIR/etc/systemd/system"
mkdir -p "$TEMP_DIR/etc/udev/rules.d"
mkdir -p "$TEMP_DIR/etc/sudoers.d"
mkdir -p "$TEMP_DIR/var/www/ceralive"
mkdir -p "$TEMP_DIR/etc/ceralive"
mkdir -p "$TEMP_DIR/opt/ceralive"

# Copy files to appropriate locations
log_step "Copying files to package structure"
cp dist/ceralive "$TEMP_DIR/usr/local/bin/ceralive"
cp dist/ceralive.service "$TEMP_DIR/etc/systemd/system/"
# Post-boot add-on reconciler oneshot (T29). Non-blocking; never gates rollback.
# Sourced from deployment/ (the repo source of truth), not dist/, so the unit lands
# in the .deb even if smart_build's deployment/*→dist/ mirror is reordered or skipped.
cp deployment/ceralive-addon-reconciler.service "$TEMP_DIR/etc/systemd/system/"
cp dist/98-ceralive-audio.rules "$TEMP_DIR/etc/udev/rules.d/"
cp dist/99-ceralive-check-usb-devices.rules "$TEMP_DIR/etc/udev/rules.d/"
cp -r dist/public/* "$TEMP_DIR/var/www/ceralive/"
cp dist/config.json "$TEMP_DIR/etc/ceralive/"
cp apps/backend/setup.json "$TEMP_DIR/opt/ceralive/"
# Stamp the build commit into the packaged tree so the backend's initRevisions()
# reads it at runtime (WorkingDirectory=/opt/ceralive). A deployed /opt/ceralive is
# not a git checkout, so without this file both the primary read AND its
# `git rev-parse` fallback fail — "unknown revision" would be the always-taken path
# on every real device.
printf '%s\n' "$COMMIT" > "$TEMP_DIR/opt/ceralive/revision"
# The same reasoning one level up: the commit alone is not a VERSION, so the
# Versions row rendered a bare short-SHA where every other row showed CalVer.
# `revision` keeps its exact meaning (the commit, demoted to build metadata) and
# this sibling carries the version that is promoted in front of it.
printf '%s\n' "$CERAUI_VERSION" > "$TEMP_DIR/opt/ceralive/version"
ln -s /var/www/ceralive "$TEMP_DIR/opt/ceralive/public"
cp dist/override-ceralive.sh "$TEMP_DIR/usr/local/bin/"
cp dist/reset-to-default.sh "$TEMP_DIR/usr/local/bin/"

# Privileged add-on lifecycle helper (T27) + its narrow sudoers drop-in, copied
# straight from the repo (a plain script, not a bun-build artifact).
cp apps/backend/ceralive-addon-helper "$TEMP_DIR/usr/bin/ceralive-addon-helper"
cp apps/backend/ceralive-addon-helper.sudoers "$TEMP_DIR/etc/sudoers.d/ceralive-addon-helper"
cp deployment/ceralive-update-recover "$TEMP_DIR/usr/sbin/ceralive-update-recover"
cp deployment/ceralive-os-stage-guard "$TEMP_DIR/usr/libexec/ceralive/ceralive-os-stage-guard"
cp deployment/ceralive-nbd-release "$TEMP_DIR/usr/libexec/ceralive/ceralive-nbd-release"
bun build apps/backend/src/modules/system/update-orchestrator/recovery-cli.ts --compile --target="bun-linux-${ARCHITECTURE}" --outfile="$TEMP_DIR/usr/libexec/ceralive/ceralive-update-recover"

# Normalize copied artifacts and builder umask before applying private/executable modes.
find "$TEMP_DIR" -type d -exec chmod 0755 {} +
find "$TEMP_DIR" -type f -exec chmod 0644 {} +

# Make binaries executable
chmod 0755 "$TEMP_DIR/usr/local/bin/ceralive"
chmod 0755 "$TEMP_DIR/usr/local/bin/override-ceralive.sh"
chmod 0755 "$TEMP_DIR/usr/local/bin/reset-to-default.sh"
chmod 0755 "$TEMP_DIR/usr/bin/ceralive-addon-helper"
chmod 0700 "$TEMP_DIR/usr/sbin/ceralive-update-recover" "$TEMP_DIR/usr/libexec/ceralive/ceralive-update-recover"
chmod 0700 "$TEMP_DIR/usr/libexec/ceralive/ceralive-os-stage-guard"
chmod 0700 "$TEMP_DIR/usr/libexec/ceralive/ceralive-nbd-release"
# sudo REFUSES a drop-in that is group/world-writable — ship it 0440.
chmod 0440 "$TEMP_DIR/etc/sudoers.d/ceralive-addon-helper"

SERVICE_EXEC="$(sed -n 's/^ExecStart=//p' "$TEMP_DIR/etc/systemd/system/ceralive.service" | awk 'NR == 1 { print $1 }')"
if [[ "$SERVICE_EXEC" != "/usr/local/bin/ceralive" || ! -x "$TEMP_DIR$SERVICE_EXEC" ]]; then
    log_error "ceralive.service ExecStart must point at the packaged backend binary (/usr/local/bin/ceralive)"
    exit 1
fi

if ! grep -qx 'Environment=NODE_ENV=production' "$TEMP_DIR/etc/systemd/system/ceralive.service"; then
    log_error "ceralive.service must force NODE_ENV=production to prevent mock-mode boot"
    exit 1
fi

if [[ ! -s "$TEMP_DIR/opt/ceralive/setup.json" ]]; then
    log_error "ceralive-device must package the required /opt/ceralive/setup.json boot identity"
    exit 1
fi

# Create post-install script
log_step "Creating maintenance scripts"
cat > dist/debian/postinst << 'EOF'
#!/bin/bash
set -e

# ONE seam for the runtime-systemd directory. With CERALIVE_SYSTEMD_RUN_DIR unset —
# every real install and every image build — this is byte-for-byte the hardcoded
# /run/systemd/system; the variable exists only so the packaging contract test can
# point the check at a scratch directory instead of the host's real one.
SYSTEMD_RUN_DIR="${CERALIVE_SYSTEMD_RUN_DIR:-/run/systemd/system}"

# Subshell scope keeps repair state out of postinst; every fallible command is
# checked explicitly because the warning boundary disables errexit in functions.
repair_public_link() (
    export LC_ALL=C
    public_parent="$1/opt/ceralive"
    public_path="$public_parent/public"
    stale_created=''
    if [ -L "$public_path" ]; then
        public_target=$(readlink -n -- "$public_path" && printf '.') || return 1
        [ "$public_target" != '/var/www/ceralive.' ] || return 0
        ln -sfnT -- /var/www/ceralive "$public_path" || return 1
    else
        if [ -e "$public_path" ]; then
            stale_stamp=$(date -u +%Y%m%dT%H%M%SZ) || return 1
            stale_path="$public_path.stale-$stale_stamp"
            stale_suffix=0
            suffix_pattern="^public\\.stale-$stale_stamp(-[0-9]+)?$"
            collision_names=$(
                for collision_path in "$stale_path"*; do
                    [[ "${collision_path##*/}" =~ $suffix_pattern ]] || continue
                    [ -e "$collision_path" ] || [ -L "$collision_path" ] || continue
                    printf '%s\n' "${collision_path##*/}"
                done | LC_ALL=C sort -rV
            ) || return 1
            IFS= read -r collision_name <<< "$collision_names" || return 1
            if [ -n "$collision_name" ]; then
                stale_path="$public_parent/$collision_name"
                if [ "$stale_path" != "$public_path.stale-$stale_stamp" ]; then
                    stale_suffix=${collision_name##*-}
                fi
            fi
            while [ -e "$stale_path" ] || [ -L "$stale_path" ]; do
                # Decimal carry avoids overflow or octal interpretation of names.
                while [[ "$stale_suffix" == 0* && ${#stale_suffix} -gt 1 ]]; do stale_suffix=${stale_suffix#0}; done
                suffix_zeros=''
                while [[ "$stale_suffix" == *9 ]]; do
                    stale_suffix=${stale_suffix%9}
                    suffix_zeros="0$suffix_zeros"
                done
                if [ -z "$stale_suffix" ]; then stale_suffix="1$suffix_zeros"
                else stale_suffix="${stale_suffix%?}$((${stale_suffix: -1} + 1))$suffix_zeros"; fi
                stale_path="$public_path.stale-$stale_stamp-$stale_suffix"
            done
            mv -T -- "$public_path" "$stale_path" || return 1
            stale_created="$stale_path"
        fi
        if ! ln -sT -- /var/www/ceralive "$public_path"; then
            if [ -n "$stale_created" ]; then
                mv -T -- "$stale_created" "$public_path" || return 1
            fi
            return 1
        fi
    fi

    # Only generated timestamp names of immediate real directories are eligible.
    # Sort names, not directory mtimes (rename preserves the stale content's age).
    stale_pattern='^public\.stale-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$'
    stale_names=$(
        for stale_path in "$public_parent"/public.stale-*; do
            [ "$stale_path" != "$stale_created" ] || continue
            [ -d "$stale_path" ] || continue
            [ ! -L "$stale_path" ] || continue
            [[ "${stale_path##*/}" =~ $stale_pattern ]] || continue
            printf '%s\n' "${stale_path##*/}"
        done | LC_ALL=C sort -rV
    ) || return 1
    stale_count=0
    while IFS= read -r stale_name; do
        [ -n "$stale_name" ] || continue
        stale_count=$((stale_count + 1))
        if [ "$stale_count" -gt 3 ]; then
            stale_path="$public_parent/$stale_name"
            [ -d "$stale_path" ] || continue
            [ ! -L "$stale_path" ] || continue
            rm -rf --one-file-system -- "$stale_path" || return 1
        fi
    done <<< "$stale_names"
    return 0
)

# Non-sensitive observability marker: the dpkg action, and WHETHER a previously
# configured version exists — never the version value itself.
if [ -n "$2" ]; then
    upgrade_from_present=yes
else
    upgrade_from_present=no
fi
echo "ceralive-postinst: action=$1 upgrade_from_present=$upgrade_from_present"

echo "🚀 Configuring CeraLive after installation..."

# Reload systemd daemon
systemctl daemon-reload

systemctl disable --now ceralive.socket 2>/dev/null || true

# Enable the post-boot add-on reconciler oneshot (T29). It is non-blocking and
# deliberately decoupled from the OS-update healthcheck/rollback chain.
systemctl enable ceralive-addon-reconciler.service 2>/dev/null || true

# Reload udev rules
udevadm control --reload

# Create ceralive user if it doesn't exist
if ! id "ceralive" &>/dev/null; then
    useradd -r -s /bin/false -d /nonexistent ceralive
fi

# Set permissions
chown -R ceralive:ceralive /var/www/ceralive
chown ceralive:ceralive /etc/ceralive/config.json

# The add-on helper runs as root via sudo; sudo IGNORES a drop-in unless it is
# owned by root and not group/world-writable. Enforce both on install.
if [ -f /etc/sudoers.d/ceralive-addon-helper ]; then
    chown root:root /etc/sudoers.d/ceralive-addon-helper
    chmod 0440 /etc/sudoers.d/ceralive-addon-helper
fi
if [ -f /usr/bin/ceralive-addon-helper ]; then
    chown root:root /usr/bin/ceralive-addon-helper
    chmod 0755 /usr/bin/ceralive-addon-helper
fi
chown root:root /usr/sbin/ceralive-update-recover /usr/libexec/ceralive/ceralive-update-recover
chmod 0700 /usr/sbin/ceralive-update-recover /usr/libexec/ceralive/ceralive-update-recover
chown root:root /usr/libexec/ceralive/ceralive-nbd-release
chmod 0700 /usr/libexec/ceralive/ceralive-nbd-release

echo "✅ CeraLive device software configured successfully!"
echo ""
echo "To start CeraLive device:"
echo "  sudo systemctl enable --now ceralive.service"
echo ""
echo "To check status:"
echo "  sudo systemctl status ceralive.service"
echo ""
echo "Web interface will be available at: http://localhost:8080"

if [ "$1" = "configure" ]; then
    # Empty on devices; the prefix seam is only for the fake-root contract test.
    repair_public_link "${CERALIVE_PUBLIC_LINK_TEST_ROOT:-}" 2>/dev/null || {
        printf '%s\n' 'ceralive-postinst: warning: could not fully repair /opt/ceralive/public, check the link and public.stale-* backups' >&2 || true
    }
    systemctl daemon-reload || true

    # The old prerm disables on upgrade. deb-systemd-helper enable is a no-op
    # after its first install, so only systemctl repairs the missing link reliably.
    systemctl enable ceralive.service || true

    # $2 is the previously configured version, so a non-empty value means UPGRADE.
    # A fresh install keeps today's behaviour: installed and enabled, never started.
    if [ -n "$2" ] && [ -d "$SYSTEMD_RUN_DIR" ]; then
        if command -v deb-systemd-invoke >/dev/null 2>&1; then
            deb-systemd-invoke restart ceralive.service || true
        else
            systemctl restart ceralive.service || true
        fi
    fi
fi
EOF

# Create pre-remove script
cat > dist/debian/prerm << 'EOF'
#!/bin/bash
set -e

# dpkg runs the OLD prerm before unpacking the new package, so stopping and
# disabling here on an upgrade is what left the device with no control plane
# after a self-update — `Restart=always` is inert after an explicit stop.
case "$1" in
    remove)
        echo "🛑 Stopping CeraLive service..."

        # Stop service if running
        systemctl stop ceralive.service 2>/dev/null || true
        systemctl disable ceralive.service 2>/dev/null || true
        systemctl disable --now ceralive.socket 2>/dev/null || true
        ;;
    upgrade|deconfigure|failed-upgrade)
        :
        ;;
esac
EOF

# Create post-remove script
cat > dist/debian/postrm << 'EOF'
#!/bin/bash
set -e

if [ "$1" = "purge" ]; then
    echo "🗑️  Purging CeraLive configuration..."

    # Remove user
    userdel ceralive 2>/dev/null || true

    # Remove configuration directory
    rm -rf /etc/ceralive

    # Reload systemd
    systemctl daemon-reload 2>/dev/null || true

    # Reload udev
    udevadm control --reload 2>/dev/null || true
fi
EOF

# Make scripts executable
chmod +x dist/debian/{postinst,prerm,postrm}

log_step "Building Debian package with FPM"

# Build the package
cd dist/debian
(
# FPM also generates payload documentation outside our staging tree.
umask 022
fpm -s dir -t deb \
    -n "$PACKAGE_NAME" \
    -v "$VERSION" \
    -a "$ARCHITECTURE" \
    --iteration "$ITERATION" \
    --maintainer "$MAINTAINER" \
    --description "$DESCRIPTION" \
    --url "$URL" \
    --license "GPL-3.0" \
    --category "net" \
    --depends "systemd" \
    --depends "udev" \
    --depends "adduser" \
    --depends "sudo" \
    --depends "util-linux" \
    --depends "gpgv" \
    --depends "debian-archive-keyring" \
    --depends "network-manager" \
    --depends "modemmanager" \
    --depends "cerastream" \
    --depends "$IPC_VPKG" \
    --conflicts "belaui" \
    --replaces "belaui" \
    --provides "ceralive" \
    --after-install postinst \
    --before-remove prerm \
    --after-remove postrm \
    --deb-no-default-config-files \
    -C temp \
    .
)

cd ../..

# Generate package info
PACKAGE_FILE=$(ls dist/debian/*.deb)
PACKAGE_FILENAME=$(basename "$PACKAGE_FILE")

log_step "Creating package metadata"

# Create architecture-specific package info
cat > "dist/debian/package-info-${ARCHITECTURE}.json" << EOF
{
  "package": "$PACKAGE_NAME",
  "version": "$VERSION",
  "iteration": "$ITERATION",
  "fullVersion": "$VERSION-$ITERATION",
  "architecture": "$ARCHITECTURE",
  "filename": "$PACKAGE_FILENAME",
  "size": "$(stat -c%s "$PACKAGE_FILE")",
  "maintainer": "$MAINTAINER",
  "description": "$DESCRIPTION",
  "buildDate": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "commit": "$COMMIT",
  "buildSystem": {
    "modernized": true,
    "sharedFunctions": true,
    "optimizedCaching": true,
    "bundleSplitting": true
  },
  "dependencies": [
    "systemd",
    "udev",
    "adduser",
    "sudo",
    "gpgv",
    "debian-archive-keyring",
    "network-manager",
    "modemmanager",
    "cerastream",
    "$IPC_VPKG"
  ],
  "apt": {
    "versionProgression": "Each build has unique timestamp-based iteration",
    "comparisonMethod": "APT compares: $VERSION-$ITERATION",
    "repositoryReady": true
  },
  "installation": {
    "command": "sudo apt-get install ./$PACKAGE_FILENAME",
    "postInstall": "sudo systemctl enable --now ceralive.service"
  }
}
EOF

# Create installation instructions
cat > "dist/debian/INSTALL-${ARCHITECTURE}.md" << EOF
# CeraLive Debian Package Installation ($ARCHITECTURE) - MODERNIZED

## Package Information
- Package: $PACKAGE_FILENAME
- Version: $VERSION-$ITERATION
- Base Version: $VERSION
- Build Iteration: $ITERATION
- Architecture: $ARCHITECTURE
- Size: $(du -h "$PACKAGE_FILE" | cut -f1)
- Commit: $COMMIT

## Build System Features
✅ **Modernized Build System**:
- Smart artifact caching (73% faster builds)
- Bundle optimization (7 chunks, 50-434KB each)
- Shared build functions for consistency
- APT-compatible versioning with timestamps

## Installation

### 1. Install the package
\`\`\`bash
sudo apt-get install ./$PACKAGE_FILENAME
\`\`\`

### 2. Fix any dependency issues (if needed)
\`\`\`bash
sudo apt-get install -f
\`\`\`

### 3. Start the service
\`\`\`bash
sudo systemctl enable --now ceralive.service
\`\`\`

### 4. Verify installation
\`\`\`bash
sudo systemctl status ceralive.service
\`\`\`

## Access

Open your web browser and navigate to: http://localhost:8080

## Optimized Performance
- **Frontend**: 7 optimized chunks for fast loading
- **Backend**: Native $ARCHITECTURE binary
- **Caching**: Smart build system for rapid updates

## Uninstallation

### Remove package (keep configuration)
\`\`\`bash
sudo apt remove ceralive
\`\`\`

### Remove package and configuration
\`\`\`bash
sudo apt purge ceralive
\`\`\`

## Troubleshooting

### Check service logs
\`\`\`bash
sudo journalctl -u ceralive.service -f
\`\`\`

### Check service status
\`\`\`bash
sudo systemctl status ceralive.service
\`\`\`

### Restart service
\`\`\`bash
sudo systemctl restart ceralive.service
\`\`\`

Built with the modernized CeraUI build system featuring smart caching,
bundle optimization, and shared build functions.
EOF

# Cleanup
rm -rf dist/debian/temp dist/debian/{postinst,prerm,postrm}

log_success "Debian package created successfully!"
log_info "Architecture: $ARCHITECTURE"
log_info "Full Version: $VERSION-$ITERATION"
log_info "Location: $PACKAGE_FILE"
log_info "Size: $(du -h "$PACKAGE_FILE" | cut -f1)"
log_info "Package info: dist/debian/package-info-${ARCHITECTURE}.json"
log_info "Install guide: dist/debian/INSTALL-${ARCHITECTURE}.md"

log_success "APT Version Control: Each build has unique, incrementing version!"
log_info "Repository deployment: Ready for APT repository with automatic update detection"
