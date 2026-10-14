<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE MODEM MUTATION-SAFETY CONTRACT [EXISTS]

The interlock above is the PRIMITIVE. This is the contract built on it, and it
covers every path that mutates a modem — MM/NM config, SIM PIN/PUK/PIN2, a
network scan, a router-admin write, the remote `modem.reconfig` op, and the
USB-composition switch.

**It is an EXTENSION of `lifecycle-admission.ts`, not a second guard beside it.**
A parallel lease plus a `getIsStreaming()` check would reopen the admission-window
race that module exists to close: `getIsStreaming()` is false for the whole
admission window, which is precisely the window a mutation must not land in. So
the `"modem-transition"` holder was GENERALIZED to a per-physical-device lease:
two devices may be mutated concurrently, a stream admission is refused while ANY
lease is held, and every mutation is refused while an admission holds the
interlock.

### The lease, and the ONE helper every entrypoint routes through

`modules/modems/mutation-lease.ts` has two shapes, and the difference is exactly
whether the mutation can cost connectivity:

| Helper | Use |
|---|---|
| `withModemMutation` | lease only — a SIM PIN submit, a network scan, a router-admin write. Nothing a rollback would have to restore. |
| `withJournaledModemMutation` | lease PLUS a durable armed journal entry written BEFORE the mutation and cancelled only after it is confirmed. APN/roaming/band/5G/USB-mode. |
| `beginModemMutation` | the lease alone, for a transaction whose confirmation is DEFERRED past the caller's return (see LEASE LIFETIME below). |

**IDENTITY IS FAIL-CLOSED.** The identity contract permits an omitted
`stable_key`, and a target with no resolvable physical key cannot be journaled,
cannot be rolled back and cannot be re-found after a re-enumeration — so EVERY
mutating entrypoint answers the typed `identity_unresolved` before anything is
written and before anything is mutated. It is deliberately not a throw: this runs
at an RPC boundary, where a throw becomes an opaque failure nobody can act on.
`mutation-identity.ts` is the one resolver (mmcli index / MM object path / ifname
→ `ID_PATH` → `deriveModemStableKey`).

### The durable journal

`modules/modems/mutation-journal.ts`, at the PINNED location
`/data/ceralive/modem-mutations/<sha256(stable-key)>.json` — `/data` because it
survives an OTA slot swap, hashed because an `ID_PATH` is not a safe filename, one
file per physical device because two devices' mutations are independent. Mode
0600; the directory 0700.

**THE DURABILITY SEQUENCE IS THE CONTRACT**, in this exact order per transition:

```
write temp -> fsync(temp) -> rename() over the journal path -> fsync(parent dir)
```

and a durable deletion is `unlink()` + `fsync(parent)`. Only genuine unlink ENOENT
is an already-absent success; all other unlink errors propagate, with no readback
substitute. Failed parent fsync after visible removal remains owned for fsync-only
retry before recovery completes, never repeated deletion from obsolete authority.
An older acknowledgement cannot clear a newer failed one. `rename` over an existing
path is atomic on every filesystem the device ships, so NO injection point can
leave a torn document. A failure anywhere REJECTS and the caller must not proceed:
the parent-directory fsync is INSIDE the boundary rather than best-effort after
it, because until the directory entry is durable the rename can be lost by a power
cut. That makes the failure mode fail-CLOSED — the visible on-disk state may
already be the new, more-restrictive one while the caller is told it did not
commit.

**Every filesystem primitive is injected** so the fault-injection harness can fail
each of the four steps independently against a REAL temp directory. An unparseable
or wrong-version slot is reported and LEFT IN PLACE — a mutation record that
cannot be read is exactly what fail-closed exists for.

