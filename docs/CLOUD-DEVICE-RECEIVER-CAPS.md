# Cloud-to-Device Receiver-Caps Advertisement Contract

**Status: [GREENFIELD] — not yet implemented. This document specifies the future contract.**

Cross-refs:
- [`docs/RECEIVER-RECONCILIATION.md`](../../docs/RECEIVER-RECONCILIATION.md) — canonical reconciliation decision record
- [`srtla/docs/GAIN-HUNT-PROTOCOL.md`](../../srtla/docs/GAIN-HUNT-PROTOCOL.md) — gain-hunt evidence gate
- [`ceralive-platform/apps/api/lib/receiver/capabilities.ts`](../../ceralive-platform/apps/api/lib/receiver/capabilities.ts) — platform-side `computeReceiverCapabilities`
- [`CeraUI/apps/backend/src/modules/remote-control/channel.ts`](../apps/backend/src/modules/remote-control/channel.ts) — device-side control channel
- [`CeraUI/apps/backend/src/modules/remote-control/protocol.ts`](../apps/backend/src/modules/remote-control/protocol.ts) — wire-envelope Zod schemas

---

## 1. Purpose

This document specifies the **future** channel by which the cloud platform advertises
per-receiver-kind capabilities to the device. That advertisement is the prerequisite for
any earned-catalog UI in CeraUI: the device cannot render a capability-gated profile
selector until it knows what the cloud receiver actually supports.

Until this channel exists, CeraUI stays latency-only. The earned catalog is empty. No
profile selector is shown. This is the correct state today.

---

## 2. Why this channel does not exist yet

There is a common confusion to clear up first.

`getCapabilities()` in CeraUI (`apps/backend/src/modules/streaming/capabilities.ts`) is
the **local cerastream engine snapshot**. It describes what the on-device encoder can do:
which pipelines, codecs, and transports the engine supports. It has nothing to do with
what the cloud receiver can accept.

The cloud platform already knows receiver capabilities. `computeReceiverCapabilities`
(`ceralive-platform/apps/api/lib/receiver/capabilities.ts`, Tasks 5+6) computes a
per-kind descriptor from the device's reported `receiverKind` and the receiver's freeze
mode. The platform uses this internally to gate which SRT profile it pushes via
`device.setProfile`.

What does NOT exist is a channel that sends those computed caps back to the device so
CeraUI can render them. The platform knows; the device does not. This document specifies
how to close that gap.

---

## 3. The channel

### 3.1 Chosen approach: new internal command `platform.receiverCaps`

The control channel already carries platform-to-device internal commands (spec §5,
`INTERNAL_COMMANDS` in `protocol.ts`). The existing pattern is:

- `ingest.slots` — platform pushes account-resolved ingest slots to the device
- `device.setProfile` — platform pushes the resolved SRT receive profile

`platform.receiverCaps` follows the same pattern: a new downstream-only internal command
the platform sends after `device.hello` (and on any change to the receiver kind or the
gain-hunt evidence set).

**Direction:** platform (hub) → device. Downstream only. The device never sends this.

**When sent:**
1. On `device.hello` receipt, after `persistAndPushProfile` resolves the receiver kind.
2. On any change to `Device.receiverKind` (e.g. the operator reconfigures the destination
   in CeraUI and a new `device.hello` arrives with a different `receiverKind`).
3. On any change to the gain-hunt evidence set that expands or contracts the earned catalog
   for the device's receiver kind (future: when a mixture clears the gain-hunt gate).

**Withholding rule (safe rollout):** the hub withholds `platform.receiverCaps` from any
device whose `device.hello` `supportedTypes` does not include `"platform.receiverCaps"`.
This is the same safe-rollout mechanism used by `device.setProfile` (spec §13). A
not-yet-updated device never receives a frame it cannot parse.

### 3.2 Alternative considered: field on `hub.hello`

The `hub.hello` handshake response (spec §4) could carry a `receiverCaps` field. This
was rejected because:

- `hub.hello` is sent once at connection time. A caps change (e.g. gain-hunt evidence
  lands mid-session) would require a reconnect to propagate.
- The internal-command pattern already handles push-on-change cleanly.
- Adding a field to `hub.hello` would require schema changes on both sides simultaneously;
  a new internal command is additive and safe-rollout-compatible.

---

## 4. Wire shape

### 4.1 Frame envelope

The frame follows the standard control-channel envelope (spec §3):

```json
{
  "v": 1,
  "kind": "command",
  "type": "platform.receiverCaps",
  "cid": "<uuid-v4>",
  "payload": { ... }
}
```

`kind` is `"command"` (downstream internal command, same as `ingest.slots` and
`device.setProfile`). The device sends a `delivery.ack` echoing the `cid` before
processing, per spec §6.1.

