# CeraUI

Frontend stream recovery carries status request-dispatch and browser-receipt
provenance separately. Earlier requests cannot confirm later Stop claims or
overwrite newer stream-fact observations; a superseded pull allows one bounded
fresh read. Only `is_streaming`, `stream_lifecycle` and unclassified field names
advance that horizon. Unrelated snapshot fields merge independently, preserving
newer pushes carrying the same field instead of discarding the whole answer.
Both watchdogs are action-lifetime fenced, so a completed cycle cannot stop or
revert a later session. These are host carrier proofs, not browser or board
qualification. See [START-LIFECYCLE](docs/START-LIFECYCLE.md).

If a current Start watchdog exhausts its bounded evidence, the existing
unconfirmed-state band offers the operator's Stop instead of leaving only
disabled “Starting…”. Its generation-owned unknown record survives navigation
and reconnect; only later admissible live/idle facts or that owner's acknowledged
Stop clear it and matching Start optimism. The latest Stop owner's acknowledgement
also settles its captured, still-current starting attempt **before** recovery
exhausts, revoking the pending watchdog; an old owner or Start generation cannot
settle a newer attempt. Operation confirmation still needs a post-press idle
lifecycle. No automatic Stop or backend lifecycle
is invented. Fields classified unrelated here are **unrelated to stream
settlement**, not every decision (`updating` still gates power; `network_ingest`
still gates Start configuration). Browser scheduling and incidence of the complete
lost-confirmation transcript against the integrated backend/engine remain UNKNOWN.

The latest Stop owner's acknowledgement revokes its captured Start whether or not
an admissible settlement already closed the Stop claim. An idle that confirms the
Stop operation does not by itself end the acknowledged Start before recovery;
the explicit acknowledgement does. Failed Stop and pre-record boolean-only false
do not revoke it; post-record admissible facts still settle UNKNOWN. The band's
Stop remains the escape. The 36-cell real-socket permutation matrix in
`LiveView.real-socket-stop.test.ts` owns this contract, with no automatic Stops.

A dispatched Start's 75-second reply timeout no longer grants a blind retry or
cancels its 90-second recovery watchdog. It follows the existing lost-reply path:
fresh facts settle the same generation, otherwise bounded recovery exposes UNKNOWN
with the operator's Stop. Proven non-dispatch and typed negative Start results
still revert. The real-carrier matrix adds the timeout dimension without changing
its acknowledged-Start contract; browser/engine incidence remains unqualified.

