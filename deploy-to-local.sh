#!/usr/bin/env bash
# Usage: ./deploy-to-local.sh [SSH_TARGET]
# If no SSH_TARGET is provided, it defaults to "root@belabox.local"
# Deploy dist to local belabox via ssh (rsync) and register service and restart service

# This script uses strict error handling:
#   - set -e: Exit immediately if any command returns a non-zero status.
#   - set -u: Treat unset variables as errors and exit immediately.
#   - set -o pipefail: Ensure that a pipeline fails if any command in it fails.
set -euo pipefail

SSH_TARGET=${1:-root@belabox.local}
USE_CERAUI=${USE_CERAUI:-false}

DIST_PATH=dist
BELAUI_PATH=/opt/belaUI
RSYNC_TARGET="${SSH_TARGET}:${BELAUI_PATH}"
CERAUI_RELEASE_TARBALL="ceraui-extended.tar.xz"
CERAUI_RELEASE_URL="https://github.com/CERALIVE/CeraUI/releases/latest/download/$CERAUI_RELEASE_TARBALL"

# Detect OS and package manager
detect_package_manager() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "brew"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "apt"
  elif command -v pacman >/dev/null 2>&1; then
    echo "pacman"
  else
    echo "unknown"
  fi
}

PACKAGE_MANAGER=$(detect_package_manager)

# Function to check for a command and install it if missing.
install_if_missing() {
  local cmd=$1
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Command '$cmd' not found. Installing..."
    case "$PACKAGE_MANAGER" in
      brew)
        brew install "$cmd"
        ;;
      apt)
        sudo apt-get update && sudo apt-get install -y "$cmd"
        ;;
      pacman)
        sudo pacman -Sy --noconfirm "$cmd"
        ;;
      *)
        echo "Unsupported package manager. Please install '$cmd' manually."
        exit 1
        ;;
    esac
  fi
}

# Ensure rsync is installed
install_if_missing rsync

echo "Deploying to $RSYNC_TARGET"
rsync -rltvz --delete --chown=root:root \
  --exclude auth_tokens.json \
  --exclude config.json \
  --exclude dns_cache.json \
  --exclude gsm_operator_cache.json \
  --exclude relays_cache.json \
  --exclude revision \
  --exclude setup.json \
  "${DIST_PATH}/" "$RSYNC_TARGET"

# Install jq if its not installed
ssh "$SSH_TARGET" "jq --version 2>/dev/null || apt-get update && apt-get install -y jq"

# Add moblink_relay_enabled: true to setup.json
echo "Enabling Moblink Relay. You can disable it in $BELAUI_PATH/setup.json"
ssh "$SSH_TARGET" "cp $BELAUI_PATH/setup.json $BELAUI_PATH/setup.json.tmp"

# Enable moblink relay and set path to moblink-rust-relay
ssh "$SSH_TARGET" "cd $BELAUI_PATH; jq '.moblink_relay_enabled = true | .moblink_relay_bin = \"/opt/moblink-rust-relay/target/release/moblink-rust-relay\"' setup.json.tmp | sudo tee setup.json > /dev/null"
ssh "$SSH_TARGET" "rm $BELAUI_PATH/setup.json.tmp"

# Install moblink-rust-relay
ssh "$SSH_TARGET" "cd $BELAUI_PATH; bash ./install-moblink-rust-relay.sh"

echo "Moblink relay installed successfully."

# shellcheck disable=SC2029
ssh "$SSH_TARGET" "cd $BELAUI_PATH; bash ./override-belaui.sh"

# Check if CeraUI should be installed
if [ "$USE_CERAUI" = "true" ]; then
  echo "Downloading and installing CeraUI content"

  # Create a temporary script to download and extract CeraUI on the remote machine
  TMP_SCRIPT=$(cat <<'EOF'
#!/bin/bash
set -e
CERAUI_TEMP_DIR="$(mktemp -d)"
cd "$CERAUI_TEMP_DIR"
wget -q --show-progress CERAUI_RELEASE_URL
tar xf CERAUI_RELEASE_TARBALL
rsync -rltz --delete --chown=root:root "$CERAUI_TEMP_DIR/" BELAUI_PATH/public/
rm -rf "$CERAUI_TEMP_DIR"
EOF
)

  # Replace placeholders with actual values
  TMP_SCRIPT=${TMP_SCRIPT//CERAUI_RELEASE_URL/$CERAUI_RELEASE_URL}
  TMP_SCRIPT=${TMP_SCRIPT//CERAUI_RELEASE_TARBALL/$CERAUI_RELEASE_TARBALL}
  TMP_SCRIPT=${TMP_SCRIPT//BELAUI_PATH/$BELAUI_PATH}

  # Execute the script on the remote machine
  ssh "$SSH_TARGET" "bash -s" <<< "$TMP_SCRIPT"

  echo "CeraUI content installed successfully."
fi

echo "Deployment complete."
