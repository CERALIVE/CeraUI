## AN UPDATE ACTION'S OUTCOME IS DECIDED BY EVIDENCE, NOT BY THE REPLY ALONE [EXISTS]

The Updates dialog's three operator actions (Check now, Install now, Download
over cellular now) are one small state machine. Two review rounds found the
same defect class at neighbouring seams: a lost reply read as a refusal, a
stale read overwrote a newer one, an unknown was rendered as a fact. Each was
fixed where it was found and the next round found it one seam over. The cure
is the machine below, not another guard: every seam feeds the same machine,
and the machine alone decides what the operator sees.

| Code | Owns |
|---|---|
| `lib/updates/update-action-failure.ts` | what a finished request PROVES (the verdict) |
| `lib/updates/update-action-outcome.ts` | the machine: states, evidence folding, ownership (pure) |
| `lib/updates/update-action-settlement.ts` | which phase or read settles which action (pure) |
| `lib/updates/update-actions.svelte.ts` | the rune shell: call ids, `osCommand`, the post-action read |
| `lib/updates/update-surface.svelte.ts` | the details reads and their fences; feeds the machine |
| `lib/updates/update-device-follow.svelte.ts` | when an OPEN dialog re-reads (phase moved, session restored) |
| `lib/rpc/session-epoch.svelte.ts` | the count of sessions restored after a dropped link |
| `main/dialogs/updates/ActionOutcomeList.svelte` | one band per action, named after its control |

### States of one dispatched call

| State | Entered by | Band |
|---|---|---|
| `dispatched` | the request left (inside `osCommand`'s `rpc`) | none; the action is busy |
| `accepted` | `{ success: true }` from the step that starts the action | none |
| `refused` | positive pre-dispatch evidence (below) | "Not started" + the reason |
| `unconfirmed` | a lost reply or a handler error, nothing has settled it | "Outcome not confirmed" |
| `reconciled` | settling evidence, before or after the verdict | none |

A click while the action's chain is still awaited is dropped BEFORE anything is
touched: it gets no call id, owns nothing, and cannot clear, conclude or steal
the watch of the call it duplicates.

### What each kind of evidence may prove

| Evidence | Proves |
|---|---|
| `{ success: false }` | not started (`refused`, the device's reason) |
| `UPDATE_ORCHESTRATOR_INITIALIZING` envelope | not started: `startupReadiness.assertReady` runs before any effect |
| `NotSentError` (the client never sent it: the socket was not open) | not started (`not_connected`) |
| `INTERNAL_ERROR` / `VALIDATION_ERROR` envelope | NOTHING about the start: any handler fault, and the reply schema runs after the handler (`unconfirmed`, cause `error`) |
| timeout, socket reset, anything else | nothing (`unconfirmed`, cause `lost`) |
| a phase CHANGE pushed after the dispatch | settles it when it is the action's start phase, `failed` or `quarantined` |
| a details read STARTED after the dispatch that LANDS | settles a check when its clocks moved, an install when a different image is staged |
| a failed or superseded read, a same-phase push | nothing |
| a session restored after a dropped link | triggers a fresh read, even when the phase is unchanged |

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

### Invariants, and how they are pinned

U1 "Not started" only for positive pre-dispatch evidence; U2 an unconfirmed
outcome clears once ANY later evidence settles it, including the restored
session's read on an unchanged phase; U3 nothing from a closed session reaches
the reopened one; U4 a dropped duplicate changes nothing; U5 busy lasts exactly
as long as the chain is awaited; U6 an outcome nothing has settled is shown as
unconfirmed, never as a negative fact.

- `update-action-interleavings.test.ts`: EVERY sequence of up to 8 events over
  17 kinds (dispatch, duplicate, device starts, refusal, internal error,
  timeout, late success, link drop, reconnect, unrelated/same phase push, read
  oldest/newest/failed, close, reopen) on a reference world that drives the
  production machine and binder step: 1,686,842 sequences for Check and
  1,136,319 for Install, U1–U6 after every event.
- `update-surface.interleavings.test.ts`: every maximal path of up to 5 of those
  events replayed against the REAL surface, shell, `osCommand` and `RPCClient`
  on a scripted socket and fake clock (10,436 Check and 9,375 Install paths);
  after every event the real bands, busy state, shown details, failure band and
  requests on the wire equal the world's prediction.
- The reviewer's sequences as named tests: `update-action-evidence.test.ts`
  (internal error after staging, validation envelope, never-sent request,
  declined duplicate then timeout, a 29 s approval followed by a hanging
  download) and `main/dialogs/UpdatesDialog.reconnect.test.ts` (a whole check
  hidden by an outage, through the real subscription layer's reconnect).

### "No newer system image" is a conclusion too

`osCheckFoundNothing()` (`lib/updates/update-dialog-view.ts`) allows that
sentence only with read details, an OS clock whose LATEST attempt succeeded
(`lastSuccessAt >= lastAttemptAt`: a newer failed check keeps the old success
clock) and a known phase that could show a held offer (not `checking`,
`failed`, `quarantined` or a system-image phase: a resumed `os-available` keeps
its phase while the candidate lived only in the old process's memory).
Otherwise the System section says it is not known yet.

### Residuals

- A request the device never received (lost before delivery) or refused with
  the reply lost stays "Outcome not confirmed" until the next attempt or close:
  no device report distinguishes those from a request still to come.
- A check settles on ANY newer check clock, including a scheduler check the
  dialog had not displayed yet when the operator clicked.
- The one-time cellular approval stays granted when the download step is
  refused or not sent; the device may download on its own schedule, which the
  dialog reports through the phase.
- After a backend restart in a package phase that followed an OS offer held by
  a stage-recovery record, the memory-only candidate is gone while the success
  clock is not; that combination still reads "No newer system image" until the
  next OS check. A backend-side "candidate unknown after restart" field is the
  proper fix and is out of the frontend's reach.
