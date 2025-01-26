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
rsync -avz --delete --exclude auth_tokens.json --exclude config.json --exclude dns_cache.json --exclude gsm_operator_cache.json --exclude setup.json "${DIST_PATH}/" $RSYNC_TARGET

#echo "Installing and restarting service"
## shellcheck disable=SC2029
#ssh "$SSH_TARGET" "cd $BELAUI_PATH; ./install_service.sh"

# Kill any running belaUI
echo "Killing belaUI"
ssh "$SSH_TARGET" "pkill belaUI || true"

echo "Starting belaUI"
ssh "$SSH_TARGET" "cd $BELAUI_PATH; ./belaUI"