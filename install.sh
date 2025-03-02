#!/bin/bash

# Install script to install the belaUI fork on a BELABOX

# Variables
RELEASE_URL="https://github.com/pjeweb/belaUI/releases/latest/download/belaUI.zip"
TEMP_DIR="$HOME/.tmp/belaui"
TARGET_DIR="/opt/belaUI"

set -e

# Install some dependencies
sudo apt-get update
sudo apt-get install -y rsync jq unzip

# Clone the repository branch into a temporary directory
if [ -d "$TEMP_DIR" ]; then
  rm -rf "$TEMP_DIR"
fi

# Full checkout
#git clone --branch $BRANCH $REPO_URL "$TEMP_DIR"

# Sparse checkout (only dist folder, silences warnings)
#git init --quiet "$TEMP_DIR"
#cd "$TEMP_DIR" || exit
#git config core.sparseCheckout true
#echo "dist/*" >> .git/info/sparse-checkout
#git remote add origin -f $REPO_URL
#git checkout $BRANCH

# Install latest release from ZIP to temporary directory
mkdir -p "$TEMP_DIR"
cd "$TEMP_DIR" || exit
wget -q $RELEASE_URL
unzip -q belaUI.zip

# Ensure target directory exists
mkdir -p $TARGET_DIR

# Copy files from dist to target directory while excluding specified files
sudo rsync -rltvz --delete --chown=root:root \
  --exclude auth_tokens.json \
  --exclude config.json \
  --exclude dns_cache.json \
  --exclude gsm_operator_cache.json \
  --exclude relays_cache.json \
  --exclude revision \
  --exclude setup.json \
  "$TEMP_DIR/" $TARGET_DIR

# Cleanup
rm -rf "$TEMP_DIR"

# Set ownership to root:root and preserve permissions
sudo chown -R root:root $TARGET_DIR

# Add moblink_relay_enabled: true to setup.json
echo "Enabling Moblink Relay. You can disable it in $TARGET_DIR/setup.json"
sudo cp $TARGET_DIR/setup.json $TARGET_DIR/setup.json.tmp

# Enable moblink relay and set path to moblink-rust-relay
sudo jq '.moblink_relay_enabled = true | .moblink_relay_bin = "/opt/moblink-rust-relay/target/release/moblink-rust-relay"' $TARGET_DIR/setup.json.tmp | sudo tee $TARGET_DIR/setup.json > /dev/null
sudo rm $TARGET_DIR/setup.json.tmp

# Install moblink-rust-relay
cd $TARGET_DIR || exit
sudo bash ./install-moblink-rust-relay.sh

echo "Moblink relay installed successfully."

# Run the override script
cd $TARGET_DIR || exit
sudo bash ./override-belaui.sh

echo "BelaUI installed and override script executed successfully."

echo "You can reset to default by running: sudo $TARGET_DIR/reset-to-default.sh"