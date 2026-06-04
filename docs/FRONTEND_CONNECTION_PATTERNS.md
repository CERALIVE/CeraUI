# Frontend Connection Patterns

This document covers the frontend-specific connection layer: how the WebSocket client initialises, how reactive state is fed, how optimistic writes are protected from stale echoes, and how the transport self-heals after any outage.

For the backend broadcast enumeration (which message types the server pushes and when), see [RPC_COMMUNICATION.md](RPC_COMMUNICATION.md).

---

## Table of Contents

1. [initSubscriptions() — startup requirement](#initsubscriptions--startup-requirement)
2. [Subscription getters](#subscription-getters)
3. [Dirty-registry field-lock contract](#dirty-registry-field-lock-contract)
4. [Reconnect re-auth and safety hydrate](#reconnect-re-auth-and-safety-hydrate)
5. [Infinite-retry with jittered capped backoff](#infinite-retry-with-jittered-capped-backoff)
6. [Failed-UI vs transport independence](#failed-ui-vs-transport-independence)
7. [Connection-ready gate and BootShell](#connection-ready-gate-and-bootshell)
8. [Half-open detection](#half-open-detection)
9. [Per-type sequence guard](#per-type-sequence-guard)

---

## initSubscriptions() — startup requirement

**File:** `apps/frontend/src/lib/rpc/subscriptions.svelte.ts`

`initSubscriptions()` must be called once at application startup, before any component mounts. It is called in `main.ts`.

```ts
// main.ts (simplified)
initSubscriptions();
mount(App, { target: document.getElementById('app')! });
```

The function is idempotent (guarded by `isInitialized`), but it must run before any getter is read. Calling it late means the `onMessage` and `onConnectionChange` handlers are not registered, so every getter returns its initial empty/`undefined`/`false` value for the lifetime of the page.

What `initSubscriptions()` does:

1. Registers `handleMessage` on `rpcClient.onMessage` — feeds all data getters.
2. Registers `handleConnectionChange` on `rpcClient.onConnectionChange` — updates `connectionState`, `isConnectedState`, `connectionReadyState`, and triggers reconnect re-auth.
3. Starts the dirty-field registry TTL sweep interval (every 5 s).
4. Calls `rpcClient.connect()` to open the WebSocket.

---

## Subscription getters

**File:** `apps/frontend/src/lib/rpc/subscriptions.svelte.ts`

All getters are plain functions that return Svelte 5 `$state` values. Because the backing variables are module-level `$state`, any component that reads them inside a reactive context (`$derived`, template expression, `$effect`) will re-run when the value changes.

| Getter | Type | Description |
|---|---|---|
| `getAuth()` | `{ success: boolean; auth_token?: string } \| undefined` | Last auth result |
| `getConfig()` | `ConfigMessage \| undefined` | Streaming/encoder config |
| `getStatus()` | `StatusResponse & { is_streaming, wifi, modems } \| undefined` | Aggregated device status |
| `getIsStreaming()` | `boolean` | Whether a stream is active |
| `getSsh()` | `StatusResponse["ssh"] \| undefined` | SSH service state |
| `getAvailableUpdates()` | `StatusResponse["available_updates"] \| undefined` | Pending software updates |
| `getUpdating()` | `StatusResponse["updating"]` | Update-in-progress flag |
| `getNetif()` | `NetifMessage \| undefined` | Network interface map |
| `getWifi()` | `WifiStatus \| undefined` | WiFi status |
| `getModems()` | `ModemList \| undefined` | Cellular modem list |
| `getSensors()` | `SensorsStatus \| undefined` | SoC telemetry (temp, load) |
| `getRevisions()` | `Revisions \| undefined` | Software version info |
| `getPipelines()` | `PipelinesMessage \| undefined` | Encoder pipeline list |
| `getAudioCodecs()` | `Record<string, { name: string }> \| undefined` | Available audio codecs |
| `getRelays()` | `RelayMessage \| undefined` | Relay server list |
| `getNotifications()` | `NotificationsMessage \| undefined` | Persistent notifications |
| `getConnectionState()` | `"connecting" \| "connected" \| "disconnected" \| "error"` | Raw transport state |
| `getIsConnected()` | `boolean` | `true` only when `connectionState === "connected"` |
| `getConnectionReady()` | `boolean` | Latches `true` on first connect or first inbound message; never reverts |

### Connection state vs connection ready

`getIsConnected()` tracks the live socket state — it flips back to `false` on every disconnect. `getConnectionReady()` is a one-way latch: it becomes `true` the first time the device speaks (either a `"connected"` event or any inbound message) and stays `true` for the rest of the page-load. The boot shell uses this latch; the disconnected banner uses `getIsConnected()`.

**Do not** read connection state from `lib/stores/offline-state.svelte` in authenticated components. That store only covers the browser-offline PWA case. Use `getIsConnected()` / `getConnectionState()` from `subscriptions.svelte.ts` — these survive socket replacement across reconnect cycles.

---

## Dirty-registry field-lock contract

**File:** `apps/frontend/src/lib/rpc/dirty-registry.svelte.ts`

When the user edits a config field and the RPC is in flight, the server will echo the old value back in the next broadcast. Without protection, the UI would flicker back to the pre-edit value. The dirty-field registry prevents this.

### The contract

```
markPending(field, intendedValue)
  → UI shows intendedValue immediately
  → stale server echoes of the old value are ignored

onRpcResolved(field)
  → marks the RPC as resolved; lock is NOT released yet

onRpcAppliedReactive(field, appliedValue)   ← fast path (Task 15)
  → releases the lock immediately to the server-applied value
  → the applied value may differ from intendedValue (hardware clamping)

  OR: wait for the next broadcast echo
  → reconcileReactive(field, incomingValue) releases the lock
    once rpcResolved is true and the server echoes the field
```

### Release rules

The lock releases via one of three paths:

1. **Fast path — `onRpcApplied`**: the RPC resolves and returns the server-applied value. The lock releases immediately to that value. If the TTL already expired before the RPC resolved, `onRpcApplied` is a no-op (idempotent — it never resurrects a stale lock).

2. **Echo path — `reconcile`**: the RPC has resolved (`rpcResolved = true`) and the server sends a broadcast carrying that field. The lock releases and the server value is accepted as truth (any value, including a hardware-clamped one).

3. **TTL safety valve — `expire`**: if neither of the above happens within `FIELD_LOCK_TTL_MS` (10 s), the lock is force-released. This guarantees a field can never stay locked forever.

### TTL vs RPC timeout

`FIELD_LOCK_TTL_MS` (10 s) is intentionally shorter than the RPC call timeout (30 s). A slow RPC that resolves after the TTL has already released the field must not resurrect the lock. `onRpcApplied` handles this: if the field is no longer locked when the RPC resolves, it applies the value to view state and returns `{ apply: true, released: false }` — safe and idempotent.

### Architecture: pure core + reactive wrapper

The decision logic (`shouldIgnoreEcho`, `reconcile`, `onRpcApplied`, `expire`) is rune-free and fully unit-testable. The reactive layer (`createDirtyStore`) wraps these functions with `$state` and is only created lazily on first selector access. Unit tests exercise the pure core directly via `registryCore`.

### Public API (reactive selectors)

| Function | Description |
|---|---|
| `isPending(field)` | Whether the field currently holds an optimistic lock |
| `markPending(field, intendedValue)` | Record an optimistic write; resets the TTL |
| `onRpcResolved(field)` | Mark the owning RPC as resolved (does not release the lock) |
| `onRpcAppliedReactive(field, appliedValue)` | Fast-path release to the server-applied value |
| `reconcileReactive(field, incomingValue)` | Reconcile an incoming broadcast field against the registry |
| `shouldIgnoreEchoReactive(field, incomingValue)` | Whether to skip applying an incoming value |
| `expireReactive()` | Force-release all locks past their TTL |

### netif special case

The `netif` message handler guards only the `enabled` field per interface, keyed as `enabled_${ifname}`. All other netif fields (`tp`, `ip`, `error`, `mac`) flow through live without registry interaction.

---

## Reconnect re-auth and safety hydrate

**File:** `apps/frontend/src/lib/rpc/reconnect.ts`

When the WebSocket reconnects after the operator has already authenticated, the new socket is unauthenticated. The backend only pushes device state after a successful `auth.login`. Without re-auth, the UI shows the authenticated shell with blank views.

`reauthenticateAndHydrate(deps)` handles this:

1. Reads the stored credential from `localStorage["auth"]` (the password, not a server-issued token).
2. Calls `deps.login(token)` — wired to `rpc.auth.login({ password: token, persistent_token: true })`.
3. Dispatches the auth result through `handleMessage` (the canonical path).
4. On success: fires a safety hydrate — `rpc.streaming.getConfig()` and `rpc.status.getStatus()` in parallel, dispatching both results through `handleMessage`. This repopulates the HUD and destination views even if the backend's post-login push is incomplete.
5. On failure: clears the stored credential (loop break — the next reconnect finds no token and short-circuits) and routes to the login screen.

The function is dependency-injected and rune-free, so it runs under the plain vitest environment.

### Outcomes

| Outcome | Meaning |
|---|---|
| `"no-token"` | No stored credential; first-time login owns the initial auth |
| `"hydrated"` | Re-auth succeeded and the safety hydrate ran |
| `"expired"` | Stored credential rejected; cleared, routed to login |

### Wiring in subscriptions.svelte.ts

`runReconnectReauth()` is called from `handleConnectionChange` when `state === "connected"` and `wasAuthenticated()` is true. A `reauthInFlight` flag prevents concurrent re-auth attempts across rapid reconnect cycles.

The seq tracker is reset on every reconnect (`seqTracker.resetOnReconnect()`) so a restarted server whose sequence numbers reset to 0 is accepted cleanly.

---

## Infinite-retry with jittered capped backoff

**File:** `apps/frontend/src/lib/rpc/backoff.ts`

The transport retries forever. There is no give-up condition in `client.ts`. A device reboot or transient network blip always self-heals once connectivity returns.

### Formula

```
delay = min(cap, base · 2^attempt) · (1 + rand(-0.3, +0.3))
```

- `base`: 1000 ms (first retry waits ~1 s)
- `cap`: 30 000 ms (~30 s ceiling before jitter)
- `JITTER_RATIO`: ±30%, applied on **every** step — not only once the cap is reached

The jitter on every step prevents a fleet of clients reconnecting after the same outage from synchronising into a thundering herd.

### `nextBackoffDelay(attempt, base, cap, rand?)`

```ts
import { nextBackoffDelay } from '$lib/rpc/backoff';

const delay = nextBackoffDelay(
  this.reconnectAttempts,  // 0-based retry index
  1000,                    // base ms
  30000,                   // cap ms
);
setTimeout(() => this.connect(), delay);
```

The function guarantees a finite, non-negative number for every input. `2^attempt` can overflow to `Infinity` for large attempt counts; the `min(cap, ...)` clamp keeps the result bounded without a give-up.

### Wiring in client.ts

`handleReconnect()` is called from `socket.onclose`. It computes the delay, increments `reconnectAttempts`, and schedules the next `connect()` call. The attempt counter resets to 0 on a successful `onopen`.

---

## Failed-UI vs transport independence

**File:** `apps/frontend/src/lib/stores/connection-ux.svelte.ts`

`MAX_RECONNECT_ATTEMPTS = 5` is a **UI-only threshold**. It controls when the disconnected banner switches from "Reconnecting…" to a hard-failure message with a manual "Retry now" affordance. It does not stop the transport.

The transport (`client.ts`) retries forever regardless of what the banner shows. Failed-UI state and transport state are independent state machines.

### Banner modes

| Mode | Condition |
|---|---|
| `"connected"` | Socket is connected; banner hidden |
| `"reconnecting"` | Socket is down, attempt count < `MAX_RECONNECT_ATTEMPTS` |
| `"failed"` | Socket is down, attempt count ≥ `MAX_RECONNECT_ATTEMPTS` |
| `"rebooting"` | `markRebooting()` was called (explicit reboot/poweroff) |

The `"failed"` mode shows a "Retry now" button. Clicking it calls `retryConnection()`, which resets the local attempt counter to 0 (so the banner returns to "Reconnecting…") and calls `rpcClient.connect()` to nudge the transport immediately.

### Precedence in `deriveConnectionUx`

1. Browser-offline PWA page is showing → suppress the banner entirely.
2. Rebooting latch is set → show "Rebooting…" banner.
3. Socket is connected → hide banner.
4. Browser is offline (but offline page hasn't taken over yet) → suppress banner; defer to the offline page.
5. Attempt count ≥ threshold → "failed" banner.
6. Otherwise → "reconnecting" banner.

### Store initialisation

`connection-ux.svelte.ts` creates its store eagerly at module load in the browser (not lazily inside a component). This is intentional: the `onConnectionChange` handler must be registered before any connection events fire. The `window` guard keeps the module importable in the node vitest environment.

### Public selectors / actions

| Function | Description |
|---|---|
| `getReconnectAttempts()` | Attempts since last successful connection |
| `getIsRebooting()` | Whether a reboot/poweroff is in progress |
| `getSessionExpired()` | Whether the session expired mid-session |
| `markRebooting()` | Flag that a reboot was triggered |
| `markSessionExpired()` | Flag that the auth token expired mid-session |
| `clearSessionExpired()` | Clear the expiry flag on fresh login |
| `retryConnection()` | Reset attempt counter and nudge the transport |

---

## Connection-ready gate and BootShell

**Files:**
- `apps/frontend/src/lib/rpc/subscriptions.svelte.ts` (`getConnectionReady`)
- `apps/frontend/src/lib/components/custom/BootShell.svelte`

### The gate

`connectionReadyState` is a one-way latch in `subscriptions.svelte.ts`. It becomes `true` when either:

- `handleConnectionChange` receives `"connected"`, or
- `handleMessage` processes any inbound message.

It never reverts to `false`. The latch is event-driven with no timeout — a remote first-connect is legitimately slow and must never be failed by a clock.

```ts
// In handleConnectionChange:
if (state === "connected") {
  if (!connectionReadyState) connectionReadyState = true;
  // ...
}

// In handleMessage:
if (!connectionReadyState) connectionReadyState = true;
```

### BootShell

`BootShell.svelte` is a purely presentational overlay rendered immediately on page load. It shows a spinning ring and "Connecting to device…" copy. `App.svelte` dismisses it the instant `getConnectionReady()` becomes `true`.

The copy is a literal string (not i18n) because the component renders before the locale bundle loads.

The component respects `prefers-reduced-motion`: the spinning animation is replaced with a fade when the user has requested reduced motion.

---

## Half-open detection

**Files:**
- `apps/frontend/src/lib/rpc/heartbeat.ts` — staleness core
- `apps/frontend/src/lib/rpc/half-open.ts` — force-close decision
- `apps/frontend/src/lib/rpc/client.ts` — wiring

A WebSocket can go half-open: the socket still reports `OPEN` but the peer is gone and no `close`/`error` ever fires. The keepalive interval in `client.ts` detects this and forces a reconnect.

### Heartbeat tracker

`createHeartbeatTracker()` returns a minimal state holder with three methods:

| Method | Description |
|---|---|
| `recordTraffic(now)` | Record that inbound traffic was observed at `now` ms |
| `isStale(now, threshold?)` | `true` if `now - lastSeenAt > threshold` (default 15 000 ms) |
| `getLastSeenAt()` | The timestamp of the last recorded traffic |

`HEARTBEAT_THRESHOLD_MS = 15000` — approximately 3 missed 5 s server pings.

Every inbound frame (any message, including server pings) calls `heartbeatTracker.recordTraffic(Date.now())` in `client.ts:handleMessage`. This keeps the tracker fresh as long as the connection is alive.

### shouldForceCloseHalfOpen

```ts
shouldForceCloseHalfOpen(tracker, now, socket?.readyState)
```

Returns `true` only when:
- The socket's `readyState` is `OPEN` (1), AND
- `tracker.isStale(now)` is `true`

A socket that is already `CONNECTING`, `CLOSING`, or `CLOSED` is not force-closed — it is already owned by the reconnect path, and closing it again would race the re-auth/hydrate sequence.

### Wiring in client.ts

The keepalive interval fires every 10 s. On each tick:

1. Call `shouldForceCloseHalfOpen(heartbeatTracker, Date.now(), socket?.readyState)`.
2. If `true`: log a warning, call `socket.close()`. The `onclose` handler fires, which calls `handleReconnect()` — the normal infinite-retry path takes over.
3. If `false`: send a `keepalive` ping to the server.

### Server ping handling

The server sends `{ ping: { t: <timestamp_ms> } }` frames. `parseServerPing(value)` validates the payload (must be `{ t: positive integer }`). On a valid ping, `client.ts` responds with `sendLegacy("pong", true)` and returns early — the ping is not forwarded to message handlers. The inbound ping frame itself already called `recordTraffic`, so the heartbeat tracker is updated regardless.

---

## Per-type sequence guard

**File:** `apps/frontend/src/lib/rpc/seq-guard.ts`

The backend tags broadcast messages with a top-level `seq` number. `client.ts` lifts `seq` out of the envelope and forwards it alongside each `type → data` pair to message handlers. `subscriptions.svelte.ts` uses a `SeqTracker` to drop out-of-order or duplicate frames before applying them to state.

### Rules

- Accept if `incomingSeq > lastSeen` (gaps are fine — monotonic-greater, not strictly +1).
- Drop if `incomingSeq <= lastSeen` (stale or duplicate).
- Messages without `seq` bypass the guard entirely (backward-additive).
- On reconnect, `seqTracker.resetOnReconnect()` clears all `lastSeen` values so a restarted server whose sequence resets to 0 is accepted cleanly.

The tracker is per-type (`Map<string, number>`), never a global counter. A slow `modems` broadcast does not affect the `sensors` sequence.

`seqTracker.advance(type, seq)` is called after applying a message, not before, so the `lastSeen` only advances on messages that were actually processed.