**A record is valid only in its own slot.** Every writer files an entry at
`sha256(entry.stableKey).json` (the only naming since the journal was created), so
`parseMutationJournalEntry` binds each parsed record to the file it came from: a
direct read of key K accepts only `sha256(K).json` content naming K, and both
inventory passes accept a file only when its name is
`sha256(record.stableKey).json`. A schema-valid record filed under any other name
(hand edit, misfile, copy) is MISPLACED and is treated exactly like a torn slot:
the read fault raises the recovery barrier, the direct read answers nothing,
`listUnreadableSlots` names the file, the complete inventory throws
`MutationJournalInventoryError`, and replay neither replays nor removes it. A
misplaced record is never ordinary absence and never a deletion target: an
acknowledgement retry for the slot's key answers the existing `no_entry` while the
barrier stays up, and the named key's real slot is untouched. Defence in depth:
acknowledge, decommission and rebaseline reread under their lease and refuse with
`state_mismatch` any record whose key differs from the leased key, so no
retirement writes or deletes a slot whose lease it does not hold. Repair is the
same operator action as for any damaged slot: remove or refile the stray file;
the retry owner then lowers the barrier on a fully readable journal.

Journal reads are bounded, anchored, no-follow/nonblocking and duplicate-strict.
A present unreadable slot or directory inspection fault raises/retains the existing
recovery barrier; replay lowers it only with zero unreadable authority. Invalid
records are not pruned, and direct failed reads cannot become admission permission.
Strict block publication vetoes malformed/schema-invalid slots; an ENOENT after
listing is a concurrent deletion and is skipped in both inventory passes, not
raised as a recovery barrier. Read errors still throw and retain the barrier.
Directory enumeration after a successful open is inside that same error boundary.
After completed startup, any non-absence fault schedules the registered read-only
verification owner (1 s doubling to a 60 s ceiling). It also settles previously
submitted attempt-bound failed-state bookkeeping and directory acknowledgements,
but never repeats runtime hardware. If acknowledgement durably
removed the slot before its refresh failed, that owner reads the empty journal,
clears the obsolete stream/modem block and lowers the barrier automatically after
repair. It never replays rollback against an already-admitted runtime mutation.
Every reconciliation belongs to the process-local journal revision it read.
Cooperating commits and removals invalidate before/after their awaited lifetime;
read faults invalidate too. A writer in flight cannot prove settled authority.
Both empty and nonempty block publication recheck immediately before replacing
the projection. A revision change during inventory acquisition permits one fresh
inventory read, not an unbounded loop or a damage classification for deletion.
Acknowledgement/decommission/rebaseline recheck the global revision after their
entry read or hardware capture. An unrelated modem's commit or a read fault during
that await can return existing `not_blocked` while the requested entry is still
blocked, not just after its own authority was superseded. Replay rereads each slot and fences its
presence/rollback awaits before old authority can advance or retire that slot.
The owner rechecks after awaited verification, before completing
the barrier; startup uses the final strict publication's revision because replay
can itself change disk. Acknowledgement can overlap verification, but an older
presence census cannot republish its removed slot. A raise while pending is
remembered and vetoes that pass's completion. Invalidation retains the existing
single owner and capped backoff; no immediate-spin retry or second owner is added.
Benign concurrent leases can raise that barrier on a healthy device: a final
refresh during another modem's commit refuses publication, and Start answers
`recovery_pending` until a read-only pass succeeds after its first 1 s wait.
`archiveAcknowledged` can reject after durable removal if its refresh loses both
bounded acquisition fences; rejection does not undo removal, and the recovery
owner clears the obsolete projection after a complete pass.
The revision and trigger flag are not stored authority or a new wire field. After
a process restart the retained journal is inventoried again under the boot barrier.
Permanent enumeration faults keep admission closed with capped waits. Repair
storage; no operator clear API is added. FCC
opt-in also uses strict reads and enables no model on ambiguity, preserving bytes.
These are host boundary proofs, not board recovery qualification.

**On a dev host there is no `/data`.** `resolveJournalDir()` reads
`CERALIVE_MODEM_MUTATION_DIR` (the `CERALIVE_RUN_DIR` precedent) and otherwise
falls back to a cwd-relative directory in development/mock mode. A real device
sets no override and is not in development mode, so it gets the pin.

### The VERSIONED state machine

`mutation-journal-state.ts` is the machine as pure data — no I/O, no clock, no
device — so every legal and illegal transition is enumerable in a unit test, and
so the durability harness can inject faults around transitions without also faking
a state machine.

