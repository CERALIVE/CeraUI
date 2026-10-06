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

and a durable deletion is `unlink()` + `fsync(parent)`. `rename` over an existing
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

`mutation-replay.ts` is the table's executor and NEVER throws: a replay that
cannot complete still LOWERS the barrier, because a barrier nobody will lower is
worse than a device that honestly reports its blocks — the blocks are what keep it
safe.

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

