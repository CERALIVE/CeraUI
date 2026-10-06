<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEVICE-FIRST SOURCE MODEL [EXISTS]

`modules/streaming/sources.ts` is the single builder behind the `sources`
broadcast (experience-simplification plan). It folds the coarse pipeline
registry, the engine's `list-devices` result (cached via
`refreshEngineDeviceCache`/`getEngineDeviceCache`), and the network-ingest
gateway status into ONE ordered `StreamSource[]` list — `getSourcesMessage()` =
`{hardware, sources}` (schema: `packages/rpc/src/schemas/sources.schema.ts`).
Every row is one of four `origin` variants (`capture`/`coarse`/`virtual`/
`network`); a bridged capture device REPLACES its coarse base entry in place
(order-preserving) via `DEVICE_KIND_TO_PIPELINE_ID` (`@ceraui/rpc`
`intersect-caps.ts`).

- **`config.source`** persists the operator's pick as a single id. Legacy
  configs (no `source` field) are coerced ONCE at load
  (`coerceLegacySource`, `helpers/config-schemas.ts`) — a pure exported
  function (not a schema `.transform`, so `runtimeConfigSchema` stays a
  `ZodObject` and `validateConfig` can keep calling `.partial()`), never
  throws, logs once.
- **`deriveEngineRouting(sourceId, sources)`** resolves a source id to the wire
  pair the engine needs (`{pipeline, selected_video_input}`) — capture routes
  to its bridged pipeline + `input_id`; coarse/virtual/network route to their
  pipeline id with `selected_video_input` explicitly `undefined` (clears a
  stale capture selection; the engine's existing `config.selected_video_input
  ?? getActiveInput()` fallback fills it). `resolveSourceRouting()` wraps this
  with the `unknown_source` rejection and is the seam BOTH
  `streaming.setConfig` and `streaming.start` call BEFORE any config mutation
  or engine dispatch — `cerastream-backend.ts` is untouched by this entire
  model (a `git diff`-based regression test proves it byte-for-byte).
- **Shim policy**: the legacy `devices` broadcast (`modules/streaming/
  devices.ts`), the `pipelines` broadcast (`rpc/procedures/
  streaming.procedure.ts`), and the coarse `capabilities.device_modes` field
  (`modules/streaming/capabilities.ts`) are kept running byte-for-byte
  unchanged as a rollback safety net. Only `SourceSection`/`StreamSetupChain`
  read `getSources()` exclusively today — `EncoderDialog.svelte`
  (`getPipelines`+`getDevices`), `AudioDialog.svelte` (`getPipelines`),
  `LiveView.svelte` (`getPipelines`), and `StreamingStateManager.svelte.ts`
  (`getPipelines`) all still consume the legacy getters directly
  (`GoLiveCard.svelte`, which this note originally named, is now an unmounted
  migration shim; see frontend `AGENTS.md`). The real exit condition: migrate
  those four consumers off `getPipelines`/`getDevices` onto `getSources()`-
  derived data, THEN ship one release with no rollback needed, THEN delete the
  producers/fields. Tracked as `TD-legacy-source-broadcasts` in
  `docs/TECHNICAL_DEBT.md`; do not delete the producers until that entry's
  exit condition is met.
- **Hotplug re-enumeration reconciliation (Todo 34)**: a capture device that
  re-enumerates under a new node path (video1→video2, e.g. a USB reset or
  module unbind-rebind) is reconciled by STABLE IDENTITY, not node path. The
  engine's `stable_id` (cerastream Todo 20, `usb:<vid>:<pid>[:serial|@port]`) is
  threaded verbatim through `fromEngineDevice()` → the engine-device cache →
  the persisted `last_seen_devices` snapshot (`stableId`). In `buildSources`,
  a remembered snapshot absent from the live list by node path but PRESENT by
  stable identity is dropped (the live successor owns the row) — so a rename
  migrates the row instead of leaving a stuck `lost:true` row. A TRUE unplug
  (no live device shares the snapshot's stable id) still yields a `lost` row,
  and an engine that never emits `stable_id` degrades to the prior node-path
  behavior. Coverage: `tests/sources.test.ts` ("hotplug re-enumeration
  reconciliation (Todo 34)").
- **A REMEMBERED device is keyed by stable identity too, not just the live row.**
  Todo 34 reconciled the rendered row; the persisted memory behind it was still
  keyed on the node path, so `mergeLastSeenLru` and the session-seen snapshot map
  treated every renumber as a NEW device. That was harmless while renumbering was
  rare — and stopped being rare the moment libuvc capture landed, because a
  libuvc-driven camera renumbers on EVERY open/close cycle. Confirmed from a live
  board's own `config.json`: THREE `last_seen_devices` entries (`/dev/video1`,
  `/dev/video2`, `/dev/video3`) under one identical
  `stableId: "usb:2ca3:0023:…"` — one camera, three operator-visible rows, and
  three separate `lost` candidates when it was absent.
  `identityKey()` (stableId when present, else the node path) is now the key for
  BOTH the persisted merge and `collectLostCandidates`, so a renumber updates the
  existing entry's `id`/`devicePath` IN PLACE. Two properties are load-bearing:
  - **It self-heals.** The fold runs over the observed AND persisted halves
    together, so a `config.json` that already carries duplicates collapses on the
    next observation — a device does NOT need a hand-edited config.
  - **The retired paths are KEPT, on `previousIds`.** Folding without them would
    strand a `config.source` still holding a retired path: `resolveSourceIdentity`
    looks the id up in `last_seen_devices` to recover its stable identity, and a
    folded-away entry answers nothing. This is the persisted twin of the
    `previousIds` already published on the live capture row, for the same reason.
    Capped at `RETIRED_ID_MEMORY` (8) — a libuvc camera renumbers indefinitely.
  Scoped on the engine's `stableId` alone: a device the engine gives no stable
  identity for still keys on its node path, byte-identically to before.
  Coverage: `tests/source-renumber-dedup.test.ts`.
- **Source-routing self-heal across a renumber (PR #197)**: Todo 34 migrates the
  source-list ROW by stable identity, but the persisted operator selection
  (`config.source`) is a literal engine id (e.g. `video1`). When that device
  re-enumerates under a new node (`video1`→`video2`, same hardware), the routing
  seam used to resolve `config.source` by literal id only, so the stale id failed
  closed as `unknown_source` and the chosen device stopped routing until the
  operator re-picked it. `resolveSourceRouting()` now runs a `resolveSourceIdentity()`
  step: when the persisted id is no longer live, it recovers the id's stable identity
  from `last_seen_devices` and routes to the live capture source that shares it. A
  genuinely different device (no stable-identity match) is NEVER adopted, and a
  missing identity still fails closed. This is additive — it consumes the
  already-published cerastream `stable_id` (no binding change) and is the UI-side
  mirror of the engine's operator re-promotion (cerastream PR #66). The stable id is
  threaded additive-optional through `StreamSource` (`sources.schema.ts`). Coverage:
 `tests/sources.test.ts`.
- **THREE capture-row states, not two (`signal`)**: a capture row is one of
  **healthy** / **lost** / **signal-absent**, and the third one is new. `lost`
  (`buildLostEntry`) means the device DISAPPEARED — it is not in the engine's
  device list at all. `signal:'absent'` means the device IS enumerated and IS
  bound but the engine projected ZERO capture modes for it: exactly what an idle
  HDMI-RX port looks like (`v4l2-ctl --query-dv-timings` answers "Link has been
  severed", yet `list-devices` still returns the node). Found live on a board,
  where such a row rendered with NO negative marker at all and read as healthy.
  The field is ADDITIVE-OPTIONAL on both `captureDeviceSchema` and
  `captureSourceSchema` (`sourceSignalSchema` in `streaming.schema.ts`), so a
  consumer that does not know it is unaffected.
- **The verdict is stamped at `fromEngineDevice`, and PROVENANCE — not
  absent-vs-empty caps — is the discriminator.** Verified on a real Rock 5B+:
  cerastream **OMITS** `caps` entirely for the severed-link node (the live UVC
  device beside it carries 64), so "empty array" and "no array" are
  indistinguishable on the wire and a rule keyed on that difference would report
  the signal-less device as `unknown` and render nothing. What actually
  distinguishes the two cases is WHO authored the row: `fromEngineDevice`
  (`devices.ts`) is the one seam that knows the engine answered, so zero caps
  there is a real finding (`absent`) rather than a gap. `buildDeviceList`'s v4l2
  fallback scan and the hotplug path's observed-but-unprobed rows leave the field
  UNSET — stamping them `absent` would mark every device signal-less during an
  engine outage — and `buildCaptureEntry` reads `device.signal ?? "unknown"`. Do
  NOT move this derivation into `sources.ts`/`buildCaptureEntry`: that layer
  cannot see provenance. This is the same "apply it at the device-construction
  seam, not per-consumer" rule as ONBOARD VIDEO DISPLAY NAMES above.
- The new state changes nothing else: the row stays `available:true`, stays
  selectable, and `resolveSourceRouting` still routes it (a signal can appear at
  any moment). `capabilities.ts` `foldDeviceModes` is untouched — it still drops
  capless devices from `device_modes` for its own consumers. Frontend half:
  `apps/frontend/AGENTS.md` → "No-signal capture row". Coverage:
  `tests/devices.test.ts` ("fromEngineDevice — signal verdict", incl. the
  fallback-scan negative) + `tests/sources.test.ts` ("capture signal state").
- **`getLinkTelemetry` null-on-stop** is a backend-locked contract:
  `stopLinkTelemetry()` clears the source state so the NEXT heartbeat tick's
  `broadcastLinkTelemetryIfChanged()` emits `{linkTelemetry: null}` exactly
  once (the dedupe cache is deliberately NOT reset in the stop path, so a
  second consecutive `null` tick is suppressed). See `apps/frontend/AGENTS.md`
  → "Telemetry-clears-on-stop" for the matching frontend-side guarantee.

