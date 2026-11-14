# Device event emitter [EXISTS]

`src/modules/events/emit.ts` owns the synchronous `emitEvent(code, params)`
pipeline. Producer params come from `@ceraui/rpc/events`; the registry validates
them and supplies severity and subject. Invalid params produce one static warning
without storing or echoing their contents. Call sites and startup wiring belong
to the event producers; this module detects nothing.

Each emitted record uses `currentBootId()` in journal form, a sequence seeded
once from `tailSeq()`, an ID formed from the first eight boot ID characters and
sequence, and the emission clock. An unreadable boot ID drops the event rather
than inventing one. `logRedact` runs before storage, the one structured journal
line and the sink registered with `setEventSink(fn | null)`. Failures in those
outputs are contained independently so one failed output does not stop the next.
No UI, socket or RPC module is imported.

Update subjects emit at most once per boot. Other subjects emit immediately,
then fold occurrences into the latest state during a 30 second window. Its
single unreferenced one-shot timer emits that latest state with the number of
folded occurrences in `suppressed`, then releases the subject. An occurrence at
or after the deadline closes a delayed timer before opening another window.
Publishing the trailing event can re-enter emission through the sink; the outer
occurrence folds into any window that call opened for the same subject.
Reset and boot changes cancel retained timers; stale callbacks cannot publish.
Each subject collection holds at most 1024 identities. New subjects beyond that
bound are dropped; normal windows release capacity at expiry, while update
identities remain until the boot changes so overflow cannot re-admit duplicates.

The first valid update emission in each boot lazily seeds its subject collection
from `readEvents()`. Only records matching the current boot and a known registry
code in the update family participate. The registry derives stored subjects from
their params with the same code-specific function used for live emissions,
including `update_failed`'s stage and reason. This suppresses already persisted
subjects after a backend process restart in the same OS boot. Unknown future
codes and non-update codes consume no update capacity. Seeding stops at 1024
unique subjects and uses the existing store's eight 512 KiB file bounds.
There is no read at import time or for non-update emission. A seed failure logs
one warning, falls back to an empty collection and does not retry in that boot;
emission remains synchronous and never throws. As with the bounded event history,
records removed by clearing or rotation cannot seed a later process.

Errors, warnings and `device_started` request sync at most once per second.
`shutdown_requested` and `service_stopping` always request sync. Other events
append without sync and do not consume that allowance. Journal levels are
error, warn and info (for both info and success).

`resetEventEmitterForTest(overrides?)` cancels timers, clears the sink and state,
and provides clock, scheduler, boot reader, store and logger seams. The tests
in `src/tests/events-emit.test.ts` drive expiry without sleeps and round-trip
every registry code and declared key through redaction and the real store.
`src/tests/events-emit-restart.test.ts` covers real separate backend processes
sharing one boot and store, plus injected seed failures, identity filtering,
boot changes, lazy initialization and the existing subject bound.
Physical device latency, CPU cost and journal volume remain unmeasured.
