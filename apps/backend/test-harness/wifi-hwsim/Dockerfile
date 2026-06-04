# wifi-hwsim harness container
#
# Provides the NetworkManager + wpa_supplicant + hostapd userspace that drives
# the host-loaded mac80211_hwsim virtual radios. The container does NOT load any
# kernel module itself — the host loads mac80211_hwsim and the container reaches
# the virtual radios via `--net=host` + `-v /sys:/sys` + `-v /lib/modules:...`.
#
# Image mirrors the on-device userspace: nmcli (NetworkManager) is the client,
# hostapd serves the virtual AP, wpa_supplicant backs WPA2-PSK association,
# and iw / wireless-tools provide phy<->wlan inspection.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Core wireless userspace:
#   network-manager  -> nmcli (the client the CeraUI backend itself drives)
#   wpasupplicant    -> WPA2-PSK supplicant backend for NM
#   hostapd          -> serves the virtual AP (SSID=CeraTest)
#   iw               -> modern nl80211 phy/interface tooling
#   wireless-tools   -> legacy iwconfig/iwlist (compat)
#   iproute2/iputils -> ip link / ping for plumbing + reachability checks
#   rfkill           -> unblock soft/hard radio blocks on the virtual phys
#   procps           -> pgrep/pkill for in-container process management
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		network-manager \
		wpasupplicant \
		hostapd \
		iw \
		wireless-tools \
		iproute2 \
		iputils-ping \
		rfkill \
		procps \
		dbus \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /etc/NetworkManager/conf.d

# hostapd ships masked on Debian; the harness invokes the binary directly, so
# no systemd unit is needed. Nothing to unmask inside the container.

WORKDIR /harness

# Scripts are bind-mounted at run time by run.sh so edits take effect without a
# rebuild. Copy them too so the image is self-contained if used standalone.
COPY integration-test.sh /harness/integration-test.sh
RUN chmod +x /harness/integration-test.sh

# Default to an interactive shell; run.sh overrides the command as needed.
CMD ["/bin/bash"]
