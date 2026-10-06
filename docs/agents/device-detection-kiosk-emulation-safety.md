<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEVICE DETECTION + KIOSK EMULATION SAFETY

`isRealDevice()` lives in `apps/backend/src/modules/system/device-detection.ts` and is re-exported from `apps/backend/src/modules/system/kiosk.ts`. It follows the same `deps`-injection pattern as the rest of the kiosk module (`DeviceDetectionDeps` + `defaultDeviceDetectionDeps`).

Detection contract (fail-safe, defaults to `false`):
1. `CERALIVE_DEVICE_TYPE==="real"` → true; `==="emulated"` → false (env override wins over everything)
2. `isDevelopment()` → false (short-circuits before any hardware probe)
3. `/proc/device-tree/compatible` OR `/proc/device-tree/model` contains the
   RK3588 marker (`"rk3588"`, matched case-insensitively) → true. `compatible`
   is the RELIABLE marker (always carries `rockchip,rk3588`, even on boards like
   the Radxa ROCK 5B+ whose `model` reads just `"Radxa ROCK 5B+"` with no
   `RK3588` substring); `model` is a belt-and-suspenders fallback for boards
   whose model string itself names the SoC (e.g. Orange Pi 5+). Generic
   Rockchip, RK3399, and RK356x identities fail closed
4. x86 mini-PC path: `/etc/ceralive/release` contains `ID=ceralive` AND DMI
   `/sys/class/dmi/id/{product_name,board_name}` contains a mini-PC marker
   (`N100`, `N200`, `Mini PC`, `MINIPC`) → true
5. Any probe throws (file absent/unreadable) → false for that probe (never propagates)
6. Unrecognised or malformed identity → false. Jetson is deliberately unhandled/deferred.

**Hardware-kind detection + `setup.json` drift guard (Todo 59 audit).**
`device-detection.ts` also exports `detectHardwareKindFromDeviceTree()` —
positively resolves the board family (`"rk3588" | "jetson" | "n100" | "unknown"`)
from the SAME reliable probes `isRealDevice()` uses, checking
`/proc/device-tree/compatible` FIRST (the marker that fixed the Todo 48 bug), then
`model`, then the x86 DMI product name. Markers are matched conservatively (the
specific SoC token, never a broad `"rockchip"`) so an unsupported RK3399/RK356x
resolves `"unknown"` instead of being mis-stamped `rk3588`.

`warnOnHardwareIdentityDrift()` is a boot-time, **warn-only** guard wired into
`main.ts` (`guardNonCritical("hardware-identity-drift", …)`, fail-soft): on a real
device it compares `setup.json` `hw` against the detected kind and logs a loud
`logger.warn` on a POSITIVE mismatch (`"unknown"` defers to config; dev/emulated
hosts are skipped). WHY: `setup.json` `hw` is a SINGLE hardcoded value packaged
verbatim into the `ceralive-device` .deb for every board/arch — there is no
per-board `setup.json`, and the image pipeline does NOT rewrite it (it leaves
`/etc/ceralive/conf.d/hardware.conf` on `auto`). So an AMD64/N100 or Orange-Pi
image still ships `hw:"rk3588"`. This guard stays as an independent boot-time
signal and is NOT superseded by the provider below (it fires even when the engine
is down, comparing setup.hw against the device-tree).