**Device updates [EXISTS].** The update orchestrator checks for package and
system updates on a schedule alongside the older package-update RPC path. It
automatically installs while idle, and
allows operator actions to bypass that idle wait. Stream/update admission:
[D8 detail](docs/DEVICE-UPDATES.md#d8-stream-admission) and
[D8 Known gaps](docs/agents/the-device-update-system.md).
Settings → Software Updates shows packages,
system image, slots, automation (auto toggles, schedule window, channel),
cellular allowances with per-candidate approval, and the update connection. A
busy update shows an app-wide badge, and the Live cockpit warns before Go Live;
Start stays enabled because the device decides admission. Implementation
reference: [device updates](docs/DEVICE-UPDATES.md).

**Update notices [EXISTS; host-tested, board qualification owed].** Independent
observers provide durable public-certificate expiry warnings (90/30/7 days and
expired) and attempt-keyed download-hold notices for genuine D8 interruptions.
Settings → Software Updates → Update connection shows the device's credential
verdict and public expiry date when supplied; older backends omit the row.
Neither notice family changes update or stream admission. Credential dates do
not prove mTLS acceptance, and a hold does not prove a stream started or traffic
stopped. Hold intents retain the documented pre-ledger crash-loss window, not
exactly-once delivery. See [notice contracts and limits](docs/DEVICE-UPDATES.md#notifications).

**What today's images can use [PARTIAL].** Every image shipping today is a
legacy image: it keeps the 15-package update roster, and the dialog states which
sections it cannot back instead of hiding them. Updating every package by origin,
signed system-image updates and the slot mirror are implemented but need image
capabilities no released image declares yet. System-image updates additionally
need an `/etc/ceralive/os-release-version` stamp, so current boards refuse them.
The origin-classification and detached-unit identity fixes were exercised on
bench-enabled Rock 5B+ and Orange Pi 5+ boards; packages installed, but both
successful installs left sticky `failed / commit_unit_absent_on_resume` because
the backend exited before recording the orchestrator's success transition.
This branch now persists `restarting-services` before exiting after an
orchestrator-owned capable install, without guessing success on an uncertain
resume or changing legacy-image behaviour. The fixed build has **not** been
re-proven on a board; the OS/slot flows are not qualified by these installs.
See also [update recovery](docs/UPDATE-RECOVERY.md).

OS-download cancellation retains its nonblocking stream-start path and now
confirms the same stopping RAUC process before detached NBD socket release at
T+3 s, with SIGKILL only as a T+8 s last resort. SIGKILL alone did not shorten
the measured kernel-NBD wedge; the manual socket-release experiments motivate
this implementation, not qualify it. The packaged automatic path still needs
the board re-drill; strict update settlement proof is unchanged. See
[the escalation contract](docs/UPDATE-RECOVERY.md#detached-rauc-termination-escalation-partial).

A matching slot-mirror receipt proves a past copy, not that a later failed OS
install left it intact. The idle gate now rechecks bounded RAUC target-health
evidence and restores a bad inactive slot even when the running package hash is
unchanged. Pending OS installs remain protected. This repair is host-tested;
the exact-head hardware fallback/restoration drill remains owed.

Interrupted package failures can now return to idle after fresh unit/process/lock/
dpkg evidence proves consistency and recorded attempt provenance proves a reboot
or slot change. Package recovery now holds the four standard APT/dpkg fcntl lock
inodes through evidence collection and recovered-state publication, excluding
ordinary external writers; any nonempty audit stderr also refuses recovery.
The pipe-owned holder calls fcntl through inline Perl on Linux little-endian
x86_64/aarch64 LP64, independently of util-linux locking options. A 30-second
read-only collection budget refuses late evidence without unlocking underneath
cleanup/publication; holder loss after pending cleanup still refuses recovery.
Missing historical provenance remains operator-only. A recorded
mirror failure needs a later matching receipt, clean unit and both slots good.
Neither path replays old work or calls an uncertain install successful; each
persists a recovered-notice intent. These are host proofs, not both-board crash
or power-loss qualification; see the same recovery contract.

Add-on mutations preserve request-owned process-group evidence even when Bun loses
the spawn handle: a checked Bash launcher records its identity before helper exec,
and recovery probes that group before descriptor jobs. Normal handles never read
the per-request `/run` file; unreadable/invalid identity remains unknown. This is
host-tested, not installed qualification. See [launcher contract and limits](docs/agents/add-on-subsystem.md).

Tracked package recovery reserves exit authority for both committing and
downloading snapshots. Owned wire `success` precedes restart-permission checking,
so it does not prove a new backend is running. If durable success cannot be written,
new packages stay installed while the old backend runs; the error log and latched
`update-orchestrator-maintenance` health flag identify that condition. A separate
pending-success fence blocks new scheduler and legacy command/channel submissions,
including admitted continuations at their post-await boundaries, while ticks
retry the successful snapshot under CONTROL. Already-submitted work is not cancelled.
Ticks service independent snapshot and intent/witness recovery before package replay,
so package priority cannot starve the recovery it needs. Both startup-tail snapshot/
package-completion observation orders are host-tested, not board-qualified.
Manual readiness requires valid startup and both OS/package durability; D8 uses its
existing update-in-progress refusal. A readable renamed success after failed directory
sync still requires successful re-persistence. Persistent drift escalates to local
maintenance without clearing the fence. Only authoritative success persistence
restores normal restart authority; no maintenance clear API is added.
Avoid Check AND Install, preserve agent/plan/unit/output evidence and repair
storage/ownership while alive. An accepted legacy Check clears retained wire success
outside the fence. Terminal startup refusal by itself still leaves legacy RPCs and
independent periodic callers active. Restart only after a positive safe baseline;
hardware, power-loss and rendered maintenance feedback remain unqualified. Full
[owner-decision inventory](docs/UPDATE-RECOVERY.md#owner-decision-pending-package-success-and-the-old-running-backend).

OS receipt publication is not final release success: pending producers cannot
arm activation, and a matching unsafe release failure stays terminal without
deleting the receipt. Invalid recovery metadata also stays terminal on startup
instead of clearing an earlier failure. Manual confirmation is limited to settled,
typed unsafe OS outcomes with positive proof. These repairs are hermetically
tested; the updated candidate still needs independent review and a board re-drill.

Admission observation is bounded to a fail-closed 10-second refusal, not a writer
deadline. Orphan settlement parses systemd absence by property, and a configured
NBD device cannot lose its recorded ownership merely because its creator PID was
reused. These safety repairs likewise remain hardware-unqualified.
An admission refusal now names its first failing predicate and, when observation
itself stopped, bounded boundary/class/code diagnostics without arbitrary exception
messages or changing admission. Receipt retirement requires persisted CONTROL
authority and a new receipt's installed-image binding to the healthy booted rootfs,
in addition to version equality. Legacy receipts (including HISTORICAL Rock `.64` and
the CURRENT prior-boot `.70` from bench build `1f6a990e`) stay
intact. A renamed receipt with failed directory fsync is reported as durability
pending and its acknowledgement retries. A successful tombstone acknowledgement
is cached by full file identity for this process only; unchanged ticks avoid
CONTROL/fsync, changes/failures retry, and a new process acknowledges again.
Marker read errors never imply absence.
Judgment carries the read-time inode/metadata/hash identity, while cooperative
publication, arming and rebinding share CONTROL. Rename is not compare-and-swap
against privileged writers ignoring that lease. Production publication uses
`commitStagedManifest` through the leased stage callback, rebinding uses
`rebindStagedReceipt` through leased runtime reconciliation, and retry uses the
same leased stage entry. Low-level `saveStagedManifest` itself requires no lease.
The image's `ceralive-rauc-activate.sh --arm/--stop` takes its own activation
flock, not CONTROL; privileged/manual or surviving helper effects can bypass
cooperative exclusion. ExecStop deliberately stays CONTROL-independent.
New never-launched jobs/witnesses
record the pre-existing receipt baseline: an unchanged stale receipt is preserved
without obstructing safe retry, but new/changed receipts still veto. Legacy records
retain their presence veto; a both-slots-good unsafe failure without a matching
completed never-launched witness still stays failed (HISTORICAL failed `.68`, not
the current Rock state). The supplied CURRENT Rock state is booted `2026.10.70`,
both slots good, agent idle: the unbound legacy receipt is inert and the next
Check → stage → install → staged → armed flow is unobstructed in the oracle's
host repro. Accepted D154 residuals are privileged arming bypass and forward-only
strict schema-1 compatibility: older unreleased intermediates reject
`receiptBaseline`; bench rollback requires clearing stage job/witness records.
`2026.9.5` is the PLANNED first orchestrator release, pending the release gate. These are host proofs, not
board qualification. See [OS staging recovery](docs/UPDATE-RECOVERY.md#os-staging-recovery-partial--fixture-proven-board-re-drill-owed).

Idle RAUC status helpers no longer make a single extra-member census a terminal
stage refusal: admission waits for fresh strict proof within a short prelaunch
bound or the settled pair's remaining recovery budget. Recovery starts that one
360-second monotonic budget before restart submission; retry and release cannot
renew it. No process role is whitelisted, and successful-but-unpublished installs
cannot restage. Ownership, cancellation, candidate/transport freshness and final
clocks remain fenced. Startup/orphan post-cleanup proofs use the same bounded
seam. Captured-stat and killed-process host tests are not a qualification of the
shipped guardian or either board; both-board failover/status-pressure re-drills
remain owed. Persisted formats and the D154 residuals above are unchanged.
Positive CLI exit is retained independently of cancellation/output drainage;
the matching runtime attempt settles unpublished success unsafe even after D8
returns to the offer. Final safety observation follows awaited preparation, and
proof I/O shares the remaining deadline with expired captures invalidated.
Optional diagnostics precede a final unit/process/resource fence; census drift
returns no snapshot and permits only bounded fresh re-observation. Command,
parsing, timeout and unit-identity failures remain terminal unknown; only an
identical clean census pair can authorize dispatch. Persisted formats are unchanged.
Simultaneous census drift cannot mask failed/malformed Operation or unavailable
health/boot/slot evidence: the drift retry marker requires valid non-census
predicates, and the changed pair still returns no snapshot.
Positive CLI success dominates transfer failure, with a runner-level replay veto.
Outer recovery, publication and release ports spend the same remaining deadline;
late callbacks cannot grant publication or release. No awaited preparation remains
between final safety observation and dispatch, but synchronous persistence and
external process changes still leave a non-atomic gap. These are host-tested
safety repairs, not a new board qualification or a change to D154.
Retained-pin drainage now uses the reconciler's active budget and CONTROL lease,
with read-only capture after ownership preparation. OS routing teardown and sweep
check that lifetime before every new command and bound each wait by its remainder;
already-submitted I/O cannot be revoked. Ordinary routing policy is unchanged.
Quiet startup with no job, guardian or private directory uses a single 10-second
CONTROL-fenced reconciliation budget for orphan inspection and stale-rule sweep.
The same lifetime is checked immediately before opening admission; timeout or
lease loss stays unsafe. Real-flock host regressions preserve normal cleanup,
but do not qualify board routing or a real OS installation.

Stage-refusal summary logs now distinguish the first admission,
runner or settlement/startup proof failure, retaining bounded stage/errno detail
and wait counts where known. This is diagnostic context, not a cause proof or
board qualification; stored formats, wire schemas and safety policy are unchanged.
See [self-describing refusals](docs/UPDATE-RECOVERY.md#os-staging-recovery-partial--fixture-proven-board-re-drill-owed).

Stored update authority now refuses symlink ancestors, invalid encoding,
oversize records and duplicate JSON members without replacing the evidence.
Contradictory unit rows cannot authorize download clearance or D8 stop, and
optional diagnostic getter faults cannot replace the original refusal. These
are host boundary proofs, not board qualification; see
[strict stored authority](docs/UPDATE-RECOVERY.md#strict-stored-authority).

The metadata exception is deliberately narrower than those authority rules:
slot-sync accepts a regular `/etc/os-release` or its exact standard link to
`/usr/lib/os-release`, whose target is still read strictly. Present invalid idle
state remains `awaiting-idle` with `activity-unknown`, never automatic install
permission. The config, modem, token, add-on and shaper authority sweep is
host-tested; installed layouts on both boards remain unknown in this fix.
See [metadata and idle boundaries](docs/UPDATE-RECOVERY.md#metadata-and-idle-boundaries).

A present unreadable capability declaration is an unknown install regime, never
legacy permission. Package exit status and text identity also require complete,
unambiguous evidence before success or cleanup; see
[capability and terminal evidence](docs/UPDATE-RECOVERY.md#capability-regime-and-terminal-package-evidence).

OS-stage reads treat ENOENT/ESRCH on vanished enumerated tasks as absence, never
cached identity. Other errno and malformed-identity failures remain unknown;
non-process paths gain no ESRCH exemption. Held-open real-kernel and default-reader
host tests cover that errno class, not every helper-churn refusal or either board.
See [unchanged residuals](docs/UPDATE-RECOVERY.md#vanished-task-errno-residuals).

State-side unlaunched OS settlement requires a private completed witness matching
the persisted attempt, signed candidate and current boot, plus fresh readiness.
It returns to operator retry without counting an already-counted failure twice.
Legacy D8 records without attempt provenance remain unsafe. A strict private
two-phase attempt intent additionally covers pre-effect publication
rollback: exact publishing authority plus positive no-producer proof restores the
pre-state across a restart without inventing a failed round. Launching/missing-intent
staging keeps the existing unsafe policy. See the [intent recovery table](docs/UPDATE-RECOVERY.md#durable-os-attempt-intent-partial--host-crash-point-proof-board-power-loss-proof-owed).
Guard/state integration
is implemented and fixture-tested; board qualification is owed.
Valid stale launching intent cannot hold a cleared or superseding attempt hostage:
it is retired only under ownership absence. A failed retirement leaves admission
closed behind logged cleanup retry, without replacing the producer's outcome.
Settlement and
new-attempt admission share the control lease and recheck authoritative state;
that lease is acquired regardless of device detection or development/mock settings;
pending durability keeps admission closed. Startup restores missing recovery
notices without replay churn. See [witness recovery](docs/UPDATE-RECOVERY.md#unlaunched-settlement-witness-partial).

A root-only, local `.deb` maintenance executable now implements the narrow
cross-slot unresolved-commit adjudication. It cannot be invoked through the UI
or remote control and requires the backend inactive/effectively masked; its plan-
bearing receipt is durable before clearance. The unprivileged test suite covers
the decision/crash path; real root/systemd/APT board proof remains owed. See
[the recovery contract](docs/UPDATE-RECOVERY.md) before any maintenance window.

The OS channel reader now selects the Orange Pi product channel from its exact
physical RAUC compatible without changing the compatible used for signed-pointer
validation. The currently published Orange Pi drill pointer still needs its
publisher-side correction, and the fixed CeraUI binary has not been deployed;
this is not permission to stage that image. See [device updates](docs/DEVICE-UPDATES.md).
An unpublished stable/beta channel no longer makes a healthy, TLS-verified link
look captive or offline: the OS check reports no candidate instead. This
correction is not yet board-proven on the fixed build.

Recorded OS rollback notices now rehydrate from quarantine on backend startup.
The existing dismissal store remembers the exact failed version across restarts,
without ordinary notice churn evicting that acknowledgement. These host-tested
notice repairs are not a new board qualification; see [update recovery](docs/UPDATE-RECOVERY.md).
Replayed OS pointers already in exact-version quarantine keep their failed-check
and installation refusal, but no longer repeat the redundant replay warning.
Unreadable dismissal preferences now defer keyed notices at the shared publication
boundary without aborting update transitions or stranding Go Live. The root NBD
helper has fixed paths and checks the opened block-device identity before release;
host refusal and helper-only packaging tests do not qualify the hardened bytes on
a board. See the same recovery contract for scope and remaining drills.

Generic raw capture inputs now have an honest, non-streamable **Raw video** row
rather than a false Cam Link identity. Both consumers now pin published bindings
2026.9.11; see [publication and rollout](docs/RAW-CAPTURE-CLASSIFICATION.md).

[![CI](https://github.com/CERALIVE/CeraUI/actions/workflows/build-check.yml/badge.svg)](https://github.com/CERALIVE/CeraUI/actions/workflows/build-check.yml)
[![Release](https://github.com/CERALIVE/CeraUI/actions/workflows/publish-release.yml/badge.svg)](https://github.com/CERALIVE/CeraUI/actions/workflows/publish-release.yml)

Web-based control interface for live video streaming with cellular bonding. Built with Svelte 5 (frontend) and Bun (backend).

## Quick Start

Use Bun **1.4.3**, matching `.bun-version`, `packageManager`, `mise.toml` and CI.

```bash
bun install
bun run dev
```

Opens at `http://localhost:6173`. Backend runs on port 3002.

## Project Structure

```
CeraUI/
├── apps/
│   ├── frontend/     # Svelte 5 PWA
│   └── backend/      # Bun/TypeScript server
├── packages/
│   ├── rpc/          # Shared RPC schemas + validation constants
│   └── i18n/         # Internationalization (10 languages)
└── docs/             # Documentation
```

## Features

### 3-Destination Navigation

The app is organized into three primary destinations:

- **Live** — a unified device-first source list leads the destination: every capture device, built-in pipeline, test pattern, and LAN network-ingest (RTMP/SRT) slot renders as one picker, with a single "Codec & delay" affordance owning all audio configuration. Below it, a "Stream setup" card shows three always-visible readiness rows (Encoder, Destination, Network — no collapse, no ready bar) each fusing a state dot with its config summary and a one-tap edit/fix affordance, plus the Start control. Pick a source, adjust encoder/server settings, and go live. While streaming, the view switches to a live cockpit: telemetry strip, bitrate hot-adjust, per-link ingest stats, and Stop. A persistent HUD bar shows four at-a-glance facts (live/idle/offline state, health verdict, bitrate, SoC temperature) across all destinations, with per-link signal detail and full telemetry available in an expanded sheet.
- **Network** — connectivity overview. Bonded link status, WiFi networks (connect/disconnect/forget), cellular modems (APN, roaming, network type), Ethernet interfaces, hotspot configuration, and provider-aware Bluetooth controls. PipeWire images never try to start the retired BlueALSA unit, and a connected Bluetooth microphone is offered only when the installed provider agrees with the selected audio backend. Newly attached cellular hardware remains visible while modem services probe it. After two authoritative misses, only strong cellular evidence retains a non-actionable “Not controllable” row; descriptor-only guesses disappear and stay retired while attached, including across monitor restarts. Bluetooth descriptors never qualify by shape alone: wireless admission requires the full RNDIS triplet `e00103`, and `ID_MM_DEVICE_IGNORE=1` always excludes the device. Successful SIM PIN, PUK, and PIN2 unlocks update the affected modem row immediately over the existing push channel, without a page reload. Calm info/warning bands surface interface-topology issues without ever blocking a connection: a same-subnet notice when two bonded links deliberately share a subnet (normal for policy-routed bonding), and a policy-route warning if a bonded WiFi/modem link is missing its expected routing table.
- **Settings** — system and device configuration. All actions open focused dialogs: cloud remote, LAN password, SSH, logs, software updates, power, version info, and per-protocol network-ingest (RTMP/SRT) enable/disable. Software-update preflight refusals report their reason and clear the progress overlay. The post-acceptance silent-return gap is recorded in [D8 Known gaps](docs/agents/the-device-update-system.md), item (c). Update-state details: [device updates](docs/DEVICE-UPDATES.md).

A dev-only DevTools destination is available in development builds.

### Other Highlights

- **Live session source switching**: the cockpit can offer engine-reported
  synthetic fallback legs alongside capture legs without adding devices to discovery.
  It retains the legacy two-capture gate when the engine lacks the contract.
  Explicit empty rosters offer no switches; legacy unknown rosters have a distinct
  notice. The [U6 hardware drill](docs/LIVE-SESSION-SWITCHING.md) remains 0/10.

- **Verified dongle credentials**: login submission verifies before saving to the
  existing permission-protected store. Failed attempts preserve a previous saved
  login; failed drafts remain only until the dialog closes. Portal reachability
  and rejected authentication have distinct messages in all ten locales.
  Router diagnostics remain reachable even without writable settings. See
  [`CONFIG_PERSISTENCE.md`](docs/CONFIG_PERSISTENCE.md) for protocol limitations.

- **Progressive Web App**: offline capabilities and native app-like performance
- **Internationalization**: 10 languages with full RTL support
- **Touch/kiosk mode**: `?mode=touch` URL flag scales touch targets to 44px minimum
- **Responsive**: desktop and mobile layouts with a persistent bottom HUD dock on mobile
- **Acknowledged stream stops**: the backend reports a stop only after cerastream
  confirms it is idle; an unrelated in-flight engine request cannot swallow Stop
  while the media session continues in the background. The request and cleanup
  budgets leave an explicit margin inside the existing 12-second bound, and a
  late, undispatched connection is closed without sending a stale stop.
  Failed stop IPC also completes local cleanup without claiming engine idle;
  restoration reconciles that state before admitting its one restart. Live
  composition disable now uses staged transactional reconfiguration rather than
  a save-only acknowledgement. The companion engine correction is released in
  cerastream 2026.9.5; CeraUI 2026.9.3 prepares the consumer release. Released-build
  product-path qualification remains separate from the candidate evidence; see
  [composition lifecycle evidence](docs/COMPOSITION-LIFECYCLE.md).
- **Capability-gated AP+STA WiFi**: proven radios can keep their station link while
  hosting a hotspot; unsupported or unreadable drivers retain the honest exclusive
  switch. The deterministic virtual interface is type-checked before reuse, and
  adapters with temporarily unresolved hardware identity remain visible as
  degraded rows rather than disappearing. Physical-radio validation is still
  pending; see
  [`docs/AP-STA-CONCURRENT-MODE.md`](docs/AP-STA-CONCURRENT-MODE.md).
- **Device Health telemetry**: memory, per-cluster CPU frequency, DDR bus load,
  GPU load, and (on the vendor kernel) per-core decoder load, alongside the
  existing SoC temperature and load-average traces. Every signal is omitted
  rather than fabricated when its kernel interface is absent. A newly signed-in
  browser receives the latest completed device-stats reading immediately rather
  than waiting for the next periodic sample.
- **Media-load detail**: the compact per-core hint uses the driver's reported
  encode/decode/JPEG/RGA inventory. MPP load and utilization remain separate,
  including values above 100%; **Media details** opens the full bound-session
  and provenance view. Older devices keep their percentage/busy/idle/unavailable
  display. Both-board visual validation remains outstanding; see
  [`docs/ENCODER-LOAD.md`](docs/ENCODER-LOAD.md).
- **Hardware preview encoding**: on capable boards (RK3588), an operator can
  toggle the local preview between software and hardware encode, with an
  honest fallback message when the board's encoder plugin is missing or
  rejects a setting. See [`docs/DEVICE-STATS-VALIDATION.md`](docs/DEVICE-STATS-VALIDATION.md)
  for the outstanding board-validation checklist (open, unrun as of writing).
- **Engine-owned codec offering**: the Encoder dialog reads the live per-codec
  encoder ladder published by cerastream, including explicit 4K60 qualification
  state. Older snapshots retain a golden-pinned board fallback rather than losing
  their encode ceiling.
- **Per-uplink health**: bounded device-specific checks feed default-route
  election. Host election prefers device-bound repository HTTPS, retaining an
  ordinary-connectivity fallback when no NIC passes. Apt waits for route repair
  and a fresh unbound family check before dispatch; see
  [host uplink policy and limitations](docs/HOST-UPLINK-ELECTION.md).
  Generic gateway checks race the first IPv4 and IPv6 targets with a 250 ms
  stagger instead of walking every DNS answer serially, while active SRTLA links
  use passive RTT/NAK telemetry instead of competing probes. Captive portals
  remain visible as degraded links.
  An update-specific, stateless selector also has fixture-proven APT/OS host
  checks per uplink and address family. Live first-party deployment validation
  awaits the update infrastructure; see `docs/HOST-UPLINK-ELECTION.md`.
- **Flow-sticky client sharing**: the backend assigns new hotspot/shared-LAN flows
  across healthy uplinks while preserving established-flow affinity and keeping
  locally-originated SRTLA traffic outside its NAT path. The image carrier is the
  remaining deployment dependency; see [`docs/UPLINK_STEERING.md`](docs/UPLINK_STEERING.md).
- **Streaming-first client shaping**: while live, locally-originated SRT/SRTLA
  traffic occupies an uncapped priority band and only steering-marked client flows
  receive an adaptive CAKE/HTB ceiling. See
  [`docs/UPLINK_SHAPING.md`](docs/UPLINK_SHAPING.md).

## Development

### Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start frontend + backend with mprocs TUI |
| `bun run build` | Build for production |
| `bun run --filter frontend dev` | Frontend only |
| `bun run build:frontend` | Build frontend only |

### Mock Scenarios

Development mode includes hardware mocking. All mock state is Zod-validated at startup
and can be reset between tests via `resetMockState()`.

Mock modems identify their own USB-network interfaces with `usb_modem_net`, so
Network lists each under Cellular once its roster row claims the interface.
The interface name and address remain in that row's Details disclosure; ordinary
Ethernet ports and isolated-dongle controls remain separate.

```bash
bun run dev                        # Default: 3 modems + WiFi (multi-modem-wifi)
bun run dev:single-modem           # 1 modem, no WiFi
bun run dev:streaming              # Active streaming simulation
bun run dev:modem-pin-locked       # 2 modems, modem 0 SIM PIN-locked (PIN 0000)
bun run dev:bt-mic-paired          # Bluetooth on, HFP mic already paired
MOCK_SCENARIO=streaming-active bun run dev  # Override inline
```

| Scenario | Modems | WiFi | Streaming |
|----------|--------|------|-----------|
| `multi-modem-wifi` | 3 (5G/4G/3G) | Yes | Idle — Bluetooth on with nothing paired yet |
| `single-modem` | 1 | No | Idle |
| `streaming-active` | 3 | Yes | Active (with live telemetry) |
| `modem-pin-locked` | 2 | No | Idle — modem 0 SIM PIN-locked (fixture PIN `0000`); exercises the SIM unlock/PUK flow |
| `bt-mic-paired` | 1 | Yes | Idle — Bluetooth on with an HFP mic already paired, trusted and connected (battery 80%) |
| `caps-full` | 2 | Yes | Idle — full engine caps: H265 + hw accel, audio-capable source, live audio switch, SRT transport |
| `engine-starting` | 1 | No | Idle — engine still booting, minimal safe floor + `engineStarting` flag |
| `engine-unavailable` | 1 | No | Idle — engine unreachable, cached/minimal snapshot + `engineUnavailable` flag |

The mock subsystem also simulates add-on state, kiosk state, SIM PIN/PUK lock states,
Bluetooth (adapter, discoverable roster, pair/trust, a timed scan window),
cerastream engine errors, and device-detection overrides. See `apps/backend/src/mocks/`
for the fixture factory and schema definitions.

### Environment Variables

In **production** the WebSocket RPC URL is derived purely from the page origin
(`window.location`): the single backend binary serves the static frontend and the
WebSocket on the same host and port, so no socket host/port/protocol is configured
and the `VITE_SOCKET_*` variables are ignored. The variables below apply to
**development only**, where Vite (`:6173`) and the backend (`:3002`) are separate
origins; all are optional.

These dev-only values live in the tracked **`.env.development`** file, which Vite
loads only in `mode === "development"` and the `bun run dev` scripts load via
`dotenv -e .env.development`. A production build never reads `.env.development`, so
none of these can reach the shipped bundle. The gitignored root `.env` is loaded in
**every** Vite mode, so it must stay absent — a CI guard fails the build if a stray
`.env` bakes a `ws://localhost` literal into `dist/public`. `NODE_ENV` is not read
from any env file (Vite sets the frontend mode; the backend `dev` scripts export it
inline). See `.env.example` for the full layout.

| Variable | Scope | Home | Dev Default | Description |
|----------|-------|------|-------------|-------------|
| `VITE_SOCKET_ENDPOINT` | dev only | `.env.development` | `ws://<page hostname>` | WebSocket endpoint (scheme + host, no port) |
| `VITE_SOCKET_PORT` | dev only | `.env.development` | `3002` | Backend dev WebSocket port |
| `MOCK_SCENARIO` | dev only | `.env.development` | `multi-modem-wifi` | Hardware mock scenario |
| `LOG_LEVEL` | dev + prod | shell / systemd env | _(per-transport default)_ | Override Winston log level for all transports. Dev console default: `info`; prod console: `warn`; file: `debug`. Set to `debug` to enable per-RPC call trace lines. |

## Build & Deploy

### Debian Package

```bash
bun run test:release-package-contracts
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh
```

Release assets are published through `publish-release.yml`; see
[`docs/BUILD_PIPELINE.md`](docs/BUILD_PIPELINE.md) for the stable APT handoff.

CeraUI pins the published `@ceralive/cerastream@2026.9.11` in both
the backend and shared RPC package, carrying schema 0.21.0's capture status,
failover-rate policy, raw-input classifications, and source-mode session-switch fields.
The producer's exported
`ChangeConfigParams` and installed schema are regression-tested directly.
The bindings-skew gate checks the schema version and preservation of the three
new HDMI capture causes. The released 2026.9.1 build retains the early-import
SIGUSR1 window. The current source closes the ordered add-on poke's startup race
with a systemd readiness barrier; see [Boot readiness](docs/BOOT-READINESS.md).
This is not a claim of full board qualification.

### Supported Hardware

**ARM64**: Orange Pi 5/5+, Radxa Rock 5B
**AMD64**: Intel N100/N200 Mini PCs, standard x86 computers

See [BUILD_PIPELINE.md](docs/BUILD_PIPELINE.md) for full build documentation.

## Documentation

| Document | Description |
|----------|-------------|
| [LIVE_DEVELOPMENT.md](../LIVE_DEVELOPMENT.md) | Local dev, deploy to device, image build, debugging |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview and data flow diagrams |
| [BUILD_PIPELINE.md](docs/BUILD_PIPELINE.md) | Build system and CI/CD |
| [APT_VERSION_CONTROL.md](docs/APT_VERSION_CONTROL.md) | Debian package versioning |
| [BRANDING.md](docs/BRANDING.md) | Branding guidelines |
| [TOUCHSCREEN.md](docs/TOUCHSCREEN.md) | Touch/kiosk layout mode |
| [UPLINK_STEERING.md](docs/UPLINK_STEERING.md) | Shared-client flow steering, route/NAT ownership, and validation status |
| [UPLINK_SHAPING.md](docs/UPLINK_SHAPING.md) | SRT-priority qdisc hierarchy, adaptive client caps, ownership, and validation status |
| [TECHNICAL_DEBT.md](docs/TECHNICAL_DEBT.md) | Machine-checkable tech-debt register (source-experience overhaul) |
| [CONVENTIONS.md](docs/CONVENTIONS.md) | CeraUI-local conventions including tech-debt register contract |
| [apps/frontend/docs/DEVTOOLS.md](apps/frontend/docs/DEVTOOLS.md) | Development tools |

## Workspace Commands

```bash
bun add [package] --cwd apps/frontend  # Add dependency to frontend
bun add [package]                      # Add shared dependency (root)
bun run clean                          # Clean all build artifacts
```

## Tech Stack

- **Frontend**: Svelte 5, TailwindCSS v4, shadcn-svelte (bits-ui v2), Vite
- **Backend**: Bun, TypeScript, WebSocket RPC (oRPC)
- **Build**: Bun workspaces, mprocs

## Support the Project

If you find CeraUI useful, consider supporting CeraLive development:

- 💬 [Join the CeraLive Discord](https://discord.gg/Q2bvU49yx2)
- ☕ [Ko-fi](https://ko-fi.com/andrescera)
- 💳 [PayPal](https://www.paypal.com/donate/?business=7KKQS9KBSAMNE&no_recurring=0&item_name=CERALIVE+Development+Support&currency_code=USD)
### UVC package integration

Software updates classify `gstreamer1.0-libuvcsrc` as an application package.
The portable libuvc source supports H.264/H.265; it is separate from RK3588's
MPP/RGA acceleration. Existing engine source IDs and factory aliases stay intact.