### 4.2 Payload schema

```json
{
  "type": "platform.receiverCaps",
  "payload": {
    "kind": "ceralive",
    "profiles": ["balanced", "low-latency", "resilient", "classic", "low-latency-fec"],
    "fec_capable": true,
    "latency_range": {
      "min_ms": 100,
      "max_ms": 5000
    }
  }
}
```

Field definitions:

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `string` | The receiver kind the platform resolved for this device. Lowercase: `"ceralive"`, `"belabox"`, `"custom"`, or `"unknown"`. Mirrors `Device.receiverKind` (stored lowercase). |
| `profiles` | `string[]` | The earned profiles the platform will honor for this receiver. Today this is always `["classic"]` for non-CeraLive receivers and `["balanced", "low-latency", "resilient", "classic"]` (or `[..., "low-latency-fec"]` when FEC is earned) for CeraLive. The list grows as gain-hunt evidence gates pass. |
| `fec_capable` | `boolean` | Whether the receiver can negotiate SRT FEC (`SRTO_PACKETFILTER`). `true` only for a CeraLive receiver with `reorderfreeze` + packet-filter support. |
| `latency_range` | `{ min_ms: number, max_ms: number }` | The latency window the receiver is rated for. `min_ms` is always 100. `max_ms` is 5000 for a true L1 CeraLive receiver, 2000 for everything else. |

### 4.3 Zod schema (device-side, lenient)

Per Rule D (repos are self-contained), the device writes its own Zod schema from this
spec. It should be lenient: unknown keys stripped, all fields optional for forward
compatibility, with safe defaults when absent.

```typescript
// In protocol.ts, alongside IngestSlotsPayloadSchema
export const ReceiverCapsPayloadSchema = z.object({
  kind: z.string().optional(),
  profiles: z.array(z.string()).optional(),
  fec_capable: z.boolean().optional(),
  latency_range: z
    .object({
      min_ms: z.number().int().optional(),
      max_ms: z.number().int().optional(),
    })
    .optional(),
});
export type ReceiverCapsPayload = z.infer<typeof ReceiverCapsPayloadSchema>;
```

The device treats an absent or empty `profiles` array as "no earned catalog" (latency-only
fallback). It never crashes on a missing field.

### 4.4 Relationship to `computeReceiverCapabilities`

The payload maps directly from the platform's `ReceiverCapabilities` struct:

| `ReceiverCapabilities` field | `platform.receiverCaps` payload field |
|------------------------------|---------------------------------------|
| `supportsFec` | `fec_capable` |
| `profiles` | `profiles` |
| `latencyMaxMs` | `latency_range.max_ms` |
| (implicit) | `latency_range.min_ms` = 100 (constant) |
| (implicit) | `kind` = normalized `Device.receiverKind` |

`srtlaVersion` and `freezeMode` from `ReceiverCapabilities` are NOT included in the
payload. They are internal platform details the device does not need for UI rendering.

---

## 5. Device-side consumer seam

### 5.1 Where the message is handled

The handler lives in `apps/backend/src/modules/remote-control/command-router.ts`, in the
INTERNAL-command branch (before the owner gate, same as `ingest.slots` and
`device.setProfile`):

```typescript
// In command-router.ts, INTERNAL-command branch
case "platform.receiverCaps": {
  const payload = ReceiverCapsPayloadSchema.safeParse(command.payload);
  if (payload.success) {
    handleReceiverCaps(payload.data);
  }
  break;
}
```

### 5.2 Storage

A new module `apps/backend/src/modules/remote-control/receiver-caps.ts` owns the
in-memory store and the handler:

```typescript
// receiver-caps.ts
import type { ReceiverCapsPayload } from "./protocol.ts";

let _caps: ReceiverCapsPayload | undefined;

export function handleReceiverCaps(payload: ReceiverCapsPayload): void {
  _caps = payload;
  // Broadcast a "capabilities" event so the frontend re-renders.
  // The existing broadcastMsg("capabilities", ...) path is the right hook.
}

export function getReceiverCaps(): ReceiverCapsPayload | undefined {
  return _caps;
}
```

The caps are reset to `undefined` on control-channel disconnect (the platform will
re-push on reconnect). They are NOT persisted to `config.json` — they are a live
platform assertion, not a device-owned config value.

### 5.3 Frontend consumption

The frontend reads the caps via the existing `capabilities` broadcast event. The backend
merges the platform-pushed caps into the `capabilities` snapshot it sends to the frontend:

```typescript
// In capabilities.ts (getCapabilities), additive merge:
const platformCaps = getReceiverCaps();
return {
  ...engineCaps,
  // Platform-advertised receiver caps (undefined until the channel exists):
  receiver_caps: platformCaps ?? null,
};
```