`armed -> executing -> completed | failed -> acknowledged` is the ordinary life.
The remaining three states exist because a physical device can LEAVE:

- **`device-absent-quarantine`** — the device is not present at replay or
  acknowledgement time. That identity stays mutation-blocked and its entry is
  RETAINED, so fail-closed handling resumes if it returns (return-of-device goes
  BACK to `failed`).
- **`decommissioned`** — the operator's journaled confirmation that it is gone.
  ONLY that physical identity stays mutation-blocked; GLOBAL streaming is
  unblocked, so a destroyed modem can never permanently strand the remaining
  links. It is deliberately NOT irrevocably terminal.
- **`recommission-pending`** — a device is present at a decommissioned identity.
  Identity is PORT-based for serial-less devices, so a REPLACEMENT modem in the
  same port inherits the key; mutations stay refused until an explicit operator
  REBASELINE captures, validates and journals the current device as the new
  baseline.

`blocksMutations` and `blocksStreaming` are DIFFERENT questions and the second is
a strict subset — that asymmetry is the whole decommission escape hatch. Blocking
is DERIVED from the state and published by `mutation-blocks.ts` alone; a second
source of "is this device blocked" is how a fail-closed guard drifts open.

### THE STARTUP REPLAY TABLE

| State | Replay action |
|---|---|
| `armed` | execute the rollback (restoring the pre-state is safe by construction — it had not been dispatched) |
| `executing` | execute the rollback |
| `completed` | prune |
| `failed` | remain blocked awaiting acknowledgement |
| `acknowledged` | resume the archive + unblock |
| `device-absent-quarantine` | re-check presence (present ⇒ `failed`; absent ⇒ remain) |
| `decommissioned` | re-check presence (present ⇒ `recommission-pending`; absent ⇒ no action) |
| `recommission-pending` | remain awaiting the rebaseline |

`mutation-replay.ts` is the table's executor. Replay lowers the barrier only after
complete readable authority and strict block publication; unknown/damaged journal
authority keeps it raised behind the cancellable retry owner. Failed rollback's
readable per-identity block is separate from an unreadable global inventory.
A lost replay fence or another thrown entry failure counts as incomplete in the
existing `unreadable` summary, never as an entry verdict. Even if final block
publication succeeds, startup schedules REPLAY and each invalidated retry retains
that mode, rather than verifying a stranded `executing` slot. Every retry rereads
the real slot and fences even an absent action read before skipping it. Retained
`executing` is the same interrupted mutation boot already handles. A fresh
already-restored capture avoids a second rollback effect; band and USB handlers
also have their own pre-state no-op guards. A same-entry operator acknowledgement
cannot be overwritten by a retry's old capture. Waits double to a 60 s cap and
shutdown cancels; infinite writer churn or permanent I/O can retain recovery
indefinitely, without spinning or unsafe timeout-open. When authority stabilizes,
the next complete pass clears the barrier without requiring a restart. This is
a cadence bound, not a bound on hardware I/O or total recovery duration.
Unlink failure is another incomplete pass: no restored/pruned count precedes
durable removal. Shutdown is checked after incomplete as well as successful
attempts; the default sleep resolves before creating a timer/listener when its
signal is already aborted, and removes its abort listener when the timer completes
as well as on abort. Already-submitted capture/hardware is not revoked.

### SAME-KEY JOURNAL EXCLUSION

Every cooperating operation that writes or removes a stable key's journal slot holds
that key's existing mutation lease (`activeMutations` in `lifecycle-admission.ts`)
for the write it authorizes, so a retirement can never outlive the authority it
validated. A revision check before an unlink, or a readback after it, cannot do this:
the pathname effect is awaited after the check.

