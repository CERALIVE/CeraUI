<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE AUDIO BACKEND IS AN OVERRIDE, AND ABSENT IS NOT A DEFAULT [EXISTS]

`config.audio_backend` (`alsa` | `pipewire`) is the operator's override of the
engine's audio backend. It is OPTIONAL, and the entire contract is what its
ABSENCE means — the field is deliberately missing from `RUNTIME_CONFIG_DEFAULTS`,
so absent stays absent through every load.

**ABSENT ⇒ CeraUI serializes NO backend key at all**, on the start payload AND on
the reload payload, and the ENGINE'S own persisted default governs (shipped:
pipewire). Every config in the fleet today carries no such key, so a CeraUI-side
default constant would silently move the whole fleet onto whichever arm this repo
happened to name — which is exactly the regression `tests/audio-backend-config.test.ts`
exists to catch. Do NOT add a `?? "alsa"` to `encodeInputAudioFields`, to
`toReloadParams`, or to the schema.

- **The wire enum is a MIRROR with a compile-time gate.** `@ceraui/rpc`'s
  `audioBackendSchema` is CeraUI-owned (that package is browser-safe and carries
  no `@ceralive/cerastream` dependency), so drift is caught by the S6 assertion in
  `cerastream-wire-skew.ts` rather than by prose. The backend module itself
  imports the producer's `AudioBackend`/`audioBackendSchema` directly.
- **`startParamsWithAudioModeSchema` must RESTATE `backend`.** Zod's `.extend`
  REPLACES the published `audio` object wholesale, so a field the frozen schema
  already carries is silently stripped off every start unless it is re-declared in
  the local raw-bridge schema. Same silent-strip class as `probeEngineDevices`'
  whitelist copy.
- **Acceptance is CAPABILITY-GATED and FAIL-CLOSED** (`audio-backend.ts`
  `isAudioBackendSupported`): a selection is accepted only while the live
  `capabilities.audio_backends.supported` list names it. An absent block — a
  legacy engine, or a snapshot that fell back to the minimal safe set — refuses,
  because the engine never stated a capability and an unverifiable claim must not
  become a persisted selection. This is the deliberate opposite of
  `device-mode-truth.ts`'s fail-open rule: that one refuses to BLOCK a save on an
  unknown, this one refuses to CREATE a selection on one. Nothing is lost, since
  absent is already the working state on every device.
- **The gate runs BEFORE the first config mutation**, like the device-mode gate,
  so a refusal (`audio_backend_unsupported`) leaves `config.json` byte-identical —
  including the unrelated fields riding the same save.
- **It is never staged behind `apply_now`.** The engine fixes its backend when it
  builds the graph and answers a live reload with `applies: "next-session"`, so a
  change can only ever take effect at the next start. The reload still re-states
  the choice; it does not switch a running session.
- **A backend the engine later REFUSES surfaces the engine's own typed error
  verbatim.** There is no silent revert to the other arm anywhere on this path —
  an operator whose selection stopped working is told, not quietly moved.

There is deliberately no CLEAR path yet: an absent input field means "do not
touch", so returning a device to the engine default is a UI concern for the
selector that offers the field.

Coverage: `tests/audio-backend-config.test.ts` (the stated-selection serialization,
the ABSENT-field regression on both payloads, the fail-closed gate table, the
config.json round-trip incl. the never-defaulted assertion, and the RPC surface
driven through the REAL procedures). Rule-E proof captured in three directions: a
`?? "alsa"` default reddens 3 tests, dropping `backend` from the raw start schema
reddens 2, and flipping the gate fail-open reddens 2.

