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

`engine-reconnect.ts` does NOT cover this: it SETTLES (`state.stopped = true`)
once the engine is reachable at boot and never re-arms, and it heals the
capability probe — a short-lived connection — not a session's dedicated one.

**The rule.** cerastream is systemd-owned (ADR-0005), so a dropped control
connection means the process CeraUI was driving went away; a restarted engine has
no memory of the session, and the client cannot re-establish one. The socket is
the ONLY handle on the engine-side pipeline, so losing it retires the session.

`noteConnectionLoss(client, error, site)` is the single seam. It acts only on
PROOF — a `CerastreamConnectionError` from the client we are STILL holding, for a
session we still believe is `active`. An engine RPC error, a request timeout, a
rejection from an already-superseded client, and our own `stop()`'s close (which
clears `active` first) are all deliberately NOT proof.

| Concern | Rule |
|---------|------|
| Detection (proactive) | `listDevicesIfActive()` — the device registry re-polls it every couple of seconds for the whole session, so it is the first call to touch a dead socket. **No watchdog timer**, so nothing can mis-fire on a missed heartbeat. |
| Detection (on demand) | `withSessionClient(site, op)` wraps every session-scoped RPC; the caller still receives its ORIGINAL error, this only adds the missing state change. `handleOpFailure` covers the queued ops. |
| Order | The dead client is dropped FIRST (see cause 2 above), with the subscription and telemetry, then `bridge.broadcastStatus()`. |
| `active` | Deliberately LEFT SET, so `stop()` still recognises the session it must tear down — clearing it makes `stop()` return `false` and trips `reportSessionInvariant`. |
| Reaction | `deps.onSessionConnectionLost(site)`. Production wiring raises the EXISTING `engine-crashed` lifecycle indicator (before the stop, since the reporter is gated on `isStreaming`), then retires the session via `stopStreamSession()` — its single owner. Fire-and-forget: it runs inside a rejected RPC's catch and must never replace the caller's error. |

Net effect: the board lands in a real `idle` and the next `streaming.start` dials
a fresh connection and succeeds — no `ceralive.service` restart.

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

**Scoped OUT, deliberately:** there is no transparent mid-session reconnect that
resumes the running stream. It is not achievable against this engine — a
restarted cerastream has no session to resume — and would need engine-side
session recovery first. The stream ends; the operator restarts it.

Coverage: `tests/engine-session-connection-loss.test.ts` (dead-connection
`switchInput` retires once and only once, the registry poll detects it with no
operator action, a fresh start dials a NEW client and works, reconciliation stops
re-affirming the phantom session, and the orchestrator re-admits a start; the RPC
error and operator-stop negatives are the controls, green on both trees).

