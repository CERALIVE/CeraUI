# Stream lifecycle events [EXISTS]

The stream event producers call the typed event emitter at existing lifecycle
decisions. They do not probe the engine, schedule work or change notifications.
Each new emit is contained even if an injected emitter violates its never-throw
contract. Only the emission is guarded: state publication, marker bookkeeping,
runtime operations, notifications and later hooks still run. The four session
composition emits share one local helper; other modules guard their calls
inline. Containment adds no warnings and no shared exported safety abstraction.

`stream-session-production.ts` observes the published lifecycle before updating
it. Only `starting -> streaming` records `stream_started`; reconciliation that
adopts a running engine does not. The start timestamp measures seconds until
the existing stop-cause callback. An adopted session has no observed start and
reports zero seconds. `stream_stopped` records stop intent, including its cause,
before the runtime stop completes; `stream_stop_failed` separately records entry
into that failed lifecycle. Leaving `reconfiguring` records its settled state
(`streaming`, `idle` or `reconciling`), without inventing an engine outcome.

The existing retry and terminal reporters publish only class, phase, attempt,
maximum attempts and the optional typed capture cause. Notification suppression
does not hide a retry from history. Raw errors, destination URLs, keys and stream
identifiers never enter these event params.

The restoration publisher records recovered and failed attempts, including the
existing failure reason. Adoption and blocked restoration are silent. Autostart
records exhausted link checks and invalid configuration at their existing
refusals; a launch failure keeps its ordinary terminal start event.

The engine indicator records loss and recovery edges while streaming. The
reconnect loop records idle boot unavailability once and recovery when its heal
broadcast completes. Before that broadcast, it captures reachability and the
streaming flag once. Both the live indicator and idle observer use that same
snapshot after reconciliation, so adopting a session cannot lose recovery and
confirming idle cannot duplicate it. Both publish through `reportEngineRecovery`.
A failed broadcast publishes no recovery. It does not record a healthy boot as
a recovery, or record each failed reconnect attempt. Stopping clears a lingering
indicator silently.

`src/tests/events-stream-emits.test.ts` exercises the production dependency bag,
real orchestrator and public reporting paths, replacing the event output at its
module seam. Existing streaming tests retain their expectations.
`events-engine-recovery-owner.test.ts` drives the default heal broadcast and real
session owner across adoption, confirmed idle, unchanged liveness, failed heals,
repeated ticks and the real emitter's trailing stored record.
`events-stream-containment.test.ts` compares real control paths, states and
notifications with working and throwing recording emitters at every hook. Its
failure-edge case observes the first `stop_failed` event before repeating the
publication, then verifies silent exit, single reentry and repeated-entry
deduplication. It also checks duration cleanup before a later adopted session.

The emitter's default coalescing scheduler imports timers from `node:timers`.
This keeps its unreferenced one-shot timer independent of global timer
instrumentation in callers. `events-emitter-native-timers.test.ts` verifies
global timer isolation, trailing publication and reset cancellation. The existing
emitter timer test observes that same native module; its timer-count, unref and
cancellation assertions remain intact, with an explicit 30-second delay check.
Physical board latency, CPU cost and journal volume remain unmeasured.
