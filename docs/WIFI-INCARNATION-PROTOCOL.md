# Additive Wi-Fi incarnation protocol [EXISTS; host proof only]

PR P exposes one optional `incarnation` string on each local Wi-Fi status row.
It accepts the same optional input on hotspot prepare (load and save), start,
stop, configure, and every adapter mode switch, including station.
The shared schema requires a string with at least one character when present.
It does not trim, coerce, parse a UUID, or impose a token format: whitespace and
escaped characters remain opaque bytes. Empty strings and non-strings fail
input/output validation. An absent field retains the legacy shape.

These inputs are deliberately ignored after parsing. A stale or unrelated
nonempty token has the same effects and results as an omitted token. There is
no binding enforcement, new refusal, operation-frame correlation, frontend
consumption, limited mode, locator acquisition, or NetworkManager targeting
change in P. The broader radio program's limited/composite state and guarded
actions remain later rollout work. G1-G5 are unrun and unclaimed here.

## Producer and lifetime

The real status builder reads the existing observational producer's token by
the row's current interface name. It does not await sysfs, mint a fallback, or
change legacy discovery, registry keys, numeric ids, credential ownership,
broadcast timing, or handler admission. Before detached observation completes,
or when no observation exists, the field is absent. The next existing status
pull, initial snapshot, or broadcast carries the sampled token.

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
Mock initialization and reset clear the token map.

## Exact wire delta and egress

With no token, the status builder adds no property, including no enumerable
`undefined`; serialized legacy Wi-Fi rows stay byte-identical. With the current
36-character UUID, each row grows by exactly 53 UTF-8 bytes:
`,\"incarnation\":\"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\"`.
Property ordering of all pre-existing members is retained. Other opaque strings
would have their ordinary JSON escaping and UTF-8 length; 53 is a producer
measurement, not a schema limit.

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
