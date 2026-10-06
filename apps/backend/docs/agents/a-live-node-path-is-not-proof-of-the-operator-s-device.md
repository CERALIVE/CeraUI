<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A LIVE NODE PATH IS NOT PROOF OF THE OPERATOR'S DEVICE [EXISTS]

The rule above refuses to resolve a node path several remembered devices answer
to. It only ever runs when the persisted id is NO LONGER LIVE, because
`resolveSourceIdentity` opened with a short-circuit:

```ts
if (sources.some((s) => s.id === sourceId)) return sourceId;
```

"Still live" and "still the same camera" are different questions, and the kernel
recycles `/dev/videoN`, so they come apart the moment two USB cameras are dropped
and restored in the opposite order. Measured on a Rock 5B+ with a RØDE
HDMI-to-USB-C and a DJI Osmo Pocket 3 (W4A4-F5, 2026-07-31 20:44–20:45Z, on a
binary that already carried the fixes above): the operator selected the RØDE at
`/dev/video2`, both cameras were re-authorized in the opposite order, the RØDE
landed on `/dev/video4` and the **Osmo took `/dev/video2`**. `config` was
untouched — `source: "/dev/video2"`, `pipeline: "usb_mjpeg"` — while
`/dev/video2` was now a `libuvch264` device, and a preview on the operator's own
configured source delivered **69 frames / 2 210 312 bytes with zero errors and
zero typed transitions**. The RØDE at its new node returned 47 frames / 97 741
bytes in the same minute: a 22× payload gap between two live cameras, with the
system routing the operator's selection to the one they did not choose.

Nothing could recover it after the fact. The identity layer worked perfectly —
both `stable_id`s survived and both `last_seen_devices` rows migrated — but
`config.source` persisted a node path with NO identity anchor, and after the fold
that path had several remembered claimants, so `unambiguousStableId` correctly
refused rather than guessed. The evidence has to be captured at SELECTION time.

**`config.source_stable_id` is that anchor** (additive-optional,
`helpers/config-schemas.ts`). It is written by `noteSourceSelectionWrite(sourceId)`
— so every site that advances the F10a token also records the identity, and the
two can never disagree — from `resolveSelectionAnchor(sourceId, sources)`, the
live capture row's `stableId`. A pick that names no single physical device writes
`undefined`, which CLEARS the previous anchor; leaving it would let a retired
camera govern a selection it has nothing to do with.

`resolveSourceIdentityDetailed` then verifies the live row before trusting it, and
reports the one outcome a bare id cannot express:

| Live row at the persisted path | Resolution |
|---|---|
| no anchor / not a capture row / no `stableId` | the id, unchanged (pre-anchor behaviour, byte-identical) |
| `stableId` === the anchor | the id, unchanged |
| a DIFFERENT `stableId`, anchored device live elsewhere | **migrate** to the anchored device's current node |
| a DIFFERENT `stableId`, anchored device gone | `takenOver` → `SOURCE_TAKEN_OVER_ERROR` |

- **It is suppression-only in the same sense #263 is.** Three of the four rows
  above resolve exactly as they did before the field existed, so a legacy config,
  a coarse source, and an engine that cannot vouch for a device's identity are all
  unaffected. Only positive, engine-authored proof of a DIFFERENT device changes
  anything.
- **The anchor OUTRANKS `unambiguousStableId` when the path is dead**, because it
  is the operator's own word rather than a retroactive inference — and it is the
  only thing that still works once a recycled path has several claimants.
- **A freshly stated pick carries no anchor.** `configuredSelectionAnchor(id)`
  answers `undefined` unless `id` IS `config.source`; the operator is choosing
  from the list in front of them, so the row they tapped is what they mean
  whatever it was called before. `streaming.setConfig` therefore passes NO anchor
  and writes a fresh one; only the START path (resolving the PERSISTED selection)
  and the reconciler pass one.
- **`SOURCE_TAKEN_OVER_ERROR` is distinct from `SOURCE_LOST_ERROR`** — the path
  resolves fine, it just no longer names the operator's camera. Keyed operator
  copy: `live.startFailed.source_taken_over` (10 locales).
- **Preview refuses instead of opening the inheritor.** `resolvePreviewInputId`
  answers `null` on a takeover and the proxy replies with the typed
  `{"type":"preview-error","reason":"source-unavailable"}` frame CeraUI already
  bands. The "resolves, never rejects" contract is otherwise unchanged — a true
  unplug still passes through so the ENGINE authors the reason.
- **The periodic signal recheck reconciles too**, and that is load-bearing rather
  than tidy. The hotplug refresh fires on a device-SET change, and on the board it
  fired at 20:49:00.661 with only the INHERITOR enumerated — correctly refusing to
  migrate, since there was nowhere honest to migrate to — while the anchored
  camera re-enumerated seconds later and no further set change ever fired. The
  right camera sat in the very same list for the rest of the session with
  `config.source` still naming the wrong one. `broadcastSourcesIfChanged` is the
  only periodic re-poke, so reconciling there bounds that self-heal to one
  `VIDEO_SIGNAL_RECHECK_INTERVAL_MS`.

Board proof (same board, same crossed-renumber drill, before and after the fix,
2026-07-31 20:44–20:58Z): pre-fix, the operator's selection silently became the
Osmo and previewed 69 frames / 2.21 MB of it. Post-fix, the same drill migrated
`config.source` `/dev/video5` → `/dev/video2` by anchor the moment the RØDE
re-appeared, and a preview on `config.source` returned **48 frames / 99 848
bytes** — the RØDE's signature, within 2% of its pre-fix control. The fixed binary
also corrected, on its first boot, the wrong pairing the pre-fix drill had left on
disk. Genuine same-identity renumbers still migrated throughout.

Coverage: `tests/source-cross-device-renumber.test.ts` (the anchor written through
the REAL `setConfig` procedure and cleared by an unidentified pick, the crossed
renumber routing the anchored camera, the typed takeover, the reconciler's
persisted migration, the periodic-recheck self-heal, both preview arms, and the
four regression controls: a genuine same-identity renumber, an anchorless legacy
config, an anchored path still held by its own device, and a live row with no
`stableId`).