`ServerDialog` and `receiver-experience.ts` read `receiver_caps` from the capabilities
snapshot. When `receiver_caps` is `null` (channel not yet established, or receiver kind
is non-CeraLive), the UI stays latency-only. When `receiver_caps.profiles` is non-empty,
the profile selector renders only the advertised profiles.

This is the "earned-catalog seam": the selector is empty today because `receiver_caps` is
always `null`. It grows automatically as the platform pushes a wider profile list.

### 5.4 Protocol registration

`"platform.receiverCaps"` must be added to `INTERNAL_COMMANDS` in `protocol.ts` and
therefore to `COMMAND_REGISTRY`. This opts the device in via `device.hello`
`supportedTypes`, which is the safe-rollout signal the hub uses to decide whether to
send the frame (spec §13).

```typescript
// In protocol.ts
export const INTERNAL_COMMANDS = [
  "ingest.slots",
  "device.setProfile",
  "platform.receiverCaps",  // <-- add this
] as const;
```

---

## 6. Prerequisites

The following must be in place before this channel can be implemented:

1. **`Device.receiverKind` persisted (done, Task 6).** The platform must know the
   receiver kind before it can compute and push caps. Task 6 added `Device.receiverKind`
   to the Prisma schema and wires it from `device.hello` `deviceCaps.receiverKind`.

2. **`computeReceiverCapabilities` in the push path (done, Task 5).** The platform
   already computes per-kind caps for the `device.setProfile` push. The same computation
   feeds `platform.receiverCaps`.

3. **`device.hello` carries `receiverKind` (done, Task 12).** CeraUI already emits
   `deviceCaps.receiverKind` in `buildDeviceHello` (`channel.ts`), derived from the
   media destination (not `remote_provider` alone).

4. **Gain-hunt evidence gate (future).** The `profiles` list in the payload stays
   `["classic"]` (or the non-FEC CeraLive set) until a mixture clears the pre-registered
   gain-hunt decision rule in `srtla/docs/GAIN-HUNT-PROTOCOL.md`. The channel can be
   implemented before the gain-hunt campaign runs; the payload will simply carry the
   current (conservative) earned set.

5. **Platform-side push wiring (future).** The platform gateway
   (`apps/api/gateway/connection.ts`, `persistAndPushProfile`) must be extended to also
   push `platform.receiverCaps` after resolving the receiver kind. This is a small
   additive change to the existing `onProfileHello` path.

---

## 7. What stays the same until this channel exists

- CeraUI renders latency only. No profile selector. No FEC toggle exposed as a
  standalone control.
- `getCapabilities()` continues to serve the LOCAL cerastream engine snapshot. It is
  NOT used for cloud receiver-caps.
- The `device.setProfile` push path (Tasks 5+6) continues to gate profiles by receiver
  kind on the platform side. The device applies whatever profile the platform pushes,
  without needing to know the full caps set.
- The earned catalog is empty. `receiver_caps` is `null` in the capabilities snapshot.

---

## 8. Implementation checklist (future task)

When this channel is implemented, the following changes are needed:

**Platform (`ceralive-platform`):**
- [ ] Add `"platform.receiverCaps"` to `INTERNAL_COMMANDS` in
  `apps/api/lib/remote-control/protocol.ts`
- [ ] Add `ReceiverCapsPayloadSchema` (platform-side, strict) to the same file
- [ ] In `apps/api/gateway/connection.ts` `onProfileHello` (or a new `onCapsHello`
  hook), after resolving `receiverKind`, build and push a `platform.receiverCaps`
  command frame via `hub.sendCommand`
- [ ] Add a unit test: CeraLive device → `profiles` includes `balanced`; belabox device
  → `profiles` is `["classic"]`

**CeraUI (`CeraUI`):**
- [ ] Add `"platform.receiverCaps"` to `INTERNAL_COMMANDS` in `protocol.ts`
- [ ] Add `ReceiverCapsPayloadSchema` (device-side, lenient) to `protocol.ts`
- [ ] Create `apps/backend/src/modules/remote-control/receiver-caps.ts` with
  `handleReceiverCaps` + `getReceiverCaps`
- [ ] Wire the handler in `command-router.ts` (INTERNAL-command branch)
- [ ] Merge `receiver_caps` into the `capabilities` broadcast in
  `modules/streaming/capabilities.ts`
- [ ] Update `receiver-experience.ts` `deriveReceiverCaps` to prefer the platform-pushed
  caps over the local engine snapshot when `receiver_caps` is non-null
- [ ] Add unit tests: `receiver_caps` null → latency-only; `receiver_caps.profiles`
  non-empty → selector renders only those profiles
- [ ] Add `"platform.receiverCaps"` to the `check:tech-debt` register as `open` until
  the channel is live (optional, per `docs/TECHNICAL_DEBT.md` conventions)
