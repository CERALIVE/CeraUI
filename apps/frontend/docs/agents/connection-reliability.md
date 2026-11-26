<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CONNECTION RELIABILITY

### Stream-read ordering and watchdog ownership [EXISTS; host-tested]

Reconnect consumes config/status independently, while restoration still waits
for both paths. After a successful sign-in reply, the first hydration frame
carries `is_streaming`, `stream_lifecycle`, and `audio_off_active` when the
running session's audio choice is known. The device sends this partial
status to the socket that signed in, before building the full snapshot. A
snapshot failure therefore does not hide the stream or its known audio choice.
An omitted audio fact on a same-stream partial push does not clear it. A link
drop, an observed stream boundary, or an admissible full pull without the fact
does clear it. An adopted stream does not assert a known choice.
An in-place `reconfiguring` frame keeps the stream's Stop confirmation epoch;
an actual stop, replacement, or uncertain liveness still invalidates it.
A status pull carries
request-dispatch and browser-receipt marks on the evidence clock; a newer
intent/STREAM-FACT observation supersedes stream
evidence. `is_streaming`, `stream_lifecycle`, `audio_off_active` and other
unclassified field names
advance that atomic horizon (unknown fails closed). Explicitly unrelated pushes
never advance it. Superseded stream fields are withheld, but unrelated supplied
fields merge unless a push carrying that field arrived after dispatch or a newer
receipt/read already applied it. Implicit stop-edge clears obey those same field
fences and cannot run from superseded stream evidence. Ordinary pulls permit at
most one fresh read, never a loop or an automatic Stop on
unknown. Receipt is arrival, not device computation; ingestion keeps provenance.
Both watchdogs fence post-await effects to their originating action lifetime.
Settlement or replacement invalidates running promises as well as timers.
The shared optimism signal exists before the first Live selector reads it,
so a cold Live mount observes the pending transition immediately. Test reset
clears actions and timers without replacing the subscribers' signal.
For a confirmed Live-bar End, the subscription store revokes the queued Stop
and its retries on link loss, an idle/false receipt, a new Start, or entry into
`reconciling`. Repeating a current phase is not entry into reconciliation:
a fresh End confirmed within it keeps its authority. Ordinary stopping and
reconfiguration are not replacement events. Each send rechecks the original
action at dispatch. Neither watchdog path resends in `stopping` or
`reconfiguring`; in `reconciling` or `stop_failed`, only operator Retry may
resend. At dequeue the latest applicable watchdog read must still report
explicit live truth, with or without a lifecycle. A newer unknown read
withdraws earlier authorization even if the snapshot clears a pending phase.
Retry can join an active check and use its confirming read. If that Retry
sends after the confirming read, one status RPC follows actual dispatch to
recover a missed idle push. A superseded reply can hydrate disjoint fields
but cannot settle the Stop, trigger another read, or resend. The button is
disabled while a Retry is accepted or a resend or its check is pending,
including while a resend waits behind composition. Revocation cancels
unsent retries without blocking a newer Stop. The banner reports delay, not
a proven failure.

Stop still has a 30 s client reply timeout. The device can continue a Stop
parked behind an apply-now change, and the client ignores the reply once the
request expires. If settlement comes after the bounded checks and the final
push is missed, another current status read or Retry is needed. The client
cannot fence an unobserved replacement without a server-side session check,
and it cannot recall an already-sent Stop.
Real-socket Vitest transcripts cover this contract; browser/board proof is owed.

Bounded Start exhaustion creates a generation-owned recovery-unknown entry in
the existing unresolved-action store. The existing unconfirmed band retains an
operator Stop across navigation/remount and reconnect, with no new read loop or
automatic Stop. Only admitted later live/idle facts after its mark or the current
Stop owner's acknowledgement clear matching optimism. The latest explicit Stop
owner's acknowledgement settles its captured, still-current starting attempt
before OR after exhaustion, revoking pending watchdog effects without requiring a
recovery record. Preserve Stop-owner and Start-generation fences; failed Stop
revokes nothing and operation confirmation still needs post-press idle lifecycle.
Acknowledgement keeps this authority whether or not admissible settlement already
closed the Stop claim. Idle confirms the operation but does not end acknowledged
Start before recovery; failed Stop and pre-record boolean false do not revoke it.
F8 post-record settlement remains unchanged, and the band's explicit Stop is the
escape. The 36-cell real-socket S/R/E permutation matrix in
`LiveView.real-socket-stop.test.ts` owns this contract, with no automatic Stops.
Non-settling/failed/stale
evidence does not. “Unrelated” means unrelated to stream settlement, not every
decision (`updating` gates power; `network_ingest` gates Start configuration).
Browser scheduling and integrated backend/engine incidence of the complete
lost-confirmation transcript remain UNKNOWN.

**Visible operator heartbeat [PARTIAL, Todo 32].** `Layout.svelte` sends the
authenticated `ui.heartbeat` every 30 seconds only while the page is visible
AND has focus, and sends on focus/visibility return. Unmount or authentication
loss clears the timer/listeners. The backend stamps receipt; an unfocused kiosk
preview is still a separate preview blocker, never inferred idle from the lack
of a UI heartbeat. This is a detector signal only; no update scheduling UI or
automatic commit path ships with it.

