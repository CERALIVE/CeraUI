#!/usr/bin/env bash

# Deploy dist to local belabox via ssh (rsync) and register service and restart service

SSH_TARGET=root@belabox.local
DIST_PATH=dist
BELAUI_PATH=/opt/belaUI
RSYNC_TARGET="${SSH_TARGET}:${BELAUI_PATH}"

# stop on error
set -e

echo "Deploying to $RSYNC_TARGET"
rsync -rltvz --delete --chown=root:root \
  --exclude auth_tokens.json \
  --exclude config.json \
  --exclude dns_cache.json \
  --exclude gsm_operator_cache.json \
  --exclude relays_cache.json \
  --exclude revision \
  --exclude setup.json \
  "${DIST_PATH}/" $RSYNC_TARGET

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
