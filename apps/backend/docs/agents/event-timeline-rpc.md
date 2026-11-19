# Device event timeline RPC [EXISTS]

`src/rpc/procedures/events.procedure.ts` exposes authenticated `events.list`,
`events.boots` and `events.clear`. The shared contract and wire types come from
`@ceraui/rpc/schemas`.

`list` reads the bounded event ring, orders by descending sequence and applies
the exclusive `beforeSeq`, boot, family and problem filters before taking the
requested limit (default 100, maximum 200). Missing or empty families select all
families. Problems are errors and warnings. `nextBeforeSeq` is the last returned
sequence only when another matching record remains; otherwise it is null.
`headSeq` and `retainedFromSeq` describe the whole retained ring, independent of
filters and pagination, and are zero when the ring is empty.

`boots` reads the separate boot ring, including stored version contexts.
`clear` attempts every event generation and leaves boot records intact. It
returns `success: false` if any removal fails, even when other generations
were removed. All three procedures use the existing authentication middleware.

After the local control server binds, `src/main.ts` registers the emitter sink
with `broadcastMsgLocal(EVENT_PUSH, { append: [event] }, 0, undefined, true)`.
Each published event reaches authenticated local sockets even when their last
activity timestamp is zero. No polling, remote relay or control-channel status
type is added. The emitter still owns coalescing and sequence allocation.

`src/tests/events-procedures.test.ts` exercises the registered router against
real temporary JSONL rings and real Bun WebSocket connections, including a guest
socket that receives nothing. Hardware throughput and latency are unmeasured.

`src/tests/events-startup.test.ts` executes every non-import statement from
`main.ts`, retaining its actual guards and awaited boot ordering. A single spy
on the real emitter export records the sink installation. Production,
development and test modes each run on Linux, macOS and Windows platform values.
An awaited server gate and the first post-bind event prove that the installed
callback reaches the real event store and the local broadcast boundary exactly
once, with the requested payload and authentication arguments. Earlier sink
installation remains valid if it precedes every post-bind event.
