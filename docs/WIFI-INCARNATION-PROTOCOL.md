# Additive Wi-Fi incarnation protocol [EXISTS; host proof only]

PR P exposes one optional `incarnation` string on each local Wi-Fi status row.
It accepts the same optional input on hotspot prepare (load and save), start,
stop, configure, and every adapter mode switch, including station.
The shared schema requires 1-128 ASCII characters from `A-Z`, `a-z`, `0-9`,
underscore and hyphen when present. It does not trim, coerce or parse a UUID.
Empty, oversized, non-string or other-character values fail input/output
validation. Valid values remain opaque and equality-only. An absent field
retains the legacy shape.

These inputs do not change admission, targeting, effects or RPC results. A stale
or unrelated valid token still has the same action behavior as an omitted token.
Config and mode requests additionally supply observational metadata for the two
asynchronous frames described below. There is no binding enforcement, new
refusal, frontend consumption, limited mode, locator acquisition, or
NetworkManager targeting change. The broader radio program's limited/composite
state and guarded actions remain later rollout work. G1-G5 are unrun and
unclaimed here.

## Asynchronous config and mode settlement [EXISTS; host proof only]

Only `wifi.hotspot.config` terminal frames and `wifi.adapter_mode`
pending/terminal frames gain optional `incarnation`, with the same strict
1-128-character ASCII bound as the row token. The current frontend settles these
by device in `subscriptions.svelte.ts`; a delayed frame otherwise cannot identify
its original radio lifetime. This step adds the producer field without changing
that consumer.

The validated expected token wins when supplied, including a valid unrelated
token. Otherwise the exact row's proven token is captured synchronously at
acceptance, before the RPC admission probe or any transaction await. The
existing config id-map lookup and mode registry lookup remain distinct. An
unproven capture stays absent even if another row becomes proven later.
Publication never looks up the latest row. Capture does not call the status
builder, start discovery, compare tokens for admission or wait for sysfs.

A private asynchronous dispatch context carries this metadata without changing
RPC inputs, results or internal call arguments. Core config continuations and
their unexpected-throw wrapper retain the captured value. Mode publishers close
over it for direct refusals, pending state, completion and the terminal timeout,
including a completion invoked outside its original asynchronous context. Real
and mock procedures use the same frame builders; mock credentials and mode
effects stay unchanged.

RPC replies, RPC error envelopes, prepare load/save responses and
`wifi.hotspot.start`/`stop` frames gain no field. RPC responses already identify
their dispatch through the request/response pair. The current UI confirms
start/stop from authoritative status rather than ingesting those terminal
frames. Internal boot reconciliation uses the shared mode producer; regulatory
reconfiguration has no additional keyed hotspot settlement frame.

With only the new field removed, the original member ordering and serialized
frame bytes remain unchanged. No enumerable `undefined` is added. Existing RPC
result and forwarding assertions remain unchanged. Separate schema, replacement
schedule, mock and remote tests inspect the raw new field as well as legacy
bytes. Same-interface replacement tests dispatch against A, establish B before
pending or terminal publication, and require A's captured token, never B's.

## Producer and lifetime

The real status builder requires evidence for the exact current registry row
and its observation generation, with a coherent lifetime witness. It does not
accept an interface-name match alone. It does not await sysfs, mint a fallback, or
change legacy discovery, registry keys, numeric ids, credential ownership,
broadcast timing, or handler admission. Before detached observation completes,
or when no current coherent observation exists, the field is absent. Discovery
invalidates prior evidence before publishing or mutating rows, including reused
row objects. Detached samples carry their captured row and generation; a late,
failed, timed-out or incoherent observation cannot authorize an older token.
The next existing status pull, initial snapshot, or broadcast carries the token
only once current evidence is proven. No new broadcast or discovery wait is added.

