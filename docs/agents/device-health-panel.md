<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEVICE HEALTH PANEL [EXISTS]

A read-only Settings instrument (Settings → Device, beside Power and Versions)
showing SoC temperature and the 1-minute load average **over time**, plus the
encoder's condition. Its thermal/load lanes add **no RPC and no contract change**
— those signals were already on the wire — and the `device-stats` 5-signal
broadcast (S1 lock) is untouched. Per-core encoder load is the one signal that
needed a producer, and it got its OWN `encoder-load` broadcast rather than a
sixth `device-stats` field (see below).

Two rules carry it, both documented in full in
[`apps/frontend/AGENTS.md`](../../apps/frontend/AGENTS.md):

- **The trace's right edge is wall-clock `now`, never the last sample.** A feed
  that stops does not freeze — it falls behind the playhead and leaves a widening
  void, so staleness is geometry rather than a badge. Hand-rolled SVG + GSAP, no
  chart library.
- **Per-core encoder load has THREE states, and two of them are not numbers.**
  The vendor 6.1 and mainline edge-7.1 kernels report VEPU580 load
  incomparably — real percentages via `mpp_service` on one, only the cores' clock
  enable-state (busy/idle, no percentage anywhere) on the other — so a core is
  `percent` | `active` | `unavailable`, each with its own visual vocabulary.
  Rendering busy/idle as a percentage would fabricate a denominator the driver
  never produced.

**The per-core collector now EXISTS** (`apps/backend/src/modules/system/encoder-load.ts`,
`TD-encoder-load-telemetry` resolved 2026-08-05). Both reads are root-only — the
same privileged class as the `sensors.ts` thermal read, using the same plain
`Bun.file()` seam, since the backend runs as root — and which kernel interface is
live is **probed at runtime**, never inferred from `uname` or a board id, because
a device can be moved between the two kernels by swapping boot media. It publishes
its own `encoder-load` broadcast; the full contract is in
[`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → PER-CORE ENCODER LOAD.

The collector is `isRealDevice()`-gated, so a dev host publishes NOTHING for this
signal and the frontend's dev-only `?health-mock=` fixture stays the single
mocking mechanism for it. That absence IS the real-vs-mock seam — there is no
build-flag branch choosing between them, and a device reading always wins,
**including when what it read was "neither interface exists"**.

**Decoder rows ride the same `encoder-load` broadcast, additively.** On an
MPP-procfs kernel (vendor BSP or the mainline media island),
`decodeCores` carries one row per `*.rkvdec*` device, using the SAME
discriminated-union row shape as the encode `cores` array (`percent` |
`active` | `unavailable`). The key is OMITTED (never `[]`) when the kernel
publishes no decode load interface, and its length is board-derived rather
than a fixed two-slot list. `EncoderStatus.svelte`'s `showDecoders?: boolean`
(default `false`) opts a mount site into rendering the decoder section; only
Device Health passes `true` today. See leg (ii) of
[`docs/DEVICE-STATS-VALIDATION.md`](../DEVICE-STATS-VALIDATION.md) for the
outstanding real-decode-load validation.

**The collector derives its inventory from procfs, not the RK3588 core count.**
`encoder-load` additionally carries `blocks[]` for published `rkvenc`, `rkvdec`,
`jpgdec` and independently probed RGA schedulers. Each block core reports raw
`load`, `utilization` and nullable session ownership from `sessions-summary`.
The legacy three-state encoder/decoder views remain compatible; the clock-count
fallback is unchanged and registered as `TD-encoder-load-clock-fallback` for
retirement. Generic `video-codec` names require compatible-string evidence,
and RGA publishes neither utilization nor per-core owners, so those are null.
The source grammar and consumer rules are in [`docs/ENCODER-LOAD.md`](../ENCODER-LOAD.md).
The frontend consumes those blocks through `EncoderStatus.svelte` →
`MediaLoadHint.svelte` at all three existing mount sites. The hint remains read-only
and compact; its lazy `MediaLoadDialog.svelte` owns full identities, raw metrics,
bound-session ownership and RGA limitations. With no blocks, the unchanged
three-state renderer remains in use. `?health-mock=island` is the illustrative
dev fixture. Desktop/mobile browser QA is separate from the still-outstanding
Rock 5B+ and Orange Pi 5+ visual checks; no new board validation is claimed.

