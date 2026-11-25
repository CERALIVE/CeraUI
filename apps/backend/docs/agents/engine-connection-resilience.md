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

- **Boot and outage cadence.** The first capability attempt is awaited.
  Unavailable retries use equal jitter: 1-2 s, 2-4 s, 4-8 s, 8-16 s, then
  15-30 s, plus probe duration. Loss within 60 s of a retried heal preserves
  the backoff. A reachable engine gets one bounded control handshake every 15 s
  plus probe duration, including when no stream is active. This is not a
  process supervisor and cannot undo systemd start-rate limiting. A loss
  invalidates the scheduled monitor even if its timer callback was dequeued
  before cancellation.
- **Loss evidence.** `engine-control-loss.ts` routes proven control transport
  failures from session operations, capability and source reads, runtime
  observations and the audio meter. An RPC refusal, timeout alone, intentional
  close or preview WebSocket failure is not proof. A failed Start classified
  `engine_unavailable` can request a check without invalidating availability.
  A replaced audio-meter bridge cannot schedule a retry, publish levels or
  reload the preference for its successor.
- **Publication.** Heal publishes `capabilities`, `pipelines`, then `sources`
  to open pages. A thrown publication retries; a live snapshot reopens offline
  delivery and a thrown offline send does not consume it. Replaced init,
  loss and SIGTERM/SIGINT revoke the current work identity. Late capability,
  pipeline, hardware and source commits and deferred audio work check it.
- **Lifecycle is separate.** A post-loss heal observes unresolved lifecycle
  state read-only. Later control checks can retry the observation, but never
  re-run one-shot restoration. Fresh Idle enables Start if the other gates allow
  it; fresh Streaming adopts without mutation. Silence or transition remains
  unknown, and operator Stop supersedes the observer. Boot heal can still run
  the separate boot reconciliation and recovery duties. On a fresh probe
  socket, the observer checks `get-capabilities` before its first status
  subscription and opts in only when the engine advertises `status-snapshot`.
  The latest delivered status is authoritative only if it proves Idle or
  Streaming. A subscription acknowledgement is not status. A mode conflict
  discards the probe without reporting engine loss or triggering an immediate
  retry. A silent legacy engine can still recover availability without
  releasing an unresolved Start fence.

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

