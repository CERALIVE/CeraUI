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

## THE CERALIVE UPDATE OFFER IS WITHDRAWN ONLY ON POSITIVE EVIDENCE [EXISTS]

`ceralive_update` ("A CeraLive update is available") was raised by both discovery
paths and never withdrawn. The backend map is process-local, a replay only adds,
and an open tab's store survives reconnects, so after an update the banner stayed
on screen even with the candidate installed (Rock 5B+, 2026-11-21). Thirteen review
rounds of PR #670 kept finding one class of fault: something other than this
process's own complete read wrote or cleared the slot (a startup or login APT read,
a stored record, a stored proof, a rate-limited rekey, an earlier check's verdict
replayed at a later login, an incomplete check's subset). Every shipped frontend
removes this notice **by name**, whatever release its copy names (current:
`dismissNotification(entry.id)`; v2026.7.2: the bare string). Owner:
`modules/system/ceralive-update-notice.ts`.

**The two rules.** (1) The slot holds at most one offer, identified by its exact
package instances (name, architecture, version). Only a complete check of this
process replaces or retires it. An unknown, partial or incomplete check changes
nothing: not the slot, not the record. (2) No removal is ever sent at login. A login
is sent the slot's current copy (its identity key and revision) when the slot holds
one, and nothing for this notice otherwise. A removal is sent only live, to the tabs
connected then, and only where no copy any of them holds can be of another pending
offer. Unknown always keeps the offer.

| Rule | How it is met |
|---|---|
| Who writes the slot | Only `reconcileCeraliveUpdateNotice`, from a complete check of this process. Startup announces, removes and runs nothing. No login, record, recovery or proof writes it. A write bumps the slot generation. Each new release reaches every connected tab (a release-scoped notice's new release bypasses the one-second limiter), and each login gets the slot's copy. So while the slot holds an offer, every connected tab was sent it. A send the socket itself dropped is not detected. |
| Removal (a): the update's own result | `createSoftwareUpdateProcessMonitor` fixes the stored offer when it takes the update. `settle()`, after the cache cleanup and before it releases `softUpdateStatus` (`isUpdating()` still refuses every check and start), reads dpkg for it only if the slot holds that offer (its key, which includes every architecture). If dpkg shows it installed and no write to the slot happened during the read, connected tabs drop it: each was sent that copy. Nothing is written. A process that never showed the offer (a recovery after a package-script restart, before any check of its own) removes nothing. |
| Removal (b): a complete check | It found none pending (with dpkg showing any stored offer installed: a held, pinned-away or pulled offer stays) or exactly the dismissed set. Then no copy a tab holds can be of another pending offer, so connected tabs are sent the removal, on every such check. Nothing outlives the check: no later login, reconnect or check acts on it. |
| The readback | #664's `targetsAttained` (`software-update-outcome.ts`): one complete `dpkg-query -W`, each offered instance (name and architecture) `ii ` or `hi `, `dpkg --compare-versions <installed> ge <offered>` exiting 0. 5 s per command, 20 s in all. A check that recorded another offer while dpkg was read wins. |
| Conclusive | The refresh exits 0 with no `Err:`, `E:`, failed-fetch or stale-index line and no captive signature, and hit or fetched the `InRelease`/`Release` of **every** CeraLive source the check's own `apt-cache policy` inventory lists (same URI and suite), with no `Ign:`/`Err:` for it. Legacy: `dist-upgrade --assume-no` exits 0, or 1 after its own `Abort.`, with no `E:`; not the kept-back fallback; the upgrade and NEW lists name exactly what the summary counts, each once. Capable: one summary line and exactly the `Inst`/`Remv` rows it counts; another architecture's instance of a roster package is unknown. |
| Complete | Conclusive, APT reports no package a transaction left unfinished (no `N not fully installed or removed.` line: an unpacked or half-configured package's setup is still pending, with no `Inst` row and no newer candidate), the kept-back list names exactly what the summary counts as not upgraded, and no first-party name it, the upgrade, NEW, REMOVED or DOWNGRADED list carries is left out of the offer (a held or solver-kept-back package, a new install, a removal or downgrade, another architecture; capable refuses removals and its summary admits no downgrade). Anything less is unknown: a verified subset is not shown, recorded, dismissable or proven installed in place of the standing offer, and "nothing pending" is not read as none. |
| The offer | What the check found Install would take, each an exact instance (which names count: the eligibility table below). Capable: every first-party row of the check's own discovery, actionable with origin `apt.ceralive.tv`, its instance the check's own simulated `Inst` row (`admittedTargets`). Legacy: the actionable first-party names, each with its `apt-cache policy` candidate from CeraLive's own source and that candidate's architecture from `apt-cache show --no-all-versions` (exactly one record of that name and version). One unverified row makes the verdict unknown. |
| Identity and record | Dismissal key `update:<name:arch=version,...>`, sorted. `ceralive_update_offer.json` is `{version:8, offer:[{name,arch,version}]|null}`, written only by a complete check, before anything is broadcast, validated by the writer with the reader's schema and limits. It is read only by the next check's "none" (dpkg must show it installed). No proof is ever stored. |
| Dismissal | `releaseScoped`: `notifications.dismiss` carries the shown `revision` and `publisher`; only the current release is dismissed durably, and then removed from connected tabs (each was sent that copy). A tab that logs in later is not told. The store writes before it remembers. |
| Wire | Additive only: optional `revision`/`publisher` on the dismiss input and separate live removal frames (typed, then the pre-#183 bare name). The login frame is main's. |

**Which packages count, per image.** Audited against main's two producers
(`541ae1e2:software-updates.ts`) and each image's Install vector (#664's
`targets`); no second list is kept.

| Image | Main raised the banner for | Install takes | This notice counts as first-party |
|---|---|---|---|
| Capable | an actionable row named `ceralive-*` or `cerastream` (e.g. `ceralive-apt-credentials`) | every admitted row of the plan (`actionableAllPackages`), Debian ones included | `isFirstPartyPackage` (`apt-all-packages.ts`, the set this path already refuses to see held): any `ceralive-*`, `cerastream`, `srtla`, `libsrt1.5-ceralive`, `gstreamer1.0-libuvcsrc`, `gstreamer1.0-rockchip-ceralive`, `librga2-ceralive`, `modemmanager` and its `libmm`/`libmbim`/`libqmi`/`libqrtr` libraries. It contains main's rule and the whole legacy roster, so no package main announced can be absent from a capable "none". Each must come from CeraLive's origin, or the check is unknown. |
| Legacy | an upgraded package in the roster (`classifyPackageLayer`, `package-layer.ts`) | only roster names (`buildAptUpgradeArgs`) | the same roster. A non-roster package such as `ceralive-apt-credentials` is neither announced nor taken by legacy Install, so it neither raises the banner nor blocks a legacy "none", exactly as on main. |

The record accepts any name `isFirstPartyPackage` admits (the roster is part of it).

Limits, each a stale banner cleared by a later complete check while the tab is
connected (checks run at boot, then about hourly), or by dismissing it:
- a tab that was not connected when a removal was sent (reloading, offline, or
  connected to a predecessor) keeps its copy, including one that reconnects after
  the update's own restarts once that process's first check has finished;
- any copy after a restart until that process's first complete check (fresh tabs
  see no banner until then); a recovery after a package-script restart removes
  nothing itself;
- any banner while CeraLive's repository is unreachable, while a package's setup
  is unfinished (APT reports it not fully installed), or while a first-party
  package is held, kept back, newly installed beside a legacy upgrade, removed,
  downgraded, or of another architecture. Such a check also shows no new offer: a
  missing banner, while Settings → Software Updates still lists the update;
- an offer dpkg does not show installed while nothing is pending, until a new
  offer or a dismissal;
- while the state directory cannot be written, a new offer is not shown and a
  check's "none" is not acted on (a check whose verdict equals the durable record
  needs no write).

