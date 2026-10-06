<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ONBOARD VIDEO DISPLAY NAMES [EXISTS]

The video half of the same port needed the same treatment. cerastream reports the
RK3588 HDMI-RX capture node's `display_name` as the raw kernel driver id
`rk_hdmirx`, and once cerastream PR #69/#70 fixed its classification the node
became a real, selectable, connected row — so that raw id surfaced verbatim in the
Live source list AND in the "Configured" summary line above it.

`modules/streaming/onboard-display-names.ts` is the video counterpart of the audio
tier-0 rule and shares its key folding: `normalizeOnboardKey` lives there and
`audio-naming.ts` imports it, so both media types key their rules identically.
`ONBOARD_VIDEO_DISPLAY_RULES` maps `rkhdmirx` / `streamhdmirx` / `snpshdmirx` /
`rockchiphdmirx` / `rockchiphdmirxcontroller` → `HDMI Input` — deliberately the
SAME name the audio ladder gives `rockchip,hdmiin`, because the two are the video
and audio halves of ONE physical port.

**One node has SEVERAL spellings, and which one arrives depends on the engine
build.** The v4l2 CARD TYPE and the v4l2 DRIVER name are different strings for the
same block: a Rock 5B+ HDMI-RX reports card type `stream_hdmirx` but driver
`snps_hdmirx` (Synopsys DesignWare HDMI-RX — the IP Rockchip licenses).
Board-confirmed: after the engine moved to naming the node after its driver, the
raw `snps_hdmirx` rendered verbatim in the operator's source picker. Keying the
rule on the IP block rather than on a node path or board model is what makes it
work on every board carrying the same receiver. Like the audio rule it is code-level only: no UI, no RPC, no
config field. Adding a board is a code change.

**It is applied at the device-construction seam, not at each render site.** The
"Configured" label and the picker row are NOT separate code paths — both read
`StreamSource.displayName` off the single `sources` broadcast (the frontend's
`resolveSourceName` in `lib/streaming/sourceSummary.ts` and `SourceSection`'s row
label). So the rule fires once, in `fromEngineDevice()`
(`modules/streaming/devices.ts`), which every engine-device consumer flows through
— the `sources` builder, the legacy `devices` broadcast, and the persisted
`last_seen_devices` snapshots alike. Two supporting sites: `buildDeviceList()`
(the engine-down v4l2 fallback scan reads the same `rk_hdmirx` from
`/sys/class/video4linux/*/name`) and `buildLostEntry()` in `sources.ts` (a
snapshot persisted BEFORE this rule existed still holds the raw id, so it is
re-applied on read).

**Display-only, and the raw name still drives classification.** `input_id`,
`device_path`, and `stable_id` are untouched — routing is byte-identical — and
`mapEngineDeviceKind`/`deriveKind` are still passed the RAW string, so the kind
heuristic sees exactly what the engine reported.

Coverage: `tests/onboard-video-display-name.test.ts` (the pure rule, both device
seams, the rendered `sources` payload, and the lost row — the last two assert the
serialized payload contains no `rk_hdmirx` at all).

