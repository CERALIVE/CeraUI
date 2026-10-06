<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a new RPC procedure | `contracts/{domain}.contract.ts` → wire into `contracts/index.ts` |
| Add/change input or output shape | `schemas/{domain}.schema.ts` |
| Shared-client steering status/refusal + transient hard-down reset | `schemas/network.schema.ts` → `uplinkSteeringStatusSchema` / `uplinkFlowsResetEventSchema` |
| Name the DEVICE behind an uplink-health row without renaming the row | `schemas/network.schema.ts` → `uplinkHealthRecordSchema.displayName`; section below → AN UPLINK ROW CARRIES A NAME, NOT A SECOND IDENTITY |
| Streaming-first shaper mode/algorithm + priority degradation | `schemas/network.schema.ts` → `uplinkShaperStatusSchema` |
| Correlate a modem across a USB-mode transition | `schemas/modems.schema.ts` → `deriveModemStableKey()` / the `stable_key` field |
| A ModemManager reading that may be absent, WITHOUT losing why | `schemas/modems.schema.ts` → `modemMetricUnknownReasonSchema` + `modemNumberMetricSchema` / `modemFlagMetricSchema` / `modemTextMetricSchema`; section below → AN ABSENT READING STILL SAYS SOMETHING |
| Extended MM signal detail (rsrp/rsrq/snr/sinr) + measurement recency | `schemas/modems.schema.ts` → `modemSignalDetailSchema` (the `signal_detail` field) |
| Which network / which cell the radio registered on | `schemas/modems.schema.ts` → `modemRegistrationContextSchema` (the `registration_context` field) |
| WHICH FACT decided `sim_presence` | `schemas/modems.schema.ts` → `modemSimPresenceEvidenceSchema` (the `sim_presence_evidence` field) |
| The shared modem MUTATION-SAFETY wire vocabulary (journal states, refusals, ack modes, the three operator procedures) | `schemas/modems.schema.ts` → `modemMutation*Schema`; section below → THE MUTATION-SAFETY VOCABULARY IS SHARED |
| What a modem OPERATION did once it was admitted (completion/result/unknown-outcome + the 8 ModemManager refusals, and whether a retry could help) | `schemas/modems.schema.ts` → `modemOperation*Schema` / `modemManagerRefusalReasonSchema` / `MODEM_MANAGER_REFUSAL_RETRYABLE`; section below → AN OPERATION'S OWN WORDS SURVIVE THE BOUNDARY |
| Identify a bonded LINK across a SIGHUP reload (`link_id` / `port_label` / `serial` on a telemetry row) + the one normalized bind-map disposition (`bond_mapping`) | `schemas/status.schema.ts` → `linkTelemetryEntrySchema`, `bondMappingSchema`; `conn_id` is a FILE POSITION and must never be a row identity |
| Say that a link's device could NOT be identified (`identity_state: 'unmappable'`) | `schemas/status.schema.ts` → `bondLinkIdentityStateSchema` on `linkTelemetryEntrySchema`; section below → AN UNIDENTIFIABLE LINK SAYS SO |
| Whether a capability module may be offered, mutated, or claimed | `schemas/capability-modules.schema.ts` + `capabilities/capability-matrix.ts` → `resolveSupportClaim` / `resolveCapabilityMatrix` / `mayRenderModule` / `mayClaimSupport`; section below → THE CAPABILITY FEATURE-GATE FRAMEWORK LIVES HERE, ONCE |
| Read-only SMS inbox shapes (`modems.getSms`) | `schemas/modems.schema.ts` → `smsMessageSchema` / `modemSmsOutputSchema` / `SMS_INBOX_CAP`; section below → THE SMS INBOX SCHEMAS ARE READ-ONLY BY DESIGN |
| Bluetooth wire surface (device/adapter rows, the shared mutation refusals, the BT capability claims) | `schemas/bluetooth.schema.ts` + `contracts/bluetooth.contract.ts`; section below → THE BLUETOOTH DOMAIN REUSES THE LADDER WITHOUT JOINING THE REGISTRY |
| The engine audio-backend enum + the capability block a selector may offer from | `schemas/streaming.schema.ts` → `audioBackendSchema` / `streamingConfigInputSchema.audio_backend` / `capabilitiesMessageSchema.audio_backends`; ABSENT is never a default — see [`../../apps/backend/AGENTS.md`](../../../../apps/backend/AGENTS.md) → THE AUDIO BACKEND IS AN OVERRIDE |
| Effective caps for a platform/source/mode | `capabilities/intersect-caps.ts` → `intersectCaps()` (pure) |
| Whether a device can DELIVER a resolution/framerate pairing | `capabilities/device-mode-truth.ts` → `evaluateDeviceMode()` / `nearestDeliverableMode()` (pure) |
| Root router type (client inference) | `contracts/index.ts` → `AppContract` |
| The engine's declared `change-config` worst-case bound (DERIVED, never a literal) | `schemas/config-change.schema.ts` → `CHANGE_CONFIG_WORST_CASE_BOUND_MS` |
| New domain (e.g. `audio`) | New `audio.contract.ts` + `audio.schema.ts`, add to `appContract` router |

