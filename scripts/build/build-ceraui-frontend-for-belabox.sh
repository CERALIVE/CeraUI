#!/bin/bash
set -e

echo "🏗️  Building CeraUI Frontend for BELABOX Distribution..."

# Clean previous build
rm -rf dist/belabox-frontend

# Build CeraUI frontend for BELABOX using existing package.json script
echo "📦 Building CeraUI frontend for BELABOX..."
VITE_BRAND=BELABOX pnpm --filter frontend run build

# Create distribution directory
mkdir -p dist/belabox-frontend

# Copy frontend assets
echo "📂 Copying frontend assets..."
cp -r apps/frontend/dist/* dist/belabox-frontend/

# Create simple web server setup for standalone frontend
cat > dist/belabox-frontend/README.md << 'EOF'
# CeraUI Frontend for BELABOX Distribution

This is a CeraUI frontend distribution compatible with existing belaUI backend on BELABOX devices.

## Running the Frontend

### Option 1: Simple HTTP Server (Python)
```bash
cd belabox-frontend
python3 -m http.server 8080
```

### Option 2: Node.js HTTP Server
```bash
cd belabox-frontend
npx serve -s . -p 8080
```

Then open http://localhost:8080 in your browser.

## Configuration

This frontend is designed to work with existing belaUI backend services. It expects:
- belaUI backend running on the same device
- API endpoints available at `/api/*` (proxied through the frontend server)
- WebSocket connection for real-time communication

## Deployment

1. Copy the frontend files to replace existing belaUI web interface
2. Or serve through a web server as shown above
3. Ensure the belaUI backend service is running

## Build Information
- Product: CeraUI Frontend
- Brand: BELABOX (belaUI-compatible)
- Target: Existing BELABOX devices with belaUI backend
- Build Date: $(date)
- Version: ${BUILD_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")}
EOF

# Create package info
cat > dist/belabox-frontend/build-info.json << EOF
{
  "product": "CeraUI Frontend",
  "brand": "BELABOX",
  "type": "ceraui-frontend-for-belabox",
  "target": "BELABOX devices with belaUI backend",
  "buildDate": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "version": "${BUILD_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")}",
  "nodeVersion": "$(node --version)",
  "pnpmVersion": "$(pnpm --version)",
  "compatibility": "belaUI backend"
}
EOF

echo "✅ CeraUI frontend for BELABOX distribution built successfully!"
echo "📍 Location: dist/belabox-frontend/"
echo "📊 Size: $(du -sh dist/belabox-frontend/ | cut -f1)"