### Connection-ready gate

`BootShell.svelte` waits for the first socket open or inbound frame. That
one-time transport signal is not permission to send protected RPCs.

`getSessionReady()` instead names admission on the current link. A successful
form or saved-token login admits that link; a drop invalidates it immediately.
An established shell attempts its remembered token once on each replacement
link. Missing or refused credentials return the tab to sign-in; an unreachable
attempt on the current link also returns to sign-in but keeps the saved token.
A refusal only removes the token actually attempted, not a replacement written
by another tab. Late login and hydrate replies cannot affect another link.
Raw, Events and the foreground UI heartbeat use session readiness. Updates'
`getRestoredSessions()` signal still moves only after both safety pulls settle.
The first-run password prompt ends on confirmed setup or socket replacement.
Only a fresh `set_password: true` from the replacement can request setup again.

### Infinite-retry with jitter backoff

The transport (`lib/rpc/reconnect.ts`) never stops retrying. Backoff formula: `min(~30s, base · 2^n) · (1 + random(-0.3, +0.3))` — jitter on every step, not only when capped. `MAX_RECONNECT_ATTEMPTS` is a UI threshold only: once exceeded, `connection-ux.svelte.ts` flips to the "failed" banner, but the transport keeps dialing. Failed-UI state and transport state are independent state machines.

### Reconnect-surface grace period [EXISTS]

Every connection-loss surface is debounced by `RECONNECT_BANNER_GRACE_MS` (3000 ms, `connection-ux.svelte.ts`) — the authenticated `DisconnectedBanner`, the pre-auth PWA top banner, the browser-offline full-page takeover, and the saved-session `authTimedOut` recovery card. `deriveConnectionSurfaceUx(input, now)` projects the one shared grace verdict onto the pre-auth surfaces; `deriveOfflinePageVisible(request, hasConnected, disconnectedSince, now)` (`offline-state.svelte.ts`) projects that SAME verdict onto the full-page takeover. A drop that heals inside the window is COMPLETELY silent to the operator. An initial page load that starts offline keeps its immediate offline recovery page; after a successful connection, a socket-only loss stays on the reconnect banner while the browser remains online.

WHY: the half-open detector (`heartbeat.ts`, `HEARTBEAT_THRESHOLD_MS = 15000`) deliberately tears down and re-dials a socket that has gone quiet. Before this rule covered pre-auth, the transport could successfully open each replacement socket — resetting its counter so the console correctly repeated `attempt 1` — while the login gate loudly stacked the top banner, auth recovery card, and toast on every cycle. This is a PRESENTATION change only: `HEARTBEAT_THRESHOLD_MS`, `half-open.ts`, and `client.ts`'s backoff are untouched and keep reconnecting exactly as before.

**ALL FOUR surfaces really do share the one projection now — that sentence used to be aspirational.** `offline-state.svelte.ts` ran a SECOND, parallel offline detector with its own `OFFLINE_THRESHOLD` constant, and the browser `offline` event bypassed even that: `handleOffline()` set the takeover flag SYNCHRONOUSLY and armed the reload-capable recovery poll in the same breath. So the LOUDEST treatment in the app — the one that throws the whole screen away, and on a PWA can spend a full `window.location.reload()` — was the only undebounced one, and `Layout.svelte` was papering over it by re-composing the raw request against `showOfflineBanner` at ONE of its three call sites (`App.svelte`'s boot-shell gate and `DisconnectedBanner`'s precedence input both read the raw flag). The store now owns the verdict: it records only a REQUEST (`"none" | "immediate" | "debounced"`), `getShouldShowOfflinePage()` folds that through the shared grace, and `Layout.svelte` consumes it verbatim. Three rules keep it honest — **`immediate` is never debounced** (a page that never connected has no transient drop to wait out, and holding a blank shell for 3 s hides the only surface that can explain it), **the reload-capable poll is armed at the grace boundary, not at the edge** (a blip that heals inside the window must not cost an operator a reload for an outage they were never shown), and **a post-connect socket-only loss never requests the takeover while the browser remains online** (the reconnect banner owns it; polling and reloading an already-healthy origin races that banner and resets the reconnect harness). `OFFLINE_THRESHOLD` is deleted; there is one grace constant.

The same change also fixed a dead path: `checkOfflineState()` computed `threshold = hasCheckedInitialState ? OFFLINE_THRESHOLD : 0` and then only scheduled `if (threshold > 0)`, so a socket loss during the ~700 ms initial-connectivity probe scheduled NOTHING — while still latching `offlineStartTime`, which disarmed the takeover for the rest of that outage. Its evident intent ("no wait before we have ever connected") is now the `!hasConnected` arm of `deriveOfflinePageVisible`, expressed against the shared `getHasConnected()` rather than a second private flag.

