# wifi-hwsim — local-only mac80211_hwsim Wi-Fi harness

A **best-effort, local-only** test harness that spins up two **virtual Wi-Fi
radios** on a Linux host using the kernel's `mac80211_hwsim` module, serves a
WPA2-PSK access point (`SSID=CeraTest`, `password=ceratest1234`) on one radio,
and exercises the **same `nmcli`/NetworkManager surface the CeraUI backend uses**
(`apps/backend/src/modules/network/network-manager.ts`) on the other.

It lets you exercise real Wi-Fi scan → list → connect → state flows **without any
physical Wi-Fi hardware**.

> **This is NOT a CI gate.** It is intentionally local-only and best-effort. No
> unit or integration test depends on it. `check-env.sh` always exits cleanly
> (`SUPPORTED` / `SKIP`) so it can be probed safely from anywhere.

---

## Why these values?

The AP defaults mirror the task harness contract and are close to the CeraUI
hotspot conventions in `apps/backend/src/modules/wifi/wifi-hotspot.ts`
(WPA2-PSK / `key-mgmt=wpa-psk` / `pairwise=ccmp` / `proto=rsn`):

| Setting | Value |
|---|---|
| SSID | `CeraTest` |
| Passphrase | `ceratest1234` |
| `wpa` | `2` (WPA2) |
| `wpa_key_mgmt` | `WPA-PSK` |
| `rsn_pairwise` | `CCMP` |

Override via env: `CERATEST_SSID`, `CERATEST_PSK`, `HWSIM_RADIOS`.

---

## Prerequisites

1. **A real Linux host.** `mac80211_hwsim` is a Linux **kernel module**; it runs
   in the host kernel, not in a container or VM you don't control.
2. **Kernel support: `CONFIG_MAC80211_HWSIM`** — built as a module (`=m`,
   loadable with `modprobe`) or built in (`=y`). Check:
   ```bash
   zcat /proc/config.gz | grep MAC80211_HWSIM        # if /proc/config.gz exists
   grep MAC80211_HWSIM /boot/config-"$(uname -r)"     # otherwise
   ```
   Most desktop distros (Arch, Fedora, Ubuntu, Debian) ship it as `=m`.
3. **Native Docker Engine** (Linux). The host loads the module; the container
   only provides the NetworkManager/hostapd userspace.
4. **Root** (or `sudo`) — required for `modprobe` and `docker --privileged`.

### ⚠️ Docker Desktop is NOT supported (macOS / Windows / WSL)

Docker **Desktop** on macOS and Windows runs containers inside a **managed
LinuxKit VM**. You have **no control over that VM's kernel** and **cannot load
host kernel modules** into it — there is no `mac80211_hwsim`, and `--privileged`
+ `-v /lib/modules` only expose your laptop's (wrong, non-Linux) filesystem.

Likewise **WSL1/WSL2** ship Microsoft-managed kernels **without
`CONFIG_MAC80211_HWSIM`** and cannot `modprobe` host modules.

On any of these, `check-env.sh` prints a clear `SKIP:` and exits non-zero. This
is expected — run the harness on a native Linux host (bare metal, a Linux VM
where *you* control the kernel, or a Linux CI runner with the module available).

---

## Files

| File | Purpose |
|---|---|
| `check-env.sh` | Probe: is this host capable? `SUPPORTED` (exit 0) or `SKIP: <reason>` (exit 1). Never crashes/hangs. |
| `Dockerfile` | Debian image with NetworkManager + wpa_supplicant + hostapd + iw + wireless-tools + dbus. |
| `run.sh` | Orchestrator: loads the module on the host, runs the privileged container, brings up the AP, runs the test, cleans up. |
| `integration-test.sh` | Sample test entrypoint: rescan → list SSIDs → connect `CeraTest` → assert `connected`. |
| `README.md` | This file. |

---

## Quick start

From this directory (`apps/backend/test-harness/wifi-hwsim/`):

```bash
# 0. Is this host capable? (safe to run anywhere — never hangs)
bash check-env.sh
#   -> "SUPPORTED: ..."   (exit 0)  ready to go
#   -> "SKIP: ..."        (exit 1)  reason printed; harness can't run here

# 1. Bring up the virtual AP and run the integration test end-to-end.
sudo ./run.sh
#   loads mac80211_hwsim radios=2, builds the image, serves the AP on radio 0,
#   runs integration-test.sh on radio 1, then tears everything down.

# 2. Or bring up the AP and poke at nmcli yourself.
sudo ./run.sh --shell
#   inside the container:
#   nmcli -t -f SSID dev wifi list ifname <wlan>
#   nmcli device wifi connect CeraTest password ceratest1234 ifname <wlan>
```

