# Picture-in-Picture / Compositing: Evaluation Record

**Status:** `[EXISTS]` (decision record + schema reservation only; no PiP feature ships from this document)

This is a decision record, not a build plan. It exists to state the current
engine reality so nobody re-derives it from scratch, fix the delivery contract
a real PiP feature would have to follow, describe how the sizing question gets
answered without inventing numbers, and draw the line around what PiP is and
is not, so future scope creep has something to point at.

The corresponding tech-debt entry, `TD-pip`, lives in
[`docs/TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) and stays **open**. This document
does not close it, does not implement anything against it, and does not change
its text.

---

## 1. Current engine reality

cerastream's live program graph is a **switcher**, not a **compositor**. Per
[`cerastream/docs/ARCHITECTURE.md`](../../cerastream/docs/ARCHITECTURE.md) §3
("Pipeline Data Flow") and §4 ("Input-Switching State Machine"):

> Two legs branch at a `tee` after the encoder: Program leg ... Preview leg ...
>
> `SRC_A["Source A (primary, HDMI/UVC)"]` and `SRC_B["Source B (standby,
> failover)"]` both feed into `SW["fallbackswitch (input switcher)"]`, which
> feeds `ENC["HAL-selected encoder"]`, which feeds `TEE["tee"]`.

`fallbackswitch` selects **one active source at a time** and guarantees a
switch gap of at most two frames on any transition (`ARCHITECTURE.md` §4, the
`STANDBY -> ACTIVE` / `ACTIVE -> STANDBY` state-machine transitions). It is a
GStreamer element built for seamless failover between candidate inputs, not
for blending or overlaying two live sources into a single frame. There is no
`compositor`, `glvideomixer`, or equivalent mixing element anywhere in the
graph described in `ARCHITECTURE.md` §1's crate map or §2's system diagram.
The crate that owns the graph, `cerastream-core`, is documented as: "Pipeline
orchestration: builds the GStreamer graph programmatically ... owns the
`fallbackswitch` input switcher." A switcher and a compositor are
architecturally distinct GStreamer element families; cerastream only has the
former.

The `cerastream/README.md` "Status" note (first-boot, Task 29) confirms the
same shape in prose:

> composing the live program graph (`videotestsrc` legs -> `fallbackswitch` ->
> HAL encoder -> `mpegtsmux` -> `appsink` -> `dyn Transport`/libsrt FFI)

This is echoed verbatim by the `TD-pip` entry itself
([`docs/TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) lines 90 to 105):

> Compositing a second source as a picture-in-picture overlay is not yet
> possible: **the engine drives a single active input.** The Live destination
> surfaces a calm "coming soon" affordance (`data-debt-id="TD-pip"`) next to
> the input picker, purely informational, never an actionable control, until
> the engine advertises `pip_supported`.

Two consequences follow directly from this reality, both load-bearing for
everything below:

1. **PiP is not a UI feature waiting on a flag flip.** It requires new engine
   capability: a second concurrent decode path plus a compositing/mixing stage
   inserted into (or alongside) the current single-active-source graph. This
   is Track-2 (cerastream engine) work, not a CeraUI-only change.
2. **The existing `fallbackswitch` failover contract must not regress.** Any
   compositing addition sits alongside, not instead of, the two-frame-max
   failover guarantee `ARCHITECTURE.md` §4 documents for the single-active-
   source path, since that path remains the default (non-PiP) mode.

`cerastream-core::sources` (README.md "Sources & device discovery") already
performs hotplug device discovery and normalizes multiple `DiscoveredDevice`
entries, and the graph builder (README.md "Pipeline graph builder") already
composes a `GraphSpec` element-by-element rather than via `gst_parse_launch`.
Both are useful building blocks for a future compositor leg, but neither one
*is* a compositor. The local-preview leg (README.md "Local preview (WebCodecs
+ WebRTC)") is a separate, already-shipped concurrent-decode precedent (a
shared downscaled tee tap feeding a second consumer), worth knowing about as
a pattern reference. It re-encodes the *same* program source for delivery
though, it does not blend two *different* sources into one frame, so it is
not evidence PiP compositing already exists.

---

## 2. The 3-layer delivery contract

A real PiP feature ships in three layers, in this order. Each layer is a hard
dependency of the one after it: CeraUI cannot build layer 2 against a
capability that doesn't exist, and layer 3 must never expose a control the
backend can't honor.

### Layer 1: Engine capability + compositing control path (Track 2, cerastream)

Owned entirely by the cerastream engine team. Scope, at minimum:

- A compositing element (e.g. `compositor` / `glvideomixer`, or an
  HAL-selected hardware equivalent) inserted into the program graph, fed by
  two concurrently decoded sources instead of the single
  `fallbackswitch`-selected source.
- A new IPC surface (JSON-RPC method, following `cerastream-ipc`'s existing
  request/response pattern, see `ARCHITECTURE.md` §1 and §6) to configure
  overlay geometry (position, size, source assignment) and to enable/disable
  the second decode leg on demand, since a second concurrent decode is not
  free (see §3).
- `pip_supported: true` advertised in the engine's `get-capabilities` response
  once the above is real and validated on target hardware, the same
  additive-capability pattern already used for `audio_live_switch`,
  `fec_capable`, and `preview.enabled` (see `capabilitiesMessageSchema` in
  `packages/rpc/src/schemas/streaming.schema.ts`).

Nothing in this document specifies the compositor element choice, the IPC
method shape, or a timeline. That design belongs to the cerastream team when
Track-2 capacity is allocated (§4).

### Layer 2: `@ceraui/rpc` additive schema + procedures (CeraUI, this task)

CeraUI's job is to make the wire contract *ready to receive* the engine's
answer without inventing behavior ahead of it. This task lands the first,
smallest piece of that: `pip_supported: z.boolean().optional()` on
`capabilitiesMessageSchema` (`packages/rpc/src/schemas/streaming.schema.ts`).
It is additive, optional, snake_case, following the exact precedent of
`audio_live_switch`, `fec_capable`, and `transports` already on that schema.
Absent on a legacy/pre-PiP engine snapshot, so a device running an older
cerastream keeps parsing cleanly (back-compat by construction, same rule the
existing optional fields document inline).

Nothing beyond the flag lands here. When Layer 1 is real, a follow-up task
adds whatever request/response schema and backend procedure the engine's
actual IPC method needs, mirroring how `device.setProfile` was added to
`packages/rpc/src/schemas/stream-profile.schema.ts` and wired through
`apps/backend/src/modules/remote-control/` once its engine counterpart
existed, not invented speculatively now.

### Layer 3: UI overlay control (CeraUI frontend)

Only once Layer 2 carries a truthful `pip_supported: true` from a live engine
does the frontend get an actionable control. Per this repo's `AGENTS.md`
"CAPABILITY CONSUMER" contract, the offered set is always the intersection:

```
platform caps ∩ capture-source caps ∩ current-mode → offered set
```

`pip_supported` alone is necessary but not sufficient: a source that can't
supply a second concurrent decode leg (e.g. a single-input device, or a
source already at its decode-channel ceiling) must still gate the control
off, same as every other capability-gated affordance in the Live destination.
When this layer ships, it replaces the `TD-pip`-tagged
`<ComingSoon debtId="TD-pip" />` pill currently rendered in
`apps/frontend/src/main/LiveView.svelte` (next to the input picker) with the
real overlay control, and flips the `TD-pip` register entry to `resolved`,
exactly as the entry's own `unblock` field already states. That replacement
is explicitly **not** part of this task (see §5 and MUST NOT DO).

---

## 3. Hardware sizing: measurement method, not numbers

This section is deliberately a **method**, not a benchmark table. No
dual-decode CPU/thermal numbers exist yet for either reference board;
inventing them here would be worse than not having them, because a
fabricated number gets treated as a real constraint by the next reader.

### What to measure

PiP compositing costs more than the current single-active-source path in two
new ways the current graph never pays for:

1. **A second concurrent decode.** Today `fallbackswitch` holds a pre-rolled
   standby source (per `ARCHITECTURE.md` §4's `STANDBY` state) but only the
   `ACTIVE` source is fed through to the encoder. PiP requires *both* sources
   decoded and composited simultaneously, for the full duration PiP is
   enabled.
2. **A compositing/mixing stage**, running concurrently with the existing HAL
   encoder and the existing 20 ms bitrate-control loop (`cerastream-bitrate`,
   `ARCHITECTURE.md` §5), all sharing the same CPU/GPU budget that today only
   serves one decode plus one encode.

The two things to measure, per board, under **sustained** load (not a burst):

- **CPU headroom.** Cycles left over after decode(×2), composite, encode, and
  the existing bitrate loop and IPC server threads, at the target stream
  resolution/bitrate/framerate. Measure with `mpstat -P ALL` / `top`
  (per-core, since HW-accelerated boards often have asymmetric core
  assignment) sampled across a soak, not a single snapshot.
- **Thermal behavior.** SoC/CPU temperature trend over the same soak, read
  from the same sensor path `apps/backend/src/modules/system/device-stats.ts`
  already uses for `socTemp` in production (§ "DEVICE STATS" in `AGENTS.md`),
  so the measurement methodology matches what the shipped telemetry actually
  reports, not a one-off lab reading with different instrumentation.

### Tooling

- A synthetic two-source pipeline built with `cerastream-core`'s existing
  programmatic `GraphSpec` builder (README.md "Pipeline graph builder") using
  `videotestsrc` legs (as the `README.md` Status note already does for its
  first-boot smoke pipeline) feeding a compositing element, run as an
  isolated `cargo` test/binary. This validates decode+composite CPU cost
  without needing the Layer-1 IPC surface to exist yet. The encode plus
  bitrate-loop cost (already characterized by the existing single-source
  path) is additive on top, not re-measured from scratch.
- Standard host tools: `mpstat`, `vmstat`, and the board's thermal_zone
  sysfs nodes (the same path `device-stats.ts`'s SoC-temperature collector
  reads), sampled at a fixed interval across a soak of at least the same
  duration as cerastream's own lifecycle soak convention
  (`CERASTREAM_E2E_SECS`, README.md "Build & test": 60 s for a full soak,
  5 s for a fast gate).

### Order: x86/N100 first, then RK3588

Prototype the synthetic two-source pipeline on an **x86/N100 board first**,
before touching RK3588 hardware. Reasons specific to this repo's own
hardware matrix (`README.md` "Supported Hardware"):

- **Faster iteration.** N100 is `x86_64`, no cross-compile step. The repo
  already documents a dedicated aarch64 cross-compile sysroot
  (`cerastream/ci/cross/README.md`) specifically because iterating natively
  on RK3588 targets requires it; skipping that loop for the exploratory
  sizing phase is a straightforward time win.
- **Different bottleneck shape, useful as a first signal.** N100 has no
  dedicated hardware video-composite block; a software (or VA-API partial)
  composite path on N100 is the more conservative case for CPU headroom, and
  any showstopper found there (e.g. compositing alone saturates a core at
  the target resolution) is cheaper to find before spending RK3588 board
  time.
- **RK3588 already runs closer to its encode ceiling for a single source**
  (it is the ARM64 board the HW encoder capability flags in
  `capabilitiesMessageSchema` (`platform.hardware_accelerated`,
  `supports_h265`) are keyed off in production). Adding a second concurrent
  decode plus composite stage is the *higher-risk* measurement of the two
  boards; it should be attempted second, with whatever
  pipeline-construction lessons the N100 pass already surfaced (correct
  `GraphSpec` shape, correct sampling interval, correct soak duration)
  already worked out.

Only after both measurements exist does a real go/no-go decision (§4) become
possible. This document does not make that call; it defines how the call
gets made.

---

## 4. Go/no-go criteria

All three must hold. Any one failing is a **no-go** for starting Layer-1
engine work, not a permanent no, just not yet.

1. **Sustained encode + composite headroom.** Across a soak at least as long
   as cerastream's own full-soak convention (60 s, `CERASTREAM_E2E_SECS`
   unset, see §3), the board sustains dual-decode + composite + encode +
   the existing 20 ms bitrate loop with **zero dropped/late encoder frames**
   and measured CPU headroom left over on every core the pipeline touches
   (not just the average; a single saturated core silently caps throughput
   even if the average looks fine). "Sustained" means the full soak, not a
   burst at the start.
2. **Thermal ceiling not exceeded.** SoC/CPU temperature, read via the same
   sensor path `device-stats.ts` uses in production, stays below that
   board's documented throttle/trip-point threshold for the entire soak
   under continuous PiP+encode load, not momentarily approached, not
   recovered-from-a-spike, but never crossed for the duration.
3. **Engine team capacity.** Track-2 (cerastream) has capacity allocated in
   an upcoming sprint window to build Layer 1 without displacing
   already-queued Track-2 work ahead of it in priority. Concretely,
   `TD-rist-egress` and `TD-plain-srt-egress` are both open Track-2 items
   already ahead of `TD-pip` in the register; PiP does not jump that queue
   implicitly just because this evaluation exists.

If criterion 1 or 2 fails on a given board, that board is a no-go
independent of the other. A go on N100 does not imply a go on RK3588, and
vice versa, per the "prototype first, decide separately" framing in §3.

---

## 5. Explicit non-goals

- **No TURN-style scope creep.** PiP is a **local compositing** feature, an
  in-process change to the program graph inside `cerastream-core`, producing
  one MPEG-TS stream that already contains both sources composited. It has
  nothing to do with network relay/traversal infrastructure. cerastream's
  *unrelated* remote local-preview feature already carries its own explicit
  relay-infrastructure boundary: README.md "Local preview (WebCodecs +
  WebRTC)" states plainly that the WebRTC remote-preview tier uses "default
  public STUN; **TURN is out of v1**." PiP work must not be used as a wedge
  to justify standing up TURN, a relay service, or any other
  network-traversal infrastructure. That scope belongs (if ever) to the
  remote-preview feature's own roadmap, not this one. If a future PiP design
  proposal needs network relay of any kind, that is a sign it has drifted
  outside what this evaluation covers.
- **PbP (picture-by-picture / side-by-side) is the same capability, not a
  second engine feature.** Once Layer 1 exists (a compositing stage that can
  place two decoded sources into one output frame), side-by-side layout is a
  **layout parameter** of the same compositor: different placement/scale
  geometry, same underlying dual-decode + composite mechanism, same
  `pip_supported` capability flag. There is no separate `pbp_supported` flag
  planned, and no separate engine IPC method planned for PbP versus PiP; the
  UI layer (Layer 3) decides which layout to request against the one
  capability. Do not model PbP as independent scope requiring its own
  go/no-go pass.
- **This document ships no code beyond the schema reservation in §2 Layer 2.**
  No compositor element, no engine IPC method, no backend procedure, and no
  frontend control are implemented as part of this task. The `TD-pip`
  register entry stays `open`. This document is additional context for a
  future implementer, not a replacement for, or a resolution of, that entry.

---

## Related documents

| Document | Scope |
|----------|-------|
| [`docs/TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) | `TD-pip` register entry (stays open) |
| [`../../cerastream/README.md`](../../cerastream/README.md) | Engine status, graph shape, local-preview precedent |
| [`../../cerastream/docs/ARCHITECTURE.md`](../../cerastream/docs/ARCHITECTURE.md) | Crate map, pipeline data flow, input-switching state machine |
| [`packages/rpc/src/schemas/streaming.schema.ts`](../packages/rpc/src/schemas/streaming.schema.ts) | `capabilitiesMessageSchema`, where `pip_supported` is reserved |
| root `AGENTS.md` → "CAPABILITY CONSUMER" | The platform ∩ capture-source ∩ current-mode offered-set model Layer 3 must follow |
