#!/usr/bin/env bash

echo "Killing belaUI"
pkill belaUI || true

echo "Stop belaUI"
systemctl stop belaUI.socket || true
systemctl stop belaUI.service || true

echo "Disable service/socket"
systemctl disable belaUI.socket || true
systemctl disable belaUI.service || true

echo "Copy udev rules"
cp *.rules /etc/udev/rules.d/

echo "Install udev rules"
udevadm control --reload-rules
udevadm trigger

echo "Copy new service"
cp belaUI.socket /etc/systemd/system/

echo "Update service"
systemctl daemon-reload

echo "Enable service"
systemctl enable belaUI.service

echo "Start service"
systemctl start belaUI.service