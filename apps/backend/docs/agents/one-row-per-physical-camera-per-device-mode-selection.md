<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ONE ROW PER PHYSICAL CAMERA + PER-DEVICE MODE SELECTION [EXISTS]

A capability source is a PIPELINE; an operator points at a DEVICE. Conflating the
two put a permanent, unactionable row in the picker — `usb_mjpeg` rendered as
"USB MJPEG · not connected" forever — and let ONE dual-format camera answer to
TWO coarse rows at once.

**`SUPPRESSED_COARSE_PIPELINE_IDS` (`sources.ts`) drops the USB-capture coarse
rows in EVERY state**, not merely when a device bridges to them: `libuvch264`,
`usb_mjpeg`, `v4l_mjpeg`, `camlink`. `v4l_mjpeg` is the starkest case — NO device
kind bridges to it at all, so it can never be replaced by a concrete row and is a
phantom by construction. `hdmi` / `rtmp` / `srt` / `test` are deliberately NOT in
the set: each names a real, always-present port or capability of the board, so a
coarse row for it is truthful with nothing plugged in. The empty state is the
picker's single generic message, never a per-pipeline phantom. Board-proven A/B on
a Rock 5B+: 6 rows → 5, the phantom `libuvch264` gone, the other five byte-identical.

**A capture row carries every format the device advertises, each with its OWN
ladder.** `captureDevice.modes[]` (cerastream schema `0.11.0`) is threaded verbatim
through `fromEngineDevice` — the one engine-authored seam — and projected onto the
row as `inputModes[]`. Three properties are load-bearing:

- **A family is published only when its pipeline is OFFERED.** `buildInputModes`
  gates on the coarse capability set, exactly the rule `buildSources` already
  applies to a whole device. Without it a camera offers MJPEG on a board whose
  engine never advertised `usb_mjpeg`, and the pick dies at
  `pipeline_not_in_offered_set` AFTER the operator committed to it.
- **The ladders are never unioned** (ADR-0008 §10). Each family projects its own
  `caps` through the same `groupDeviceCaps` the flat list uses.
- **Parsing is per-FAMILY, not per-device.** An engine that reports an `InputKind`
  this build does not know drops that family; refusing the whole device would lose
  the camera.

**`config.input_mode` is a single field SCOPED to `config.source_stable_id`, not a
map.** "Per device" is satisfied by scoping: an operator pick that lands on
DIFFERENT hardware (compared by stable identity — node paths are recycled) CLEARS
the mode, so a choice made for one camera can never govern another. A keyed map
would need its own retention/eviction policy and would silently evict a stated
intent. Absent ⇒ the engine's own precedence, which is H.264 first — byte-identical
to every start before modes existed. Only an operator who explicitly picked a mode
sends one.

**Routing is mode-aware, because the two formats are two pipelines.** The same
camera reaches the engine through `libuvch264` in H.264 mode and `usb_mjpeg` in
MJPEG mode, so `deriveEngineRouting` re-answers the pipeline question against the
selected family (`pipelineIdForInputMode`, the mode-aware sibling of
`deviceKindToPipelineId`). A mode-only `setConfig` therefore re-routes the
PERSISTED selection without rewriting `config.source`.

**A mode switch mid-stream rides the EXISTING apply-now transaction.**
`input_mode` is an `APPLY_NOW_FIELDS` member and a `StreamConfigChangeDelta` field;
the engine owns the libuvc-release → re-enumeration-barrier → open transaction and
rolls it back honestly. Do NOT build a second transaction in CeraUI.

**Save-time validation intersects the SELECTED mode's ladder only.** This is ONE
substitution, not a fork: `@ceraui/rpc` `device-mode-truth.ts` already scopes a
ladder by "the media type the KIND names", so `device-mode-guard.ts`
`governingKind()` hands it the selected mode instead of the device's scalar kind.
`capabilities.ts`'s per-`media_type` split is untouched. The pick is trusted only
while the device still ADVERTISES it. An EXPLICIT `input_mode` the device does not
offer is REFUSED (`input_mode_unsupported`); a merely CARRIED one is silently
dropped — a refusal answers the operator's own action, but applying it to a value
they are not touching would let a device that stopped advertising a mode block
every unrelated save.

Coverage: `tests/one-row-per-camera.test.ts`.