**Resolved hardware-kind provider — `setup.hw` demoted to fallback (Todo 15).**
`modules/system/hardware-kind.ts` is now the SINGLE runtime authority for "what
board am I on". The four consumers that previously read `setup.hw` directly
(`sensors.ts`, `audio.ts`, `pipelines.ts` → `getEffectiveHardware()`,
`addons/reconciler.ts` `getBoard`) all resolve through it. Resolution order,
highest-authority first, each tier failing through: (1) **engine** —
cerastream's `get-capabilities` `platform.hardware_kind` (cerastream Todo 14),
read via a NARROW RAW IPC PROBE (`probeEngineHardwareKind`) that dials the control
socket directly and reads the optional `platform` field tolerantly, because the
published `@ceralive/cerastream` client Zod-STRIPS the nested `platform.hardware_kind`
field (the binding is not republished); (2) **device-tree** —
`detectHardwareKindFromDeviceTree()` (`"unknown"` falls through); (3) **setup.hw** —
the static value (KEPT as fallback + test seam; NOT removed); (4) **generic** floor.
The resolved value is cached WITH its source tier (`getHardwareKindTier()`) and
RE-RESOLVED on every engine reconnect/capability refresh (`engine-reconnect.ts`
heal path re-runs `getHardwareKind()` before re-broadcasting pipelines/sources) —
so a boot-time device-tree/setup.hw fallback is superseded by the engine value once
cerastream comes up, and a re-resolution that CHANGES the kind logs a loud drift
warning. Reads: `getHardwareKind()` (async, full ladder + cache) and
`getHardwareKindCached()` (sync, hot paths; returns the `setup.hw` fallback before
the first resolve so a boot-time read is byte-identical to the pre-migration value —
RK3588 behavior is byte-unchanged, asserted in tests). Coverage:
`tests/hardware-kind.test.ts` (resolution-order table, drift warning, each consumer
under mocked kinds).

Real platform pairing parses `PLATFORM_URL` before any secret registration or
claim request. HTTPS is required on production and real devices; plaintext HTTP
is accepted only for `localhost`, `127.0.0.1`, or `[::1]` while the backend is in
development mode and device detection is emulated. Malformed, non-loopback HTTP,
and all other non-HTTPS URLs fail before a pairing secret, claim code, or issued
token can cross the boundary. Pairing POSTs also reject redirects so an accepted
HTTPS endpoint cannot replay a credential body through a downgrade redirect.

**`isDevelopment()` power-gate (T1):** `isDevelopment()` (defined in
`apps/backend/src/mocks/mock-config.ts`, `NODE_ENV==="development" ||
MOCK_MODE==="true"`) is the gate for all dev-only side-effects. The
`system.poweroff` and `system.reboot` RPC handlers skip the real OS spawn when
`isDevelopment()` is true — they return `{success:true}` without calling
`poweroff`/`reboot`. The post-update reboot in `software-updates.ts` is gated the
same way via `rebootAfterUpdate()`. DI runner seams (`setPowerCommandRunner`,
`setRebootRunner`) let tests assert the exact command without touching the host.
**Never use `isDevelopment()` to gate mock-hardware paths** — use `shouldUseMocks()`
for that (the mock subsystem requires both `isDevelopment()` AND
`mockState.initialized`).

**Dev reboot-disconnect helper (T2):** `simulateDevReboot()` (exported from
`apps/backend/src/rpc/events.ts`) reproduces the real-device reboot effect in dev:
it snapshots `getAuthenticatedClients()` and closes each socket after a macrotask
delay (`setTimeout(..., 0)`). The delay is critical — it lets the in-flight
`system.reboot` reply (`{success:true}`) flush to the client before the socket
drops, matching the real-device sequence where systemd takes the host down after
the reply is sent. The frontend's `DisconnectedBanner` then shows the "rebooting"
state and reconnects normally. Gated by `isDevelopment()` — the early return means
no production call site can schedule socket teardown through this helper.

**Kiosk RPC handlers are emulated-safe.** The 4 action handlers (`kioskStart`, `kioskStop`, `kioskConfigure`, `kioskOsk`) in `apps/backend/src/rpc/procedures/system.procedure.ts` gate on `await isRealDevice()` at entry. In dev/emulated mode they return `{ success: false, error: "kiosk_unavailable_in_emulated_mode" }` without invoking `systemctl`. `kioskStatus` is NOT gated (read-only config; the settings UI needs it to render).

The error constant `KIOSK_UNAVAILABLE_ERROR` is the single source of truth in `packages/rpc/src/schemas/system.schema.ts`. The frontend (`OnDeviceDisplaySection.svelte`) renders a calm `role="status"` banner (`data-testid="kiosk-unavailable"`, i18n key `onDeviceDisplay.unavailable`) when the gate fires — not an error toast.

