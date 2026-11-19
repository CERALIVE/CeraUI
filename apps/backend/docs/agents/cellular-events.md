# Cellular event history [EXISTS]

`src/modules/events/cellular-events.ts` subscribes once to `onModemsChange`
before the modem update loop starts. It reads the published cache snapshot and
keeps a value copy of the last observations by `stable_key`, using
`deriveModemStableKey` with the existing cached ID_PATH. An unresolved identity
emits nothing. Numeric modem ID changes preserve the baseline.

A new identity emits `modem_added`. Each field has its own unknown or known
baseline: a field's first available reading establishes that baseline and emits
nothing, even if the modem itself was already present. A missing identity emits
`modem_removed` with its last observed name and retires its field baselines.
Only changes between two known observations emit field events. Entering
`connected` emits `modem_connected`; leaving it emits `modem_disconnected`.
Missing, empty and `unknown` connection reads retain the previous observation.
Other connection states, signal, operator and roaming updates alone are silent.

Rejection has three states: unreadable, positively clear, or a known error token.
A missing status is unreadable and retains the previous rejection. A readable
status without a rejection token positively clears it. A new or changed token
after a known observation emits `modem_registration_rejected`; an identical
token returning after an unreadable status does not. A positive clear allows a
later rejection to emit again.

Known SIM changes emit `sim_inserted` or `sim_removed`; unknown and omitted reads
retain the previous value. The cache signature includes SIM presence so changes
reach subscribers without a status block. The entire next baseline is published
before emission, so a synchronous recording sink cannot replay old baselines.
Reentrant snapshots append to the same synchronous emission queue; facts from
the earlier snapshot finish before facts observed during their emission.
Each queued emission contains even an injected throwing emitter independently:
remaining emissions and cache subscribers continue. The drain always releases
its queue and in-progress flag in `finally`; a failed output is not retried and
does not roll back the committed field baselines.

Only explicitly selected event fields enter `emitEvent`. SIM identifiers,
phone numbers, APN and credentials are never copied into params. The shared
emitter owns validation, redaction, storage, journal output and coalescing:
several changes for one modem inside its 30 second window may be folded.
Stopping the subscriber detaches it; a subsequent start begins a fresh baseline.

Coverage: the cellular known-observation and observation-sequence tests record
producer calls without coalescing. The known-store and cellular-store tests
round-trip real storage; `modems-state-cache.test.ts` covers SIM-only delivery.
The matrices compose first readings, unknown gaps, positive rejection clearing,
independent modem identities, startup replay and synchronous reentry.
There is no new probe,
poll or timer. Hardware latency, CPU cost and journal volume remain unmeasured.
This subscriber observes the existing modem cache; D-Bus-only wire changes remain
subject to the existing legacy reconciliation cadence.
