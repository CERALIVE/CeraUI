## AN UPDATE ACTION'S OUTCOME IS DECIDED BY EVIDENCE, NOT BY THE REPLY ALONE [EXISTS]

The Updates dialog's operator actions (Check now, Install now, Download over
cellular now, and the legacy Packages Update) are one small state machine.
Three review rounds found the same defect class at neighbouring seams: a lost
reply read as a refusal, a stale read overwrote a newer one, an unknown was
rendered as a fact. Each was fixed where it was found and the next round found
it one seam over. The cure is the rule and the machine below, not another
guard: every seam feeds the same machine, and the machine alone decides what
the operator sees.

**The rule.** A sentence about what the device did or holds ("Not started",
"not saved", "no newer image", "up to date", "no add-ons") is a conclusion. It
is rendered only when device evidence its PRODUCER guarantees establishes it.
A reply, a timeout, a clock or an absent value proves only what its producer
says it proves; anything else renders the explicit unknown.

Stream pulls follow the same read-start horizon as update details (FIX-16-F6):
dispatch after the action/newest STREAM-FACT observation is required, separately from
browser receipt. Receipt is arrival, never device computation time; ingestion
does not mint causality. Only `is_streaming`, `stream_lifecycle` and unclassified
names advance that atomic stream horizon; unknown names fail closed. Unrelated
pushes do not supersede stream evidence. Successful snapshot fields merge
independently unless a push carrying that field arrived after dispatch or a newer
receipt/read already applied it; stream-superseded facts are never applied or
used for settlement. Superseded lifecycle reads allow one fresh read, never
a loop; failed or twice-superseded reads settle nothing. Stream watchdogs are
also fenced to the originating action lifetime across every await/effect. This
does not change update action settlement or the shared operation registry.

The stream allowlist classifies fields as unrelated to **stream settlement**,
not every decision: `updating` gates reboot/power and `network_ingest` gates Start
configuration. Exhausted current Start recovery records generation-owned UNKNOWN
in the existing unresolved-action store and renders the existing band/keys with
an operator-reachable Stop. Later admissible live/idle facts after its mark or
that Stop owner's acknowledgement clear only matching Start optimism; navigation,
remount, reconnect and uncertain evidence do not. The latest explicit Stop owner's
acknowledgement also settles its captured, still-current starting attempt before
exhaustion, revoking the watchdog even when no recovery record exists. Stop-owner
and Start-generation fences stay; a failed Stop settles nothing. The shared
operation still requires post-press idle lifecycle for confirmation.
That acknowledgement revokes its captured Start whether or not admissible
settlement already closed the Stop claim. Idle confirms the Stop operation but
does not end acknowledged Start before recovery; failed Stop and pre-record
boolean false do not revoke it. Post-record F8 facts still clear UNKNOWN, and
the band's explicit Stop remains the escape. The 36-cell real-socket S/R/E
permutation matrix in `LiveView.real-socket-stop.test.ts` owns this contract.
No automatic Stop or backend
lifecycle is fabricated. Browser scheduling and integrated backend/engine
incidence of the complete lost-confirmation transcript remain UNKNOWN.

| Code | Owns |
|---|---|
| `lib/updates/update-action-failure.ts` | what a finished request PROVES (the verdict) |
| `lib/updates/update-action-outcome.ts` | the machine: states, evidence folding, ownership (pure) |
| `lib/updates/update-action-settlement.ts` | which phase or read settles which action (pure) |
| `lib/updates/update-actions.svelte.ts` | the rune shell: call ids, `osCommand`, the post-action read |
| `lib/updates/update-surface.svelte.ts` | the details reads and their fences; feeds the machine |
| `lib/updates/update-settings-owner.svelte.ts` | the settings reads, the ONE write in flight, its verdict |
| `lib/updates/os-offer-witness.ts` | the only evidence for "no newer system image" (pure) |
| `main/dialogs/updates/PackagesSection.svelte` | the legacy Packages controls, through the same machine |
| `main/dialogs/updates/SettingsSaveBand.svelte` | "not sent" vs "not confirmed" for a settings save |
| `lib/updates/update-device-follow.svelte.ts` | when an OPEN dialog re-reads (phase moved, session restored) |
| `lib/rpc/session-epoch.svelte.ts` | the count of sessions restored after a dropped link, the link epoch, and which link last DELIVERED `stream_lifecycle` |
| `main/dialogs/updates/ActionOutcomeList.svelte` | one band per action, named after its control |

### States of one dispatched call

