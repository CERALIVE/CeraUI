# Raw capture classification

The engine's `raw_video` is an uncompressed capture input, not an Elgato product
identity. CeraUI preserves that kind, renders the hardware name with a neutral
**Raw video** badge, and keeps the row disabled with the reason “This raw video
input is detected, but streaming from it is not supported.” There is no new
pipeline. The empty `pipelineId` represents no route; `deriveEngineRouting`
explicitly refuses it, independently of the UI disabled state.

`unknown` is a producer-classified node without a usable capture format. It
remains in device metadata but does not become a selectable source row. Neither
kind maps to Cam Link or HDMI through the pipeline bridge. Existing translated
labels are selected dynamically by SourceSection/EncoderDialog/LiveSourceSwitch;
their neutral video icon fallback is correct because raw video need not be USB.
The legacy InputPicker's unrecognized-group fallback stays non-Cam-Link too.

Cam Link's USB2 warning already checks Elgato VID/PIDs and is behaviorally
unchanged. `pipeline-sources.ts` describes selectable IDs, not discovery kinds.
The existing audio-reason enum is unchanged; a non-streamable raw input must not
gain Cam Link's fixed audio-card policy.

## Release prerequisite — not merge-ready until published

This consumer requires companion cerastream bindings **2026.9.9 / schema 0.19.0**.
The package is prepared, not published. Both committed registry pins intentionally
remain at 2026.9.8 until publication; replace BOTH pins and regenerate `bun.lock`
from the registry before merging. The strengthened skew and exact-registry gates
remain blocking. No local link or fabricated integrity is committed.

Local candidate tests use the documented development-link workflow. Bun's isolated
workspace installs need the link at both backend and RPC package resolution sites.
The Zod catalog is aligned to the producer lock's 4.6.2 because Zod 4.4 and 4.6
schema internals are not type-compatible when schemas are composed. During linked
builds they must also resolve one physical Zod copy, or duplicate bundling trips
the existing chunk-warning gate. No gate was relaxed.

## Copy and scope

`packages/i18n/README.md` requires the same keys in all ten catalogs; no automatic
missing-key fallback or translation generator exists. English is authored once;
the three new keys use that same English wording in the other nine catalogs as
an explicit temporary fallback, pending reviewed translations. No guessed
translations or edits to the frozen rendered fixtures were made.

The separate multi-node enumeration repair is CeraUI PR #367. This PR does not
duplicate its `seenNames` removal or audio naming changes. The live verification
candidate used #367's exact head plus this patch, preserving the already-deployed
BRIO colour-source repair. Review/land #367 alongside the classification rollout.

The Rock candidate reported video9 as unavailable `raw_video` and video7 as
available `mjpeg`, verified through authenticated source pushes. No reboot,
RAUC update, EDID write, capture start or preview was performed. Colour-source
enumeration/routing was preserved; a fresh streaming run was not authorized here.
No physical Elgato Cam Link 4K was available; its continuity is unit/golden-tested.
