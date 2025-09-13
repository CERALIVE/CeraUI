#!/bin/bash
set -e

echo "📦 Building Debian Package using FPM..."

# Check if FPM is installed
if ! command -v fpm &> /dev/null; then
    echo "❌ FPM is not installed. Installing..."
    echo "Please run: gem install fpm"
    echo "Or on Ubuntu/Debian: sudo apt install ruby-dev gcc g++ && gem install fpm"
    exit 1
fi

# Configuration
PACKAGE_NAME="ceralive-device"
VERSION=${BUILD_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/v//' || echo "1.0.0")}
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
ARCHITECTURE="arm64"
MAINTAINER="Andrés Cera <andres@ceralive.com>"
DESCRIPTION="CERALIVE device software - live streaming hardware controller"
URL="https://github.com/CERALIVE/CeraUI"

# Clean previous builds
rm -rf dist/debian
mkdir -p dist/debian

echo "📦 Building full CeraUI product for Debian packaging..."

# Build the full product using existing package.json script
echo "Using existing build script: pnpm run build"
pnpm run build

# Create temporary packaging directory
TEMP_DIR="dist/debian/temp"
mkdir -p "$TEMP_DIR"

echo "📂 Preparing package structure..."

# Create directory structure
mkdir -p "$TEMP_DIR"/{usr/local/bin,etc/systemd/system,etc/udev/rules.d,var/www/belaui,etc/belaui}

# Copy files to appropriate locations
cp dist/belaUI "$TEMP_DIR/usr/local/bin/belaUI"
cp dist/belaUI.service "$TEMP_DIR/etc/systemd/system/"
cp dist/belaUI.socket "$TEMP_DIR/etc/systemd/system/"
cp dist/98-belaui-audio.rules "$TEMP_DIR/etc/udev/rules.d/"
cp dist/99-belaui-check-usb-devices.rules "$TEMP_DIR/etc/udev/rules.d/"
cp -r dist/public/* "$TEMP_DIR/var/www/belaui/"
cp dist/config.json "$TEMP_DIR/etc/belaui/"
cp dist/override-belaui.sh "$TEMP_DIR/usr/local/bin/"
cp dist/reset-to-default.sh "$TEMP_DIR/usr/local/bin/"

# Make binaries executable
chmod +x "$TEMP_DIR/usr/local/bin/belaUI"
chmod +x "$TEMP_DIR/usr/local/bin/override-belaui.sh"
chmod +x "$TEMP_DIR/usr/local/bin/reset-to-default.sh"

# Create post-install script
cat > dist/debian/postinst << 'EOF'
#!/bin/bash
set -e

echo "🚀 Configuring CERALIVE after installation..."

# Reload systemd daemon
systemctl daemon-reload

# Reload udev rules
udevadm control --reload

# Create belaui user if it doesn't exist
if ! id "belaui" &>/dev/null; then
    useradd -r -s /bin/false -d /nonexistent belaui
fi

# Set permissions
chown -R belaui:belaui /var/www/belaui
chown belaui:belaui /etc/belaui/config.json

echo "✅ CERALIVE device software configured successfully!"
echo ""
echo "To start CERALIVE device:"
echo "  sudo systemctl enable --now belaUI.service"
echo ""
echo "To check status:"
echo "  sudo systemctl status belaUI.service"
echo ""
echo "Web interface will be available at: http://localhost:8080"
EOF

# Create pre-remove script
cat > dist/debian/prerm << 'EOF'
#!/bin/bash
set -e

echo "🛑 Stopping CERALIVE service..."

# Stop service if running
systemctl stop ceralive.service 2>/dev/null || true
systemctl disable ceralive.service 2>/dev/null || true
EOF

# Create post-remove script
cat > dist/debian/postrm << 'EOF'
#!/bin/bash
set -e

if [ "$1" = "purge" ]; then
    echo "🗑️  Purging CERALIVE configuration..."

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

echo "📦 Building Debian package with FPM..."

# Build the package
cd dist/debian
fpm -s dir -t deb \
    -n "$PACKAGE_NAME" \
    -v "$VERSION" \
    -a "$ARCHITECTURE" \
    --iteration "1" \
    --epoch "1" \
    --maintainer "$MAINTAINER" \
    --description "$DESCRIPTION" \
    --url "$URL" \
    --license "GPL-3.0" \
    --category "net" \
    --depends "systemd" \
    --depends "udev" \
    --depends "adduser" \
    --conflicts "belaui" \
    --replaces "belaui" \
    --provides "ceralive" \
    --after-install postinst \
    --before-remove prerm \
    --after-remove postrm \
    --deb-systemd ceralive.service \
    --deb-no-default-config-files \
    -C temp \
    .

cd ../..

# Generate package info
PACKAGE_FILE=$(ls dist/debian/*.deb)
PACKAGE_FILENAME=$(basename "$PACKAGE_FILE")

cat > dist/debian/package-info.json << EOF
{
  "package": "$PACKAGE_NAME",
  "version": "$VERSION",
  "architecture": "$ARCHITECTURE",
  "filename": "$PACKAGE_FILENAME",
  "size": "$(stat -c%s "$PACKAGE_FILE")",
  "maintainer": "$MAINTAINER",
  "description": "$DESCRIPTION",
  "buildDate": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "commit": "$COMMIT",
  "dependencies": [
    "systemd",
    "udev",
    "adduser"
  ],
  "installation": {
    "command": "sudo dpkg -i $PACKAGE_FILENAME",
    "postInstall": "sudo systemctl enable --now ceralive.service"
  }
}
EOF

# Create installation instructions
cat > dist/debian/INSTALL.md << EOF
# CERALIVE Debian Package Installation

## Package Information
- Package: $PACKAGE_FILENAME
- Version: $VERSION
- Architecture: $ARCHITECTURE
- Size: $(du -h "$PACKAGE_FILE" | cut -f1)

## Installation

### 1. Install the package
\`\`\`bash
sudo dpkg -i $PACKAGE_FILENAME
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
EOF

# Cleanup
rm -rf dist/debian/temp dist/debian/{postinst,prerm,postrm}

echo "✅ Debian package created successfully!"
echo "📍 Location: $PACKAGE_FILE"
echo "📊 Size: $(du -h "$PACKAGE_FILE" | cut -f1)"
echo "🔍 Package info: dist/debian/package-info.json"
