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
  page reload, then SETTLES (stops polling). Settling is gated on the broadcast
  actually completing: a reachable engine whose heal broadcast throws (a transient
  broadcast-collaborator error) does NOT settle — it reschedules under the same
  backoff — so clients are never stranded on the offline banner while the loop
  silently gives up.

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
REAL capability ladder — no regression to `engineUnavailable`/`engineStarting`).

