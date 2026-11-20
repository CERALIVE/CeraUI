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
event the filter admits, once. A skipped `seq` or a reconnect reads the live
edge again for the events it missed; a full page, a continuation cursor or
`retainedFromSeq` above the last seen sequence plus one makes the tally
incomplete, even if the read adds no matches. Start from newest shows
`startFromNewestAtLeast` for a positive lower bound or `startFromNewestCount`
for a positive exact count. A zero tally with incomplete coverage, including
an empty filtered page after unseen events were evicted, shows
`startFromNewestUnknown`; only an exact zero keeps the plain label. Start
from newest reads the latest page again and clears the count. At the live
edge, pushes keep the newest 300 rows and move
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
`headSeq` is below one already seen proves the ring was cleared, even when its
range still covers displayed rows; an empty ring reports zero for both bounds.
Seq, and with it the event id, can then restart at 1, so the newest page
replaces the window, its paging cursor and the seen head, any pending raw-log
action is retired, and the new-event count restarts.

An `events.list` reply names the ring's `epoch` when the store can keep one.
Only a matching UUID proves that the previous window belongs to that ring.
A changed UUID, a lower head or a reused `seq` with a different record
changes the history's identity and its row keys. The UUID can change after
a history clear or an epoch repair, even if the retained events are unchanged.
A reconnect or gap check
without an epoch can refresh the newest page and retire pending raw-log
actions without changing the row keys: a same-history refill keeps focus on
a still-shown row, including when the same epoch returns after an omission
or the record's `params` fields are reordered. An edge check with no epoch
and a lower head can replace the window directly from the page it already read.

Load older with no epoch validates the paging boundary by rereading its
last visible record in the same snapshot as the older rows. If that record
still matches and the head has not gone backward, the view keeps its
position and advances with the older page. A boundary that cannot be
verified shows the paging Retry, keeping the rows and cursor. A lower head
replaces the window with the newest page. A late reply that settles
nothing leaves the seen epoch alone.

A failed check keeps every row and adds the load-failure band, whose Retry
checks again. The band is withdrawn while disconnected, because the next
reconnect checks by itself, and Start from newest or any other reload also
ends the stale state once connected. At the live edge, reconnect loads the
newest page.

Each list reply's `retainedFromSeq` expires older rows already shown. Push
frames carry events only, so between list replies the view uses the last known
retained boundary and epoch. A new process reaches the view only on a new
connection. A drop discards pushes held by that connection. A reconnect read
and any replacement read it triggers can replay only pushes from their own
connection that are newer than the replacement page's head. A row evicted
within the current window's generation stays mounted in place of one row
until focus leaves it. An explicit reload
clears the pin and retires any pending raw-log action. When a gap refresh
settles, it preserves row focus and pending raw-log actions only for rows
still present in the same history. A failed gap refresh leaves no rows. If a
reset removes the focused row and focus has not moved elsewhere, focus goes
to the list's row stop (the first row action), or to the first visible filter
when no row remains.

`lib/rpc/subscriptions-event-feed.test.ts` drives the real subscription handler.
Its producer compatibility case runs the real backend emitter under Bun, feeds
it a hyphenated kernel boot ID through `currentBootId`, and checks that every
startup version field reaches the listener and the raw-log link schema accepts
the resulting journal boot ID. The initial-route bundle budget is verified with
the complete viewer release; this feed alone makes no hardware cost claim.
