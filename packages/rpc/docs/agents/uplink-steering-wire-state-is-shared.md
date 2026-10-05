<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## UPLINK STEERING WIRE STATE IS SHARED [EXISTS]

`NETIF_DUPLICATE_IPV4_ERROR` names the legacy `netif.error` spelling. It adds no
wire field: `error` remains an optional string and `enabled` remains the backend's
bond-eligibility projection. Error text alone cannot distinguish a pure flag from
a compound bitmask; a duplicate-IP entry is eligible only with `enabled:true`.

`schemas/network.schema.ts` owns both steering channels. The persistent
`uplinkSteeringStatusSchema` is a discriminated union: `available`, or
`steering_unavailable` with one of the six machine-stable reasons and an optional
diagnostic detail. The transient `uplinkFlowsResetEventSchema` is exactly
`{iface, linkId}` — physical identity, never a route-table position or mark.

The backend parses both shapes before broadcast. Only `uplink-steering` is sent in
the post-login snapshot; `uplink-flows-reset` describes a hard-down action that
already happened and must never be replayed to a later session. Do not duplicate
either type under `apps/` or widen the reset event into persisted state.