The producer's existing coherent ifindex/wiphy/path evidence rotates the random
token on a replacement, replug, classification change, or either degraded edge.
A true same-object rename and ordinary connection, scan, mode or capability
updates retain it. Uncertainty cannot establish continuity. Tokens are ephemeral
and equality-only, with no MAC, path, credential, or stable derived identifier.
They are non-secret observations and do not authorize an action.

The mock producer emits one random token per radio on station and hotspot
status. Mode and connection changes retain it. The authenticated development
procedure `dev.rebindWifi({device})` rotates only that radio's token and emits
the existing status shape; credentials, mode and connections remain unchanged.
It accepts the mock numeric id or device name, is registered only outside
production, and additionally refuses production or non-mock execution.
Mock initialization and reset clear the token map. Mock protocol fixtures use
fake clocks for all service timers and retain reset/stop cleanup.

## Exact wire delta and egress

With no token, the status builder adds no property, including no enumerable
`undefined`; serialized legacy Wi-Fi rows stay byte-identical. With the current
36-character UUID, each row grows by exactly 53 UTF-8 bytes:
`,\"incarnation\":\"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\"`.
Property ordering of all pre-existing members is retained. Other valid opaque
ASCII strings have their stated length; 53 is a producer measurement, not the
128-character schema limit.

Authorized local clients receive the field through initial `sendStatus`,
`broadcastWifiState`, `wifi.getStatus`, and aggregate `status.getStatus`.
Both RPC output schemas retain it. The current frontend's existing shared types,
JSON receive path and status hydration tolerate both shapes without using the
token for rendering or actions.

Remote-bound status strips it using the projection introduced for local hotspot
passwords. This includes initial and subsequent legacy remote serialization
and the optional v2 status relay when a channel is injected. The production
relay remains unwired by this change. A cloud mirror receiving those projected
frames therefore gains zero token bytes. Keeping the token local avoids exposing
an unused lifetime observation across the remote boundary and preserves remote
status bytes. It does not classify the token as a credential.

The legacy remote sender also strips the two settlement-frame tokens, preserving
unrelated members, send options and callbacks. Tokenless non-status frames keep
their original serialized bytes. Local frames are untouched. The v2 status
allowlist does not include `wifi`, and its command dispatcher does not invoke
hotspot procedures; this change adds neither route. The installed v2 decoder
probe therefore does not apply to these unsupported frame types. No new cloud
schema, package publication or relay wiring is required.

## Compatibility and package boundary

The installed platform decoder is separately probed against
`@ceralive/control-protocol` 2026.7.0: strict status/frame decoding constrains the
envelope while retaining unknown nested Wi-Fi fields. The probe establishes
installed-package compatibility, not deployed-cloud or hardware qualification.
Remote stripping remains the policy even though that decoder accepts the field.

The workspace rule to publish producer bindings before new-field consumers
merge still governs registry packages such as `@ceralive/control-protocol`.
Here the producer contract is `@ceraui/rpc`, compiled from this repository's
`workspace:*` dependency by backend and frontend in the same build. There is no
external binding publication for this field or external new-field consumer.
P does not alter the published control-protocol schema.

Schema tests reject malformed/empty tokens and preserve both shapes. Real
producer tests use the prior injected discovery/sysfs fakes. The recorded
legacy equivalence oracle removes only the new row field before comparing its
existing status, registry, id-map, credential, result and broadcast assertions;
the frozen fixtures remain unchanged. The one authorized exception to A's
internal-only premise replaces
`expect(JSON.stringify(wifi.wifiBuildMsg())).toBe(before)` with
`expect(legacyBytes(recovered)).toBe(before)`, where both byte strings remove
only each row's incarnation. Additional emitted-value assertions require
unavailable/recovery rotation and stability across ordinary saved-network status
changes. Every other pre-existing assertion remains unchanged. Separate tests
inspect raw emitted tokens and serialized local/remote frames. User-facing
binding behavior, copy and coordinated EN/es-419 user documentation belong to
the later frontend rollout; this step changes no operator controls or claims.
