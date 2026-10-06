<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AUDIO-DEVICE NAMING [EXISTS]

**Production v7.2 also reports `HDMIIN` / `RK3588 HDMI-IN`.** Rock's
2026-09-18 raw ALSA inventory uses that third spelling, not `hdmirx`.
The onboard display table accepts the card ID and longname; Auto's ordered
`HDMI_CARD_IDS` appends `HDMIIN` without changing the older spellings' precedence
or the capture-PCM gate. No persisted selector is renamed. A missing PipeWire
node still falls to the kernel longname and receives the same onboard label.

**A video presence scan must retain EVERY node before the engine join.**
`buildDeviceList` no longer deduplicates display names. Rock's BRIO publishes
`video7`–`video10` under one name: lexicographic order picks metadata-only
`video10` first, and the former dedup removed both real capture nodes. The
membership-authoritative merge then discarded the engine's healthy `video7`
and `video9` rows. Numeric sorting alone would still lose same-model cameras
and other capture interfaces. Keep node membership complete; only engine-typed,
pipeline-bridged rows become sources. Regression:
`tests/source-enumeration-regression.test.ts`, including a true-unplug control.

`modules/streaming/audio-naming.ts` turns the raw audio-card map into per-card
operator-facing labels. Resolution is PURE (the one documented exception is the
tier-3 diagnostic below) and runs a **4-tier** ladder:

| Tier | Source |
|------|--------|
| **0** | a STATIC, code-level display-name rule for a known ONBOARD card (`ONBOARD_AUDIO_DISPLAY_RULES`) |
| 1 | the engine `list-devices` entry joined on `alsa_card_id` (`product_name`, then `display_name`), each gated by `isHumanAudioName()` |
| 2 | the `/proc/asound/cards` longname |
| 3 | the current generic alias/name (byte-identical fallback) |

**There is NO operator rename anywhere in CeraUI.** No text field, no RPC, no
config field, for any device. Device naming is either the cleaned hardware name
(tiers 1-2) or a code-level rule (tier 0) reviewed like any other source change.
Do not re-add an alias/rename surface.

**Tiers 1 and 2 both carry RAW device strings and are CLEANED before display.**
On Linux both are literally the ALSA longname — `sound/usb/card.c` appends
`" at usb-<bus>-<devpath>, <speed> speed"` to `"<manufacturer> <product>"`, and
cerastream sets an audio entry's `display_name` to that same longname. A live
operator report showed both leaking verbatim into the picker, via *different*
tiers:

- **tier 1** — `RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed`
  (engine `product_name` was the generic `"usbaudio"`, rejected for equalling the
  card id, so the heuristic fell through to the longname-valued `display_name`);
- **tier 2** — `DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed`
  (no engine entry for that card at all).

`cleanAudioDeviceName(raw)` fixes both: it strips the kernel bus/speed tail
(anchored on the trailing `speed` word, so a product name merely CONTAINING
" at " is never truncated) and collapses a manufacturer duplicated as the product
prefix. The duplicate rule is generic — no vendor allowlist: the first token must
reappear later with ONLY corporate filler (`Technology`, `Co.`, `Ltd.`, `Inc`, …)
in between; any other token BLOCKS the collapse, so `"Blue Microphones Yeti Blue"`
is left alone. Diacritics are not folded (`Rode` ≠ `RØDE`) — a wrong collapse
silently mangles a real product name.

**Tier 0 — static onboard display-name rules.** Cleaning cannot help a card whose
only hardware string is a raw driver id: the RK3588 HDMI-RX capture card reports
`rockchip,hdmiin` through every tier (engine, longname, and card id alike), and
there is nothing human in it to recover. `ONBOARD_AUDIO_DISPLAY_RULES` maps such
a card to a fixed operator-facing name (`rockchiphdmiin` → `HDMI Input`,
`rockchipes8388` → `Onboard Audio`). Keys are normalized through
`normalizeOnboardKey` (punctuation + case folded), so ONE entry matches every
spelling of the same block — the ALSA card id `rockchiphdmiin`, the driver name
`rockchip_hdmiin`, and the longname `rockchip,hdmiin`. `resolveOnboardDisplayName`
probes the card id first, then the raw hardware string. Only cards that can
actually REACH the picker are listed — `updateAudioDevices` already excludes the
HDMI-output and codec-playback cards. Adding a board is a code change.

**Punctuation folding is not enough for the HDMI-RX — it has TWO card ids.**
Which one a board reports is decided by the KERNEL TRACK, not the hardware: the
vendor 6.1 BSP registers the port's audio half as `rockchiphdmiin`, while
mainline / Armbian `edge` 7.1 registers the SAME port as `hdmirx` (the
first-party `simple-audio-card` DT node over the Synopsys receiver). They do not
fold onto one key, so BOTH are listed — the audio twin of the several-spellings
rule `ONBOARD_VIDEO_DISPLAY_RULES` already carries for the video half, and of
`auto-audio.ts`'s `HDMI_CARD_IDS`.

**The raw string is moved, never deleted.** It rides `AudioSource.detail`
(diagnostic-only: a tooltip on the picker rows and the read-only source line) so
the bus path, link speed, full legal manufacturer name, and the raw driver id a
tier-0 rule replaced all stay available for debugging. `detail` is absent when the
resolved name is already the raw string.

