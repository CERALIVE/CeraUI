# CeraUI Receiver Model

**Status:** `[EXISTS]`

This document describes the T1 receiver-kind model introduced by the
`ceraui-receiver-experience` overhaul and the Scope-B contract that governs
plain-SRT egress. It is the authoritative reference for how CeraUI selects,
validates, and routes a stream to a receiver endpoint.

> **Device UI v2 — receiver-coherence (latency-first).** The backend transport
> model below (resolver, registry, kinds) is unchanged. The Live → Receiver/Server
> **dialog** was made honest:
>
> - **Destination IS the provider.** Three tiles — **CeraLive Cloud**, **BELABOX
>   Cloud**, **Custom receiver** (`ReceiverDestinationChoice = 'ceralive' |
>   'belabox' | 'custom'`, derived from `CLOUD_PROVIDERS` via
>   `deriveDestinationChoice`). A managed cloud the device has no key for shows an
>   "add your key" prompt that deep-links `CloudRemoteDialog` preselecting it
>   (`provider` prop). No nested provider dropdown, no manual-endpoint override.
> - **One transport.** SRTLA is the only egress; `TransportRow` shows it active and
>   renders **RIST** (`TD-rist-egress`) + **SRT** (`TD-plain-srt-egress`) as calm
>   coming-soon pills. There is no protocol radiogroup.
> - **One knob.** Reliability is automatic (SRT ARQ over SRTLA bonding, always on);
>   **latency is the ARQ retransmit budget** — the single `LatencySection` slider,
>   window from `deriveLatencyRange(getCapabilities())`. FEC / recovery / presets /
>   cloud-override controls are removed from the device UI (the
>   `device.setProfile` wire contract + `fec_enabled`/`recovery_mode`/
>   `stream_profile` schema fields are kept — only the device-side controls go).
>
> The pure logic lives in `apps/frontend/src/lib/streaming/receiver-experience.ts`;
> the components in `apps/frontend/src/main/dialogs/server/` (`DestinationSection`,
> `TransportRow`, `LatencySection`, `RelayServerSelector`, `CustomEndpointForm`,
> `ServerIngestSlots`). Removed: `ProtocolSelector`, `TransportBadge`,
> `StreamTuningSection`.

---

## 1. T1 Receiver-Kind Model

CeraUI classifies every stream destination into one of three receiver kinds:

| Kind | Description |
|------|-------------|
| **managed relay** | A relay server from the `relays` list; the transport adapter resolves the endpoint from the cached relay record. |
| **manual** | An operator-supplied host + port (and optional stream ID); the transport adapter validates and resolves the raw values. |
| **custom receiver** | A relay-override: the operator supplies a custom host + port that replaces the managed relay association. The relay record is cleared (`relay_server: null`) and the session is treated as a manual endpoint for the duration. |

The active receiver kind is determined at `resolveStreamEndpoint` time
(`modules/streaming/transport/`) by inspecting the current config:
`relay_server` present → managed relay; `relay_server` absent + manual fields
present → manual; relay-override path → custom receiver (see §4 caveat ii).

---

## 2. Transport Registry and Protocol Adapters

The transport registry (`modules/streaming/transport/registry.ts`) is the
single extension point for relay protocols. Each protocol is backed by a
`TransportAdapter` (defined in `transport/types.ts`) with three methods:

```
interface TransportAdapter {
  protocol: RelayProtocol;
  validate(cfg: TransportConfig): void;
  resolveEndpoint(cfg: TransportConfig): ResolvedEndpoint;
  describe(): TransportDescriptor;
}
```

Current registrations (bottom of `registry.ts`, lines 126–130):

```typescript
registerProtocol(srtlaAdapter);   // active — SRTLA bonded transport
registerProtocol(ristAdapter);    // active — RIST simple-profile (capability-gated)
registerProtocol(
  createPlaceholderAdapter("srt", "SRT", "SRT not yet implemented"),
);                                // reserved — placeholder; throws NotImplementedError
```

`srtlaAdapter` and `ristAdapter` are fully implemented. The `srt` entry is a
`createPlaceholderAdapter` whose `validate` and `resolveEndpoint` both throw
`NotImplementedError` — it exists to hold the registry slot and drive the
reserved-SRT UI affordance in `ServerDialog`, not to route traffic.

---

## 3. Scope-B Contract — Plain-SRT Egress

Plain-SRT egress is a fully-specified multi-layer follow-up. It is NOT
implemented in Scope A. The three layers that must land together are:

### Layer 1 — Capability advertisement

`cerastream` must advertise `"srt"` in its `get-capabilities` response under
the `transports` list. CeraUI's capability service (`modules/streaming/capabilities.ts`,
`getSupportedTransports()`) forwards this list in the `capabilities` event.
The frontend uses `capabilities.transports` to determine which protocols are
selectable. Until `"srt"` appears in `transports`, the `srt` protocol remains
in `CAPABILITY_GATED_RELAY_PROTOCOLS` and the `ServerDialog` renders it
disabled with a reason tooltip — never hidden.

### Layer 2 — Real `srt` TransportAdapter

The placeholder registration in `registry.ts` must be replaced with a real
`srtAdapter` whose `resolveEndpoint` delivers a remote SRT caller target
(host + port + optional stream ID) directly to the engine — bypassing
`srtla_send` entirely. The adapter shape mirrors `ristAdapter`
(`transport/rist-adapter.ts`) but without the even-port constraint.

### Layer 3 — `startStream` protocol branch

`streamloop/start-stream.ts` currently unconditionally spawns `srtla_send`
and connects the engine to `127.0.0.1:9000` (the local SRTLA listener):

