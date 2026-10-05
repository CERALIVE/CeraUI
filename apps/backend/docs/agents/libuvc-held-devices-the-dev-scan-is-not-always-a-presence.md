<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## LIBUVC-HELD DEVICES — THE `/dev` SCAN IS NOT ALWAYS A PRESENCE ORACLE [EXISTS]

Everything above rests on one premise: the device registry's own
`/sys/class/video4linux` scan truthfully answers "is this device plugged in".
For ONE family of capture devices that premise is simply false, and CeraUI kept
reporting a working camera as disconnected because of it.

`libuvch264src` never opens a v4l2 node. It drives its camera through **libuvc**,
i.e. through **usbfs**, which unbinds the kernel `uvcvideo` driver from the USB
interface for the whole session. So while the engine is streaming or previewing
such a camera, `/dev/videoN` is **legitimately gone** — and on release the device
comes back under a DIFFERENT number. Absence from `/dev` is what a *working*
libuvc capture looks like.

cerastream already knows this about itself: a leg whose resolved `InputKind` is
`UvcH264`/`UvcH265` records the device it holds, and both `capture_rebind_tick`
and `list_devices` union that set over the v4l2 registry (cerastream PR #84 for
the streaming leg, PR #86 for the idle preview). Its `list-devices` is therefore
**correct** — proven live, retaining `/dev/video1` for a whole session.

CeraUI has a **second, independent** presence signal that had no such notion, and
`mergeObservedWithProbe` takes video membership from it. So the engine answered
"present, I am holding it", the local scan said "no such node", membership won,
and the row was dropped — surfacing as a `Lost` / "Device disconnected" badge on
a camera whose preview was live on screen at that moment.

- **`modules/streaming/held-devices.ts` `releasesV4l2Node(kind)`** is the
  CeraUI-side mirror, scoped exactly like the engine's rule: on the resolved
  device **KIND** (`uvc_h264` / `uvc_h265` — the two kinds
  `DEVICE_KIND_TO_PIPELINE_ID` bridges to `libuvch264`), **never** on a vendor
  id, product id, serial, or display name. Every UVC-H.264/H.265 camera behaves
  this way and no other kind does.
- **A probe-listed device of such a kind survives the membership filter.** Every
  other kind keeps the byte-identical observation-wins rule, including the two
  cases that rule exists for (a failing probe must not mask a removal; a stale
  probe must not mask a replug) — this only ever ADDS a device the engine
  positively vouches for.
- **A real unplug still reports lost.** An unplugged camera is in neither the
  engine's v4l2 registry nor its held set, so it is absent from the probe too.
  The exemption cannot manufacture a device the engine did not name.

Do NOT try to fix this class of symptom by suppressing the `lost` badge, by
special-casing a model, or by having CeraUI track preview/stream state to guess
at a hold — the engine already tracks the hold authoritatively and reports it;
CeraUI's job is only to stop overruling that answer with a scan that cannot see
the device. Coverage: `tests/source-renumber-dedup.test.ts`.