**External vs onboard is a READ-ONLY marker, derived from `transport`.** The
engine's `transport` field (`usb` / `hdmi` / `bluetooth` / `onboard`, corrected in
cerastream PR #69) rides `AudioSource.transport` through `resolveAudioIdentities`
unchanged. The frontend turns `usb`/`bluetooth` into an "External" badge
(`isExternalAudioSource`, `apps/frontend/src/lib/streaming/sourceSummary.ts`).
NEVER re-derive external-ness from bus-path string matching — the engine reports
it correctly.

`deriveAudioSources()` defaults its display/identity args to the last resolved
maps, so the pull-based `status` snapshots (`modules/ui/status.ts`,
`rpc/procedures/status.procedure.ts`) serve the same labels as the push
broadcast instead of falling back to the bare asrc key.

Coverage: `tests/audio-device-naming-cleanup.test.ts`, `tests/audio-naming.test.ts`.

### …AND THE LADDER IS THE SAME ON THE PIPEWIRE ARM — PROVEN, NOT ASSUMED [EXISTS]

cerastream's `[audio] backend = "pipewire"` arm changed WHERE an audio row's
identity comes from — PipeWire node props resolved back through the engine's
`sources/pw_identity.rs` — and deliberately not what a device is CALLED. The
engine still builds an audio row's `id` as `hw:CARD=<card>` FIRST on both arms
and still publishes `alsa_card_id`, so this ladder needs no change at all.

**That is a claim, so it is tested rather than stated.**
`tests/audio-naming-pipewire-arm.test.ts` renders ONE physical roster as BOTH
arms' `list-devices` payloads, drives each through the REAL `probeEngineDevices`
whitelist copy and the REAL ladder, and compares. Three properties carry it:

- **`device_path` is the field the arms genuinely disagree about, and it is not
  a naming input.** On the ALSA arm it is the provider's own path (`hw:5,0`); on
  the PipeWire arm it is `PipeWireNodeIdentity::persisted_device()`, i.e.
  `hw:CARD=<id>`. It is absent from the AUDIO whitelist entirely, so it cannot
  reach `EngineAudioDevice` — asserted in both directions (the payloads differ,
  no crossed row carries the key), which is what stops the equality above being
  a tautology.
- **`device_address` is the one PipeWire-only field that DOES cross, and it must
  move nothing.** This is CeraUI's half of the engine's own
  `a_node_that_advertises_a_device_address_carries_it_verbatim` contract: the
  field reaches the row (proven, or the comparison is vacuous) and no label,
  detail or identity changes with it.
- **Tier 2 is provider-independent by construction.** It is
  `/proc/asound/cards`, a kernel file CeraUI reads itself, so the tier a failed
  tier-1 join falls to cannot drift between arms — including for a PipeWire node
  whose provider published no `api.alsa.card.id` at all, which falls to tier 3
  and still logs the same one-shot diagnostic naming
  `engineEntriesWithoutJoinKey`.

**Honesty boundary: the ladder is proven provider-agnostic; a provider's own
human STRING is not pinned.** `display_name` is authored by whichever GStreamer
device provider enumerated the node, so a PipeWire node description could be
worded differently from the ALSA card longname on real hardware. That can only
change which cleaned string tier 1 yields — it cannot change the join key, which
tier fires, the picker key, `config.asrc`, routing, or the meter preference, and
a non-human value still loses to the kernel longname on BOTH arms. No board has
run this ladder on the PipeWire arm; that is the todo-31 drill's.

**The resolved label/identity maps are re-resolved when the ENGINE list changes,
not only on a udev hotplug.** `lastAudioDisplays` / `lastAudioIdentities` are built
inside `broadcastAudioSources()`, which only `updateAudioDevices()` called — and
that runs on the SIGUSR2 udev hotplug and at boot. The engine's own audio
enumeration lands on ITS schedule, seconds later, through `sources.ts`
`commitEngineDevices` (the 5 s signal recheck and the video-hotplug probe both
commit it). Nothing re-ran the join, so whatever the maps resolved to at plug time
LATCHED. Confirmed live on a Rock 5B+: a DJI Osmo Pocket 3 plugged in mid-session
rendered with no `transport` and no `stable_id` for the rest of the session while
the engine had been reporting `alsa_card_id: "DJIPocket3"`, `transport: "usb"`,
`stable_id: "card:DJIPocket3"` within seconds of the plug; one manual SIGUSR2
filled both in instantly. Same latched-stale class as `policy_route_missing` and
the video signal recheck.

`commitEngineDevices` now fires an injected handler when the SERIALIZED audio list
changes (default: a lazy `import("./audio.ts")` — `audio.ts` imports `sources.ts`,
so a static import would cycle; the same shape `devices.ts` uses for
`onDevicesChanged`). The handler is `reresolveAudioForEngineChange()`, deliberately
NOT the whole of `updateAudioDevices()`: the sysfs card scan has not changed
(nothing was plugged), so re-walking it would raise a spurious lost-device verdict
and re-blink the meter through `noteMeterSelection`. Only the engine JOIN goes
stale, so only `broadcastAudioSources()` + `refreshResolvedAsrcPreview()` are
redone; `syncAudioMeterPreference()` is skipped because the meter preference
resolves from the sysfs card map. Keyed on the serialized list, so the 5 s recheck's
steady state costs one string compare and broadcasts nothing.
`setEngineAudioChangeHandler()` is the test seam. Coverage:
`tests/lost-device-retention.test.ts`.