**And there is ONE signal per fact, not two.** `deriveConnectionSurfaceUx` no longer carries `showConnectionLostToast`, and `LayoutToastHost` no longer pushes a `connection-lost` toast. That field was byte-identically `showOfflineBanner`, and `PWAStatus` — which renders that banner — is mounted UNCONDITIONALLY by `Layout.svelte`, so the toast could not fire in any state the banner was not already stating, at the same instant, one layer higher. A connection loss is an ONGOING STATE (a band's job); a toast is for a transition that would otherwise be missed. The `notifications.connectionLost` catalog key is left in place — it is inert, and retiring a key costs a Paraglide regeneration plus all ten `*.rendered.json` fixtures.

Five rules are load-bearing. **Only ordinary connection-loss treatments are debounced** — `rebooting` is an explicit operator action that must surface immediately, and `failed` already implies `MAX_RECONNECT_ATTEMPTS` backoff cycles have elapsed, so delaying either hides something the operator already knows about or has waited out. **Time is INJECTED, never read inside the pure functions**: `deriveConnectionUx(input, now)`, `deriveConnectionSurfaceUx(input, now)` and `deriveOfflinePageVisible(…, now)` all take an explicit `now` (mirroring `isHeartbeatStale(lastSeenAt, now, threshold)`), while `reduceConnection(prev, state, now)` and `reduceBrowserOfflineSince(prev, online, now)` stamp their loss edges, so the decision layer stays rune-free and unit-testable. **The effective disconnect stamp is the EARLIEST browser-or-socket loss and each is stamped once** — Chromium offline emulation can leave an open WebSocket intact, so socket state alone can suppress a real browser outage forever; re-stamping either edge would restart the window on every retry/event. **A missing stamp fails CLOSED on every surface** (`hasOutlastedBannerGrace(null, now)` is `false`), so absence can never be the reason something appears. **The re-derivation rides ONE `createStalenessClock`** (`hud/staleness.ts`) over that effective stamp, gated by `shouldRunBannerGraceClock` so it runs ONLY inside the grace window and stops itself the instant it elapses — do NOT replace it with a raw always-on `setInterval` or a component-local timeout. Coverage: `offline-state.test.ts` (pure reducers, earliest-stamp rule, the pre-auth projections, gate, boundaries, and a lock that the projection carries no second field for one fact), `offline-state.grace.test.ts` (the takeover's own rule plus the REAL stores end-to-end under fake timers — a raw browser `offline` edge, the poll-arm boundary, a silent blip, and the never-connected immediate path), `Layout.test.ts` (auth card + the takeover consumed verbatim, both ways), `reconnect-smoke.test.ts` (live store + clock start/stop under fake timers), `tests/e2e/reconnect-banner-grace.spec.ts` (rendered DOM — asserts the DELAY between the drop and first appearance for BOTH the banner and the full-page takeover, not mere presence, so a slow environment cannot flake it while a ~0 ms flash always fails).

### Seq drop-stale

`subscriptions.svelte.ts` maintains a `Map<string, number>` of the last seen `seq` per event type. Any incoming message whose `seq` is not strictly greater than the last seen value is silently dropped. Gaps are fine — only strict monotonic-greater is required, not +1. The map resets on reconnect so a server restart (seq back to 0) is always accepted.

### Applied-state acknowledgement

After any RPC setter resolves, the frontend reads `result.applied` (not the client's intended value) and releases field locks to that value. This ensures the UI reflects what the backend actually wrote after clamping and validation, not what the user typed.

### Per-modem state merge

Every modem frame carries the authoritative roster key set, but each entry has one
of TWO shapes. A full descriptor carries the required `ifname`, `name`, and
`network_type` fields; its complete FIELD SET is authoritative, so omission of an
optional field retracts it. A status-only entry carries none of those descriptor
fields and merges onto the previous value, preserving the full fields it was never
asked to restate. Targeted broadcasts still walk the whole roster: the target is a
full descriptor and unchanged neighbours are status-only.

The pure, rune-free `lib/rpc/modem-list-merge.ts` owns this distinction;
`subscriptions.svelte.ts` imports and re-exports `mergeModemList`. Do NOT spread
every incoming entry over its previous value: that latches a field a full
descriptor deliberately omitted. This was operator-visible after a successful SIM
unlock — the backend sent a full descriptor with no `sim_lock`, while the merge
preserved the old lock and left the row at `SIM locked` until reload. Conversely,
do NOT replace a status-only entry: that wipes `config`, `name`, and identity fields
and can flip a live modem to a spurious no-SIM state.

Network scans additionally carry `network_scan {generation, phase, failure?}`.
`generation` is monotonic and crosses both `status.modems` targeted updates and
full `modems` snapshots. `mergeModemList` preserves the newer generation and its
`available_networks` even when the late older payload is otherwise a full
descriptor, so separate event-type sequence counters cannot let an older scan
overwrite a newer result. The dialog settles on the
lifecycle marker, not on list-content change: an unchanged successful scan is
still `completed`, a device failure is `failed`, and absence of either reaches
the scan-specific 270 s unknown-outcome bound. A second client receives the
typed `already_scanning` refusal; it is never silently dropped.

See [`docs/FRONTEND_CONNECTION_PATTERNS.md`](../../../../docs/FRONTEND_CONNECTION_PATTERNS.md) for the full connection-pattern reference.
