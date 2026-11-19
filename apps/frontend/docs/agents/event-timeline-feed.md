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

The open view displays at most 300 rows, newest first. Loading older events
past that limit drops the newest edge and continues with the server cursor.
Live pushes leave that history window in place. The view counts each new
event the filter admits, once, and Start from newest names that count. A
skipped `seq` or a reconnect reads the live edge again for the events it
missed; that read counts at most one page. Start from newest reads the
latest page again and clears the count. At the live edge, pushes keep the newest 300 rows and move
the older-query boundary when they evict rows, so Load older or Retry can
recover those rows if they are still stored.

Reconnect while browsing older events checks the live edge without moving the
window, its paging cursor or scroll. The list stays stale until a check on
the current connection succeeds: a drop retires the check in flight, so its
late reply settles nothing and the next reconnect checks again. A successful
check removes only displayed rows outside the ring the reply describes, below
its `retainedFromSeq` or above its `headSeq`, and settles them as a gap
refresh does (next paragraph). An empty filtered reply keeps every row those
bounds still cover. Seq only grows while the ring is kept, so a reply whose
`headSeq` is below one already seen, with no displayed row left, proves the
ring was cleared; an empty ring reports zero for both bounds. Seq can then
restart at 1, so the newest page replaces the window, its paging cursor and
the seen head, and the new-event count restarts. A clear and restart that
refill seq up to a displayed row keep that row until Start from newest;
proving that case needs a ring identity on `events.list`.
A failed check keeps every row and adds the load-failure band, whose Retry
checks again. The band is withdrawn while disconnected, because the next
reconnect checks by itself, and Start from newest or any other reload also
ends the stale state once connected. At the live edge, reconnect loads the
newest page.

Each list reply's `retainedFromSeq` expires older rows already shown. Push
frames carry events only, so between list replies the view uses the last known
retained boundary. A row evicted within the current window's generation
stays mounted in place of one row until focus leaves it. An explicit reload
clears the pin and retires any pending raw-log action. When a gap refresh
settles, it preserves row focus and pending raw-log actions only for rows
still present. A failed gap refresh leaves no rows. If either reset removes
a focused row, focus goes to the filter bar.

`lib/rpc/subscriptions-event-feed.test.ts` drives the real subscription handler.
Its producer compatibility case runs the real backend emitter under Bun, feeds
it a hyphenated kernel boot ID through `currentBootId`, and checks that every
startup version field reaches the listener and the raw-log link schema accepts
the resulting journal boot ID. The initial-route bundle budget is verified with
the complete viewer release; this feed alone makes no hardware cost claim.
