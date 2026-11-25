<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SESSION CONTROL CONNECTION — A DROP *IS* A SESSION BOUNDARY [EXISTS]

The exact inverse of the rule above, for a different connection. Read both
together: the same event (a socket closing) carries opposite authority depending
on what the socket is FOR.

`cerastream-backend.ts`'s `this.client` is opened once in `start()` and held for
the session's whole lifetime. It is dialled with the published client's
`autoReconnect` at its default (**false**), and that client — inspected in the
shipped `dist/client.js`, v2026.7.3 — exposes **no** close/error event, **no**
`isConnected()`, and **no** `reconnect()`. Once its Unix socket drops, the
instance is permanently unusable: `rawRequest` short-circuits on `if (!socket)`
and every later call rejects `CerastreamConnectionError("control connection is
not open", code "closed")`. Only a fresh `connect()` produces a usable client.

**Nothing was watching, and three things compounded.** Confirmed live in Wave H:
`cerastream.service` restarted mid-session and CeraUI never noticed for 11+
minutes.

1. `switchInput` (and `switchAudio` / `setBitrate` / `reloadConfig` /
   `reloadAudioDelay` / `listDevicesIfActive`) kept dispatching onto the dead
   client, rejecting identically forever, changing no state.
2. `reconcileRuntimeState()` short-circuits on
   `telemetry !== null && this.client !== undefined` — it treated a **dead client
   as proof of a live session** and re-affirmed `"streaming"` from the last stale
   heartbeat, so even the `engine-reconnect.ts` heal path's
   `reconcileStreamSession()` could not correct it.
3. `is_streaming` therefore stayed true and the lifecycle stayed `streaming`, so
   a fresh `streaming.start` was inadmissible; forced through, an engine with no
   memory of the session answered an RPC error classified `engine_internal`.

`engine-reconnect.ts` heals availability, not the lost socket. A proven session
loss re-arms it through the shared engine-control loss seam.

**The rule.** A dropped control connection retires the local session handle.
It does not prove process exit: cerastream can keep streaming after a client
disconnects. Actual process exit ends its in-process session. The binding's
hello reports build and protocol versions, not a process-instance identity;
neither a successful dial nor a matching `cs-N` proves ownership.

`noteConnectionLoss(client, error, site)` is the single seam. It acts only on
PROOF — a `CerastreamConnectionError` from the client we are STILL holding, for a
session we still believe is `active`. An engine RPC error, a request timeout, a
rejection from an already-superseded client, and our own `stop()`'s close (which
clears `active` first) are all deliberately NOT proof. The packaged 90 s
systemd watchdog applies when engine watchdog notifications cease. It is not a
promise that every unresponsive socket leads to process exit.

| Concern | Rule |
|---------|------|
| Detection (proactive) | The device registry checks the active client with `listDevicesIfActive()`. The availability owner also checks the control plane when idle; neither infers session state from a missed heartbeat. |
| Detection (on demand) | `withSessionClient(site, op)` wraps every session-scoped RPC; the caller still receives its ORIGINAL error, this only adds the missing state change. `handleOpFailure` covers the queued ops. |
| Order | Revoke local client ownership, retire its subscription, evidence and telemetry, close the client, and publish the change. |
| Reaction | `deps.onSessionConnectionLost` raises the existing loss indicator and retires the generation's local sender, listeners and telemetry. No Stop is sent. The launch and OTA fence stays in place until fresh lifecycle evidence settles it. |

One-shot restoration still requires its armed marker and affirmative fresh Idle.
A fresh Streaming report adopts the running stream without restarting it. Silence
does not allow a new Start or remove the OTA fence.
After availability heals, separate read-only reconciliation keeps checking an
unresolved loss until it sees authoritative state or operator intent takes over.

**STOP uses a second connection, and success means engine Idle.** The IPC server
dispatches at most one request per connection. Reusing the session client for
`stop`, then closing it to interrupt pending work, can leave the stop line unread
behind `list-devices` or start; the server finishes the first call, fails its reply
to the closed peer, and exits without dispatching stop. That produced a real board
state where CeraUI returned `stopped`, the engine kept reconnecting egress, and the
frame watchdog later aborted it. `CerastreamBackend.stop()` now connects a fresh
client, dispatches stop there, closes the old session client, awaits the fresh
client's `state: "idle"` response, closes it, and only then invokes `onStopped`.
The connect-plus-acknowledgement request gets 6.5 seconds, derived by reserving
`ENGINE_CLOSE_DEADLINE_MS` (5 seconds) plus
`ENGINE_STOP_DEADLINE_MARGIN_MS` (0.5 seconds) inside the unchanged 12-second
orchestrator bound. Expiry fences a connection that has not dispatched: if it
resolves later, it is closed before `stop()` is called. An already-dispatched but
unacknowledged stop connection is closed and never invokes the callback, but the
engine may still finish work already written to that socket; its state is therefore
unknown, and the orchestrator reports `stop_failed` before reconciliation adopts
the eventual truth. Coverage:
`tests/cerastream-stop-ack.test.ts` drives a blocked session request and controls
the independent stop acknowledgement; `tests/cerastream-stop-deadline.test.ts`
drives both late-connect and unacknowledged-RPC expiry.

**Scoped OUT, deliberately:** ambiguous in-flight Start rollback and its outer
deadline need attempt-scoped cancellation. A process restart does not resume
an old engine graph; observation or marker-authorized restoration is separate.

Coverage: `tests/engine-session-connection-loss.test.ts` (dead-connection
`switchInput` retires once and only once, the registry poll detects it with no
operator action, a fresh start dials a NEW client and works, reconciliation stops
re-affirming the phantom session, and the orchestrator re-admits a start; the RPC
error and operator-stop negatives are the controls, green on both trees).

