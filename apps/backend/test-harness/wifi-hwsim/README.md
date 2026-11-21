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

## Offline native-shim preflight

The first-AP shim installs an exclusive `/usr/local/bin/nmcli` link to its
private executable in the exported repository and removes its owned link on
close, uncaught process exit, SIGINT and SIGTERM. `/run` may remain `noexec`.
That launcher directory is already
on the guest's startup PATH. Bun 1.4.4's env-less product execution path retains
the startup PATH, while the stdin runner receives the current environment;
prepending a private directory after startup alone does not intercept both.
An existing `/usr/local/bin/nmcli` is never overwritten.

Run the exact two-runner preflight without a VM:

```bash
taskset -c 0-3 bun \
  apps/backend/test-harness/wifi-hwsim/checks/first-ap-nmcli-shim.selftest.ts
```

This requires Linux with unprivileged user and mount namespaces enabled.
The test mounts temporary `/run` (deliberately `noexec`) and `/usr/local/bin`
filesystems only inside its private user/mount/PID namespace, preserves the real Bun executable with a private bind
mount, and invokes the real installer and product runners against the real
`nmcli --version`. It verifies two receipts and launcher cleanup. It is an
explicit selftest outside normal backend test discovery. No host root,
NetworkManager daemon, VM or shared lock is used. This proves instrumentation,
not native Wi-Fi behavior.

Before the four-radio native cases, run the aggregate guest preflight once:

```bash
export NODE_ENV=production MOCK_MODE=false LC_ALL=C
bash apps/backend/test-harness/wifi-hwsim/guest-preflight.sh
```

Run it after installing any outer nmcli capture observer. It attempts every
independent probe, prints every failure, and returns nonzero if any failed.
It checks tools/versions, guest boundaries, writable and executable paths,
backend imports, WebSocket loopback, both real product runners' shim receipts,
four distinct hwsim radios and channel 6, managed-device readiness, virtual
interface creation/deletion, shared-IPv4 AP activation on control radio B,
NM framing/offline stdin, persisted file and D-Bus
properties, an actual NM restart, and readiness after restart. Its two NM
fixtures (a short-lived control AP and an inactive dummy profile) have generated
UUIDs and are deleted only by those UUIDs. The control uses the public harness
passphrase. It never calls a CeraUI hotspot entrypoint or runs a native scenario.
Logs and fsynced results live in the printed `/var/tmp/ceraui-preflight.*`
directory; copy or emit them before guest teardown. The check imports backend
modules in a disposable process and exits explicitly to retire their pollers.

Execute **each** native case through its own mount namespace:

```bash
bash apps/backend/test-harness/wifi-hwsim/native-exec.sh \
  bun apps/backend/test-harness/wifi-hwsim/checks/first-ap.ts
bash apps/backend/test-harness/wifi-hwsim/native-exec.sh \
  bun apps/backend/test-harness/wifi-hwsim/checks/hybrid-upgrade.ts
```

The wrapper keeps the real Bun executable through an open descriptor, then
mounts a private `/usr/local/bin`. Even an uncatchable process death cannot
leave its launcher in the next case's namespace. It preserves the guest PID
namespace, so NetworkManager audit PIDs remain comparable. A hard kill can
leave private state files in the disposable repository; they are never reused.
Do not use a PID namespace for native cases that compare NM audit PIDs.

Offline lifecycle, aggregate-failure and type checks:

```bash
taskset -c 0-3 bun apps/backend/test-harness/wifi-hwsim/checks/native-exec.selftest.ts
cd apps/backend/test-harness/wifi-hwsim
taskset -c 0-3 bun ../../../../scripts/tsc.mjs -p tsconfig.json
```

## Local VM without host root

