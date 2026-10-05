<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE DEGRADED-SELECTED CAPTURE SNAPSHOT [EXISTS]

`capture_degraded` is NOT a wire event — `grep capture_degraded` across the
published `@ceralive/cerastream` bindings returns nothing. cerastream reports it as
the EXISTING `capture_video_error` runtime error additionally carrying
`selected: true`. That pair IS the signal, and no other code may raise it.

`modules/streaming/capture-degraded.ts` holds it as a persistent SNAPSHOT rather
than a one-shot notification, because CeraUI otherwise maps engine errors only onto
notifications and a client that connects afterwards never sees them — a backend
restart or a frontend reconnect must not lose the state. It rides the `sources`
payload: `degraded` on the row it is about, plus `degradedSelected` mirrored at the
top level so the state survives the row (a device that degrades and is THEN
unplugged has no row left to hang it on). The row is matched by stable identity
first — the snapshot is taken at stream start and a libuvc camera renumbers on the
very next release.

**It inherits `ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION`'s retraction and has NO
clearing path of its own.** `clearSelectedCaptureDegraded()` is called from
`clearRecoveredEngineError()` and nowhere else; `stop()` was added as a third call
site of that SAME seam (it already treats a stop as a session boundary for
`active_encode`). Three boundaries clear it: a concordant `streaming` status frame
(rejoin), an operator stop, and a new session start.

**It is dropped AHEAD of the standing-error gate, and that ordering is
load-bearing.** `resolved.channel` is ONE notification slot shared by every
non-srtla engine error, so `capture_video_error{selected}` → `srt_connection_lost`
→ healthy session would return EARLY (the srt code is not in the membership table)
and latch a capture claim the boundary disproved. The notification stays behind the
gate, unchanged.

**The re-publisher lives in `capture-degraded.ts`, not in the backend that raises
it.** `cerastream-backend.ts` is pinned by a regression test to never name
`./sources.ts` — the start choke point stays isolated from the source builder — and
the import is dynamic because `sources.ts` imports this module statically.

Coverage: `tests/one-row-per-camera.test.ts`.

