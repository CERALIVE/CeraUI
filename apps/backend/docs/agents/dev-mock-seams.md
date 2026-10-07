<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEV MOCK SEAMS [EXISTS]

These seams let tests and dev mode exercise real code paths without hardware. All
are gated by `shouldUseMocks()` or `isDevelopment()` — never active in production.

### Backend per-file test isolation

The backend `test` script runs `bun test --parallel`, adopted after five full
smoke runs and twenty consecutive clean acceptance runs on Bun 1.4.2. It
runs files across worker processes with per-file isolated globals; it does not
make tests within a file concurrent. Each file writing fixtures must own a
`mkdtemp` root and redirect the existing path seam, never use a fixed shared
path. `sim-autounlock.test.ts` uses `setConfigFilePath()` and absolute reads
instead of changing cwd. `usb-tether-fence.test.ts` scans a private source
snapshot: tracked plus new non-ignored working-tree files, not runtime state.
The transient `stream.armed.json` is ignored beside the other backend runtime
files. Source copy/read failures remain fatal; only snapshot teardown tolerates
`ENOENT`.

The initial 2026-09-07 adoption batches finished 19/20 and 18/20: both original
isolation repairs passed, but add-on helper, modem-transition and source-routing
tests exposed two more failure modes. The clock and child-command fixes below
then passed 20/20 at default 28-worker parallelism (6,033 passed tests and two
unchanged skips per run). No timeout was widened and no assertion was removed.

The transition-engine fixture controls `Date.now()` with `setSystemTime`:
USB enumeration cannot spend the NM-timeout case's budget through host scheduling
delay. Only the unresolved NM reader advances time, including the failure-path
re-probe; teardown restores the real clock. Production polling is unchanged.

The software-update scheduler fixture preserves its real `process.hrtime()`
origin when enabling fake timers, then advances that clock with the retry timer.
Bun resets fake hrtime to zero while the imported scheduler retains its deadline;
a file loaded after 60 seconds in a parallel worker otherwise never reaches its
skip runner. Teardown restores the clock spy and real timers; production is unchanged.

