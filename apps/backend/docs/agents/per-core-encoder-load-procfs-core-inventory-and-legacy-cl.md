<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PER-CORE ENCODER LOAD — PROCFS CORE INVENTORY AND LEGACY CLOCK FALLBACK [EXISTS]

`modules/system/encoder-load.ts` publishes `encoder-load`; its pure procfs
parsers live in `encoder-load-proc.ts`. The core inventory comes from actual
`/proc/mpp_service/load` rows, never a two-slot encoder constant. The existing
`cores` / `decodeCores` three-state contract (`percent`, `active`, `unavailable`)
is retained alongside additive `blocks[]`. Full wire and source grammar:
[`docs/ENCODER-LOAD.md`](../../../../docs/ENCODER-LOAD.md).

| Interface | Reading |
|---|---|
| `/proc/mpp_service/load` (island and vendor BSP) | Independent raw `load` and `utilization` for each published MPP core |
| `/proc/mpp_service/sessions-summary` | Session creator PID + driver index, matched to the exact bound device |
| `/proc/rkrga/load` | Published RGA scheduler load only; utilization and per-core owners remain unknown |
| Legacy `/sys/kernel/debug/clk/clk_rkvenc{0,1}_core/clk_enable_count` | Unchanged clock enable-state fallback, a boolean and never a percentage |

- **Which one is live is PROBED, never inferred.** No `uname` test, no board-id
  test, no hardware-kind lookup: a device can be moved between the two kernels by
  swapping boot media (the bench board has been, repeatedly), so the only honest
  question is which interface answers right now. Probe order is richest-first, and
  **a reality only wins when it produced a usable core reading** — a vendor `load`
  file that exists but parses to nothing (the driver prints
  `please set load_interval first!!!` until it is armed) still falls through to the
  busy/idle bit rather than reporting an instrumented-but-empty device.
- **THE INVARIANT: a `clk_enable_count` is never turned into a percentage.** It is
  a reference count, not a magnitude — the measured 2-and-1 under four concurrent
  sessions does not mean "core 0 is twice as busy". There is deliberately no code
  path from an enable count to a number, and `tests/encoder-load.test.ts` pins that
  absence the same way the frontend contract test does.
- **`load_interval` is armed ONCE, idempotently, and only when it is off.** The
  vendor driver reports nothing until it is non-zero, but arming it is a WRITE into
  `/proc`, so the current value is READ first and an already-armed device is left
  exactly as found. A refused write never breaks the read.
- **Ordering is derived from the block's base ADDRESS, not from file order or a
  hardcoded address table.** Numeric address ordering supplies legacy ordinal
  labels; `blocks[].cores[].core` retains the actual device name for identity.
  `rkvenc-core`, legacy `rkvdec*`, and `jpegd`/`jpgdec` are grouped separately.
  A generic `video-codec` row needs the NUL-separated device-tree compatible
  `rockchip,rkv-decoder-v2` before it can be called `rkvdec`. RGA has its OWN
  procfs file and is never inferred from MPP or assumed to have three cores.
- **Load and utilization are different quantities.** Run-to-reap accounting
  is `load`; hardware time is `utilization`. The driver permits multicore
  percentages above 100, so raw block metrics preserve them without clamping;
  the legacy percentage view still refuses values outside 0–100. Malformed
  metrics become null independently, retaining the core identity.
- **Ownership is bound-device membership, not executing-core attribution.**
  `sessions-summary` is re-read each sample. Empty means no owners; missing or
  malformed means unknown (`sessions: null`). Neither IOVAs nor codec-table
  strings are broadcast. The creating task's PID is not assumed to be a TGID,
  engine session ID, preview owner, or live-program owner.
- **Blocks do not depend on encoder availability.** Decoder/JPEG/RGA telemetry
  survives even if the legacy encoder view falls back to clock counts or has
  no usable reading. Consumers replace the whole snapshot; no previous owner
  or retired core is retained. The fallback is tracked as
  `TD-encoder-load-clock-fallback`, not removed in this change.
- **Privilege: none is escalated.** The backend runs as root
  (`deployment/ceralive.service` `User=root`), so both reads use the same plain
  `Bun.file()` seam as the `sensors.ts` `/sys/class/thermal` read. Do not introduce
  a helper, a `sudo`, or a capability for this.
- **Degradation follows `sensors.ts`/`device-stats.ts`:** every read is wrapped in
  its own try/catch, one unreadable core degrades only that core, and a device
  where neither interface answers reports the honest unavailable floor
  (`source: null`, no cores) rather than a shaped guess.
- **It is its OWN broadcast, NOT a sixth `device-stats` field** — that payload is
  frozen by the S1 lock, and this reading is structured per core rather than a
  scalar. It is likewise not foldable into `sensors`, which is a flat
  `Record<string, string>` of display strings. Wire schema: `@ceraui/rpc`
  `encoderLoadSchema`. Cadence 2 s, coalesced at 2 s, and seeded into the
  post-auth initial-state push so a fresh client does not sit on the unavailable
  band waiting for the first tick.
- **`initEncoderLoad` is `isRealDevice()`-gated.** A dev/emulated host has no
  VEPU580, so it publishes NOTHING rather than a synthetic reading — and that
  silence is precisely what keeps the frontend's dev-only `?health-mock=` fixture
  the single mocking mechanism for this signal. A backend mock provider here would
  be a parallel mechanism, not the established one.

Coverage: `tests/encoder-load.test.ts` (legacy shapes, arming, fall-through,
emulated-host gate and never-a-number regression), `encoder-load-island.test.ts`
(source-derived fixtures, dynamic core counts, generic decoder names, raw metrics,
ownership and RGA), and `encoder-load-proc.test.ts` (malformed/ambiguous input).
This collector rewrite is code-only; no hardware validation is claimed. Existing frontend coverage:
`apps/frontend/src/tests/encoder-load-source-precedence.test.ts` and
`apps/frontend/src/main/dialogs/DeviceHealthDialog.test.ts`.

