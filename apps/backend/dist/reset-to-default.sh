#!/usr/bin/env bash

# stop on error
set -e

echo "Removing old service and socket"
systemctl disable belaUI.socket || true
systemctl disable belaUI.service || true
rm /etc/systemd/system/belaUI.socket || true
rm /etc/systemd/system/belaUI.service || true

echo "Killing belaUI"
pkill belaUI || true

echo "Reinstall BelaUI"
apt-get install --reinstall belaui

echo "Start service"
systemctl start belaUI

echo "Enable service and socket"
systemctl enable belaUI.service
systemctl enable belaUI.socket