The add-on shell/GPG suite and historical source-routing Git guard use
`tests/helpers/run-test-command.ts`: asynchronous spawn, concurrent stdout/stderr
drains and exit observation, with scoped disposal. Bun 1.4.2's synchronous spawn
loop can lose poll accounting when GC finalizes main-loop resources during the
wait (oven-sh/bun#40078), stalling later children even after they exited.
The helper's regression reproduces that state in a disposable process; do not
replace real shell/GPG verification or Git history with mocks, or switch these
calls back to `spawnSync`. No test or production timeout was increased.

The historical source-routing Git guard requires a full checkout. At a depth-one
boundary Git reports the checkout commit as the file's addition; its parent is
unavailable, so `git diff <addition>^` exits 128. The guard checks exit status and
prints stderr rather than accepting an empty failed diff. Both Build Check's
`test-be` checkout and `publish-release.yml`'s `release-package-contracts` checkout
use `fetch-depth: 0`, enforced by `scripts/ci/build-check-shape.test.mjs`.
Twenty local passes are stability evidence, not a substitute for the complete
hosted PR gate. Readiness requires every check on the current hosted run to pass.

The optional-audio-codec start fixture also owns a `mkdtemp` config root through
`setConfigFilePath`, installed before mock initialization. It must not read or
restore a shared cwd `config.json`: a fresh checkout has none, and another file
creating it is not a test prerequisite. Teardown restores the path and removes
only this fixture's directory.

Witness fixtures also allocate under the test run's temporary root, outside the
source tree. Repository-wide source inventory must never race their short-lived
JSON files; the inventory still includes every new non-ignored source file.

Backend tests inject procedure launch/source dependencies through
`setStreamingProcedureDepsForTest()` and stream-start process/telemetry/engine
dependencies through `setStartStreamDepsForTest()`. Every test that overrides
either seam restores it in `afterEach`; do not replace these narrow seams with
`mock.module`, whose namespace mutation leaks across files in serial runs.

`bunfig.toml` registers `src/tests/test-preload.ts` as the backend test preload.
Its `modules/setup.ts` mock is therefore the sole intentional process-global
module mock. `stopWifiUpdateLoopForTest()` cancels every delayed Wi-Fi refresh
scheduled through `scheduleWifiUpdate()` and resets the unavailable-device retry
window. Tests that start that loop call the stop seam in `afterEach`.

The lifecycle-admission test reset remains `resetLifecycleInterlock()`. Any test
that acquires a streaming or modem-transition lease installs it in `afterEach`,
even when the test also releases its individual grant on the happy path.

### isDevelopment() power-gate (T1)

`isDevelopment()` (`mocks/mock-config.ts`: `NODE_ENV==="development" ||
MOCK_MODE==="true"`) gates all dev-only side-effects. The `system.poweroff` and
`system.reboot` handlers skip the real OS spawn when `isDevelopment()` is true.
The post-update reboot in `software-updates.ts` is gated via `rebootAfterUpdate()`.
DI runner seams (`setPowerCommandRunner`, `setRebootRunner`) let tests assert the
exact command without touching the host.

### simulateDevReboot (T2)

`simulateDevReboot()` (`rpc/events.ts`) reproduces the real-device reboot effect in
dev: snapshots `getAuthenticatedClients()` and closes each socket after a macrotask
delay (`setTimeout(..., 0)`). The delay lets the in-flight `system.reboot` reply
flush before the socket drops, matching the real-device sequence. Gated by
`isDevelopment()` — the early return means no production call site can schedule
socket teardown through this helper.

### Adapter diagnostics (T3)

`extractValidationDetails(error)` (`rpc/error-enrichment.ts`) turns an opaque
oRPC/Zod validation failure into `ValidationDetails`:
`{ phase: "input" | "output" | "unknown", issues: ValidationIssueDetail[] }`.
The WS adapter attaches the result as a `validation` field on the `RpcCallTrace`
log record. These adapter diagnostics surface which schema field failed and whether
it was an input or output validation error — visible at `LOG_LEVEL=debug`. Phase is
classified from the oRPC wrapper message then the error code. Issue paths are schema
field names (safe); messages are scrubbed through `logRedact`. Returns `undefined`
when the error has no issue list.

### The scenario is the `sources` truth — and deliberately NOT the switch-reachability truth

`main.ts` injects `getMockEngineDevices()` into the capability fold and the boot
`sources` seed. That is not sufficient, and the gap is silent: the readers that
REBUILD `sources` afterwards — `sources.ts` `refreshSourcesForHotplug` (fired by
the device registry's own device-SET change) and `recheckSourceSignals` (the 5 s
tick) — take DEFAULT deps, i.e. a cerastream control socket that cannot exist
under `MOCK_SCENARIO`. A failing probe then hands over to the registry's
observation, which in dev is the HOST's own `/sys/class/video4linux` + ALSA scan:
hardware the scenario says nothing about.

Measured on a dev host with no `/dev/video*`: the registry's first scan is empty
and correctly skipped as the initial scan; ~2 s later the host's ALSA cards land
in `getAudioSources()`, the device SET changes, and the hotplug refresh publishes
that observation — erasing every simulated capture device from `sources`. Because
`sources` is on-change only, the coarse-only list then stood for the life of the
process, and a page that authenticated afterwards got it in its post-login
snapshot. Nothing failed loudly.

Two seams carry the repair, and BOTH are scoped to the `sources` rebuild:

- `defaultFetchEngineDevices` (`capabilities.ts`) serves `getMockEngineDevices()`
  under `shouldUseMocks()`. Its only consumers are the capability service and the
  engine-device cache — the build path, never a gate.
- `observedForSourcesRebuild` (`sources.ts`) substitutes the scenario list for the
  registry's host observation in the two rebuild entry points above. The scenario's
  own hotplug seam is `setMockDeviceAttached`, so the scenario IS the observation.

**`defaultGetEngineDevices` (`devices.ts`) is deliberately NOT redirected.** The
registry's `scan()` is also `switchInput`'s reachability gate
(`deviceRegistry.switchInput` re-scans and answers `SOURCE_LOST` when the target
is absent), and picker-VISIBILITY and switch-REACHABILITY are allowed to diverge:
a scenario device is visible in the picker while still having no engine or v4l2
node behind it, and the honest answer to a live switch there is `SOURCE_LOST`.
Widening the registry too — the first attempt at this fix — erased that divergence
and broke `tests/e2e/input-picker.spec.ts`'s deliberate negative coverage. Do not
redo it; if a new reader needs the scenario, route it through
`observedForSourcesRebuild` or take injected deps.

Production is byte-unchanged (every gate requires `isDevelopment()` AND an
initialised mock state) and the imports are lazy, so the mock graph stays off
these modules' load paths. Coverage: `tests/mock-engine-devices-wiring.test.ts`,
whose second describe is the negative half (the registry must NOT adopt the
scenario, and a live switch to a scenario-visible device must still refuse before
commanding the engine).

### Scenario-seeded capability profiles (T5)

Three `MOCK_SCENARIO` values seed the engine-capability state:

| Scenario | Behaviour |
|----------|-----------|
| `caps-full` | Full engine profile: H265 + hw accel, audio-capable HDMI source, `audio_live_switch`, `transports: ["srtla","srt"]` |
| `engine-starting` | Mock fetcher throws with empty cache → minimal safe floor + `engineStarting: true` |
| `engine-unavailable` | Mock fetcher throws after seeding last-known-good → cached snapshot + `engineUnavailable: true` |

`setMockEngineCapabilities(partial)` (`mocks/providers/streaming.ts`) merges a
`Partial<ScenarioCapabilities>` onto the active scenario's profile and immediately
re-broadcasts the `capabilities` event. Gated by `shouldUseMocks()`. Use in tests
that need a specific capability combination without switching the full scenario.

### Bluetooth dev seam (`mocks/providers/bluetooth.ts`)

An in-memory BlueZ stand-in — adapter, discoverable roster, pair/trust state
machine, bounded TIMED scan window — so the whole surface is drivable with no
controller. It is a PARALLEL layer: `modules/bluetooth/` never imports it, and it
imports only that module's PURE halves (`deriveCapability`,
`buildBluetoothStatus`) so the mock's `deviceClass` / `scoCapable` / `transport`
and its whole wire payload come from the production derivations rather than from
a second, driftable copy. Its refusals are the shared
`bluetoothMutationRefusalSchema` set, in `bluetooth.procedure.ts`'s own gate
order. `setMockBtScenario(partial)` / `setMockBtAgentRegistered(bool)` are the
override seams; `resetMockBluetoothState()` is wired into `resetMockState()` and
drops every scan timer. Full contract: [`../../AGENTS.md`](../../../../AGENTS.md) →
MOCK SUBSYSTEM.