| State | Entered by | Band |
|---|---|---|
| `dispatched` | the request left (inside `osCommand`'s `rpc`) | none; the action is busy |
| `accepted` | `{ success: true }` from the step that starts the action | none |
| `refused` | positive pre-effect evidence, or a `{ success: false }` reply no start evidence preceded (below) | "Not started" + the reason |
| `unconfirmed` | a lost reply or a handler error, nothing has settled it | "Outcome not confirmed" |
| `reconciled` | settling evidence, before or after the verdict; also a `{ success: false }` reply after start evidence | none: the device's phase states what happened |

A click while the action's chain is still awaited is dropped BEFORE anything is
touched: it gets no call id, owns nothing, and cannot clear, conclude or steal
the watch of the call it duplicates.

### What each kind of evidence may prove

| Evidence | Proves |
|---|---|
| `{ success: false }` | not started (`refused`, the device's reason), UNLESS start or outcome evidence for the action reached the dialog between the dispatch and that reply: then `reconciled`. The OS-install producer answers `not_available` from the END phase of a stage it already ran (`runtime.ts` `installUpdatesNow`), and it publishes every phase transition before it returns, over the same ordered socket, so a start the request caused is always seen before its reply (round-3 review C, C3-1) |
| `UPDATE_ORCHESTRATOR_INITIALIZING` envelope | not started: `startupReadiness.assertReady` runs before any effect |
| `NotSentError` (the client never sent it: the socket was not open) | not started (`not_connected`) |
| `INTERNAL_ERROR` / `VALIDATION_ERROR` envelope | NOTHING about the start: any handler fault, and the reply schema runs after the handler (`unconfirmed`, cause `error`) |
| timeout, socket reset, anything else | nothing (`unconfirmed`, cause `lost`) |
| a phase CHANGE pushed after the dispatch | settles it when it is the action's start phase, `failed` or `quarantined` |
| a legacy `update_state` kind CHANGE pushed after the dispatch | settles the Packages Update when it is `downloading`, `installing`, `update_preflight_failed`, `failed` or `success` |
| a details read STARTED after the dispatch that LANDS | settles a check when its clocks moved, an install when a different image is staged |
| a failed or superseded read, a same-phase push | nothing |
| a session restored after a dropped link | triggers a fresh read of the details, the settings AND the image capabilities, even when the phase is unchanged; it is NOT evidence about any pushed field itself (its status hydrate can fail and still count as restored) |

Settling evidence is sticky: once seen it holds, so a later read that shows
less cannot reopen the question. Evidence that arrives while the call is still
`dispatched` counts, so an error reply after the device has shown the image
staged lands directly in `reconciled`.

A cellular approval is TWO requests (`allowCellularOnce`, then
`installUpdatesNow`) and ONE action: the last step decides the verdict, and the
action stays busy until the whole chain settles. Every step is bounded by the
client's own 30 s timeout, so busy can never outlive the chain; the
`osCommand` valve is sized to `steps × timeout + 5 s` to agree with it.

### Ownership and sessions

Each action keeps its own outcome, so a newer Check never erases an Install
nobody has confirmed; each band names the control that started it. Closing the
dialog (`reset`) ends the session: every outcome is dropped, a call from the
closed session concludes nowhere and starts no read, and every details read
from it is fenced by the surface's latest-read counter. Busy marks are NOT
dropped: a chain still on the wire keeps its control busy in the reopened
dialog until it settles.

### The legacy Packages Update

`system.startUpdate` is the machine's fourth action (`packages`), on the
historical `update` operation key that drives the section's spinner. A
`{ success: false }` reply is "didn't start" with the device's reason ("refused
without giving a reason" only for a real refusal envelope without one); a lost
reply is "Outcome not confirmed" until a legacy state change settles it. The
"accepted, no progress" band needs an ACCEPTED reply and only reports that the
device "has never reported any progress so far": the valve also lapses while a
reply is still on the wire, and missing progress never proves nothing was
installed. "System is up to date" needs `idle` with a `checked_at` stamp (a
completed discovery found nothing); `checking` says checking, anything else
says the device has not reported a completed check yet.

### Installation, restart and connection conclusions [EXISTS]

Package `update_state.kind: success` proves the package transaction completed,
not that services restarted. The dialog and the app-wide overlay report
installation with restart **not confirmed**. Neither the status nor the details
contract exports an update-specific backend start/boot identity or completed
restart witness. A reconnect, a new boot, a restart permission or the
`restarting-services` phase cannot substitute for that missing evidence. This
extends U6; it is not a second action machine. Host render tests cover the exact
success state, including withheld/unknown restart authority. No board restart
or future availability time is claimed.
The installed-only copy uses additive `general.updateInstalledDetail` and
`updatingOverlay.installedDescription` keys. The previous legacy keys remain
unused in app code, preserving the immutable migration oracle without changing
its fixtures or weakening its assertions.

Connection details are a timestamped selection observation, not live use or
durable download history. A null record is **not known in this session**, including
after a backend restart. `healthy: false` alone means the selector did not prove
usability: `Not reachable` additionally requires a positive failed probe state,
and only `no-route`, `dns-failed` and `blocked` count as one. A
`credentials-invalid`, `tampered`, `tls-error` or captive state is produced after
the link REACHED a server, so any of them makes the row **Not usable for
updates** instead (`connection-evidence.ts`, early oracle F4); an
empty/unavailable-only state stays unconfirmed. The same producer token also
covers a LOCAL client certificate curl could not use, so the credentials band
says the device's update certificate **could not be used**, never that the
server rejected it. The no-selection band says
no connection was **confirmed usable** by that check. The chosen row is labeled
**Selected by this check**, never **In use**. Inventory `metered: null` remains
null through the shared RPC schema and renders **Cost unknown**; conservative
transport admission still treats that cost as requiring approval. The pending
approval band therefore says no connection is **known** to be unmetered and the
download goes over a metered link or one of unknown cost; `pendingCellular`
carries a candidate and a size, never the link's identity, so the band never
says only a cellular connection exists (early oracle F5).

The withheld-packages band is headed **Not included in this update**. A row
says "Ships with the next OS image" only for `layer: platform` (the wire
schema's documented meaning of that layer) and "Held back by the system" only
for `kept_back`; `actionable: false` alone adds nothing. A progress frame whose
total is unknown renders an indeterminate bar, never 100 % (early oracle F7).

### A terminal install releases the takeover [EXISTS]

The legacy `status.updating` push has ONE reading, `legacy-install.ts`:
running (an object without `result`, or `true`), succeeded (`result: 0`),
failed (any other `result`; only a string carries the device's words), none.
The device publishes the terminal object, then clears its own latch and
publishes only `update_state`; the store keeps the omitted field on purpose, so
the terminal object is the last `updating` frame the page holds. Layout mounts
the non-dismissible takeover only while the install RUNS, so a failure or a
success releases it in the same frame, with no reload. The UpdateBanner, the
power dialog's "Update in progress" gate and the HUD flag ask the same
predicate (`legacyInstallRunning`). The terminal outcome has one announcer,
`legacy-install-notice.ts`, called from Layout (which receives the terminal
frame) and from the overlay rendered on its own; it toasts once per terminal
object, so a repeated frame, a re-mounted Layout or a second caller stays
quiet and a new run's result is announced. Layout passes the dedicated
`getUpdating()` object, whose identity the store keeps for an unchanged field;
the aggregate `getStatus().updating` is a new object whenever ANY sibling field
moves, so the same outcome beside a changed lifecycle was announced again
(early oracle R3; `a repeated terminal outcome with a changed sibling announces
once`, with `a genuinely new run right after the first is still announced` as
the control). Failure stays visible: the error
toast with the device's text (one honest sentence when it sent none), the
device's persistent `ceralive_update_failed` notice and the dialog's "Update
failed" summary. Pinned through the real store and Layout by
`Layout.update-terminal.test.ts` (refresh failure, transaction failure,
result 0) and by `PowerDialog.update-terminal.test.ts`.

### Settings saves

`update-settings-owner.svelte.ts` owns the ONE write in flight. A save owns the
controls from the click until its whole request chain SETTLES; it never leans
on the shared operation valve (15 s, shorter than the client's 30 s call
timeout). Every write is built from a settings read STARTED after the click:
the wire takes the whole object (no field patch, no compare-and-swap) and
settings are not pushed. Only a write never sent (or whose basis read failed)
is "not sent"; any other failure is "Change not confirmed", the shown settings
being the last the device reported, re-read at once and cleared when a read
shows the requested values.

### Invariants, and how they are pinned

U1 "Not started" only for positive pre-effect evidence or a negative reply no
start evidence preceded; U2 an unconfirmed outcome clears once ANY later
evidence settles it, including the restored session's read on an unchanged
phase; U3 nothing from a closed session reaches the reopened one; U4 a dropped
duplicate changes nothing; U5 busy lasts exactly as long as the chain is
awaited; U6 an outcome nothing has settled is shown as unconfirmed, never as a
negative fact. Settings: S1 one write awaited at a time; S2 a write changes at
most one, operator-set, field of the device's settings; S3 "not sent" only for
a write the device never received, "not confirmed" only for one it did; S4 the
controls are released only once no write is awaited; S5 a restored session
re-reads the settings. Capabilities: a restored session re-reads the image's
declaration (an OS replacement changes the image behind a dropped link), under
its own latest-read counter; a failed read lands as UNKNOWN (no legacy notice,
the failure band), never as the previous image's answer (early oracle R5;
`UpdatesDialog.live-link.test.ts`). The reference world models that re-read
(`capsRead`), answered with the unchanged image's declaration.

- `update-action-interleavings.test.ts`: EVERY sequence of up to 8 events over
  18 kinds (dispatch, duplicate, device starts, refusal (also AFTER a start),
  startup envelope, internal error, timeout, late success, link drop,
  reconnect, unrelated/same phase push, read oldest/newest/failed, close,
  reopen) on a reference world that drives the production machine:
  2,126,403 sequences for Check and 1,384,886 for Install. The oracle states
  the contract from device-side facts; WHEN the dialog reads is the world's
  own `contractMove`, and the production `followStep` is checked against it
  over every frame pair.
- `update-surface.interleavings.test.ts`: every maximal path of up to 5 of
  those events replayed against the REAL surface, shell, `osCommand` and
  `RPCClient` on a scripted socket and fake clock (11,894 Check and 10,706
  Install paths); the binder there is the production `followStep`, so a binder
  that stops re-reading on a restored session diverges from the world.
- `update-settings.interleavings.test.ts`: every path of up to 6 save events
  (clicks, basis read, applied or applied-but-lost write, 16 s, timeout, a
  remote change, a restart) on the real stack, S1–S5 checked from what the
  device received and what the screen says, with no model of the code.
- `os-offer-witness.test.ts`: every sequence of up to 8 device and dialog
  events against the producer's ground truth (below).
- The reviewers' sequences as named tests: `update-action-evidence.test.ts`,
  `update-conclusions.test.ts` (start observed then `{success:false}`, package
  phase + lost candidate memory, save reply delayed > 15 s then second save,
  lost reply after settings persisted), `main/dialogs/UpdatesDialog.reconnect.test.ts`
  and `main/dialogs/UpdatesDialog.conclusions.test.ts`.

### "No newer system image" is a conclusion too

The device keeps its OS candidate in MEMORY only, while the OS check clocks,
the phase and a stage-recovery record survive a backend restart. A read with
`candidate: null` beside a successful clock therefore proves nothing: the
process that answered may not be the one that ran the check, and the schema
carries no process identity. The only positive evidence is the dialog's own:
`os-offer-witness.ts` records, per link (`getLinkEpoch()`, bumped on every
drop; a restart always drops the link), the OS success clock of the link's
first read as a baseline, and the verdict of every success clock it later sees
APPEAR. A read is attributed to the link it STARTED on, never to the link that
is current when it lands, and the link count is reactive state, so the
rendered sentence leaves the screen at the drop itself and a failed read over
the restored link cannot bring it back (early oracle F2,
`UpdatesDialog.live-link.test.ts`). The sentence needs that witnessed empty verdict for the CURRENT clock
on the CURRENT link, AND `osCheckFoundNothing()` (the latest attempt succeeded,
the phase is known and could show a held offer). Every other combination,
including an ordinary restart in a package phase, renders "It is not known yet
whether a newer system image is available." A witness survives closing the
dialog on the same link. What it means exactly: the latest check this dialog
saw complete left no offer, either nothing was found or the device's own
admission rejected what was (expired, replayed, quarantined, not newer).

### Residuals

- A request the device never received (lost before delivery) or refused with
  the reply lost stays "Outcome not confirmed" until the next attempt or close:
  no device report distinguishes those from a request still to come.
- A check settles on ANY newer check clock, including a scheduler check the
  dialog had not displayed yet when the operator clicked.
- The one-time cellular approval stays granted when the download step is
  refused or not sent; the device may download on its own schedule, which the
  dialog reports through the phase.
- "No newer system image" after a restart, or when the dialog opens after the
  device's last check, stays "not known yet" until the dialog sees a check
  complete (Check now does that). This is the honest cost of a memory-only
  candidate, not a false sentence.
- A settings write races another client's change only inside one round trip
  (its basis read and the write): the wire has no compare-and-swap.
