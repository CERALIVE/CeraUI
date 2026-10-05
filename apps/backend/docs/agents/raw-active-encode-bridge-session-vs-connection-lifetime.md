<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## RAW `active_encode` BRIDGE — SESSION vs CONNECTION LIFETIME [EXISTS]

`modules/streaming/active-passthrough.ts` holds its OWN persistent control-socket
connection, separate from the streaming session's, purely to read the raw
`active_encode` fields the published `@ceralive/cerastream` client Zod-strips
(`passthrough`, `frames_emitted`, `pipeline_playing`). Both caches it keeps
describe the SESSION — what the engine is encoding — not that socket.

**Those are different lifetimes, and conflating them made health lie.** The
bridge's `close`/`error` fire on any transient reconnect (engine restart, socket
hiccup, a read that outlived its window) — none of which says anything about
whether video is flowing. Clearing `cachedLiveness` there erased a REAL,
correctly-stalled frame counter, and `collectRealLiveness()` (`health.ts`) read
the resulting `undefined` as the genuine COLD-START case and fell back to
`processAlive` — which only reports that the supervised OS process has not
crashed. Confirmed live during a Wave H HDMI mid-stream unplug drill: health
reported the frozen counter as `degraded` for several seconds, then flipped to
`state: "healthy"`, `frames: {advancing: true, count: null}` the instant the
bridge reconnected — while a local SRT receiver had already errored out
(`Error during demuxing: Input/output error`) and the kernel reported
`power_present: 0`. The wipe also BYPASSED `FRAMES_FRESHNESS_MS`, the mechanism
that exists precisely to age a stale reading into `advancing: false`.

The caches are therefore cleared at SESSION boundaries only, and there are
exactly three:

| Seam | Why it is a boundary |
|------|----------------------|
| `readStreamingFalse(msg)` in `onLine` | an engine-AUTHORED status event saying the session ended — ground truth, clears immediately |
| `startStream()` (beside `clearStreamProcessExit()`) | a new session must not inherit the previous one's counter; the bridge holds its connection across a stop/start, so nothing else retires it |
| `stopActivePassthroughBridge()` | process teardown — nothing left to describe |

A dropped socket is NOT one of them. The retained reading ages out on its own:
`lastStatusAtMs` stops advancing and `health.ts`'s freshness window turns it into
`advancing: false` (degraded) — the honest verdict, and the one the wipe was
preventing from ever running. `cachedPassthrough` follows the same rule for the
same reason (a blip used to drop the "Passthrough active" state mid-session);
it is overlaid onto `active_encode` only when the engine telemetry already
carries one, so a retained value can never outlive a stopped session on the wire.

The cold-start fallback itself is CORRECT and must not be "fixed": on a stream's
very first heartbeat window no frame telemetry exists to judge advancement, so
raw process liveness is the only honest signal available.

Coverage: `tests/liveness-bridge-reconnect.test.ts` (the blip drives the real
`close`/`error` handlers over an injected socket; the engine-authored stop, the
fresh-start reset, and both cold-start cases are the controls).

