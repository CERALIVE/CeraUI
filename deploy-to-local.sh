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

# shellcheck disable=SC2029
ssh "$SSH_TARGET" "cd $BELAUI_PATH; sudo ./override-belaui.sh"
