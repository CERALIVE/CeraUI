#!/usr/bin/env bash

# Reset BELABOX to default BelaUI package (removes CeraUI monorepo installation)
# This script removes the custom CeraUI installation and reinstalls the default BelaUI from apt

SSH_TARGET=root@belabox.local

# stop on error
set -e

echo "Removing old service and socket"
ssh "$SSH_TARGET" "systemctl disable belaUI.socket || true"
ssh "$SSH_TARGET" "systemctl disable belaUI.service || true"
ssh "$SSH_TARGET" "rm /etc/systemd/system/belaUI.socket || true"
ssh "$SSH_TARGET" "rm /etc/systemd/system/belaUI.service || true"

echo "Killing belaUI"
ssh "$SSH_TARGET" "pkill belaUI || true"

echo "Reinstall BelaUI"
ssh "$SSH_TARGET" "apt-get install --reinstall belaui"

echo "Start service"
ssh "$SSH_TARGET" "systemctl start belaUI"

echo "Enable service and socket"
ssh "$SSH_TARGET" "systemctl enable belaUI.service"
ssh "$SSH_TARGET" "systemctl enable belaUI.socket"

