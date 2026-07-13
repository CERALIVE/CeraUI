# Remote Topology

> **REMOTE/CLOUD PATH: DESIGN-ONLY.**
> The same-device production topology and split local development topology are
> implemented today. The remote/cloud path remains unwired; the typed seam in
> `packages/rpc/src/schemas/envelope.schema.ts` anchors that future work.

---

## 1. Two Topologies

CeraUI currently operates in the local topology. The `DeploymentMode` type
(`deploymentModeSchema` — `"local" | "remote"`) models the future switch to the
remote/cloud topology.

### 1a. Same-device / localhost (current production mode)

```
┌──────────────────────────────────────┐
│  Device (ARM64 / AMD64)              │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ CeraUI backend (Bun :80)       │  │
│  │  ├─ serves the static PWA      │  │
│  │  └─ upgrades same-origin /ws   │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
                  ▲
                  │ HTTP + WebSocket, same origin
                  ▼
             Operator browser
```

`deploymentMode = "local"`. In production the backend serves both the static PWA
and same-origin `/ws`; the operator opens `http://<device>/` and the browser uses
`ws://<device>/ws` (port 80 by default). Ordinary `bun run dev` is intentionally
split: Vite serves the PWA on port 6173 and the local development backend listens
on port 3002. Functional E2E pages instead select worker-scoped 31xx backends.
This is the only wired deployment topology today.

### 1b. Cloud-hosted frontend → device backend over bonded cellular (future)

```
┌──────────────────────┐        ┌──────────────────────────────┐
│  Cloud               │        │  Device (field, CGNAT)        │
│                      │        │                              │
│  ┌────────────────┐  │  WSS   │  ┌──────────────────────┐   │
│  │  Frontend PWA  │  │◄───────┤  │  Backend (Bun :443)  │   │
│  │  (static CDN)  │  │ :443   │  │  outbound dial-out   │   │
│  └────────────────┘  │        │  └──────────────────────┘   │
│                      │        │                              │
│  ┌────────────────┐  │        │  bonded cellular links       │
│  │  Cloud relay   │  │        │  (srtla / cerastream)        │
│  │  (broker TBD)  │  │        └──────────────────────────────┘
│  └────────────────┘  │
└──────────────────────┘
```

`deploymentMode = "remote"`. The frontend is served from a cloud host; the
device backend dials out to a relay and the frontend connects through it.

> **Out of scope here:** the cloud relay/broker design. This document covers only
> the device-side and frontend-side seams.

---

## 2. Why the Device Dials OUT

Field devices sit behind carrier-grade NAT (CGNAT). Inbound TCP connections are
infeasible: the device has no stable public IP, and the carrier blocks unsolicited
inbound packets.

The solution is outbound dial-out: the device initiates a persistent WSS connection
to a known relay endpoint on port 443 (outbound HTTPS/WSS is almost universally
permitted). The relay holds the connection open; the cloud-hosted frontend connects
to the relay and the relay bridges the two sides.

This is the same pattern used by reverse-tunnel tools (ngrok, Cloudflare Tunnel,
etc.) and is the only viable approach for devices on bonded cellular.

**Constraint summary:**
- Outbound WSS:443 from device — always permitted.
- Inbound TCP to device — blocked by CGNAT, not viable.
- The device is always the initiator; the relay is always the listener.

---

## 3. `deploymentMode` and Profile Knobs

The `deploymentModeSchema` (`"local" | "remote"`) gates a set of connection-layer
parameters that differ between topologies. These are not yet wired; the table below
records the intended design.

| Parameter | `"local"` | `"remote"` |
|---|---|---|
| Heartbeat interval | ~5 s (WS ping/pong) | ~5 s (same) |
| Heartbeat miss threshold | ~15 s (3 missed) | ~15 s (same) |
| Reconnect base delay | 1 s | 1 s |
| Reconnect backoff cap | ~30 s | ~30 s |
| Jitter | ±30% on every step | ±30% on every step |
| Transport stops retrying | Never (UI threshold only) | Never (UI threshold only) |
| Auth credential | Raw password (localStorage `auth`) | `SessionToken` (see §4) |
| Visibility subscription | Not sent | Sent on connect (see §5) |

The formula for reconnect delay is:

```
delay = min(cap, base · 2^n) · (1 + random(−0.3, +0.3))
```

`deploymentMode` switches the auth credential and enables the visibility
subscription; the cadence/backoff parameters are identical in both modes by design
(one wire protocol, profile-switched behaviour).

---

## 4. Session-Token Model (Ambition A)

### Current state

`reconnect.ts:21-24` documents the current credential model: the "token" stored
under localStorage `auth` is the raw device password. On reconnect, the frontend
re-authenticates by passing it as `input.password` to `auth.login`. This works for
same-device deployments where the password never leaves the LAN.

### Future remote model

For remote deployments the raw password must not travel over a cloud relay. The
intended replacement is a short-lived session token issued by the relay after the
device authenticates with its key (the `remote_key` field in
`CloudRemoteDialog.svelte`).

The typed seam is `sessionTokenSchema` in `envelope.schema.ts`:

```typescript
// packages/rpc/src/schemas/envelope.schema.ts
export const sessionTokenSchema = z.object({
  token:        z.string(),          // opaque (JWT or similar), issued by relay
  expiresAt:    z.string().datetime(), // ISO 8601 expiration
  refreshToken: z.string().optional(), // optional long-lived refresh token
});
export type SessionToken = z.infer<typeof sessionTokenSchema>;
```

**Flow (not yet wired):**

1. Device authenticates to relay with `remote_key`.
2. Relay issues a `SessionToken` (short-lived, e.g. 1 h).
3. Frontend receives the token via the relay handshake.
4. On reconnect, frontend presents `token` instead of the raw password.
5. When `expiresAt` is near, frontend uses `refreshToken` to obtain a new
   `SessionToken` without re-prompting the operator.

### `schemaVersion` and migration

`schemaVersionSchema` (`z.number().int().positive()`) is a numeric version field
on the `RemoteEnvelope`. Its purpose is token migration detection: if the relay
changes the envelope format (e.g. switches from opaque string to structured JWT
claims), both sides can negotiate by comparing `schemaVersion` values.

Current design version: **1** (design-only, not yet wired).

When the remote profile is wired, a `schemaVersion` mismatch should cause the
frontend to display a "firmware/relay version mismatch" banner rather than silently
failing.

---

## 5. Client Visibility Subscription

On metered relay links (bonded cellular), pushing every data stream to every
connected client wastes bandwidth. The `visibilitySubscriptionSchema` lets the
client declare which views it is actively rendering:

```typescript
// packages/rpc/src/schemas/envelope.schema.ts
export const visibilitySubscriptionSchema = z.record(z.string(), z.boolean());
export type VisibilitySubscription = z.infer<typeof visibilitySubscriptionSchema>;
```

Example payload:

```json
{ "streaming": true, "network": true, "settings": false, "hud": true }
```

The client sends this map on connect (and whenever the active destination changes).
The backend uses it to suppress pushes for views the client isn't showing. A client
that doesn't send a subscription receives all streams (backward-compatible default).

**Not yet wired.** The subscription message type and the server-side suppression
logic are both future work.

---

## 6. Ambition-B ACK/Replay Seam

### Decision

ACK + replay buffer (Ambition B) is **not justified** for the current message
stream. All periodic device-state messages (sensors, modems, network interfaces,
streaming config) are idempotent snapshots: a missed message is corrected by the
next broadcast. Sequence numbers + snapshot-on-reconnect + heartbeat dominate.

The typed seam exists only as a future extension point. **Do not build Ambition B
unless a non-idempotent event stream appears** (e.g. a command audit log, a
one-shot alert that must not be dropped, or a file-transfer chunk stream).

### What "non-idempotent event stream" means

A message is non-idempotent if missing it permanently loses information. Examples:

- A one-shot alert: "modem SIM ejected at 14:32:07" — if the client was
  disconnected at that moment, it never learns the event happened.
- A command audit log entry — each entry is unique and must be delivered exactly
  once.
- A firmware update progress chunk — chunks are ordered and non-repeatable.

Periodic telemetry (bitrate, signal strength, temperature) is NOT non-idempotent:
the next broadcast supersedes the missed one.

### Seam location

If Ambition B is ever triggered, the ACK/replay layer slots in at the
`RemoteEnvelope` boundary (`remoteEnvelopeSchema` in `envelope.schema.ts`). The
envelope wraps the existing RPC message; the replay buffer sits between the relay
and the backend message dispatcher. No changes to the existing oRPC contract layer
are needed.

---

## 7. Typed Seam Reference

All symbols below are exported from `packages/rpc/src/schemas/envelope.schema.ts`
(Task 4). They have zero runtime wiring today.

| Symbol | Kind | Purpose |
|---|---|---|
| `deploymentModeSchema` | `z.enum` | `"local" \| "remote"` profile switch |
| `DeploymentMode` | TypeScript type | Inferred from `deploymentModeSchema` |
| `sessionTokenSchema` | `z.object` | Short-lived relay-issued credential |
| `SessionToken` | TypeScript type | Inferred from `sessionTokenSchema` |
| `visibilitySubscriptionSchema` | `z.record` | Client view subscription map |
| `VisibilitySubscription` | TypeScript type | Inferred from `visibilitySubscriptionSchema` |
| `schemaVersionSchema` | `z.number` | Envelope version for migration detection |
| `SchemaVersion` | TypeScript type | Inferred from `schemaVersionSchema` |
| `remoteEnvelopeSchema` | `z.object` | Complete remote envelope (composes all above) |
| `RemoteEnvelope` | TypeScript type | Inferred from `remoteEnvelopeSchema` |

---

## 8. What Is and Isn't Wired Today

| Concept | Status |
|---|---|
| Same-device localhost topology | **Wired — production** |
| `CloudRemoteDialog.svelte` (provider/key config UI) | **Wired — UI only** |
| `deploymentMode` runtime branching | Not wired |
| Device dial-out to relay | Not wired |
| `SessionToken` auth on reconnect | Not wired |
| `VisibilitySubscription` send/suppress | Not wired |
| `schemaVersion` negotiation | Not wired |
| Ambition-B ACK/replay buffer | Not wired (build only if triggered) |

The `CloudRemoteDialog.svelte` stores provider and key config via `saveRemoteConfig`
but the backend does not yet act on those values to initiate a dial-out connection.