`vm/run-vm.sh` runs the same harness in a disposable Debian 13 trixie **generic**
amd64 guest with its full kernel, NetworkManager, wpa_supplicant and hostapd.
The generic flavour includes `mac80211_hwsim`; genericcloud does not.
Both VM and container provisioning include `dnsmasq-base` for NetworkManager's
shared-IPv4 hotspot profiles; the container uses `debian:trixie-slim`.
It requires Linux with readable/writable `/dev/kvm`, QEMU (`qemu-system-x86_64`
and `qemu-img`), xorriso, OpenSSH, curl, coreutils, find, flock, tar, Git and Python
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
Pre-existing symlinks below the state root are rejected before permissions or
files are changed, including `runs`, `images`, digest directories and image
entries; they cannot redirect state into a checkout or `/tmp`.

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
| `--repo PATH` | Normalize PATH to its Git work-tree root, export one committed revision (default `HEAD`) to `/repo`, copy workstation Bun 1.4.4, and run `bun install --frozen-lockfile --linker=hoisted` in the guest. Hoisting makes workspace dependencies available to root-level gate imports. Commands start in `/repo`; `HWSIM_REPO=/repo` is available. Uncommitted files, workstation dependencies and submodules are excluded. |
| `--ref REV` | With `--repo`, select a commit from that repository's object store without checking it out or changing any worktree. The resolved commit supplies both checks and product code. |
| `--no-install` | Skip the guest dependency install for self-contained repository commands. Without `--repo`, commands start in `/harness`. |
| `--keep` | After a successful command, print the SSH command and hold the VM up for inspection until the runner is interrupted or one hour elapses. Keep the runner alive in its terminal; it still owns cleanup. |

For example, dependency imports execute from the exported repository root:

```bash
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 2 --repo "$PWD" -- \
  bun -e "import 'zod'; import 'winston'; console.log('deps-ok')"
```

For a reviewed gate that is not on the current branch, select its revision:

```bash
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 4 \
  --repo "$PWD" --ref "$REVIEWED_COMMIT" -- \
  bun apps/backend/test-harness/wifi-hwsim/checks/first-ap.ts
```

The selected commit must contain the harness, gate and its product imports together;
do not overlay checks from another revision. Before any download, VM state
creation or boot, the runner rejects an invalid revision or a direct
`bun path.ts` / `bun path.js` command whose script is absent from that commit.
The same check covers JSX/TSX and CommonJS/ESM script extensions.
It does not inspect imports embedded in `bun -e` or shell commands.
All transfer archives and the command file are prepared before downloads or
boot. With `--repo`, the harness archive comes from that same immutable commit,
independent of the runner script's location. A misplaced standalone runner
without a valid harness directory fails before QEMU. The guest initializes local Git metadata solely so the archived
repository's install hooks can configure hooks; it does not invent a commit.
The exported application SHA is printed separately. An install failure is an
infrastructure failure, before the requested command runs.

The command CWD also contains committed `apps/backend/setup.json` copied to
`/repo/setup.json`: production `modules/setup.ts` parses that required image
metadata relative to CWD at import time. `/repo/config.json` starts as a fresh
`{}` for simulator-owned runtime settings. Optional relay, DNS and authentication
caches may start absent; their loaders handle absence. Application logs and
subsequent state writes stay in this disposable guest CWD. No workstation
configuration, credentials or runtime state is copied. This metadata enables
imports and does not qualify the guest as physical RK3588 hardware:

```bash
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 2 --repo "$PWD" -- \
  bun -e "await import('./apps/backend/src/modules/network/network-manager.ts'); console.log('import-ok')"
```

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
Initial registration requires the recorded PPID to equal the runner's PID.
Cleanup ignores INT/TERM before disabling EXIT; cancellation at cleanup entry
enters cleanup directly rather than aborting an active EXIT handler.
SIGKILL or host power loss cannot execute shell traps.

The Debian image cache is the only persistent VM artifact. A completed run
prints its QEMU PID and removed run directory as cleanup receipts. Do not
commit images, overlays or seed ISOs.

Historical association parity was verified on November 12, 2026 with the
previous image's `6.1.0-54-amd64` kernel: the unchanged `integration-test.sh` exited 0 with
`GENERAL.STATE:100 (connected)`. The host's hwsim module count was 0 before
and after, and the owned QEMU process and run directory were removed.
The VM path is available for simulated-radio checks; no owner-run fallback
was needed.

Each invocation records the image SHA512, guest kernel (`uname -r`),
NetworkManager, iw and wpa_supplicant versions, and the exported application SHA
with `--repo`. These receipts identify the actual environment: `latest` and
guest package updates can change it between runs.

