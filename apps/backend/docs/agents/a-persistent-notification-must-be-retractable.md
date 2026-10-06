<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A PERSISTENT NOTIFICATION MUST BE RETRACTABLE [EXISTS]

The third instance of the same latched-stale class as `policy_route_missing` (a
flag raised but never lowered) and `active_encode` (engine truth that outlived its
session). Here the mechanism is blunter: `notificationRemaining()`
(`modules/ui/notification-liveness.ts`) returns `NOTIFICATION_LIVES_FOREVER` for
EVERY persistent notification by deliberate design — `duration` does not apply to
one — so a raise site with no matching retraction is **permanent by
construction**. `duration: 3` on the raise reads like an expiry and is not one.

Two notifications shipped that way, and both were confirmed on a board.

| Notification | Raised by | Why it could never clear |
|---|---|---|
| `hdmi_error` — BOTH "No HDMI signal detected" and the EMI/cable advisory | `modules/system/sensors.ts`, off the RK3588 dmesg lines `hdmirx-controller: Err, timing is invalid` (no-signal) and `hdmirx_wait_lock_and_get_timing signal not lock` / `hdmirx_delayed_work_audio: audio underflow` (advisory) | the kernel logs the failure and prints NOTHING when the link relocks, so the only event the watcher can see is the bad one |
| the `cerastream` channel carrying `capture_video_error` | `cerastream-backend.ts` `handleErrorEvent()` | the engine reports the Tier-2 error and never revokes it; the condition cleared and the engine returned to idle/healthy with the error still on screen |

**The retraction runs on the same evidence the source list already trusts, never
on a timer.** A timeout would hide a genuinely-still-broken condition exactly as
readily as it clears a resolved one, which is a worse bug than the one being
fixed. Both retractions therefore demand a POSITIVE, engine-authored statement
that contradicts the notification's own claim; every other outcome — an
unreachable engine, a fallback v4l2 row, an idle engine — leaves the notification
standing.