### Kiosk dev-seam gate (T6)

`resolveActiveKioskDeps()` (`modules/system/kiosk.ts`) returns the mock kiosk
harness under `shouldUseMocks()`, else the production `activeDeps`. The kiosk RPC
handlers call `kioskStart(resolveActiveKioskDeps())` etc. so dev exercises the full
state machine against in-memory fakes without touching `systemctl`. The gate in
`system.procedure.ts` was widened to `if (!shouldUseMocks() && !(await
isRealDevice())) return UNAVAILABLE` so dev bypasses the emulated-mode guard.
`peekMockKioskHarness()` returns the singleton without building it — use in prod
tests to assert the mock double was never constructed.

### Add-on dev-seam gate (T7)

`resolveActiveAddonManagerDeps()` (`modules/addons/manager.ts`) returns a
lazily-built mock `AddonManagerDeps` singleton under `shouldUseMocks()`, else the
production `activeDeps`. `resolveReconcilerDeps()` (`modules/addons/reconciler.ts`)
mirrors the same pattern for the post-boot reconciler. Both are the default-parameter
values for their respective public functions, so existing tests that pass deps
explicitly are unaffected.

### Software-update + SSH dev mock seams (T8)

- `simulateMockSoftwareUpdate()` (internal, called by `startSoftwareUpdate()` under
  `shouldUseMocks()`) broadcasts a realistic sequence of `{updating: SoftUpdateStatus}`
  frames without spawning `apt-get`. The in-flight promise is accessible via
  `getMockSoftwareUpdatePromise()` for test awaiting.
- `setSoftwareUpdateRunner(runner)` (`modules/system/software-updates.ts`) replaces
  the default apt spawn with an injected function. Use in prod tests to assert the
  runner was called without running a real update.
- `setSshServiceRunner(runner)` (`modules/system/ssh.ts`) replaces the default
  `systemctl start/stop ssh` spawn. The `shouldUseMocks()` branch in `startStopSsh()`
  flips `mockSshActive` and broadcasts `{ssh}` without touching `systemctl` or `passwd`.
  On device, `ceralive` is the default SSH account when `setup.json` has no override;
  start, stop, and reset RPC responses settle only after the privileged action completes.