A successful run ends with:

```
RESULT: PASS — <wlanX> is connected to 'CeraTest'
```

### `run.sh` flags / env

| Flag / env | Effect |
|---|---|
| `--shell` | After the AP is up, drop into an interactive container shell instead of running the test. |
| `--keep-module` | Do not `rmmod mac80211_hwsim` on exit (useful for repeated runs). |
| `HWSIM_RADIOS=N` | Number of virtual radios to create (default `2`). |
| `CERATEST_SSID` / `CERATEST_PSK` | Override AP SSID / passphrase. |

---

## How it works

```
HOST kernel:  modprobe mac80211_hwsim radios=2   ->  wlanA (AP) + wlanB (client)
                                 │ simulated radio medium │
HOST userspace (run.sh):
  - detects the two hwsim wlan interfaces
  - releases them from host NetworkManager (so the container can own them)
  - docker run --privileged --net=host -v /sys:/sys -v /lib/modules:/lib/modules

CONTAINER userspace:
  - own dbus + NetworkManager (manages the client radio)
  - hostapd serves WPA2-PSK 'CeraTest' on the AP radio
  - integration-test.sh drives nmcli on the client radio
```

Because `mac80211_hwsim`'s radios share one simulated medium, the client radio
"sees" the AP radio's beacons and can associate — a full scan/connect cycle with
zero physical hardware.

---

## Running just the integration test

`integration-test.sh` is the assertable entrypoint. Normally `run.sh` invokes it
inside the container after the AP is up. You can also run it directly in any
environment where `nmcli` can see the `CeraTest` AP (e.g. inside `--shell`):

```bash
CERATEST_SSID=CeraTest CERATEST_PSK=ceratest1234 \
CERATEST_CLIENT_IF=wlan1 \
  bash integration-test.sh
```

It prints each step to stdout and exits `0` only when
`nmcli -t -f GENERAL.STATE dev show <wlan>` contains `connected`, so it is easy
to assert on from a wrapper.

---

## Caveats

- **`--net=host` shares the host's network namespace.** `run.sh` therefore
  releases the hwsim interfaces from the host's NetworkManager (`nmcli device set
  <if> managed no`) before starting the container, and hands them back on
  cleanup. If your host runs a different network stack (e.g. `systemd-networkd`,
  `iwd`, `connman`), you may need to release the virtual interfaces from it
  manually first.
- **One hwsim instance per host.** `mac80211_hwsim` is a single global module.
  `run.sh` will reuse an already-loaded instance and will **not** unload one it
  didn't load (so it won't disturb other users). Use `--keep-module` to keep
  yours loaded across runs.
- **`modprobe` + `--privileged` require root.** Expected for kernel-module and
  raw-netlink work; this is why the harness is local-only and never wired into
  shared CI.
- **Channel/regdomain.** The AP uses 2.4 GHz channel 6 (`hw_mode=g`). hwsim is
  region-agnostic, so no regulatory setup is needed for the defaults.
- **Best-effort timing.** `integration-test.sh` retries scan/connect/state for a
  bounded number of attempts; the simulated medium occasionally needs a beat.
- **Cleanup is on `EXIT`/`INT`/`TERM`.** Ctrl-C still tears down the container
  and unloads the module (unless `--keep-module`).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `SKIP: host OS is 'Darwin'...` | You're on macOS/Docker Desktop — run on native Linux. |
| `SKIP: CONFIG_MAC80211_HWSIM not available` | Kernel lacks the module — install/build a kernel with `CONFIG_MAC80211_HWSIM=m`. |
| `SKIP: docker CLI not found` | Install native Docker Engine. |
| `expected >=2 mac80211_hwsim interfaces` | Reset the module: `sudo modprobe -r mac80211_hwsim && sudo modprobe mac80211_hwsim radios=2`. |
| `hostapd did not reach AP-ENABLED` | Another process owns the AP interface — ensure host NM/iwd released it (see Caveats). Check `/tmp/hostapd.log` in `--shell`. |
| Client never reaches `connected` | Wrong PSK, or the client radio is still host-managed. Re-run; try `--shell` and inspect `nmcli device status`. |
