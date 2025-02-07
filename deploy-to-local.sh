#!/usr/bin/env bash

# Deploy dist to local belabox via ssh (rsync) and register service and restart service

SSH_TARGET=root@belabox.local
DIST_PATH=dist
BELAUI_PATH=/opt/belaUI
RSYNC_TARGET="${SSH_TARGET}:${BELAUI_PATH}"

# stop on error
set -e

echo "Installing dependencies"
bun install

echo "Building"
bun run build:linux-arm64

echo "Copying assets"
bun run copy

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

echo "Installing and restarting service"
# shellcheck disable=SC2029
ssh "$SSH_TARGET" "cd $BELAUI_PATH; ./install_service.sh"

echo "Installing Moblink Relay"
# shellcheck disable=SC2029
ssh "$SSH_TARGET" "cd $BELAUI_PATH; ./install-moblink-rust-relay.sh"

# Kill any running belaUI
echo "Killing belaUI"
ssh "$SSH_TARGET" "pkill belaUI || true"

echo "Stop belaUI"
ssh "$SSH_TARGET" "systemctl stop belaUI || true"

echo "Disable service/socket"
ssh "$SSH_TARGET" "systemctl disable belaUI.socket || true"
ssh "$SSH_TARGET" "systemctl disable belaUI.service || true"

echo "Update service/socket"
ssh "$SSH_TARGET" "systemctl daemon-reload"

echo "Enable service/socket"
ssh "$SSH_TARGET" "systemctl enable belaUI.service"
#ssh "$SSH_TARGET" "systemctl enable belaUI.socket"

echo "Starting belaUI"
ssh "$SSH_TARGET" "systemctl start belaUI.service"

echo "Watch belaUI"
ssh "$SSH_TARGET" "journalctl -u belaUI -n 200 -f"

#echo "Starting belaUI"
#ssh "$SSH_TARGET" "cd $BELAUI_PATH; ./belaUI"