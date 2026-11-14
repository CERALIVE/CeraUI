<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STREAMING RPC PROCEDURES

`streaming.switchInput` uses `session-switch.ts` admission against a fresh engine
`list-switch-targets` result while live. Synthetic session legs bypass discovery,
not admission, and never persist capture config or trigger audio follow. Only an
unsupported query uses the legacy registry path. See
[LIVE-SESSION-SWITCHING](../../../../docs/LIVE-SESSION-SWITCHING.md) for the published
2026.11.1/schema 0.23.0 contract. Targets carry `input_id`, `kind`, and optional
source-mode fields;
membership is authoritative, including explicit `[]` for passthrough/composition.
Non-membership is `SWITCH_FAILED`, not evidence of a physical unplug. The
`session-switch-adapter.test.ts` gate drives the real published UDS client through
the adapter and authenticated procedure: only numeric RPC `-32601` permits
legacy discovery. Other RPC errors, transport failures and malformed replies
leave discovery, capture persistence and pending audio follow untouched.

### Engine-owned encoder ladder [EXISTS]

`@ceralive/cerastream@2026.11.1` parses the additive `encoders[]` block before
`capabilities.ts` caches or broadcasts it. The backend performs no codec-table
reconstruction: live and cached snapshots retain the producer-owned
`EncoderCapability[]`, while the minimal cold-start floor omits it so the frontend
uses its explicitly-tested legacy platform fallback. Every consumed nested field
is listed in `producer-schema-drift.test.ts`; `producer-wire-type-shadow.test.ts`
separately rejects local `PlatformCaps`, `VideoSourceCap`, `EncoderCapability`, and
matching schema declarations.

Optional `encoder.default_codec` survives the producer parser and capabilities
projection. The status projection forwards optional `active_encode.route_reason`;
the RPC active-encode schema lives in `status.schema.ts`. Older engine snapshots
remain valid without either field.

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

### Format settings [EXISTS]

`setConfig` accepts optional `balancer` through the published producer's
`balancerAlgorithmSchema` (`adaptive`, `fixed`, `aimd`). It persists the value,
echoes it in `applied`, and includes it in config broadcasts and `getConfig`.
Unknown algorithms fail input validation before persistence. Remote
`streaming.setConfig` dispatches to this same procedure.

`video_codec: null` clears the saved codec; omission leaves the saved selection
alone. Disk and config messages retain an optional, non-null codec. The next
start therefore omits engine `codec` after a clear. Balancer saves and codec
clears make no engine call while streaming, including a clear with `apply_now`.
Explicit non-null codec choices retain the existing apply-now transaction.
`video_passthrough` remains accepted, stored and forwarded unchanged. Loading
saved settings does not rewrite values, and runtime defaults and start assembly
are unchanged. Coverage: `streaming-format-settings.test.ts` and the unedited
`on-air-baseline.test.ts`.

### Audio inputs [EXISTS]

`setConfig({ audio_inputs })` stores picker ids, tracks, gain in dB, mute and
per-input delay in milliseconds. An omitted field leaves the saved set alone.
Null clears it; exactly the primary input at 0 dB, unmuted, 0 ms and Track 1
also clears it. Loading config performs no migration and never rewrites `asrc`.
An omitted per-input mute means false, matching the producer's default. Loading
fills that value in memory without rewriting the file; an explicit true at
otherwise default primary settings remains an explicit muted mix.
Membership and track changes apply at the next start, including with `apply_now`.

The save gate runs before any mutation against `audio_mix` and the selectable
audio source list. Its errors are `audio_mix_unsupported`, `audio_input_unknown`,
`audio_inputs_empty`, `audio_input_duplicate`, `audio_inputs_too_many`,
`audio_tracks_invalid`, `audio_tracks_gap`, `audio_gain_range` and
`audio_delay_range`. Tracks must be distinct integers from 1 to the advertised
maximum, and their union must be 1 through k. Gain includes both advertised
endpoints. Delay is an integer from zero through the advertised maximum.
Non-numeric/non-finite values fail RPC input parsing.

The engine adapter resolves every picker id through the existing audio resolver,
puts the primary first, omits `audio.device` and sends producer-owned
`audio.inputs`. It sends `effectiveAudioInputs`: a primary the device can open
but the saved mix lacks joins first on Track 1, or in a full mix takes the
first entry's place and tracks. Live and idle `setAudioMix` admit the same
mix, and nothing is written until an operator edit. For a network source, its source id (`rtmp` or `srt`) denotes
the embedded input and becomes engine `embedded`. Without saved inputs or the
capability, start serialization stays on the existing path. The compatibility
start-schema export aliases the published producer schema, preserving its
additive audio fields.

`audio_mix_active` describes the admitted running session, independently of
next-start saves. Status snapshots, updates and initial hydration carry it;
Stop, engine idle or connection loss withdraw it. Only an active mix refuses
`switchAudio` with `audio_mix_active`. A legacy session retains live source
switching even after a mix is saved.

`streaming.setAudioMix({ id, gain_db?, mute?, delay_ms? })` uses that session's
admitted input identity. A live mix sends one producer `setAudioMix` request,
returns the applied state and saves its values.
The reply is authoritative even when its gain differs from the request; partial
live updates retain the admitted gain, mute and delay unless the engine changes
them. Reloading saved settings and the next Start retain those applied values.
Pending membership and track
edits remain pending; updating an input removed from next-start settings does
not re-enable it. Idle or on a legacy session, the procedure only saves an
already-enabled input (or the default primary), returning
`applies_next_start: true`. Unknown inputs and invalid values leave disk and
the engine untouched. Native RPC refusals retain their complete numeric code,
message and data, including capture causes, under `engine_error`.

Per-input meter entries keep their measured values and map engine `input_id`
back to picker ids. Live mix meters follow the admitted stream even if a
deferred audio pick changes; idle meter selection is unchanged. Coverage:
`audio-inputs.test.ts` drives the published UDS client, persistence and RPC;
`mock-audio-contract.test.ts` pins native error serialization. The mixer UI is
the Audio card's strips ([live screen contract](../../../../docs/agents/live-screen.md#the-audio-cards-mixer-exists));
the layout designer remains a separate change. No hardware qualification or
release documentation claim follows from these host checks.

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

