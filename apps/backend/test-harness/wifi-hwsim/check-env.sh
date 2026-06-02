#!/usr/bin/env bash
#
# check-env.sh — detect whether this host can run the mac80211_hwsim Wi-Fi harness.
#
# Contract (NEVER crash, NEVER hang):
#   exit 0  + prints "SUPPORTED: <details>"   when the host can run the harness
#   exit 1  + prints "SKIP: <reason>"          for any unsupported host
#
# This is a best-effort, local-only probe. It is NOT a CI gate and must never
# block a build or test run. All failures are caught and reported as SKIP.
#
set -euo pipefail

skip() {
	echo "SKIP: $*"
	exit 1
}

supported() {
	echo "SUPPORTED: $*"
	exit 0
}

# --- 1. Must be Linux (mac80211_hwsim is a Linux kernel module) -------------
uname_s="$(uname -s 2>/dev/null || echo unknown)"
if [ "$uname_s" != "Linux" ]; then
	skip "host OS is '$uname_s', not Linux. mac80211_hwsim is a Linux kernel module (Docker Desktop on macOS/Windows runs a managed VM with no host kernel-module passthrough)."
fi

# --- 2. Reject WSL (no real host-kernel module control) ---------------------
# WSL2 uses a Microsoft-managed kernel without CONFIG_MAC80211_HWSIM and no
# privileged host modprobe; WSL1 has no real kernel at all.
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
	skip "running under WSL ($(cat /proc/sys/kernel/osrelease 2>/dev/null || echo unknown)). WSL kernels do not ship CONFIG_MAC80211_HWSIM and cannot load host modules."
fi

# --- 3. Kernel release + module tree must exist -----------------------------
krel="$(uname -r 2>/dev/null || echo unknown)"
moddir="/lib/modules/${krel}"
if [ ! -d "$moddir" ]; then
	skip "kernel module directory '$moddir' does not exist (no matching modules tree for the running kernel ${krel})."
fi

# --- 4. mac80211_hwsim must be available (built-in, module, or already loaded)
hwsim_found=""

# 4a. Already loaded?
if [ -d /sys/module/mac80211_hwsim ]; then
	hwsim_found="already loaded (/sys/module/mac80211_hwsim)"
fi

# 4b. Built as a loadable module in the modules tree?
if [ -z "$hwsim_found" ]; then
	# modules.dep is the authoritative index; fall back to a file scan.
	if [ -f "${moddir}/modules.dep" ] && grep -q 'mac80211_hwsim' "${moddir}/modules.dep" 2>/dev/null; then
		hwsim_found="loadable module (modules.dep)"
	else
		# Direct file probe (handles .ko, .ko.gz, .ko.xz, .ko.zst).
		hwsim_ko="$(find "${moddir}" -name 'mac80211_hwsim.ko*' -print -quit 2>/dev/null || true)"
		if [ -n "$hwsim_ko" ]; then
			hwsim_found="loadable module (${hwsim_ko})"
		fi
	fi
fi

# 4c. Built into the kernel? (CONFIG_MAC80211_HWSIM=y)
if [ -z "$hwsim_found" ]; then
	for cfg in "/boot/config-${krel}" "/proc/config.gz" "${moddir}/config"; do
		[ -e "$cfg" ] || continue
		if [ "$cfg" = "/proc/config.gz" ]; then
			if command -v zcat >/dev/null 2>&1 && zcat "$cfg" 2>/dev/null | grep -q '^CONFIG_MAC80211_HWSIM=y'; then
				hwsim_found="built-in (CONFIG_MAC80211_HWSIM=y in ${cfg})"
				break
			fi
		else
			if grep -q '^CONFIG_MAC80211_HWSIM=y' "$cfg" 2>/dev/null; then
				hwsim_found="built-in (CONFIG_MAC80211_HWSIM=y in ${cfg})"
				break
			fi
		fi
	done
fi

if [ -z "$hwsim_found" ]; then
	skip "CONFIG_MAC80211_HWSIM not available for kernel ${krel} (no loaded module, no .ko in ${moddir}, and not =y in kernel config). Rebuild the kernel with CONFIG_MAC80211_HWSIM=m, or run on a host/distro that ships it."
fi

# --- 5. Docker must be present (the harness runs inside a container) ---------
if ! command -v docker >/dev/null 2>&1; then
	skip "docker CLI not found on PATH. Install Docker Engine (native Linux Docker, NOT Docker Desktop) to run the harness."
fi

# --- 6. Warn (non-fatal) if not effectively root --------------------------- #
# modprobe on the host requires root/CAP_SYS_MODULE. We only warn here; run.sh
# performs the privileged operations and will fail loudly with guidance.
root_note="root privileges available"
if [ "$(id -u 2>/dev/null || echo 1000)" -ne 0 ]; then
	if command -v sudo >/dev/null 2>&1; then
		root_note="non-root, but sudo present (run.sh will use sudo for modprobe)"
	else
		root_note="non-root and no sudo — run.sh must be run as root for 'modprobe mac80211_hwsim'"
	fi
fi

supported "Linux ${krel}, mac80211_hwsim ${hwsim_found}, docker present, ${root_note}."
