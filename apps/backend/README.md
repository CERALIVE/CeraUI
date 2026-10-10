# CeraUI Backend

Bun/TypeScript HTTP + WebSocket server for CeraLive streaming hardware. Serves the frontend static bundle and exposes all device control via oRPC over WebSocket.

## Overview

The backend is a single compiled binary (`ceralive`) produced by `bun build --compile`. It drives the `cerastream` Rust streaming engine — the sole engine (ceracoder retired 2026-06-11) — over JSON-RPC on a Unix domain socket via the `@ceralive/cerastream` npm package, and supervises `srtla_send` as a separate process (streamloop) through the private workspace package `@ceraui/srtla-send` (`packages/srtla-send`, `workspace:*`). Only `@ceralive/cerastream` is a public-npm registry dep (`@ceralive` scope).

**Stack**: Bun, TypeScript, oRPC (`@orpc/server`), Zod, WebSocket RPC  
**Shared contract**: `@ceraui/rpc` (workspace package at `packages/rpc/`)  
**Engine/bindings**: `@ceralive/cerastream` (public-npm registry dep — JSON-RPC/UDS client), `@ceraui/srtla-send` (private workspace package at `packages/srtla-send/`)

### Modem-control compatibility

The backend pins `@ceralive/modem-control` at `1.3.0` EXACTLY. The SMS port, the
usage-policy setter and the band certification catalog are static imports: while
the pin was the published `0.2.0` floor each was resolved through a lazy
`import()` and a structural probe, because its API had landed in modem-stack
after the pinned release and a static import would have failed the build rather
than degrading. With an exact pin that question is settled by `tsc` and by
`bun install`.

`modems.getSms` follows the committed `modem_backend`: `dbus` uses the
package's read-only `createDbusSmsPort` with one inbox store per modem and MM
owner epoch; `mmcli` retains the shipped list/read implementation as the explicit
rollback. An owner-epoch change stops old subscriptions before resolving the
same `ID_PATH` on the new roster and rebuilding its immutable-path port, so MM
renumbering cannot leave a stale path subscribed. USSD remains on mmcli.

Fourteen frozen projection modules still consume additive pure modem logic
through `src/modules/modem-control-compat.ts`, which is a static namespace import
rather than a probe. It is permanent: two of its names are exported by no release,
so the local implementations behind it are the implementation, not a fallback.
The package-owned `MODEM_OPERATION_IDS` registry is held to set equality with
CeraUI's disposition manifest by the unskipped frontend tier-2 drift gate.

A fifteenth compatibility consumer lives in `modems/usb-mode-runtime.ts`.
Version 1.3.0 supplies its read-only `resolveRuntimeCompositionCapability`
candidate; a boundary test proves the package function is selected and remains
structurally and behaviorally identical to CeraUI's local fallback. The package's
write-side composition registry is intentionally not consumed by this bump.

Modem-stack mutation operations receive CeraUI's existing stream-coupled admission
policy through `src/modules/modems/mutation-admission-port.ts`; transport/session
ownership and the device wire contract remain in CeraUI. The committed pin and
boundary gate is `src/tests/modem-control-projections.test.ts`.

USB composition transitions treat the modem's physical reappearance and its
NetworkManager readiness as separate events. After re-enumeration, the backend
boundedly resolves the transaction's NM connection id to its replacement interface
before returning the target snapshot to the transition engine. If that interface
never appears, the transaction fails and its journal records the failure rather than
claiming success. Shipping-modem catalog admission remains evidence-gated; the
RM530N-GL entry is deferred to the hardware-validation Todo 42.

## Structure

```
src/
├── main.ts                  # Entry point
├── modules/                 # Domain logic (no RPC awareness)
│   ├── streaming/           # cerastream JSON-RPC client + srtla supervision (streamloop)
│   ├── modems/              # mmcli integration
│   ├── network/             # Network interfaces, gateways
│   ├── wifi/                # WiFi scan, connect, disconnect
│   ├── system/              # Sensors, system info
│   ├── ui/                  # HTTP + WebSocket servers, auth
│   ├── ingest/              # Ingest config
│   ├── remote/              # Cloud remote relay
│   ├── config.ts            # Config read/write
│   └── setup.ts             # First-run setup
├── rpc/                     # oRPC layer
│   ├── router.ts            # Procedure router
│   ├── procedures/          # <domain>.procedure.ts files
│   ├── middleware/          # Auth middleware
│   └── events.ts            # Typed broadcast events
├── helpers/                 # Pure utilities
├── mocks/                   # MOCK_SCENARIO providers
└── tests/                   # bun:test suites
```