- **Operator acknowledge/rebaseline/decommission** (`mutation-retirement-key.ts`) read
  eligibility first. A slot the action would refuse (armed/executing included) answers
  today's `not_blocked` without waiting. An eligible slot takes the key nonblocking
  (`tryAcquireModemJournalKey`, which bypasses recovery/published-block admission but
  never the same-key exclusion) and holds it through read, transition, unlink/rename,
  parent fsync and refresh, releasing in `finally`. If the key is held, it waits for
  that holder's release, then rereads from scratch. An eligible slot with the lease
  held is a mutation's journal-only tail (e.g. the arming-failure fallback refresh)
  OR another holder: a stale eligible read can wait while disk already holds a newer
  `executing` entry, and a nonjournaled network scan holds the lease without touching
  the slot. The loop rereads after every wake, so neither case is retired. Three
  acquisitions bound HANDOFFS, not elapsed time; exhaustion, or an abort of a signal
  observed during a wait, answers the existing `state_mismatch` (owner note: here it
  means "not retired under this observation", not a hardware disagreement). No wire or
  schema change.
- **Cancellation is not wired in production.** The handlers accept an optional signal
  and the procedures forward oRPC's `signal`, but the WebSocket adapter invokes
  `call(procedure, input, { context })` with none, and socket close only removes the
  client. The frontend's 30 s request timeout rejects locally and sends nothing. So a
  retirement waiting behind a holder is NOT cancelled by a disconnect or a client
  timeout: it proceeds and retires when the holder releases, and repeated retries can
  leave further pending requests behind the same holder. Even with a signal,
  `withRetirementKey` checks it only inside the release wait, not before a free-key
  acquisition nor after a wait resolves, so an already-aborted signal still acquires
  and retires. Do not describe a cancelled request as doing nothing.
- **Owner option, not planned.** The acknowledgement refusal enum
  (`modemMutationAckRefusalSchema`) has no `mutation_in_progress`; the ordinary
  `modemMutationRefusalSchema` does. Contention is therefore reported as the observed
  state (`not_blocked`, `state_mismatch`, `no_entry`), and only a NEW mutation is
  refused `mutation_in_progress`. An additive acknowledgement `mutation_in_progress`
  member is available if the owner wants a distinct busy reason. In this repository the
  same release's device UI is its only consumer. The enum is a `z.enum`, which rejects
  an unknown value rather than stripping it, so a consumer validating against an older
  schema would fail the parse.
- **Ordinary mutation admission** keeps its frozen refusal order. A retirement-held
  acknowledged slot refuses with `mutation_in_progress`; a quarantined slot keeps its
  published block (`mutation_blocked`) ahead of the lease.
- **Boot replay** holds no key during capture or rollback hardware (an operator may act
  meanwhile), but takes it nonblocking around each revision check plus the write it
  authorizes. A held key is an incomplete pass retried by the recovery owner.
- **Failed-transition settlement** takes the key nonblocking for read, revision check and
  commit; a held key keeps the bookkeeping retained and the pass incomplete.
- Directory-fsync debt deletes nothing and needs no key.
- A journal-only key holder (operator retirement, replay, settlement) is the same map
  entry for same-key exclusion but is excluded from the stream interlock count:
  acknowledging a modem never refuses Go Live, exactly as before this exclusion.

Lock order: key → reads/revision/effects/refresh → `finally` release. No key holder
waits on a barrier, recovery owner or another key; waiters hold no lease. A holder
that never releases (a never-settling filesystem, capture or presence await) keeps the
exclusion by design, and an operator retirement waiting behind it stays pending with
no production cancellation path. Cancelling a waiter must never release someone
else's lease, and admission never times out open. Other keys are independent.
Host-tested only.

### THE REPLAY BARRIER AT THE ADMISSION CHOKEPOINT

