<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ENGINE CONNECTION RESILIENCE [EXISTS]

The capability contract is fetched over a SHORT-LIVED probe to the systemd-owned
cerastream control socket (`capabilities.ts` → `defaultFetchEngineCapabilities`:
connect → get-capabilities → close). Before this module that probe was attempted
exactly ONCE at boot (`guardNonCritical("pipelines", initPipelines)`); if cerastream
was not up yet — a real systemd-ordering race / slow engine start — the fallback
ladder served `engineUnavailable`/`engineStarting` and the engine stayed marked
unavailable PERMANENTLY (no retry, no recheck), so the "Streaming engine offline"
banner never cleared until an operator restarted `ceralive.service`.

`modules/streaming/engine-reconnect.ts` (`initEngineConnection`) closes that gap.
It is the boot `pipelines` init now (main.ts) and owns ONE self-rescheduling loop:

- **Bounded boot retry** — the first attempt is awaited (so the pipeline registry is
  populated before `reconcilePersistedPipeline` / the boot sources step read it —
  boot ordering unchanged). If the engine is reachable → return, no loop. Else the
  first backoff steps (~2s, 4s, 8s, 16s → ceiling) are the short exponential backoff
  that resolves a normal engine-not-ready-yet race with no operator action.
- **Periodic background recheck** — once backoff caps at `ENGINE_RECONNECT_MAX_MS`
  (30 s) it is a slow periodic health-recheck that keeps running so a device
  self-heals minutes/hours later. BOUNDED (30 s ceiling, never a tight loop): a
  masked/disabled cerastream just gets a cheap 30 s poll, never hammering.
- **Heal broadcast** — on the unavailable→reachable transition it re-broadcasts
  `capabilities` + `pipelines` + `sources` to already-connected clients (the SAME
  trio the `setMockHardware` RPC uses), so the offline banner clears LIVE with no
  page reload, then SETTLES (stops polling) until the next proven loss. Settling is
  gated on the broadcast actually completing: a reachable engine whose heal broadcast
  throws (a transient broadcast-collaborator error) does NOT settle — it reschedules
  under the same backoff — so clients are never stranded on the offline banner while
  the loop silently gives up. The BOOT heal also settles the boot race (session
  reconcile, in-flight config change, restoration).
- **Re-arm after a later loss**: `rearmEngineReconnect(site)` starts the same loop
  again whenever the engine connection is PROVEN lost after boot: a session whose
  control connection closed or failed (`cerastream-backend.ts`
  `noteConnectionLoss` → `deps.onEngineUnreachable`, the re-arm by default), or a
  start classified
  `engine_unavailable` (`stream-start-retry.ts`, the one place every start origin's
  failure is classified; a cancelled attempt returns before it, so an operator Stop
  closing a pending start never counts). Without it a watchdog restart of cerastream
  left "Streaming engine offline" and a disabled Start until `ceralive.service`
  restarted. The loop pushes the unavailable snapshot to connected clients once per
  outage, and once more when a loss during an attempt left a stale available
  snapshot (a Start loss does not invalidate it, since that classification also
  covers failures other than a gone engine). Until the next recheck corrects it, a
  page that connects in that window reads the engine as available and can offer a
  Start that fails. Its heal only PUBLISHES availability (`publishEngineAvailability`:
  capabilities, pipelines, sources): session reconcile, owned-session cleanup and
  restoration keep their own triggers, and a second reconcile here would supersede
  their pending observations. A loss within `ENGINE_RECONNECT_FLAP_WINDOW_MS` (60 s)
  of a heal that followed rechecks keeps the backoff, so a flapping engine is not
  probed every second; a loss during an attempt stops that attempt's heal (the
  steps not yet run, and the recovery report) and it cannot settle on that
  answer. Rechecks log at info until the backoff caps, once more at the cap, then at
  debug. `stopEngineReconnect()` runs first on SIGTERM/SIGINT (`helpers/shutdown.ts`
  `stopEngineReconnect` dep) and makes an in-flight heal skip its remaining steps;
  the guard reaches `refreshAndBroadcastSources`, so nothing is committed or
  broadcast after teardown. A hung engine is not detected here: its watchdog kills
  it within 90 s, which closes the socket. The heal does not clear a session left in
  `stop_failed` (the engine-loss Stop could not reach the engine). Restoration's
  reconcile clears it when the restarted engine answers idle within
  `RESTORATION_UNKNOWN_DEADLINE_MS` (10 s). Known gap: an engine that takes longer
  leaves the session unconfirmed, so Start stays refused and the Live view's
  unconfirmed-stream band offers the operator's Stop.

Reachability = `getLastCapabilities()?.engineUnavailable === false` (a live snapshot).
It feeds INTO the existing `engine-unavailable`/`engine-starting` capability tier — it
does NOT create a parallel state machine. Backoff mirrors
`modules/remote-control/channel.ts` `backoffDelay` (equal-jitter). All collaborators
are injected (`EngineReconnectDeps`); `settleEngineReconnect()` / `stopEngineReconnect()`
are the test/teardown seams. main.ts threads the dev/e2e mock fetchers via the
`capabilities`/`sources` override bags (same fetchers the boot `initPipelines`/
`refreshAndBroadcastSources` already used) so dev exercises the identical loop.

The `@ceralive/cerastream` client's `ConnectOptions.autoReconnect` does NOT cover
this: it only rescues an already-established connection that later drops and throws
immediately on the first connect failure — useless for a fresh per-fetch probe, and
it emits no "became available" event. Recovery therefore lives backend-side here.

Coverage: `tests/engine-reconnect.test.ts` (boot-retry heal, later out-of-band
reconnect, backoff-ceiling cadence, and the permanently-unavailable case through the
REAL capability ladder — no regression to `engineUnavailable`/`engineStarting`);
`tests/engine-reconnect-rearm.test.ts` (re-arm after a loss, long absence, flapping,
loss during an attempt, publish-only heal, teardown during a heal and during the
sources probe, SIGTERM wiring, logging, the production start binding);
`tests/engine-reconnect-start.test.ts` (the start hook);
`tests/engine-session-connection-loss.test.ts` (session loss, including the
production re-arm binding).

