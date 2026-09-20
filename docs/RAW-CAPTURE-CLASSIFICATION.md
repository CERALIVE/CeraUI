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

## Published dependency boundary

This consumer requires companion cerastream bindings **2026.9.9 / schema 0.19.0**.
The package was published on 2026-09-18 from cerastream PR #177's merge commit
`c80e0ccc55c5ae5c0d1c7b75540efa8899ad543a`, tagged `bindings-v2026.9.9`.
The [publish workflow](https://github.com/CERALIVE/cerastream/actions/runs/35395597683)
passed, including 181 binding tests, and npm reports that exact `gitHead`.
Both backend and shared RPC now pin 2026.9.10, which carries this schema
additively (schema 0.20.0 adds only optional `active_encode` encode-telemetry
fields); the regenerated `bun.lock` carries
the registry tarball's SHA-512 integrity. The skew and exact-registry gates remain
unchanged. No local link or fabricated integrity is committed.

Earlier local candidate tests used the documented development-link workflow. Bun's isolated
workspace installs need the link at both backend and RPC package resolution sites.
The Zod catalog is aligned to the producer lock's 4.6.2 because Zod 4.4 and 4.6
schema internals are not type-compatible when schemas are composed. During linked
builds they must also resolve one physical Zod copy, or duplicate bundling trips
the existing chunk-warning gate. Release validation instead uses a forced frozen
registry install at both resolution sites. No gate was relaxed. Publication removes
the dependency blocker, not the requirement for green consumer CI and final review.

## Copy and scope

`packages/i18n/README.md` requires the same keys in all ten catalogs; no automatic
missing-key fallback or translation generator exists. English is authored once;
the three new keys use that same English wording in the other nine catalogs as
an explicit temporary fallback, pending reviewed translations. No guessed
translations or edits to the frozen rendered fixtures were made.

The separate multi-node enumeration repair is CeraUI PR #367. This PR does not
duplicate its `seenNames` removal or audio naming changes. The live verification
candidate used #367's exact head plus this patch, preserving the already-deployed
BRIO colour-source repair. PR #367 merged separately on 2026-09-18; this PR still
requires its own final merge authorization. Deploy this consumer before or together
with an engine emitting the new classifications; publishing npm does not update a board.

The Rock candidate reported video9 as unavailable `raw_video` and video7 as
available `mjpeg`, verified through authenticated source pushes. No reboot,
RAUC update, EDID write, capture start or preview was performed. Colour-source
enumeration/routing was preserved; a fresh streaming run was not authorized here.
No physical Elgato Cam Link 4K was available; its continuity is unit/golden-tested.