```typescript
// start-stream.ts lines 61–100 (current, Scope A)
spawnStreamingLoop(srtlaSendExec, buildSrtlaSendArgs({ ... }).args, ...);
// ...
getStreamingBackend().start(config, {
  host: "127.0.0.1",
  port: SRTLA_LISTEN_PORT,   // 9000
  ...
});
```

A protocol branch is needed so that when the resolved protocol is `"srt"`,
`startStream` skips the `srtla_send` spawn and passes the remote SRT target
directly to the engine IPC instead of `127.0.0.1:9000`.

**This branch is a PREREQUISITE refactor shared by both RIST and SRT.**
`session.ts` and `autostart.ts` carry no protocol parameter today. Threading
the resolved protocol through `session.ts` → `autostart.ts` → `startStream`
is required before either RIST or SRT can use a non-SRTLA egress path. Until
this refactor lands, a resolved RIST endpoint is still handed to `srtla_send`
(see §4 caveat i).

---

## 4. Honest Caveats

### (i) RIST egress is resolver-only today

The `ristAdapter` in `transport/rist-adapter.ts` correctly resolves a RIST
endpoint (even-port validation, relay/manual dispatch, optional stream ID).
However, `startStream` has no protocol branch: it unconditionally spawns
`srtla_send` and connects the engine to `127.0.0.1:9000` regardless of the
resolved protocol. A resolved RIST endpoint is therefore still handed to
`srtla_send` in Scope A. RIST is **not** a verified single-link path until the
shared `startStream` protocol branch (Layer 3 above) lands. The RIST adapter
is correct and ready; the egress wiring is the missing piece.

### (ii) Relay-override reloads as a custom receiver

When an operator supplies a custom host + port that overrides a managed relay,
the backend clears `relay_server` from the config and treats the session as a
manual endpoint. This means the managed relay association is not preserved
across the override — a subsequent session will not automatically restore the
relay. Preserving the managed association across a relay-override (e.g. by
storing the original relay ID alongside the override) is a noted future
enhancement and is explicitly out of Scope A.

---

## 5. Tech-Debt Registration

Plain-SRT egress is tracked in the machine-checkable register:

| ID | Title | Status | Exit condition |
|----|-------|--------|----------------|
| `TD-plain-srt-egress` | Plain-SRT (non-SRTLA) receiver egress | open | `capability:srt` |

See [`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) for the full entry and unblock
prose. The `data-debt-id="TD-plain-srt-egress"` marker is added to the
`ServerDialog` reserved-SRT affordance in T8.

---

## 6. Device ↔ Cloud-OBS Association (T17)

When the device feeds a platform-managed ingest slot (T18 managed accounts), the
cloud may bind that slot to a specific cloud OBS instance. The platform reports the
binding on each pushed slot via two optional fields — `obsInstanceId` (the bound
instance, or `null`/absent when unbound) and `instanceLabel` (its human name).

The device surfaces this as a **read-only** line: `obsInstanceAssociation(account)`
(`lib/streaming/receiver-experience.ts`) returns `{ label }` only when BOTH a
non-null `obsInstanceId` AND a non-empty `instanceLabel` are present, so an unbound
slot yields `undefined` and the line is simply absent (never "undefined"). The line
renders in two places:

- `ServerIngestSlots.svelte` — under each managed slot in the picker
  (`data-testid="obs-instance-association"`).
- The Live server summary — `buildServerSummary(...)` appends
  ` · feeds cloud OBS instance: <label>` when the active slot is bound.

Copy is the i18n key `settings.feedsCloudObsInstance`
(`"Feeds cloud OBS instance: {label}"`, 10 locales).

**Read-only by contract.** The device only *observes* the association the platform
pushes; it has **no device-side OBS control** — it never starts, stops, switches
scenes on, or otherwise commands a cloud OBS instance. OBS lifecycle and scene
control live entirely in `ceralive-platform`.

### Platform `sourceKind` taxonomy

On the cloud side, every ingest endpoint carries a `sourceKind`
(`IngestSourceKind` enum in `ceralive-platform`) that records **who publishes** to
it — orthogonal to the slot's role (`purpose`) and to which instance consumes it
(`obsInstanceId`). A CeraUI device that feeds an endpoint is classified `DEVICE`;
other producers use values such as `EXTERNAL_OBS` / `EXTERNAL_ENCODER`. CeraUI does
not set or read `sourceKind` — it is a platform-owned classification of the device's
own feed. It is documented here only so device-side readers understand how the cloud
labels the stream this UI configures.

---

## Related Documents

| Document | Scope |
|----------|-------|
| [`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) | Machine-checkable debt register; `TD-plain-srt-egress` entry |
| [`scripts/check-tech-debt.mjs`](../scripts/check-tech-debt.mjs) | CI validator |
| [`apps/backend/src/modules/streaming/transport/registry.ts`](../apps/backend/src/modules/streaming/transport/registry.ts) | Protocol registry + placeholder registration |
| [`apps/backend/src/modules/streaming/transport/rist-adapter.ts`](../apps/backend/src/modules/streaming/transport/rist-adapter.ts) | RIST adapter (reference implementation shape) |
| [`apps/backend/src/modules/streaming/streamloop/start-stream.ts`](../apps/backend/src/modules/streaming/streamloop/start-stream.ts) | Stream launch — unconditional `srtla_send` spawn (Scope A) |
| [`apps/backend/src/modules/streaming/capabilities.ts`](../apps/backend/src/modules/streaming/capabilities.ts) | Capability service; `getSupportedTransports()` |
| [`CONVENTIONS.md`](CONVENTIONS.md) | CeraUI doc + debt-register convention |