A package rolled back by hand is not seen until the next check, like any offer.
Without a stored record (a banner main raised), a candidate pinned out of the
solver's view looks like "none" to a complete check, and that banner is retired;
Install would not take it either. A notice dismissed under a former key is shown
once more, and a dismissal from an older frontend no longer sticks. The
orchestrator's package `update:updates-available:*` notice has no retraction yet
(separate follow-up).

Coverage: `tests/ceralive-update-notice-lifecycle.test.ts` (real check entries and
install completion over scripted APT and dpkg, both images; a table of sequences
asserting what a connected tab and a later login hold in both decoders, including
evidence that changes before a login, a dismissal before a login, an incomplete
check beside the standing offer and then the install of the other package (before
and after a restart), incomplete then complete, a hold that changes, and an
install APT reports unfinished (with no stored offer, then configured, and beside
another package's upgrade); every
inconclusive and incomplete refresh and discovery; rate-limited releases; the
readback inside the update's result step; dpkg's own order; dismissals through the
RPC procedure; logins through the real login sender);
`tests/ceralive-update-notice-restart.test.ts` (fresh `bun` processes sharing only
device files, real authenticated WebSocket tabs of both decoders, the real check
entry and the real recovery up to the update's deliberate restart, both images.
Older banners come from main's own backend: `helpers/main-backend-preload.ts`
serves every production file that differs from main `541ae1e2` with its source at
that commit, and its real check raises them. The file covers the reported journey,
an update from main's backend, rollbacks, a stored or dismissed offer under another
backend's newer copy, a stored older offer during recovery, a tab logging in after
the update's own proof, a held package with and without a stored offer, three
releases inside a second, a table of the same sequences over real processes, an
install APT reports unfinished under main's banner (kept, then cleared once
configured), a credentials-only capable update under main's banner (kept while
pending and unfinished, cleared once dpkg shows it configured at the candidate),
records, early tabs, dismissal across restart, the largest committable offer,
refused records and stores, failed writes); and the frontend half
(`apps/frontend/src/tests/notification-recovery-ingestion.test.ts`,
`apps/frontend/src/main/notifications/notification-presentation.test.ts`).