**Kiosk dev-seam gate (T6):** `resolveActiveKioskDeps()` (exported from
`apps/backend/src/modules/system/kiosk.ts`) returns the mock kiosk harness when
`shouldUseMocks()` is true, otherwise the production `activeDeps`. The kiosk RPC
handlers call `kioskStart(resolveActiveKioskDeps())` etc. so dev exercises the full
state machine against in-memory fakes without touching `systemctl`. The gate in
`system.procedure.ts` was widened to `if (!shouldUseMocks() && !(await
isRealDevice())) return UNAVAILABLE` so dev bypasses the emulated-mode guard.
`peekMockKioskHarness()` returns the singleton without building it — use in prod
tests to assert the mock double was never constructed.

**Add-on dev-seam gate (T7):** `resolveActiveAddonManagerDeps()` (exported from
`apps/backend/src/modules/addons/manager.ts`) returns a lazily-built mock
`AddonManagerDeps` singleton under `shouldUseMocks()`, else the production
`activeDeps`. `resolveReconcilerDeps()` (exported from
`apps/backend/src/modules/addons/reconciler.ts`) mirrors the same pattern for the
post-boot reconciler. Both are the default-parameter values for their respective
public functions, so existing tests that pass deps explicitly are unaffected.

**Software-update + SSH dev mock seams (T8):**
- Production self-updates run through `software-update-process.ts` as a
  PID-1-owned transient service, never as a direct child of `ceralive.service`:
  the CeraUI package's own restart must not kill the `apt-get`/`dpkg` transaction.
  Progress comes from fixed, root-owned, no-follow mode-0600 append files under
  `/run/ceralive`, not `systemd-run --pipe` or a caller-owned scope, so the status
  parsers are not coupled to the backend process lifetime or file-read chunking.
  `RemainAfterExit` preserves the terminal result; boot verifies the exact unit id,
  transient fragment and effective `[Service]` append destinations, no-hook service
  posture, and canonical
  upgrade argv before reattaching. An
  unreadable probe fails closed before the periodic refresh and retries until it can
  resume that loop; concurrent recovery callers join one attempt. Fresh starts reject
  an existing unit and non-upgrade apt argv;
  observation errors retain independently-advanced cursors, final output must drain
  completely before cleanup (bounded exhaustion retains the unit for recovery), and
  cleanup failure is terminally visible rather than reported as success. Discovery
  is single-flight. Every apt call names `/usr/bin/apt-get` explicitly; refresh
  and read-only discovery are argv-only and locally bounded, while the detached
  install transaction remains deliberately unbounded.
- `simulateMockSoftwareUpdate()` (internal, called by `startSoftwareUpdate()` under
  `shouldUseMocks()`) broadcasts a realistic sequence of `{updating: SoftUpdateStatus}`
  frames — initial zero totals, then downloading/unpacking/setting-up counts, then
  completion — without spawning `apt-get`. The in-flight promise is accessible via
  `getMockSoftwareUpdatePromise()` for test awaiting.
- `setSoftwareUpdateRunner(runner)` (exported from `software-updates.ts`) replaces
  the default apt spawn with an injected function. Use in prod tests to assert the
  runner was called with the expected arguments without running a real update.
- `setSshServiceRunner(runner)` (exported from `ssh.ts`) replaces the default
  `systemctl start/stop ssh` spawn. The `shouldUseMocks()` branch in
  `startStopSsh()` flips `mockSshActive` and broadcasts `{ssh}` without touching
  `systemctl` or `passwd`.

**SIM PIN boot auto-unlock is another `isRealDevice()`-gated boot action.** `maybeAutoUnlockSimPins()` (`apps/backend/src/modules/modems/sim-autounlock.ts`, wired into `initModemUpdateLoop`) no-ops on a dev/emulated host. It submits the opt-in PIN — stored in the chmod-600 tmpfs file `/run/ceralive/sim-pin.secret` (`sim-secrets.ts`), never in `config.json` — at most once per locked modem, then clears the PIN and stops on any failure (no PUK-lockout loop). See `apps/backend/AGENTS.md` → SIM PIN AUTO-UNLOCK.

Override for tests: set `CERALIVE_DEVICE_TYPE=emulated` or `=real` in `beforeEach`/`afterEach` to pick the branch deterministically on any host.