The device receipt is kernel `7.2.0-ceralive-rk3588` and NetworkManager `1.52.1`.
The simulator now uses Debian 13 trixie to match the device OS and its
NetworkManager `1.52.x` series; its generic amd64 kernel remains different.
Device qualification remains separate. hwsim does not model physical driver,
firmware, RF, USB/PCI topology or physical interface limits, so a passing VM gate
does not prove slot-limit behavior. See [Equal permanent MAC and guest port
identity](#equal-permanent-mac-and-guest-port-identity) for the current
duplicate-address simulator procedure and its distinct-address control.

The unchanged `integration-test.sh` accepts any state output containing
`connected`, including `disconnected`. Its PASS marker alone is insufficient:
the parity receipt must contain **`GENERAL.STATE:100 (connected)`**. The VM
qualification checks that numeric connected state; the integration script is
not changed by this runner.

### Stub-only self-test

```bash
bash apps/backend/test-harness/wifi-hwsim/vm/selftest.sh
```

This compact local regression test uses a whitelist PATH and verifies executable
VM/network stubs before each case. It checks foreign-parent PID rejection,
cleanup-entry TERM/INT, incompatible-revision rejection before VM creation,
selected-revision bootstrap and redirected state rejection. It never boots a VM or
loads a host module and remains outside shared CI.

### Later gates

Run `replacement.ts` on four radios to check that Start refuses after the
physical names are swapped during saved-profile refresh before Up. The
duplicate-address gate has its own [current procedure](#equal-permanent-mac-and-guest-port-identity).

### Equal permanent MAC and guest port identity

Validate both rule layouts offline, then run the check from a committed CeraUI
checkout with a disk-backed `TMPDIR` outside the worktree:

```bash
harness=apps/backend/test-harness/wifi-hwsim
bash "$harness/vm/duplicate-address-ports.sh" --verify-rules
bash "$harness/vm/run-vm.sh" --radios 4 --repo "$PWD" --ref HEAD -- \
  bun "$harness/checks/duplicate-address.ts"
```

Offline verification uses `udevadm verify` without loading host rules. The
check requires the native VM and its runner marker before touching NetworkManager.
After the distinct-address AP control, it creates a second radio with the same
permanent MAC. The guest assigns `ID_PATH` by hwsim parent and reads it back
from udev and NetworkManager before each layout. Guest-only metadata lets
CeraUI enroll both radios using normal discovery; the check waits for settled
identity publication.

The same-path layout must refuse both radios with exactly `radio-unverified`.
With distinct paths, both APs must still be active after the second starts,
each on its own device with the expected UUID, SSID and AP mode.

Historically, unconfigured hwsim radios reported no NetworkManager port paths,
so that setup exercised the fail-closed path only. The explicit paths now let
the VM exercise both layouts. This is simulator evidence, not physical
same-address hardware qualification.

### #603 secret boundary

Run the following from the committed CeraUI checkout, with `TMPDIR` set to
a disk-backed directory outside Git work trees and `/tmp`.

```bash
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh \
  --radios 4 --repo "$PWD" --ref HEAD -- \
  bun apps/backend/test-harness/wifi-hwsim/checks/secret-boundary.ts
```

`B8-603` receipts distinguish stored, agent-owned, not-saved and missing PSKs.
The check records flags, persistent presence, verified equality, and activation
outcomes across separate `nmcli` processes. It repeats the legacy nonsecret
rewrite before running the candidate's saved-profile Start and active Save.
If a fixture cannot Start without a usable secret, the check first records
that refusal and then installs a stored control secret for Save and rollback.
A forced forward activation failure tests rollback on the original UUID.
Only generated fixture secrets are used, and the receipts omit their values.
A pass ends with `B8-603 complete`. It cannot identify the flags on the
removed incident profile.

### First AP add-then-up gate

`checks/first-ap.ts` is a local-only guest check. It calls the real
`nmApConnAdd` and `nmConnect`, verifies the inactive profile's autoconnect,
AP mode, permanent MAC and shared IPv4 fields, then checks AP mode/channel
and client association with the exact profile and SSID. A working AP on
distinct-address radio B is the positive control for B's later MAC-incompatible
refusal of A's profile. It then restarts NetworkManager inside the guest and
checks that the bus-scoped NM run identity changes while the settings fingerprint
and persisted creation authority survive. Owned add/modify writes refresh the bound
keyfile receipt within the same NM run; up/down/delete keep strict equality.
Restart must preserve filename/device/inode/ctime.
The same script then calls the backend's production `wifiHotspotStart` and
`wifiHotspotStop` entry points for the saved UUID. A resolved-adapter test row
uses real NM activity and sysfs data; the production radio-identity sampler
must verify its lifetime and permanent MAC. Vendor/product remain unknown:
neither product discovery nor identity logic is patched. This avoids assuming
hwsim has physical manufacturer metadata.
The fixture feeds the radio's observed operational MAC/IP through the existing
device-list cache API. Real discovery publishes and retains its numeric ID;
the harness does not register an ID mapping itself.

The case first confirms activity after the NM restart, then Stops and Starts
the same saved UUID. It requires the real terminal broadcast and connected NM
state, and verifies the credential UUID remains bound; the transient creation
marker retires on confirmation. Each confirmation has a 60-second deadline.
The existing transaction, adapter lock, NM operations and bounded confirmation
code all run with production defaults. RPC transport/admission is covered by
the related RPC/roundtrip/context unit suites, not claimed by this native case.
No second runner or product identity bypass is introduced.
The check removes only its recorded
profile UUIDs.

The guest provisioning includes `dnsmasq-base` for NetworkManager's shared
IPv4 mode. Select one reviewed revision for the check and its product code:

```bash
bash apps/backend/test-harness/wifi-hwsim/vm/run-vm.sh --radios 4 \
  --repo "$PWD" --ref "$REVIEWED_COMMIT" -- \
  bun apps/backend/test-harness/wifi-hwsim/checks/first-ap.ts
```

The four radios must belong to `mac80211_hwsim`. Root and the VM runner's
`HWSIM_REPO=/repo` environment are required. The script never prints a PSK or
a secret-bearing command exception. A source/type check does not qualify
NetworkManager behavior; the VM run remains a separate gate.

Failure receipts include a fixed phase and check id. Assertions report only
expected/actual kinds and array lengths; values, exception messages/stacks and
command argv are never serialized. Phase markers cover A's add, returned UUID,
instance binding, settings read, provenance, binding tuple and inactive-state
checks. `wifi-first-ap-diagnostics.test.ts` exercises that CLI boundary with
credential-bearing command and assertion errors.
Start admission, terminal Start confirmation and Stop outcomes retain only
success and the canonical error enum in phase receipts, never a free-form reason.
The adjacent `checks/first-ap-radio.test.ts` reproduces empty-cache `no-device`
and verifies that observed MAC/IP keeps the ID through real discovery.

The pending expanded case installs a guest-only nmcli shim which checks that
the synthetic PSK never appears in child argv or environment. The AP and a
separate station activation must associate using that persisted secret.
The client setup also uses the protected secret boundary. Phase receipts
never print the PSK, raw keyfile data or arbitrary command failures.

The same saved-profile case starts the existing R1 restore composition,
observes an externally downed owned AP and requires recovery on that exact
owner. Public Stop must keep station intent without restart. Scheduled
activation refusals must exhaust three attempts and degrade only that owner.
The adjacent recovery test drives that orchestration against the existing
R1 fake-NM fixture and fake clock; it does not qualify native behavior.

Additional native cases compare real writes to the offline prediction for
arm/disarm, binding, band/channel and credential deltas. The shim schedules
in-place/atomic restores after the real reply, an in-place edit before the
real write, and an actual activation between modify and readback. That
activation must preserve authority when the predicted bytes match; VersionId
is a diagnostic measurement, never equality evidence. On NM 1.42.4 the same
activation control runs without that unsupported property.
Foreign results must be preserved with no later product mutation and visible
authority degradation. After the refused deletes and activation control,
first-AP disables device autoconnect on A and loads the two exact keyfiles
restored after NM's reply. It checks that NM reports autoconnect `yes` for
both UUIDs and that their foreign bytes survive. A separate hybrid invocation
in the same guest can then compare every unrelated profile through its NM
restart. Hybrid also runs independently in a fresh guest.

The NM 1.52.1 guest passed the serializer and foreign-edit controls in R26.
The exact-file handoff still needs a combined native run.

Retiring product readbacks now emit a sanitized WARN with changed field names,
two-read stat witnesses, path/run flags and optional VersionId. The console
therefore retains these receipts without requiring INFO logging. Secret
rediscovery separately reports presence flags and short digests; empty or
hidden display reads preserve the same owned profile's known credential.
These diagnostics do not prove the cause of earlier uncaptured failures.

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

## Hybrid upgrade readiness

`checks/hybrid-upgrade.ts` gates every explicit profile activation, including
the uplink activation after NetworkManager restart, on fresh
`DEVICE,TYPE,STATE` observations. The selected device must be Wi-Fi and in a
managed state other than unavailable. There is no readiness sleep or activation
retry. A 30-second abort deadline bounds the state reads; timeout fails with an
`UPGRADE-WIFI-READINESS` receipt containing the device inventory, rfkill list,
hwsim interface state and NetworkManager general status. Each diagnostic command
has a separate two-second bound, and credential values are redacted.

Run `bun apps/backend/test-harness/wifi-hwsim/checks/hybrid-upgrade.ts --selftest`
without a VM to cover immediate readiness, several non-ready state changes and
a never-ready device failing with the bounded diagnostic receipt. The existing
native upgrade, unrelated-profile and Stop assertions remain unchanged.

The native row helper derives channel 6 through the normal exact-phy channel
initialization and records the observed NM band offering. It retains indexed
IPv4 values through the real named-field boundary. Hybrid AP observations use
the verified current row and the matching profile interface pin.

Cold NM/netdev loss is a negative qualification control: mac80211_hwsim remains
outside the MT7925 gate, so the AP must stay inactive, hybrid intent pending and
the station uplink unchanged, with `hybrid-channel-not-permitted`. Stop runs
while the adopted AP is still live, before this cold control; the saved hybrid
configuration is then restored as cold-test setup. Offline isolated MT7925
fixtures prove positive missing-leg restore. A simulated radio does not qualify
physical MT7925 restore; that remains in the board gate.

## Guest execution and version proof

The offline namespace checks install Bun as a regular mode-0755 file at
`/usr/local/bin/bun`, use the guest's exact PATH and umask 077, and keep `/run`
noexec. A host Bun path outside the private bin mount does not exercise the
guest layout. The lifecycle proof compares the executable's device, inode,
size, mode and owner before/after the wrapper; it also checks CWD, root UID,
the unchanged PID namespace and closure of the saved descriptor.

The wrapper opens descriptor 9 after entering its mount namespace, then binds
it with `mount --no-canonicalize`. A descriptor opened before `unshare` still
references the previous mount tree and cannot be cloned by the new mount API.
Without disabling canonicalization,
libmount resolves `/proc/self/fd/9` back to `/usr/local/bin/bun` after that
directory is covered, binding the new empty placeholder instead of Bun.
Adding execute permission to the placeholder would not repair that inode error.

`guest-versions.sh` prints every command's exit status and verdict. A valid
hostapd version banner may accompany exit 1 on Debian 13's hostapd 2.10;
that property applies only to this version probe. Other tool failures still
fail the group, and the exact Bun/NM daemon pins remain 1.4.4/1.52.1.

```bash
taskset -c 0-3 bash apps/backend/test-harness/wifi-hwsim/guest-versions.selftest.sh
```

## Recorded guest replay

`replay-corpus/README.md` lists the real R19/R20/R21 captures, consumer coverage
and explicit missing samples. The replay suite drives shared native decoders,
the frozen literal matchers and actual bootstrap/version scripts. It never
executes receipt contents or invokes host NetworkManager mutations.

The guest setup now explicitly activates its reserved CeraTest station profile
with one bounded NM activation before declaring the fixture ready. Profile
creation and a running hostapd AP do not establish client association.
Bootstrap diagnostics report every prerequisite and the selected device's
actual state/profile.

Capability replies are decoded as numeric MHz fields before the unchanged
channel assertions, so both `2437` and `2437.0` represent the same frequency.
Disabled flags and exact AP mode remain meaningful. All radio roles are
collected before capability validation, and full safe iw replies are saved
in the preflight receipt directory before assertions can truncate them.
The tracked `framing.sh` is the unchanged B7 framing/od case for future
same-revision controllers.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `SKIP: host OS is 'Darwin'...` | You're on macOS/Docker Desktop — run on native Linux. |
| `SKIP: CONFIG_MAC80211_HWSIM not available` | Kernel lacks the module — install/build a kernel with `CONFIG_MAC80211_HWSIM=m`. |
| `SKIP: docker CLI not found` | Install native Docker Engine. |
| `expected >=2 mac80211_hwsim interfaces` | Reset the module: `sudo modprobe -r mac80211_hwsim && sudo modprobe mac80211_hwsim radios=2`. |
| `hostapd did not reach AP-ENABLED` | Another process owns the AP interface — ensure host NM/iwd released it (see Caveats). Check `/tmp/hostapd.log` in `--shell`. |
| Client never reaches `connected` | Wrong PSK, or the client radio is still host-managed. Re-run; try `--shell` and inspect `nmcli device status`. |