- `setSshPersistenceRunner(runner)` is its SIBLING for the `enable`/`disable` verb
  (see SSH BOOT PERSISTENCE below). Keeping the two seams apart is what lets a
  test prove a persistence change provably never touched the running service.
- `MessageSocket` (`modules/ui/message-socket.ts`) is exactly
  `{ readonly data?: { readonly senderId?: string }; send(message: string): void }`;
  SSH, log, and notification producers accept Bun `AppWebSocket` structurally
  without casts.
- Kiosk start/stop RPCs likewise await the cog-display add-on lifecycle before reporting
  their applied status. Background status refresh and software-update scheduling remain
  deliberately asynchronous because their responses acknowledge a refresh/scheduled job,
  not completion.

### SSH BOOT PERSISTENCE IS A SECOND AXIS, NOT A SIDE EFFECT [EXISTS]

`startStopSsh` runs `systemctl start|stop ssh` and NOTHING else, so the operator
could turn SSH on and the device would still come up without it. Measured on the
bench board: `systemctl is-active ssh` answered `active` — the dialog said
"Active", the operator was logged in over it — while `systemctl is-enabled ssh`
answered `disabled`. Every reboot silently dropped remote access until somebody
re-enabled it over UART, and nothing on any surface said so. That cost a
multi-hour board-access outage.

`setSshPersistent(enabled)` (`modules/system/ssh.ts`) is the second axis, and the
two are DELIBERATELY NOT FUSED — an operator must still be able to run SSH for one
session without committing it to boot. Six rules carry it:

- **`--now` is ABSENT and must stay absent.** The runner spawns exactly
  `systemctl enable|disable ssh`, so the running service is untouched in BOTH
  directions: arming for boot never starts sshd, and un-arming never kills the
  operator's live session. It is a one-word edit away and invisible to every seam
  spy, so `tests/ssh-persistence.test.ts` greps the module's executable lines for
  it (comments stripped, so this prose may name it freely).
- **Its DI seam is a SIBLING, never an overload** —
  `setSshPersistenceRunner`/`resetSshPersistenceRunner`, mirroring
  `setSshServiceRunner`'s shape. `enable`/`disable` are different verbs from
  `start`/`stop`, and separate seams are what let a test assert that each path
  provably never fired the other's.
- **`status.ssh.enabled` is REQUIRED on the wire and EXPLICIT on every status
  object**, never omitted-when-false. The consumer status merge preserves an
  omitted optional field, so a present-only-when-true flag could be raised and
  never lowered — the `policy_route_missing` latch, exactly.
- **`parseSystemctlIsEnabled` accepts the exact word `enabled` and nothing else**,
  parsed as defensively as `parseSystemctlIsActive`: a non-zero exit is swallowed
  and the word read off `err.stdout`, and an unreadable probe is not-enabled
  rather than a throw. `enabled-runtime` is the sharpest rejection — its symlink
  lives in `/run` and is wiped on reboot, so treating it as enabled would restate
  the very bug this field exists to surface. `static`/`indirect`/`generated`/
  `masked`/`linked` likewise mean "no `[Install]` symlink".
- **The probe rides `getSshStatus`'s existing `Promise.all`** beside the
  active/hash probes, and `enabled` joins the broadcast change key — so a boot
  arming that changes with nothing else re-broadcasts exactly once.
- **The outcome is DEVICE-CONFIRMED.** `setSshPersistent` returns whether the
  re-probe agrees, so a runner that resolved against a unit that did not take is
  reported as a failure rather than a silent success.

The RPC is `system.sshSetPersistent` (`.strict()` input, same `authedProcedure` +
streaming/updating gate as its sibling SSH mutations). Operator surface and its
pessimistic-toggle contract: [`../frontend/AGENTS.md`](../../../frontend/AGENTS.md) →
SSH PERSISTENCE IS A SECOND, INDEPENDENT CONTROL.

