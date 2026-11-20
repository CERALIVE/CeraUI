# Capture events [EXISTS]

`src/modules/streaming/lifecycle-indicators.ts` records active video and audio
loss from the existing streaming verdict. Event state is separate from the
notification state: only a positive observation of the same source ID in the
device set records video recovery. Empty scans, source selection changes and
repeated reports cannot manufacture a recovery or another uninterrupted loss.
Stopping a stream clears event state without claiming recovery. Video events
omit the optional name because this boundary has device IDs rather than
operator names.

`src/modules/streaming/capture-resilience.ts` records input loss and return at
the existing backup-loss decision and positive `live_inputs` observations.
It retains the product name shown at loss until that same input is live again.
Replacing a per-input notice with standby, a missing catalog or a partial
status frame leaves the loss unresolved and deduplicated. Device paths,
persisted IDs and serials never enter event params.
The registry's `activeCamera` field is a boolean:
loss notices concern a backup camera, while return events state whether that
camera is now the active input. Notification params retain their existing
active camera display name.

Standby entry and exit use the existing standby timestamp and clock to record
elapsed seconds, clamped to zero after clock changes or a future timestamp.
Partial capture frames do not imply recovery. Stream-stop cleanup emits no
input-return or standby-exit event. No probe, timer, capture identity, black
standby action or rejoin behavior is added or changed.

Both producers resolve `emitEvent` through their existing dependency seams;
omitting that dependency uses the real emitter. Its subject coalescing still
applies: a quick recovery is delivered by the trailing record. Tests in
`src/tests/events-capture-emits.test.ts` cover producer edges and this wiring.
`src/tests/events-capture-transitions.test.ts` composes standby, catalog loss,
empty scans, source switching and flapping through recording and real stores.
Board latency, CPU cost and physical camera rejoin remain unmeasured.
