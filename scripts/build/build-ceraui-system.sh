#!/bin/bash
set -e

echo "🏗️  Building CeraUI System Distribution..."

# Configuration
PRODUCT_NAME="ceraui"
VERSION=${BUILD_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/v//' || echo "1.0.0")}
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +"%Y%m%d_%H%M%S")
ARCHIVE_NAME="${PRODUCT_NAME}-v${VERSION}-${COMMIT}-${BUILD_DATE}"

# Clean previous builds
rm -rf dist/compressed
mkdir -p dist/compressed

echo "📦 Building full CeraUI system..."

# Build the full product using existing package.json script
echo "Using existing build script: pnpm run build"
pnpm run build

# Create temporary directory for packaging
TEMP_DIR="dist/compressed/temp_${ARCHIVE_NAME}"
mkdir -p "$TEMP_DIR"

echo "📂 Preparing distribution files..."

# Copy all distribution files
cp -r dist/* "$TEMP_DIR/" 2>/dev/null || true

# Remove temporary directories from the package
rm -rf "$TEMP_DIR"/compressed "$TEMP_DIR"/belabox-* 2>/dev/null || true

# Create installation script
cat > "$TEMP_DIR/install.sh" << 'EOF'
#!/bin/bash
set -e

echo "🚀 Installing CeraUI System..."
echo "This will install CeraUI to replace belaUI or deploy on custom development devices."

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "❌ This script must be run as root (use sudo)"
   exit 1
fi

# Install binary
echo "📦 Installing CERALIVE binary..."
cp belaUI /usr/local/bin/belaUI
chmod +x /usr/local/bin/belaUI

# Install systemd service
echo "⚙️  Installing systemd service..."
cp belaUI.service /etc/systemd/system/
cp belaUI.socket /etc/systemd/system/

# Install udev rules
echo "🔌 Installing udev rules..."
cp 98-belaui-audio.rules /etc/udev/rules.d/
cp 99-belaui-check-usb-devices.rules /etc/udev/rules.d/

# Install web files
echo "🌐 Installing web interface..."
mkdir -p /var/www/belaui
cp -r public/* /var/www/belaui/

# Install configuration
echo "⚙️  Installing configuration..."
mkdir -p /etc/belaui
cp config.json /etc/belaui/

# Install scripts
echo "🛠️  Installing utility scripts..."
cp override-belaui.sh /usr/local/bin/
cp reset-to-default.sh /usr/local/bin/
chmod +x /usr/local/bin/override-belaui.sh /usr/local/bin/reset-to-default.sh

# Reload systemd and udev
systemctl daemon-reload
udevadm control --reload

echo "✅ CeraUI system installed successfully!"
echo ""
echo "To start the service:"
echo "  sudo systemctl enable --now belaUI.service"
echo ""
echo "To check status:"
echo "  sudo systemctl status belaUI.service"
echo ""
echo "Web interface will be available at: http://localhost:8080"
EOF

chmod +x "$TEMP_DIR/install.sh"

# Create uninstall script
cat > "$TEMP_DIR/uninstall.sh" << 'EOF'
#!/bin/bash
set -e

echo "🗑️  Uninstalling CeraUI system..."

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "❌ This script must be run as root (use sudo)"
   exit 1
fi

# Stop and disable service
systemctl stop belaUI.service 2>/dev/null || true
systemctl disable belaUI.service 2>/dev/null || true

# Remove systemd files
rm -f /etc/systemd/system/belaUI.service
rm -f /etc/systemd/system/belaUI.socket

# Remove udev rules
rm -f /etc/udev/rules.d/98-belaui-audio.rules
rm -f /etc/udev/rules.d/99-belaui-check-usb-devices.rules

# Remove binary and scripts
rm -f /usr/local/bin/belaUI
rm -f /usr/local/bin/override-belaui.sh
rm -f /usr/local/bin/reset-to-default.sh

# Remove web files
rm -rf /var/www/belaui

# Remove configuration (ask user)
read -p "Remove configuration files? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf /etc/belaui
fi

# Reload systemd and udev
systemctl daemon-reload
udevadm control --reload

echo "✅ CeraUI system uninstalled successfully!"
EOF

chmod +x "$TEMP_DIR/uninstall.sh"

# Create build info
cat > "$TEMP_DIR/build-info.json" << EOF
{
  "product": "CeraUI",
  "brand": "CERALIVE",
  "type": "full-system",
  "purpose": "Replace belaUI or deploy on custom development devices",
  "version": "${VERSION}",
  "commit": "${COMMIT}",
  "buildDate": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nodeVersion": "$(node --version)",
  "pnpmVersion": "$(pnpm --version)",
  "architecture": "linux-arm64",
  "compatibility": "belaUI replacement compatible",
  "includes": [
    "CeraUI backend binary (as belaUI)",
    "CERALIVE-branded frontend web interface",
    "Systemd service files (belaUI.service)",
    "Udev rules for hardware detection",
    "Installation and uninstallation scripts",
    "Configuration files"
  ]
}
EOF

# Create README
cat > "$TEMP_DIR/README.md" << EOF
# CeraUI System Distribution Package

Version: ${VERSION}
Build: ${COMMIT}
Date: $(date -u)

## Contents

- \`belaUI\` - Main CERALIVE backend binary
- \`public/\` - Web interface files
- \`*.service\`, \`*.socket\` - Systemd service files
- \`*.rules\` - Udev rules for hardware detection
- \`config.json\` - Default configuration
- \`install.sh\` - Automated installation script
- \`uninstall.sh\` - Automated uninstallation script

## Quick Installation

\`\`\`bash
sudo ./install.sh
\`\`\`

## Manual Installation

See the installation scripts for reference or follow the deployment documentation.

## System Requirements

- Linux ARM64 (Raspberry Pi 4, etc.)
- systemd
- udev
- Web browser (for interface access)

## Support

For support and documentation, visit: https://github.com/CERALIVE/CeraUI
EOF

echo "📦 Creating system distribution archives..."

# Create tar.gz
cd "dist/compressed"
tar -czf "${ARCHIVE_NAME}.tar.gz" -C "temp_${ARCHIVE_NAME}" .

# Create zip
cd "temp_${ARCHIVE_NAME}"
zip -r "../${ARCHIVE_NAME}.zip" . -q

cd ../..

# Cleanup temporary directory
rm -rf "dist/compressed/temp_${ARCHIVE_NAME}"

# Calculate checksums
cd dist/compressed
sha256sum *.tar.gz > "${ARCHIVE_NAME}.tar.gz.sha256"
sha256sum *.zip > "${ARCHIVE_NAME}.zip.sha256"

echo "✅ CeraUI system distribution created successfully!"
echo "📍 Location: dist/compressed/"
echo "📦 Files created:"
ls -lah dist/compressed/
echo "📊 Total size: $(du -sh dist/compressed/ | cut -f1)"
