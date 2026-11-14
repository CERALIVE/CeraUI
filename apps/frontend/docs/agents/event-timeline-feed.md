# Device event timeline feed [EXISTS]

`lib/rpc/client.ts` exposes typed `events.list`, `events.boots` and `events.clear`
calls using shared wire types. `lib/rpc/subscriptions.svelte.ts` receives the
`EVENT_PUSH` frame through the existing subscription handler, with its existing
per-type sequence guard. It imports `EVENT_PUSH` and `deviceEventSchema` from
`@ceraui/rpc/schemas`; the typed event registry stays out of startup imports.

The open timeline registers `setEventFeedListener(listener)`. Each append record
is parsed independently. Valid records are delivered in one array, in frame
order; malformed siblings are skipped. Empty or wholly malformed frames do not
call the listener. New codes and flat params survive older readers, with unknown
families and severities using the wire schema's device/info defaults.

The view must call `setEventFeedListener(undefined)` when it closes. There is no
global event cache or replay queue. A later listener receives only later frames;
it obtains retained history through `events.list`. `resetState()` also detaches
the listener at logout.

`lib/rpc/subscriptions-event-feed.test.ts` drives the real subscription handler.
Its producer compatibility case runs the real backend emitter under Bun, feeds
it a hyphenated kernel boot ID through `currentBootId`, and checks that every
startup version field reaches the listener and the raw-log link schema accepts
the resulting journal boot ID. The initial-route bundle budget is verified with
the complete viewer release; this feed alone makes no hardware cost claim.