`modules/streaming/recovery-barrier.ts` is an AWAITABLE PROMISE, not a boolean,
and that is the point. The WS control server binds BEFORE subsystem
initialisation (`main.ts` — it is the operator's only lifeline), so an RPC can
arrive mid-replay. A boolean gives exactly one answer to that race, and refusing
is the WRONG answer for the two INTERNAL boot origins:

- stream restoration converts an unhandled refusal into a terminal `start_failed`
  and retires its one-shot marker (`stream-restoration.ts`), so a refusal does not
  defer the intent — it destroys it;
- boot autostart records a failed result with no retry at all (`autostart.ts`).

So `startStreamSession` gates EVERY origin with TWO semantics: `autostart` and
`restoration` AWAIT the promise; `ui`, `remote-control` and `set-profile` get the
typed `recovery_pending` refusal, which costs only a retry. Both internal sites
ALSO await at their own trigger — restoration before it READS its marker (not
merely before it launches), autostart as its first statement.

A modem whose failed rollback holds streaming is refused at the same chokepoint
with the `mutation_blocked` class. Both classes are non-retriable on every phase
and carry keyed operator copy in all 10 locales.

### ACKNOWLEDGEMENT SEMANTICS — acknowledging is NOT unblocking

A failed rollback means the modem's true state is UNKNOWN, so a bare alert-dismiss
must never clear it. `mutation-acknowledge.ts` offers exactly two typed paths, and
both END in a state the device has proven:

- **VERIFIED-ROLLBACK** — re-read the device and CONFIRM it equals the journaled
  pre-state. A mismatch REFUSES and the device stays blocked.
- **FORCE-REBASELINE** — the operator explicitly accepts the CURRENT hardware,
  which is captured, validated as coherent, and journaled as the new baseline.

Both write `acknowledged` durably FIRST and archive SECOND, so a crash between
those two writes is replayable rather than a lost operator decision. `ifname` is
excluded from the state comparison on purpose: a predictable name is derived from
a MAC this fleet has proven can collide, and it legitimately changes across a
re-enumeration that restored the correct mode.
Retirement failure returns existing `journal_write_failed`, retains the durable
decision and previous projection, and an explicit acknowledged/rebaseline retry
resumes removal without capturing a new baseline. A later independent publication
can project acknowledged as nonblocking under the existing state contract.
Decommission retains its slot and never calls removal. Confirmed journaled lease
work commits existing `completed` before retirement: a cleanup error returns a
typed refusal and releases the lease while confirmed authority remains nonblocking.
If an operation's failed-state fallback also cannot commit, its attempt-bound
transition stays owned by recovery. Settlement rereads/fences the current slot,
does not overwrite acknowledged/decommissioned/newer-attempt authority, and does
not repeat hardware. These queues are process-local; boot replay owns crash residue.

### LEASE LIFETIME spans the TRANSACTION, not the entrypoint call

`modem.reconfig` applies and then leaves a 30 s confirm/auto-revert watchdog live
AFTER the handler returns (`self-fencing.ts`). Releasing on return would leave a
stream admissible during exactly the window in which the modem is half-applied or
being rolled back — so the lease is stored on the pending entry and released on
confirm, on successful auto-revert (AFTER the revert runs — the rollback is itself
a mutation), or on a discarded/terminal failure.

The wire payload for `modem.reconfig` names no target device, so a payload without
one takes the SUBSYSTEM-WIDE holder; a payload that DOES name one is keyed on it,
and a named-but-unresolvable device is refused rather than silently widened.

### FAIL-CLOSED TERMINAL POLICY

A rollback that cannot complete keeps stream autostart AND new mutations for that
device BLOCKED until explicit operator acknowledgement — never a silent fail-open.
A kind with no registered rollback handler answers `unavailable`, which is
visible; it is never inferred as success.

Coverage: `tests/modem-mutation-state-machine.test.ts` (the FULL cross product of
states — every legal transition accepted and every remaining pair refused, plus
the blocking sets and the replay table), `tests/modem-mutation-durability.test.ts`
(the four injection points over a real temp dir, the step ORDER, the 0600 mode,
and the never-torn assertion), `tests/modem-mutation-replay.test.ts` (one test per
journal state, incl. the returning original modem AND a replacement in the same
port), `tests/modem-mutation-acknowledge.test.ts` (5a-5e: verified rollback,
mismatch, force-rebaseline, the crash between ack and archive, and every path that
must NOT unblock), `tests/modem-mutation-entrypoints.test.ts` (one enforcement test
per inventoried entrypoint plus its `identity_unresolved` branch, and the lease
lifetime across confirm/auto-revert), `tests/modem-mutation-admission.test.ts` (the
two refusal semantics and the delayed-replay proofs), and
`tests/modem-transition-engine.test.ts` (the REAL modem-stack transaction over mock
transport).

**Honest status:** none of this has been exercised against a real modem. Every
fixture models the contract; the board drill is a separate, still-owed step.
