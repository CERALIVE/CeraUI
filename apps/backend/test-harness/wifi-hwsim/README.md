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

## Local VM without host root

`vm/run-vm.sh` runs the same harness in a disposable Debian 12 **generic**
amd64 guest with its full kernel, NetworkManager, wpa_supplicant and hostapd.
It requires Linux with readable/writable `/dev/kvm`, QEMU (`qemu-system-x86_64`
and `qemu-img`), xorriso, OpenSSH, curl, coreutils, flock, tar, Git and Python
with `os.pidfd_open`/`signal.pidfd_send_signal` support (Linux, Python 3.9+).
`--repo` additionally requires the workstation's Bun 1.4.4 binary.
No host module, Docker or administrator password is needed. This remains
local-only infrastructure, outside shared CI.

From the repository root, create state on disk outside `/tmp` and every Git
work tree, then run:

```bash
mkdir -p "$HOME/.cache/ceraui-hwsim-state"
export TMPDIR="$HOME/.cache/ceraui-hwsim-state"
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 2 -- bash integration-test.sh
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 4 -- sh -c 'iw dev | grep -c Interface'
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 2 -- false
```

The canonical state path is checked, including symlinks; repository state and
paths under `/tmp` are rejected before any download or key creation. Paths
containing commas are rejected because QEMU's drive syntax uses that delimiter.

The first command must print `connected` and exit 0, the second prints at least
4 interfaces, and the third returns the command's nonzero exit status. On the
host, `lsmod | grep -c hwsim` must print `0` before and after (grep exits 1 when
there are no matches). The module is checked with `modinfo` and loaded only
inside the guest. The AP uses the same `CeraTest` SSID, `ceratest1234` test
passphrase, channel 6 and WPA2 settings as the container flow. The guest leaves
the first radio unmanaged by NetworkManager and manages the second as client.
Static guest-only test addresses (`192.0.2.1/24` and `192.0.2.2/24`) let the
unchanged integration test exercise association and report `connected` without
a DHCP server; this does not test DHCP or Internet access.

Flags:

| Flag | Effect |
|---|---|
| `--radios N` | Create 2 to 100 radios, default 2. |
| `--repo PATH` | Normalize PATH to its Git work-tree root, export committed `HEAD` to `/repo`, copy workstation Bun 1.4.4, and run `bun install --frozen-lockfile --linker=hoisted` in the guest. Hoisting makes workspace dependencies available to root-level gate imports. Commands start in `/repo`; `HWSIM_REPO=/repo` is available. Uncommitted files, workstation dependencies and submodules are excluded. |
| `--no-install` | Skip the guest dependency install for self-contained repository commands. Without `--repo`, commands start in `/harness`. |
| `--keep` | After a successful command, print the SSH command and hold the VM up for inspection until the runner is interrupted or one hour elapses. Keep the runner alive in its terminal; it still owns cleanup. |

For example, dependency imports execute from the exported repository root:

```bash
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 2 --repo "$PWD" -- \
  bun -e "import 'zod'; import 'winston'; console.log('deps-ok')"
```

Later plan commands such as
`bun apps/backend/test-harness/wifi-hwsim/checks/first-ap.ts` likewise run from
`/repo` when `--repo` is used; those gate files are supplied by their later plan
steps. The guest initializes local Git metadata solely so the archived
repository's install hooks can configure hooks; it does not invent a commit.
The exported application SHA is printed separately. An install failure is an
infrastructure failure, before the requested command runs.

The image lives under `$TMPDIR/hwsim-vm/images/`, separate from scripts and
per-run files. Each invocation fetches Debian's published `SHA512SUMS` over
certificate-validated HTTPS, selects the exact generic amd64 qcow2 entry and
checks the image bytes, including cached images. The inspected Debian cloud
directory publishes no detached signature alongside that checksum file:
this verifies the digest from Debian's HTTPS origin, not an independently
authenticated signing key. A corrupt cached image is rejected before boot and
replaced with one fresh download, which must pass the checksum. A changed published digest
gets its own cache directory. Interrupted downloads never become cached images.
Both curl transfers disable default curl configuration with a first-argument
`-q`, so a workstation curlrc cannot disable HTTPS certificate verification.
The cache directories are mode `0700` and verified images are mode `0444`;
each run uses a copy-on-write overlay without copying the backing image.
Same-user cache writers are trusted: these permissions and the cooperative lock
do not protect against an active owner replacing bytes between verification and
QEMU opening the backing file.

Each run creates a fresh copy-on-write overlay and NoCloud `cidata` ISO,
a new instance identity, throwaway SSH key and private known-hosts file.
The VM uses two vCPUs with host CPU features (required by the copied Bun binary),
2 GiB RAM and user networking with SSH bound only to
`127.0.0.1` on an available host port. Downloads, SSH boot (300 seconds),
cloud-init (600 seconds), transfers and setup all have bounded deadlines.
The requested command has a 900-second deadline; expiry returns nonzero.
Forwarding bind collisions get at most three fresh-port attempts within the
boot deadline and are reported as infrastructure failures. SSH readiness is
accepted only while the recorded QEMU PID and process starttime still match.
All SSH/SCP calls, including poweroff, use `-F /dev/null`, the explicit
throwaway identity, `IdentitiesOnly=yes` and `IdentityAgent=none`; workstation
SSH configuration and agents cannot redirect commands or retain the key.
User networking limits the inbound SSH forward to loopback; it does **not**
isolate the guest from the host or Internet. Outbound access provisions packages
and repository dependencies.
The runner returns the inner command's exit code rather than boot success.
On exit, failure, SIGINT or SIGTERM it powers off its recorded QEMU process,
escalates only while PID and `/proc` starttime still match, and removes the
entire run directory, including overlay,
seed, SSH key and partial downloads. `--keep` also cleans up when interrupted.
Signals use a pidfd to close the identity-check-to-signal race. Cleanup traps
are installed before resource creation; cancellation is deferred across child
launch and ownership registration, including bounded command children.
SIGKILL or host power loss cannot execute shell traps.

The Debian image cache is the only persistent VM artifact. A completed run
prints its QEMU PID and removed run directory as cleanup receipts. Do not
commit images, overlays or seed ISOs.

Parity verified on November 12, 2026 with the generic image's
`6.1.0-54-amd64` kernel: the unchanged `integration-test.sh` exited 0 with
`GENERAL.STATE:100 (connected)`. The host's hwsim module count was 0 before
and after, and the owned QEMU process and run directory were removed.
The VM path is available for simulated-radio checks; no owner-run fallback
was needed.

Each invocation records the image SHA512, guest kernel (`uname -r`),
NetworkManager, iw and wpa_supplicant versions, and the exported application SHA
with `--repo`. These receipts identify the actual environment: `latest` and
guest package updates can change it between runs.

The device receipt is kernel `7.2.0-ceralive-rk3588` and NetworkManager `1.52.1`;
this Debian 12 simulator uses kernel `6.1` and NetworkManager `1.42.4`.
Device qualification remains separate. hwsim does not model physical driver,
firmware, RF, USB/PCI topology or physical interface limits, so a passing VM gate
does not prove slot-limit behavior. Duplicate-address behavior is unqualified
here: its later gate must record the actual Debian result with a working
distinct-address control, rather than infer it from an upstream error string.

The unchanged `integration-test.sh` accepts any state output containing
`connected`, including `disconnected`. Its PASS marker alone is insufficient:
the parity receipt must contain **`GENERAL.STATE:100 (connected)`**. The VM
qualification checks that numeric connected state; the integration script is
not changed by this runner.

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

## Container prerequisites

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
