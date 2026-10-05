<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE AUDIO BACKEND IS OFFERED ONLY WHERE THE ENGINE ADVERTISED IT [EXISTS]

`lib/streaming/audioBackend.ts` (pure, rune-free) is the offer rule behind the
Audio dialog's engine-backend selector — the operator half of the device contract
in [`../backend/AGENTS.md`](../../../backend/AGENTS.md) → THE AUDIO BACKEND IS AN
OVERRIDE, AND ABSENT IS NOT A DEFAULT. `AudioDialog.svelte` layers state on it and
`audio/AudioDialogContent.svelte` renders it; neither re-derives the rule.

FOUR rules carry it, and each one is a defect the module exists to prevent:

1. **A backend the capability payload does not list is NEVER offered.** The option
   list is `capabilities.audio_backends.supported` and nothing else — not the
   enum, not the persisted selection, not the pair. `canSelectAudioBackend`
   mirrors the device's OWN `isAudioBackendSupported` gate, so a click can never
   spend a round-trip to be refused for something the offering already knew.
2. **ABSENT IS NOT `alsa`.** `config.audio_backend` is absent on every device in
   the fleet and means "the operator stated nothing", which hands the ENGINE's own
   default (shipped: pipewire) the decision. The resting selection is therefore
   the engine's own `active`, rendered beside an always-visible "Running now" line
   — never the first enum member, which would misreport every unconfigured board.
3. **An absent capability block renders ZERO nodes** (`data-testid="audio-backend"`
   is absent entirely). The engine never stated a capability — a legacy build, or
   a fallback snapshot — so there is nothing being withheld to explain, and a
   disabled control there would imply one. Same CT-1 rule the modem capability
   dialog follows, and it is what keeps an older engine byte-identical to today.
4. **ONE supported backend is a STATE, not a choice.** It renders — the operator
   still needs to know which arm this build runs — but disabled, with the reason on
   screen (`audio-backend-single-reason`), because the kiosk touchscreen cannot
   hover. A radiogroup of one is a control that cannot act.

- **It writes on SELECTION, not on Save, and that split is deliberate.** The field
  is next-session-only by construction (the engine fixes its backend at graph-build
  time and answers a live reload `applies: "next-session"`), so it dispatches its
  own `setConfig`. The dialog's Save button commits the codec/delay DRAFT; folding a
  platform switch into it would make one press mean two unrelated things. The
  "takes effect at the next start" line (`audio-backend-next-start`) renders
  whenever the selection differs from the running arm.
- **PESSIMISTIC, the `NetworkIngestDialog` discipline.** Nothing is assigned on
  dispatch: the rendered selection moves only on the device's APPLIED echo
  (`result.applied.audio_backend`), so an RPC that resolves `{success:false}` is
  structurally unable to move the control. The spinner
  (`audio-backend-applying`) is the sole optimistic element.
- **A REFUSAL IS AN EXPLICIT BAND, never a swallowed result** — the preview-error
  honesty rule (root `AGENTS.md` → typed preview failures): the operator must never
  be left with a control that looks busy or unchanged with no stated outcome.
  `streaming.setConfig` RESOLVES with `{success:false, error}` rather than throwing,
  so `result.success` is read BEFORE anything else — the same trap
  `encoderSaveError.ts` exists for — and the typed
  `audio_backend_unsupported` is mapped through `audioBackendSaveErrorMessage` to
  keyed copy in a `role="alert"` band (`audio-backend-error`). The machine token is
  never rendered, and the spinner is always cleared, so the band IS the end of the
  attempt.
- **A STORED selection this build no longer advertises is STATED, not offered.**
  `staleSelection` bands it (`audio-backend-stale`) while the radiogroup stays
  supported-only, so the truth about what is on disk survives without rule 1 being
  bent.
- **The backend NAMES are not translated copy.** `ALSA` and `PipeWire` are the
  subsystems' own proper nouns and read identically in every locale — the same rule
  the modem identity line follows for device strings.
- **A FEDERATED mount reads the HOST's snapshot.** `initSubscriptions()` never runs
  inside a hosted bundle, so `getCapabilities()` there is permanently `undefined`
  and the selector would render nothing forever. `FederationMountOptions` gained an
  ADDITIVE-OPTIONAL `capabilities` (and `audio-entry.ts` threads `config.audio_backend`
  through the existing `config`), so `federationAbiVersion` stays 1 and a host that
  passes neither gets the pre-Todo-20 dialog exactly. The ABI's additive-only
  promise is mechanically pinned by `lib/federation/host-contract.test.ts` (the
  REQUIRED set is frozen at `host`; every added member must be optional) and by the
  BUILT-bundle legs in `tests/federation/federation-abi.test.ts`.
- **…AND THE CODEC/DELAY GATE IS ONE RULE, NOT TWO.** `hasAudioSupport` has always failed
  OPEN for a hosted mount (`hostAdapter !== undefined || gateState === 'enabled'`)
  — a federated bundle runs no `initSubscriptions()`, so `getSources()` there is
  permanently `undefined` and the pipeline gate has NO evidence to evaluate — but
  only the Save button read it. `AudioDialogContent` still read the raw
  `gateState`, so every hosted mount rendered "Select a pipeline first" beside an
  ENABLED Save and offered no codec or delay controls, whatever the host passed.
  `contentGateState` applies the same rule to those controls. The backend selector
  is deliberately OUTSIDE that gate: it changes which subsystem builds audio on
  the NEXT start and may be the prerequisite for making that start possible, so it
  remains reachable while codec/delay honestly show the no-pipeline or
  no-audio-support band. Its own `audio_backends` capability remains the sole
  visibility gate. Do NOT re-split the Save/content codec-delay gate, and do not
  nest the backend selector beneath it again. Coverage: `AudioDialog.backend.test.ts`
  → the hosted no-subscription leg and the device no-pipeline selector regression,
  and the built-bundle legs in
  `tests/federation/federation-abi.test.ts`, which are what caught it (the jsdom
  tests mock the subscriptions the real bundle does not have).

Copy: `settings.audioBackend.*` (9 keys × 10 locales). Coverage:
`lib/streaming/audioBackend.test.ts` (the pure rule, written against the four rules
above), `main/dialogs/AudioDialog.backend.test.ts` (rendered DOM — the zero-node
gate with its positive control, the applied-echo move, both refusal arms, and the
federated mount), and `tests/e2e/audio-backend.spec.ts` (the two operator
scenarios; the refusal leg is driven by the device's OWN fail-closed gate rather
than a stub).

