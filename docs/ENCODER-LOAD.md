# Encoder-load collection and presentation

**Status:** `[EXISTS]` — backend, shared wire schema, frontend hint and detail
dialog. Fixture/dev-browser validation does not close the outstanding visual
acceptance on Rock 5B+ and Orange Pi 5+; neither board was accessed for the
frontend change.

`apps/backend/src/modules/system/encoder-load.ts` owns the two-second
`encoder-load` sample and post-login snapshot. It uses injected file I/O; the
production implementation is `Bun.file().text()`. It starts only on real devices,
does not spawn tools, and never queries an engine or changes driver bindings.
The existing load-interval arming behavior is retained.

## Source grammar

Source inspected: [CERALIVE/rk3588-media-island at e0faa4a](https://github.com/CERALIVE/rk3588-media-island/tree/e0faa4a24e614c42f75ab28c78ee808baeeaa213).
`drivers/video/rockchip/mpp/mpp_service.c` creates these files under
`CONFIG_ROCKCHIP_MPP_PROC_FS`; `mpp_telemetry.h` formats each populated queue core:

```text
%-25s load: %3d.%02d%% utilization: %3d.%02d%%\n
```

For example, `fdbd0000.rkvenc-core load: 11.34% utilization: 11.08%`.
`mpp_common.c` calculates `load` from run-to-reap busy time and `utilization`
from hardware busy time. Both can exceed 100 for a multicore queue. These
values are neither normalized to one core nor swapped.

`sessions-summary` includes IOVA ranges followed by:

```text
session: pid=4242 index=7
 device: fdbd0000.rkvenc-core
 memory: 0 MiB
```

Codec-specific tables can follow. Only the creating task's PID, driver session
index and exact bound-device name participate in ownership. The source sets
`pid = current->pid`, so it is not necessarily a process TGID. A scheduler can
execute a session's tasks on another core: this file is not executing-core,
preview/live-program, or engine-session attribution. IOVAs, memory dumps and
codec strings never reach the wire.

Generic decoder nodes (`fdc38100.video-codec`, for example) are not classified by
address. The collector reads the node's NUL-separated
`/sys/bus/platform/devices/<name>/of_node/compatible` and requires the island
driver's `rockchip,rkv-decoder-v2`. Unknown bindings are not called decoders.
Named legacy `rkvdec*` nodes and `rkvenc-core`/`jpegd`/`jpgdec` remain supported.

RGA is separate: `rga3/rga_debugger.c::rga_load_show` publishes `/proc/rkrga/load`:

```text
num of scheduler = 1
================= load ==================
scheduler[0]: rga3
	 load = 12%
-----------------------------------
=========================================
<session>  <status>  <tgid>  <rga2-stage-bytes>  <process>
```

Each scheduler's hardware-busy ratio is an integer capped at 100. The global
session table does not associate sessions with schedulers; neither per-core
owners nor utilization can be inferred from it.

## Wire contract

The existing required `source`, `cores`, `updatedAt`, `simulated`, and optional
`decodeCores` retain their meanings. `cores` and `decodeCores` use the existing
`percent | active | unavailable` union. MPP legacy ordinal labels are assigned
after numeric address sorting, with no padding or two-core truncation. The
legacy encoder source still requires a usable 0–100 percentage; otherwise it
tries the unchanged clock-count fallback. `decodeCores` remains tied to that
legacy MPP view.

The optional `blocks` array carries the richer independent readings:

```json
{
  "source": "mpp-service",
  "block": "rkvenc",
  "cores": [{
    "core": "fdbd0000.rkvenc-core",
    "load": 11.34,
    "utilization": 11.08,
    "sessions": [{"pid": 4242, "index": 7}]
  }]
}
```

- Block order: observed `rkvenc`, `rkvdec`, `jpgdec`, then `rga`; absent blocks
  are not padded. A decode-only or RGA-only reading survives an unavailable
  legacy encoder view. Top-level `source` describes that legacy encoder view;
  each block names its own source.
- MPP core identity is the device name, never the legacy ordinal. RGA identity
  includes its published scheduler index and driver string, so two `rga3`
  schedulers remain distinct.
- `load` and `utilization` are independently nullable raw percentages. A malformed
  field does not erase its core or its other metric. Duplicate MPP core rows
  retain one identity with both metrics unknown.
- `sessions: []` means a complete summary reports no bound owner for this core;
  `null` means unavailable or malformed ownership. The summary is re-read each
  tick; old owners are never retained. RGA always has both `utilization: null`
  and `sessions: null`, enforced in the shared schema.
- An incomplete/ambiguous RGA scheduler inventory is withheld, not filled with
  guessed schedulers. Its global process table is ignored.
- **Replace the entire snapshot.** Optional blocks and disappeared cores are
  not merge patches; retaining omitted entries would resurrect stale owners.

`packages/rpc/src/schemas/media-load.schema.ts` owns these types; the existing
`system.schema.ts` export path remains valid. No field defaults onto a legacy
payload, no new broadcast is introduced, and the five-signal `device-stats`
contract is unchanged.

## Fallback and tests

### Frontend presentation

`EncoderStatus.svelte` routes non-empty blocks to a compact `MediaLoadHint` at
the existing three mount sites. It displays each MPP core's load **and**
utilization in aligned columns, grouped by the reported block; RGA shows its
load alone. Counts are derived from the arrays, not from a silicon table. No
block percentage is clamped, averaged or drawn on a misleading 0–100 bar.
These are advisory readings only (MNH-37), not evidence of a healthy stream.

Compact identifiers are derived from the reported address or scheduler identity
(for example `fdbd0000` and `rga3[1]`); they never become row keys. The full
identity remains in the hint's title and is shown without truncation in detail.
The detail body is a labelled, focusable region so keyboard users can scroll its
read-only content without leaving the dialog's focus trap.

The explicit **Media details** button lazy-loads `MediaLoadDialog`, using the
same desktop Dialog/mobile Sheet chrome as Device Health. Its scrollable body
shows every full identity, source, metric, sample timestamp and bound session:
`null` owners → Unknown, `[]` → No bound sessions. For RGA, both utilization and
ownership explicitly read Not published by this driver. The creating-task and
bound-device caveat precedes the rows rather than being hidden beneath them.

Snapshot replacement retracts omitted blocks, cores and owners immediately. A
dialog already open during a downgrade remains open on the legacy reading;
utilization and ownership are stated as unknown rather than fabricated. Without
blocks, all existing hint mount sites retain their prior renderer, including
opt-in legacy decoder rows. No backend or RPC producer changed in this UI work.

On the block arm, the shared refcounted health clock marks a sample older than
six seconds (three collector intervals), or a disconnected source, as a last
reading. Values remain readable but muted. Simulated readings remain explicitly
labelled; the existing device-over-fixture precedence is unchanged.

`?health-mock=island` selects a deterministic, illustrative nine-core fixture.
Its identities follow the documented driver grammar; its numbers and owners are
not hardware measurements. It covers above-100% queues, independent null
metrics, two session indices for one PID, empty/unknown owners, and RGA nulls.
The default fixture and all three existing flavor names remain unchanged.

Frontend gates: `src/tests/media-load.test.ts` (activity, count, staleness,
schema-valid fixture), `src/tests/media-load-ui.test.ts` (rendered states and
retraction), and `tests/e2e/media-load.spec.ts` (socket → hint → lazy dialog →
legacy fallback with keyboard/focus checks). Existing encoder/status/Device
Health tests remain regression guards. All paths here are under `apps/frontend`.

### Collector compatibility

`clk-enable-count` is a legacy compatibility path (historically needed by
pre-island mainline images; vendor BSP normally provides MPP procfs). It still
reads the two existing clock paths, reports positive counts as `active: true`,
zero as `false`, and an unreadable core as `unavailable`. It never authors
percentage, utilization or session values. Retirement is tracked as
`TD-encoder-load-clock-fallback` in [the debt register](TECHNICAL_DEBT.md).

The repo-local [fixture provenance](../apps/backend/src/tests/fixtures/encoder-load/README.md)
names the exact driver emitters. `encoder-load-island.test.ts` drives those
fixtures through the real collector; `encoder-load-proc.test.ts` covers malformed
boundaries and `encoder-load.test.ts` retains the legacy and emulation gates.
Shared schema tests prove old payload compatibility and reject invented RGA data.
No test requires a board or a sibling checkout.