## Development

### Prerequisites

[Bun](https://bun.sh/docs/installation) v1.3.0 or newer. Install dependencies from the workspace root:

```bash
bun install
```

### Run in development

From the workspace root, `bun run dev` starts both frontend and backend together via mprocs. To run the backend alone:

```bash
bun run dev
```

Mock hardware scenarios are available via `MOCK_SCENARIO`:

| Command | Scenario |
|---------|----------|
| `bun run dev` | `multi-modem-wifi` (default) |
| `bun run dev:single-modem` | Single modem, no WiFi |
| `bun run dev:streaming` | Active streaming simulation |
| `bun run dev:modem-pin-locked` | 2 modems, modem 0 SIM PIN-locked (fixture PIN `0000`) |
| `bun run dev:bt-mic-paired` | Bluetooth on with an HFP mic already paired, trusted and connected |

Bluetooth microphone source identity remains `bt:<upper-case underscored MAC>`.
The backend detects BlueALSA versus PipeWire Bluetooth packages before governing
services or enumerating microphones. PipeWire images govern only
`bluetooth.service`; BlueALSA images additionally govern `bluealsa.service` and
its drop-in. The selected engine audio backend must agree with that provider.
PipeWire then requires the engine's `pipewire-capture` feature and an
address-matched `list-devices` node; BlueALSA retains its capture-PCM oracle.

### Type-check

```bash
bun run check
```

### Tests

```bash
bun run test
```

The package's `test` script runs `bun test --parallel` on Bun 1.4.2, adopted
after five smoke runs and twenty consecutive clean full-suite runs. Files run
in isolated worker globals across worker processes, but filesystem paths are still shared. Tests that
persist fixtures must use per-file `mkdtemp` roots and the existing path setters
(runtime config: `setConfigFilePath`). The USB-tether source fence scans its own
temporary snapshot of tracked and new non-ignored source, excluding runtime
markers; missing source remains an error. The modem-transition fixture controls
its polling clock. Real add-on/GPG and source-routing Git checks use an async
test-command helper to avoid Bun 1.4.2's GC-sensitive synchronous-loop defect
(oven-sh/bun#40078), retaining real child execution and all existing assertions.
See `AGENTS.md` → Backend per-file test isolation for these contracts.

Run the complete suite from a full Git checkout. The historical source-routing
guard needs the commit that introduced `sources.ts` and its parent, so a shallow
clone cannot run that assertion. Build Check's backend job and the release/package
contract job both fetch full history; Git failures remain test failures, never an
empty diff. Local stability runs do not establish PR readiness: every hosted check
on the current PR revision must succeed before the change is handed off.

Redacted, hardware-derived modem diagnosis inputs live in
[`src/tests/fixtures/modems/`](src/tests/fixtures/modems/README.md). Their README
records the installed/candidate versions, per-port timing, separately observed
MM details, and unexercised portal-credential cases. These are observations for
regression tests, not a device-support certification.

OS-stage command receipts live in [`src/tests/fixtures/real-device/`](src/tests/fixtures/real-device/README.md).
Systemd 257 omits empty exec-list properties: guardian ownership permits missing
`ExecStartPre`, `ExecStartPost`, `ExecStop` and `ExecStopPost` only. A present
nonempty hook, duplicate property, changed identity or noncanonical ExecStart
is still refused. Guardian, orphan and RAUC observation share the orphan lane's
strict key parser. Real idle-board fixtures prove output parsing, not successful
staging, resource retirement or lock release on hardware; those need the re-drill.
The isolated Rock guardian receipts additionally cover loaded failed and active
exited units through the existing ownership and orphan parsers, with explicit
test-only identity aliases. They are not product-unit recovery qualification.
Every never-launched runner failure now uses the shared private/kernel/client/
outcome/pin settlement proof before releasing the guardian. Successful proof
preserves typed cancellation/admission reasons; failed or thrown proof stays
unsafe with its cause retained. Kernel lock rows correlate filesystem device
and inode through validated fd/mount metadata. Helper-child churn is rescanned
within a fixed budget; persistent unexpected membership refuses. Exit-75 cleanup
retires provenance only after checked stop/reset replies and positive absence.
Further read-only Rock receipts exercise the transport selector's real DNS and
curl marker framing, failed versus empty route-table reads, and idle RAUC
observation. Their coverage matrix states the live-install branches still owed.

The second isolated Rock receipt ran the capture-base product helper with historical
test-directory overrides. The shipped helper now has fixed root-owned paths;
guardian tests use a generated copy differing only in two constants, while singleton
tests execute the unmodified shipped helper's independent observer mode. Historical
environment names in the receipt are inert capture aliases documented in its README.
Individual flock/bash/sleep cmdlines and inherited fds,
whole kernel lock tables, exact combined observation replies and a live
ACK-pending window now feed production parser tests. Starting-before-ready,
transient stat children and different-filesystem/same-inode golden coverage were
attempted but not captured; live-install resource branches remain owed. See the
fixture README for normalization and scope. The replay adapter derives the
kernel device from the captured lock fdinfo and mountinfo before supplying
device-plus-inode inputs to the guard parser; no capture or assertion is changed.

## Build

The backend compiles to a single self-contained binary. Architecture is controlled by `BUILD_ARCH`:

```bash
BUILD_ARCH=arm64 bun run build   # ARM64 (default)
BUILD_ARCH=amd64 bun run build   # AMD64
```

The full `.deb` package (backend binary + frontend static) is built from the workspace root:

```bash
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
```

See [`docs/BUILD_PIPELINE.md`](../../docs/BUILD_PIPELINE.md) for the full build and CI reference.

That package upgrades itself on the device, so its maintainer scripts carry two rules
worth knowing before editing them. `prerm` stops and disables `ceralive.service` only
when it is invoked for a real `remove` — dpkg runs the OLD `prerm` before unpacking a
new package, so doing it unconditionally left a self-updated device with no control
plane. And `postinst` re-enables the unit unconditionally with `systemctl enable`,
because `deb-systemd-helper enable` is a silent no-op once its own installation state
exists and therefore cannot repair a unit the old `prerm` disabled. Both are pinned by
`scripts/build/deb-maintainer-scripts.test.sh`, run from
`scripts/build/release-package-contracts.sh`.

## RPC Architecture

Singleton acquisition reads kernel status real/effective UID before exact argv,
executable identity and the held-fd grant. A running deleted-flock wrapper still
counts across a package upgrade; other granted executable identities fail unproven.
Restricted-proc reads follow an explicit fail-closed policy. The path monitor's
2 s cadence is not a termination deadline, and separate proc reads have no
pidfd/start-time fence. Full contract: [singleton recovery](../../docs/UPDATE-RECOVERY.md).

Update startup awaits the retained physical-reconciliation completion off the
control-server boot path. One startup flight retries transient acquisition and
durability failures six times, with 250/500/1000/2000/4000 ms waits; transient
exhaustion keeps the retryable mutation gate closed while one unreferenced timer
retries every 30 seconds until success. Operator calls do not rearm it.
Authoritative safety refusals and invalid recovery metadata remain closed without
automatic repair. See [startup recovery](../../docs/UPDATE-RECOVERY.md).

One detached bootstrap orders orchestrator adjudication before standalone APT
recovery and periodic checks, without blocking unrelated boot work. Transient
exhaustion parks the handoff until a later startup succeeds; invalid metadata or
terminal safety refusal skips legacy cleanup so it cannot consume plan evidence.
It logs an error and flags `update-orchestrator-maintenance` on `/api/health`, but
does not observe an untracked unit or initialize the bootstrap's hourly refresh.
Stream-stop/coordinator callers may still resume discovery, and legacy Check/Install
RPCs remain callable. Preserve unit/state evidence and arrange local repair before
restarting; a wider legacy admission gate remains an OWNER DECISION in the recovery
contract, not behavior this bootstrap enforces.

Recovered tracked commits and downloads use an explicit persist-before-exit handshake, not
microtask ordering. Both already-finished and initially-running units await valid
startup and authoritative durable success under CONTROL before deliberate exit.
A failure withholds exit and leaves the process alive/degraded; standalone unit
recovery keeps its legacy restart/reboot behavior. Host proofs do not qualify
systemd restart or power loss on a board.

Owned package wire `success` is published before restart permission is checked;
it does not prove the new backend is running. If success persistence fails, new
packages remain installed with the old backend alive. The error log and latched
`update-orchestrator-maintenance` health flag report this maintenance condition.
An explicit pending-success fence blocks new scheduler/discovery/install/OS-stage/
mirror/cleanup/stale-restart submissions and legacy callers while the existing tick
retries authoritative success under CONTROL. Admitted legacy continuations recheck
at shared command/preflight ports and the post-read channel-write boundary; their
refusal releases in-flight latches. Already-submitted effects are not cancelled.
Manual readiness requires validated startup and independent OS/package durability;
D8 rechecks pending success after publishing recovery and around its awaited
probe/stop boundaries. A pending package tick services the independent snapshot
and intent/witness recovery owners before its package retry; startup-tail snapshot
failure and package completion are host-tested in both observation orders without
opening unfinished startup or discarding the original withheld exit.
A renamed-but-unacknowledged success must be re-persisted; readable equality alone
cannot clear the fence. Five consecutive disk mismatches, or an unrelated persisted
phase, escalate to local maintenance once per completion, with same-signature retry
logs limited to once per minute. Durable success clears the fence
and restores normal restart authority; no operator clear API is added.
Repair storage/ownership while alive and preserve agent/plan/unit/output evidence.
Avoid Check as well as Install: an accepted legacy Check clears `lastUpdateSucceeded`
outside the pending fence, so wire success is not immutable maintenance evidence.
Terminal startup refusal alone still leaves legacy RPC/periodic callers active.
Restart only after a positive safe baseline; an early restart or power loss can
lose consumed outcome evidence. See the owner-decision inventory in the recovery
contract above.

Interrupted OS settlement, generic confirmation and legacy migration preserve
exact-snapshot durability intent after I/O failure. The tick replays it under
CONTROL without repeating the event or failed-round count; manual mutations are
retryably closed meanwhile, and authoritative disk drift remains fail-closed.

Initial OS-attempt publication is inside its cleanup lifetime. A pre-effect write
failure restores the pre-state, clears the attempt token, and durably rolls back
even a renamed staging record; pending rollback uses the same snapshot replay.
The strict private `os-attempt-intent.json` additionally makes that authority
restart-recoverable: `publishing` precedes agent publication, and `launching`
precedes producer creation under CONTROL. Only exact publishing authority plus
fresh physical no-producer proof restores the baseline without a round or unsafe
notice. Launching/missing-intent staging retains existing uncertainty policy.
Invalid authority is preserved with mutations closed.
D8 also preserves unreadable intent/job authority and returns the existing
retryable initializing refusal when recovery or guardian observation cannot
establish evidence. Only a valid matching launched job permits its existing
producer cancellation; repaired evidence is re-probed on a retried start.
The `os-attempt-intent-stream-{evidence,producer}.test.ts` suites exercise actual
session admission and the real adapter over disposable loopback WebSockets.
Valid stale launching authority over an absent/superseding attempt is retired
under fresh CONTROL-protected ownership absence, never restored. Retirement
failures are logged and retain a separate cleanup-pending admission latch without
replacing the stage outcome or escaping its tick; repair includes parent fsync
even when unlink already succeeded. Snapshot persistence remains independent.
See the
[intent recovery table](../../docs/UPDATE-RECOVERY.md#durable-os-attempt-intent-partial--host-crash-point-proof-board-power-loss-proof-owed).

Persisted `checking` is an interrupted discovery, not a live transaction. Startup
returns it to idle with both discovery clocks due while retaining all history and
recovery metadata. All other phases keep their existing owners; see the complete
[restart table](../../docs/UPDATE-STARTUP-PHASES.md).

All device control goes through oRPC over WebSocket. There are no HTTP REST endpoints for device state.

### Procedures

Dongle login submission verifies before saving to the existing mode-0600 atomic
credential store. Failed submissions and failed re-verification preserve any
previously saved credential; forgetting cancels pending verification as well.
The RPC distinguishes portal unreachability from rejected authentication without
returning a password. See [`CONFIG_PERSISTENCE.md`](../../docs/CONFIG_PERSISTENCE.md)
for the at-rest mechanism and the still-unsupported ZTE/UFI operator-login paths.

Procedures live in `src/rpc/procedures/<domain>.procedure.ts` and are wired into `src/rpc/router.ts`. The shared schema types and validation constants are defined in `@ceraui/rpc` (`packages/rpc/`) and consumed by both the backend and frontend.

Key streaming procedures:

| Procedure | Purpose |
|-----------|---------|
| `streaming.start(config)` | Overlay optional fields on saved stream config, then validate and admit one lifecycle attempt; concurrent/cancelled admission resolves as typed `busy`/`cancelled` plus `attemptId` |
| `streaming.stop()` | Cancel/stop the active lifecycle generation and return a typed stop result |
| `streaming.setConfig(fields)` | Persist config fields without starting the stream |
| `streaming.setBitrate({ max_br })` | Hot-adjust bitrate while streaming |
| `streaming.getPipelines()` | List available GStreamer pipelines |
| `streaming.getAudioCodecs()` | List available audio codecs |
| `streaming.getConfig()` | Return current config snapshot |

All setters return `{ success: boolean, applied: <fields> }`. The `applied` object reflects post-validation values actually written to config. Clients must lock their UI to `applied`, not to the raw input.

`network.configure` follows the same rule for bond toggles: it reads the
post-mutation `netif` projection back and returns that result, never the requested
boolean. Duplicate-IP links use one eligibility predicate for both the displayed
Included/Excluded state and SRTLA IP-list/bind-map admission. A link with a valid
physical bind row can be included; one that cannot be mapped is refused with
`bond_unmappable`. Operator exclusions persist in `config.json` under canonical
physical link IDs, so they survive backend restarts and interface renames.

`streaming.start` accepts a partial config. An empty `{}` starts from the complete
persisted stream configuration; defined fields override only their saved counterparts.
A manual address/port switches away from both saved managed-relay fields, while a
managed relay server switches away from the saved manual address/port. An omitted
audio codec remains omitted and uses cerastream's engine default; only an explicitly
stated codec is registry-validated.
The merge occurs in the shared streamloop update seam, so UI starts and control-channel
reconnects have the same semantics.

All start origins share `stream-session-orchestrator.ts`; UI, autostart, remote
control, and set-profile cannot launch parallel engine sessions. The backend
publishes additive `status.stream_lifecycle` transitions and keeps legacy
`is_streaming=false` until the engine confirms the stream. Boot/reconnect
reconciliation adopts a stream that survived a backend process restart. A timeout,
query error, or contradictory engine status stays `reconciling`; the reconnect-heal
path retries instead of publishing a false idle state.

Stop uses a fresh, short-lived cerastream control connection. The engine processes
one request at a time per connection, so sending stop on the session connection and
then closing it can discard an unread stop behind another RPC. The backend dispatches
stop independently, closes the old session client to interrupt pending local work,
and signals completion only after the engine replies with its idle state. The
connect-plus-acknowledgement request is bounded at 6.5 seconds, leaving 5 seconds
for cleanup and a 0.5-second scheduling margin inside the unchanged 12-second
lifecycle bound. A connection resolving after the request deadline is closed
before it can dispatch. If an already-dispatched request misses acknowledgement,
its outcome is unknown and the lifecycle reconciles engine truth after
`stop_failed`.

### Cellular activation

Cellular status polling is observation-only. NetworkManager owns automatic GSM
activation and its retry budget; a refused APN no longer causes CeraUI to issue
another explicit activation every 30 seconds. Profile creation and operator
configuration remain unchanged, and status still reports the modem's live state.

### Software update admission

On images declaring `apt-all-packages`, APT discovery simulates an upgrade,
refuses removal plans or held first-party packages, and admits only candidates
from the permitted Debian Trixie suites or apt.ceralive.tv. Commit installs the
discovered packages by exact version inside one detached flock-protected service;
the backend can restart without releasing the lock. Stable APT sources remain
enabled when beta is selected. Older images keep the original 15-name path.
No capable device image has been released. The candidate-origin fix was
bench-tested with the capability enabled on a Rock 5B+: it identified and
installed `ceralive-apt-credentials` 1.0.0→1.0.1 through authenticated update
RPCs. On 2026-09-28 the Rock 5B+ completed apt at 18:06:04Z, yet the backend
still reported `installing` / `committing` 84+ minutes later until a restart.
The detached-unit identity checker rejected systemd's real flock-wrapped
`ExecStart` rendering (`flock wrapper does not match`), repeatedly blocking
observation of the successful exit. The repaired identity check was exercised on
both benches; both installs then reached the next bug: the backend exited before
the orchestrator persisted `COMMIT_SUCCEEDED`, and resumed to sticky
`failed / commit_unit_absent_on_resume` with the pending plan intact. The capable,
orchestrator-owned path now persists `restarting-services` before its deliberate
exit; legacy images retain their old restart/reboot behaviour, and a genuinely
uncertain commit still fails closed. The new build has not yet been board-proven.
See [`DEVICE-UPDATES.md`](../../docs/DEVICE-UPDATES.md).

Candidate provenance joins two APT readings: `apt-cache policy <name>` supplies
the version's package-file line, while one unscoped `apt-cache policy` reading
supplies that complete line's Release Origin/Label and suite for the whole batch.
Missing or conflicting metadata leaves the package informational. The test
fixture captures both command forms from the Rock 5B+ on 2026-09-27.

The separate packaged `/usr/sbin/ceralive-update-recover` is a root-only local
maintenance tool for one cross-slot failed reason. It requires the backend to
be inactive and effectively masked, reads exact expected current-slot evidence,
and durably archives the old plan before a narrow failed-to-idle transition.
It has no RPC/remote/sudoers entry. Its injected-probe decision tree is tested
without root; real systemd/APT board proof is still owed. See
[`UPDATE-RECOVERY.md`](../../docs/UPDATE-RECOVERY.md).

`startSoftwareUpdate()` acknowledges dispatch synchronously. Its asynchronous
update-check continuation clears cached downloads and checks space before stamping
planned shutdown, immediately before the detached package transaction launches.
A refused preflight leaves the armed-stream marker unchanged and clears the
update overlay with a typed reason. The 256 MiB reserve is an engineering margin
for transient unpack overhead, not a guarantee against running out of space.
After the transaction settles, direct bounded cache cleanup is best-effort;
failure adds a warning to success without changing the transaction verdict.

### Broadcast Events

The `encoder-load` collector derives MPP core count from procfs and adds
per-block raw load/utilization plus bound-session ownership. RGA scheduler load
is read independently; quantities its driver does not publish remain unknown.
Legacy percentage/clock-active/unavailable readings remain compatible. See
[`Encoder-load contract`](../../docs/ENCODER-LOAD.md) for exact fields,
source-derived fixtures, and the clock fallback's retirement condition.

The backend pushes typed events to all connected clients via `src/rpc/events.ts`. Each event type carries a monotonic `seq` counter that resets on server restart.

| Event | Interval | Source |
|-------|----------|--------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
| `uplinks` | 5 s / on change | `modules/network/uplink-health/` |
| `uplink-steering` | on change + post-login snapshot | Persistent steering availability/refusal state |
| `uplink-shaper` | 5 s / lifecycle edge + post-login snapshot | Priority mode, realized CAKE/HTB algorithm, or honest degraded state |
| `uplink-flows-reset` | hard-down only | Transient `{iface, linkId}` conntrack-reset notice |
| `sensors` | 1 s | `modules/system/sensors.ts` |
| `gateways` | 2 s | `modules/network/gateways.ts` |
| `modems` | 30 s | `modules/modems/modem-update-loop.ts` |
| `status` | on-change | Streaming state transitions |
| `config` | on-change | `setConfig` / `start` / `stop` |
| `wifi` | on-change | WiFi scan / connect / disconnect |
| `relays` | on-change | Relay list mutations |
| `ping` | 5 s | Heartbeat (frontend reconnects after ~15 s silence) |

After a client authenticates, the backend immediately pushes a full snapshot of every event type. Clients don't need to wait for the first periodic tick to render.

See [`docs/RPC_COMMUNICATION.md`](../../docs/RPC_COMMUNICATION.md) for the full wire-protocol reference.

### Shared-client uplink steering

`modules/network/uplink-steering/` owns `inet ceralive_share`, stable namespaced
flow marks, per-uplink policy-route support, and the single-flight reconcile loop.
Only packets entering a registered hotspot/shared-LAN zone are eligible; local
traffic and foreign nftables tables are structurally outside the generated rules.
Hard-down removes new-flow selection before a mark-scoped conntrack flush and
route teardown. Full design, failure behavior, deployment dependency, and netns
coverage: [`docs/UPLINK_STEERING.md`](../../docs/UPLINK_STEERING.md).

### Streaming-first uplink shaping

`modules/network/uplink-shaper/` consumes steering's shared-uplink set and installs
a two-band priority hierarchy while streaming. Local traffic remains uncapped;
only `CLIENT_FLOW`-marked client traffic reaches the adaptive CAKE/HTB ceiling.
Ownership, AIMD behavior, failure reporting, and real netns classification proof:
[`docs/UPLINK_SHAPING.md`](../../docs/UPLINK_SHAPING.md).

## Conventions

Confirmed generic family success survives a joined sibling observation exception.
An unsuccessful unbound observation exception stays UNKNOWN while repository
candidates are still observed; UNKNOWN alone never authorizes route release.
Host-uplink observers isolate repository exceptions as typed UNKNOWN and drain
submitted siblings before releasing the election flight. UNKNOWN is never
repository success or permission to release an owned preference. Independent
generic connectivity still supplies the existing fallback. See
[`HOST-UPLINK-ELECTION.md`](../../docs/HOST-UPLINK-ELECTION.md).
Repository success on the first/default candidate stops speculative sibling
probes. Only a failed first candidate opens a four-worker, input-ordered pool;
held preferences independently observe natural winners through that same ceiling.
Natural recovery carries its proven path identity into the serialized route
writer. A changed/unusable natural winner or expired proof withholds deletion,
resets recovery, and keeps maintenance armed; release remains forward-only.
The coordinator delegates default-interface observation and natural-recovery
coordination to small network modules; route serialization stays in the writer.
The retained-realm kernel regression explicitly probes kernel support and prints
a skip reason when realms are erased. A mandatory target-shape regression covers
the same recovery identity without realm/classid support.

- **Runtime**: Bun only. No Node-specific APIs (`node:path`, `node:os`, `node:fs/promises` are fine).
- **Process spawning**: `Bun.spawn()` / `Bun.$` shell — not `node:child_process`.
- **File I/O**: `Bun.file().text()` / `Bun.write()` — not `fs.readFileSync`.
- **Config files**: read/written via `helpers/config-loader.ts` — not raw `fs`.
- **Error handling**: `invariant` from `helpers/invariant.ts` — not `process.exit`.
- **All device control**: oRPC over WebSocket — no new HTTP REST endpoints.

## License

GPL-3.0. See the [LICENSE](LICENSE) file for details.
## Start-failure diagnostics

Terminal start failures retain the engine's original diagnostic `message` beside
the typed class/code. It is logged and carried in notification params, so JSON-RPC
reasons such as an unavailable ALSA capture device are not reduced to `-32602`
alone and stay readable in the device log.

That detail lands in the **log**, not the operator's toast. CeraLive operators
have no console, so the failure toast renders the localized class + retry state
only and points at Settings → System Logs; the verbatim engine string (and any
shell command or systemd unit name) never appears in user-facing copy.
