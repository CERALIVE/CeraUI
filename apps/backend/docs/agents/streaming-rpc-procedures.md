<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STREAMING RPC PROCEDURES

`streaming.switchInput` uses `session-switch.ts` admission against a fresh engine
`list-switch-targets` result while live. Synthetic session legs bypass discovery,
not admission, and never persist capture config or trigger audio follow. Only an
unsupported query uses the legacy registry path. See
[LIVE-SESSION-SWITCHING](../../../../docs/LIVE-SESSION-SWITCHING.md) for the published
2026.9.11/schema 0.21.0 contract. Targets carry `input_id`, `kind`, and optional
source-mode fields;
membership is authoritative, including explicit `[]` for passthrough/composition.
Non-membership is `SWITCH_FAILED`, not evidence of a physical unplug. The
`session-switch-adapter.test.ts` gate drives the real published UDS client through
the adapter and authenticated procedure: only numeric RPC `-32601` permits
legacy discovery. Other RPC errors, transport failures and malformed replies
leave discovery, capture persistence and pending audio follow untouched.

### Engine-owned encoder ladder [EXISTS]

`@ceralive/cerastream@2026.9.11` parses the additive `encoders[]` block before
`capabilities.ts` caches or broadcasts it. The backend performs no codec-table
reconstruction: live and cached snapshots retain the producer-owned
`EncoderCapability[]`, while the minimal cold-start floor omits it so the frontend
uses its explicitly-tested legacy platform fallback. Every consumed nested field
is listed in `producer-schema-drift.test.ts`; `producer-wire-type-shadow.test.ts`
separately rejects local `PlatformCaps`, `VideoSourceCap`, `EncoderCapability`, and
matching schema declarations.

The `streaming` router exposes these procedures:

| Procedure | Purpose |
|-----------|---------|
| `start(config)` | Overlay optional fields on persisted stream config, validate, launch, persist |
| `stop()` | Stop active stream |
| `setConfig(fields)` | Persist config fields **without** starting the stream (added Task 19) |
| `setBitrate({ max_br })` | Hot-adjust bitrate while streaming |
| `getPipelines()` | List available capture sources, derived from the capability contract (`getCapabilities`) — NOT the `pipeline-sources.ts` tables directly |
| `getAudioCodecs()` | List available audio codecs |
| `getConfig()` | Return current config snapshot |

`setConfig` writes the provided fields onto the running config (same relay/manual mutual-exclusion logic as `updateConfig`, minus DNS/pipeline validation), then calls `saveConfig` and broadcasts a `config` message. Use this for all config-only dialogs that must not start the stream.

`start` input is PARTIAL by contract. `updateConfig` projects the saved runtime
config through `streamingConfigInputSchema`, overlays the caller's stated fields,
then validates the effective whole. Thus `{}` means “start exactly what is saved” —
required by both the public RPC and `device.setProfile`'s direct reconnect path —
while a partial call changes only its defined fields; an explicit `undefined` is
not a clear. A stated manual endpoint clears both saved managed-relay fields
(`relay_server` and `relay_account`), while a stated managed server clears the
saved manual address and port. The schema projection is the
credential boundary: never replace it with `{...getConfig()}`, which would put
non-stream fields such as device credentials on the applied-start object. `acodec`
remains optional: when neither the request nor persisted config states one,
validation leaves it absent so cerastream applies its engine default; an explicitly
stated codec is still checked against the supported codec registry. Keep the merge
below the RPC layer so every start origin receives identical behavior.