**`hdmi_error` retracts on `signal: "present"` for an HDMI-RX capture device**
(`modules/system/hdmi-signal-notification.ts`
`clearHdmiSignalErrorOnRecovery`). That verdict is stamped at `fromEngineDevice`
— the one seam that knows the ENGINE authored the row (see "THREE capture-row
states") — so it is the engine's own `VIDIOC_QUERY_DV_TIMINGS` projection saying
the port carries a picture. A row with `signal` unset reads `unknown` and proves
nothing. Four properties are load-bearing:

- **It hangs off `commitEngineDevices` (`sources.ts`), not off a broadcast.** That
  is the ONE seam every engine-authored device view flows through — the 5 s
  `recheckSourceSignals` tick, the hotplug refresh, the boot seed, the reconnect
  heal — so no path can commit a recovery the notification does not see. It runs
  on EVERY commit, deliberately NOT gated on a changed payload: a transient
  `timing is invalid` line raises the notification while the engine's own view
  never varies, and a change-gated hook would then never fire at all.
- **Scoped to `kind === "hdmi"`.** The kind heuristic tests usb/uvc BEFORE hdmi
  precisely so a "RØDE HDMI to USB-C" dongle is not mislabelled, so a working
  webcam can never retract a claim about the board's HDMI-RX port.
- **Scoped to a KNOWN message, and BOTH of them qualify.** The name `hdmi_error`
  is ONE slot shared by two claims — "No HDMI signal detected" and the
  EMI/cable-quality advisory ("HDMI signal issues detected…") — so
  `HDMI_MSGS_CLEARED_BY_LOCKED_SIGNAL` is the membership table, exactly as
  `ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION` is for the engine channel. A blind
  remove-by-name would retract a future third claim this evidence says nothing
  about.

  **The advisory used to be EXEMPT, and that was the bug.** It was read as a claim
  about cable QUALITY, which a relocked link does not falsify. Operators reported
  the consequence — *"an infinite notification for something that is already
  corrected"* — and the board agrees with them: the two kernel lines behind it fire
  during ORDINARY link locking, so a plain unplug/replug raised an advisory with no
  retraction path at all, which then stood for the rest of the session. An
  engine-authored "this port is carrying a picture" falsifies both claims equally,
  so there is no longer any reason to treat them differently for RETRACTION. They
  are still different for RAISING: each keeps its own trigger.
- **Idempotent.** `notificationExists` answers `undefined` once it is gone, so the
  healthy steady state costs one map lookup and broadcasts nothing.

**`capture_video_error` retracts at a healthy SESSION boundary** — a concordant
`state:"streaming" + streaming:true` status frame (the engine is delivering video
right now), or the start of a new session, which must not inherit the previous
one's failure. That second rule is the same session-boundary discipline
`active_encode` follows in `startStream()`. An IDLE engine is deliberately NOT
proof: idle means "not streaming", not "the capture card works".
`ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION` is the membership table and holds
`capture_video_error` alone — `capture_audio_error`, `pipeline_stall` and the two
SRT codes stay latched until each has an established recovery signal of its own.
The table is required because `resolved.channel` (`"cerastream"`) is ONE
notification slot shared by every non-srtla engine error, so
`standingEngineError` records which code currently occupies it; a blind
remove-by-name would retract whichever error happened to be standing.

**Both are now `isDismissable: true`, and that is a safety net, not the fix.**
`active_encode`'s precedent argues for leaving a status signal non-dismissable
when its automatic clear is reliable, and the automatic clears above ARE the
primary mechanism. But each depends on the engine being reachable and speaking:
`hdmi_error` needs cerastream to enumerate the HDMI-RX node, and
`capture_video_error` needs a later status frame or a new session. A masked or
crashed engine emits neither, and the pre-existing `isDismissable: false` left the
operator with no escape at all from a notification the device could no longer
retract. The manual affordance costs nothing when the automatic path works and is
the only recourse when it cannot run.

Coverage: `tests/notification-recovery-clearing.test.ts` (the pure verdict, the
persists-while-severed and unreachable-engine controls, the real `remove` frame
pushed to a connected client, the SAME three assertions repeated for the EMI
advisory, the foreign-device negatives, the idle-is-not-proof and shared-slot
negatives, and the repeat-heartbeat idempotence)
plus the frontend half `apps/frontend/src/tests/notification-recovery-ingestion.test.ts`
(the `remove` frame drops the entry from the persistent panel).

### THE PER-MODEM ROAMING ADVISORY — the same rule, applied per ENTITY [EXISTS]

`modules/modems/roaming-advisory.ts` (todo 40) is the first notification on this
device that is keyed **per device instance** rather than to one fixed slot, so it
carries the retraction rule in the form the rule takes when the entity can
multiply and disappear: a MEMBERSHIP TABLE of the currently-standing advisories,
reconciled on every modem broadcast against the roaming set the broadcast itself
carries.

| Property | How it is met |
|---|---|
| Retraction evidence | the modem's OWN next registration state — `status.roaming` reading `false` on a later broadcast. Never a timer. |
| Device-absent retraction | absence from a later broadcast retracts too. A device-absent modem emits no further registration states, so a per-modem evaluator would never see the evidence that falsifies its own claim, and the advisory would stand for the session on hardware no longer in the board — the `policy_route_missing` latch class exactly. |
| Slot key | `stable_key` → the legacy wire id → **suppressed**. `stable_key` is optional by todo 17's contract, so the legacy id is a real fallback, not a defensive one; a modem with NEITHER is suppressed rather than collided, because a notification `name` is the removal identity and a shared slot makes one retraction clear two claims. |
| Dedupe | raise on the ENTRY edge only. Re-broadcasts of an unchanged roaming state — including one where only the device LABEL changed — emit nothing. |
| `isDismissable` | `true`, the same safety net the two above adopted: the automatic retraction is the mechanism, but a wedged poll loop must not trap an operator under a notification the device can no longer retract. |
| Tone | `info`, not `warning`. Which is why `Notification["type"]` now imports the SHARED `NotificationType` instead of re-spelling a narrower union — the wire schema and both render surfaces always accepted `info`; only the backend's local type had drifted. |

**It NEVER gates.** Roaming is a BILLING fact. Refusing to bond a roaming link
would take a working stream off the air over a cost the operator may already have
accepted, and staying silent is how a data bill becomes a surprise — so the
advisory says the true thing and changes nothing. Three tests enforce that rather
than asserting it: a one-hop import gate (the module's only import is
`../ui/notifications.ts`), a comment-stripped grep gate over its executable
source, and a rendered-DOM assertion that a roaming row is byte-identical to a
home-network row once the badge itself is removed.

It reads `status.roaming` (the modem's registration claim) and NEVER
`config.roaming` (the operator's PERMISSION to roam) — a modem allowed to roam
that is sitting on its home network is not roaming, and advising on it would
report a setting back to the person who set it. A row with no `status` block at
all (every `router-ethernet` dongle, by construction) draws no badge.

Hooked at `broadcastModems()` (`modem-status.ts`) — the ONE seam every modem
payload flows through — AFTER the payload is on the wire and inside a `try/catch`:
an informational surface may cost an operator a badge when it fails, never the
modem list. Coverage: `tests/modem-roaming-advisory.test.ts` (28 tests, including
the real-store raise/retract through a connected client),
`apps/frontend/src/main/network/cellular-row.test.ts` and
`CellularSection.test.ts`.

## …AND ITS RAISE MUST BE SCOPED LIKE ITS RETRACTION [EXISTS]

The retraction above is scoped to `kind === "hdmi"`. The RAISE was scoped to
nothing but the board resolving as `rk3588` — not to `config.source`, not to the
active capture source, not to the pipeline, not to `status.active_encode`. The
pair was asymmetric, and the asymmetry is reachable in ordinary use.

Measured on a board (2026-07-30): **a `streaming.start` attempt probes EVERY
capture input**, so it opens `/dev/video0` in passing. On a board whose HDMI-RX
carries no cable — the normal state for an operator streaming a USB camera — that
probe makes the kernel print `hdmirx-controller: Err, timing is invalid`, and the
watcher raised "No HDMI signal detected" at an operator who was using a UVC camera
and had asked nothing about HDMI. The CeraUI journal names the driver of the sweep
exactly: `no capture input reached PLAYING (signal-less: /dev/video0,
/dev/video1)`. The claim is TRUE about the HDMI-RX port; it is simply not addressed
to anyone. And because a persistent notification never expires on a timer, the
`duration: 3` on that raise buys nothing — it stands until something retracts it,
which on a cable-less port is never.

`provesSelectionIsNotHdmi()` is the gate, and it is a **SUPPRESSION-ONLY** test —
the same discipline as the audio meter's foreign-card rule, for the same reason.
It can only ever withhold a raise PROVEN irrelevant:

| Selected source | Raise |
|---|---|
| a capture row whose engine-authored `kind` is not `hdmi` | SUPPRESSED |
| a coarse/virtual/network row that is not the `hdmi` source | SUPPRESSED |
| a capture row of `kind: "hdmi"`, or the coarse `hdmi` source | RAISED |
| nothing selected, or a selection that resolves to no row at all | RAISED |

- **Absence is never evidence.** An unset selection and an unresolvable one both
  leave the raise armed, because neither proves the operator is not watching the
  HDMI port. Do NOT "harden" this into a fail-closed check — that would silently
  drop a genuine no-signal report, which is the exact fault the notification
  exists for.
- **It reads the persisted `kind` when the live row is missing.**
  `last_seen_devices` is consulted as a fallback because the ONE moment this is
  asked — mid stream-start sweep — is precisely when the live row may be
  transiently degraded by the libuvc rebind the same sweep triggers (see A
  DEBOUNCE IS NOT AN ABSENCE GRACE). `kind` is a durable hardware property, so
  the snapshot can answer it; a live row always outranks the snapshot.
- **A renumbered camera is still recognised**, through the `previousIds` aliases
  the successor publishes — otherwise a libuvc camera would lose its own
  selection on exactly the cycle that matters.
- **The EMI/cable advisory does not take this SELECTION gate.** Its two kernel
  lines are emitted only while the receiver is actually locking or clocking a
  link, so they already describe work somebody asked for. Do not extend
  `provesSelectionIsNotHdmi` to it.
- **`hdmiNoSignalRaiseAllowed()` (the production wiring in `sensors.ts`) is
  FAIL-OPEN.** A throw reading config or the sources list is not evidence about
  the operator, so it must never be the reason a real fault goes unreported.

**The advisory DOES take a DEDUP guard, which is a different question.** Its raise
was unconditional — every matching kernel line called `raise()`, and a link that is
merely settling prints them repeatedly, so one replug cycle could re-fire the toast
several times over and could also overwrite a standing "No HDMI signal detected" on
the slot the two share. Both properties are fixed by ONE check: it raises only when
`peek(HDMI_ERROR_NOTIFICATION)` is `undefined`, i.e. only onto a free channel.

Note the deliberate asymmetry with the sibling no-signal raise, which DOES re-raise
over its own standing notification (`!hdmiNotif || hdmiNotif.msg === HDMI_NO_SIGNAL_MSG`).
That one re-asserts a condition the operator is being asked to act on; the advisory
is one-shot guidance about the physical link, and repeating it teaches nothing new.

The dmesg callback was extracted to the exported `handleRk3588HdmiDmesg(data,
deps)` so both raise conditions are drivable without a `dmesg -w` process.
Coverage: `tests/hdmi-raise-scope.test.ts` (the pure verdict table incl. the
coarse/renumber/persisted-fallback arms, the sweep raising nothing, the advisory's
dedup guard — free channel raises, own-advisory and no-signal standing both refuse,
a five-line settling burst costs exactly one raise, and the audio-underflow trigger
under the same guard — and the negative controls: a selected HDMI input with no
cable still raises, the advisory still raises past the selection gate, and the
no-signal raise's own standing-advisory non-overwrite is unchanged).

