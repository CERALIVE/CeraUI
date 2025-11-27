#!/usr/bin/env bash

# stop on error
set -e

echo "Removing old belaUI service and socket (if present)"
systemctl disable belaUI.socket || true
systemctl disable belaUI.service || true
rm -f /etc/systemd/system/belaUI.socket || true
rm -f /etc/systemd/system/belaUI.service || true
pkill belaUI || true

echo "Removing CeraLive service and socket"
systemctl disable ceralive.socket || true
systemctl disable ceralive.service || true
rm -f /etc/systemd/system/ceralive.socket || true
rm -f /etc/systemd/system/ceralive.service || true
pkill ceralive || true

echo "Reinstall CeraLive"
apt-get install --reinstall ceralive

echo "Start service"
systemctl start ceralive

echo "Enable service and socket"
systemctl enable ceralive.service
systemctl enable ceralive.socket

echo "✅ CeraLive reset to default"
