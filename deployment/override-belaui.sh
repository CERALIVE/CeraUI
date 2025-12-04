#!/usr/bin/env bash

echo "Stopping existing belaUI (if present)"
pkill belaUI || true
systemctl stop belaUI.socket || true
systemctl stop belaUI.service || true
systemctl disable belaUI.socket || true
systemctl disable belaUI.service || true
rm -f /etc/systemd/system/belaUI.service || true
rm -f /etc/systemd/system/belaUI.socket || true

echo "Stopping existing CeraLive (if present)"
pkill ceralive || true
systemctl stop ceralive.socket || true
systemctl stop ceralive.service || true
systemctl disable ceralive.socket || true
systemctl disable ceralive.service || true

echo "Copy udev rules"
cp *.rules /etc/udev/rules.d/
# Remove old belaui udev rules
rm -f /etc/udev/rules.d/*belaui*.rules || true

echo "Install udev rules"
udevadm control --reload-rules
udevadm trigger

echo "Copy new service"
cp ceralive.service /etc/systemd/system/

echo "Update service"
systemctl daemon-reload

echo "Enable service"
systemctl enable ceralive.service

echo "Start service"
systemctl start ceralive.service

echo "✅ CeraLive installed (replaced belaUI if present)"