Coverage: `tests/ssh-persistence.test.ts` — the verb table with its
never-start/stop and never-enable/disable proofs in BOTH directions, the
device-confirmed outcome, the dev no-spawn seam, the `is-enabled` reading matrix
(incl. `enabled-runtime`), the explicit-in-both-directions wire assertion, the
non-zero-exit and unreadable-probe paths, the enabled-alone re-broadcast, and the
`--now` source gate. Rule-E proof in three directions: adding `--now` reddens 1,
fusing the axes onto the service runner reddens 5, and making `enabled`
omitted-when-false reddens 6.

### SSH password sync on boot — OTA slot-swap fix [EXISTS]

`ensureSshPasswordSynced()` (`modules/system/ssh.ts`, wired into `main.ts` via
`guardNonCritical("ssh-password-sync", …)` immediately before the boot
`getSshStatus()` probe) fixes an operator lockout confirmed on real Rock 5B+
hardware: an OTA A/B slot swap silently invalidated SSH login. `config.json`
(`ssh_pass` + `ssh_pass_hash`) is `/data`-persisted and survives the swap, but the
OS-level `/etc/shadow` entry is **rootfs-local** — baked fresh into each image and
NOT carried across slots — so a freshly-activated slot holds the build-time
password while config.json still remembers the operator's real one. Nothing
re-applied it, so the operator had to click "Reset SSH Password" after every single
OTA.

The sync mirrors image-building-pipeline's
`ceralive-ssh-firstboot.sh::ensure_host_keys()` restore pattern for host keys:
compare the persisted `ssh_pass_hash` (cached via `getSshPasswordHash()`) against
the live `/etc/shadow` hash (`probeSshUserHash`), and on a mismatch RE-APPLY (never
regenerate) the EXISTING persisted `ssh_pass` through the same stdin-only
`runWithStdin("passwd", …)` path `resetSshPassword()` uses. It is additive and does
NOT touch `resetSshPassword()` (still generates a fresh secret on explicit reset)
or `startStopSsh()`'s "generate when `ssh_pass` is undefined" branch. Contract:
never throws (BOOT FAIL-SOFT); a clean no-op under `shouldUseMocks()`, when
`ssh_pass` is undefined (nothing persisted yet), or when the OS already matches (the
common same-slot boot). It NEVER generates a new password and NEVER calls
`saveConfig()` — the credential is unchanged, only the OS shadow entry catches up.
Effectful surface (`readShadow` / `applyPassword`) is injected via
`SshPasswordSyncDeps` (mirrors `SshStatusDeps`) so `tests/ssh-password-sync.test.ts`
drives it without a real `passwd`/`/etc/shadow`.

### SSH password provisioning on first boot [EXISTS]

`ensureSshPasswordProvisioned()` (`modules/system/ssh.ts`, wired into `main.ts` via
`guardNonCritical("ssh-password-provision", …)` immediately BEFORE the
`ssh-password-sync` step) mints an INITIAL `ssh_pass` on a device that has never
had one. SSH is enabled-by-default at the OS/systemd level, but CeraUI only ever
generated a password on an explicit operator "Start SSH" / "Reset" action — so a
fresh device ran `sshd` with `ssh_pass` permanently `undefined` and the account
effectively unreachable until a manual reset. Provisioning closes that gap: when NO
`ssh_pass` is persisted it mints one through the SAME credential path the operator
reset uses.

The generation is shared between the operator reset and boot provisioning by the
single private `mintAndApplySshPassword()` helper (random `ssh_pass` → stdin-only
`passwd` apply → persist → re-probe hash → broadcast config + status), so both
routes emit and persist the secret through EXACTLY the same code — never logged.
`resetSshPassword()` wraps it with an operator notification on failure;
`ensureSshPasswordProvisioned()` wraps it with a boot broadcast. It is called
UNCONDITIONALLY at boot (independent of the `ssh.service` active/enabled state), so
even a production device shipping with SSH disabled-by-default has a ready
credential the instant SSH is enabled from the UI. Contract: never throws (BOOT
FAIL-SOFT); a clean no-op under `shouldUseMocks()` or when a password is ALREADY
persisted — it NEVER regenerates an existing credential (that stays
`ensureSshPasswordSynced()`'s restore-only job). Effectful surface (`readShadow` /
`applyPassword` / `persist` / `refreshStatus`) is injected via
`SshPasswordProvisionDeps` so `tests/ssh-password-provision.test.ts` drives it
without a real `passwd`/`/etc/shadow` (and without persisting to disk).
