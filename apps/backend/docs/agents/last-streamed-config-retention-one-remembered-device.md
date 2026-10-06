<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## LAST-STREAMED-CONFIG RETENTION — ONE REMEMBERED DEVICE [EXISTS]

An absent capture device is worth an unavailable `lost` row only if somebody
wants it back. The retired rule inferred that from ENUMERATION: every device the
process had ever seen became a lost candidate, uncapped, for the whole backend
lifetime. So a colleague's webcam plugged in once, or a dongle moved to another
machine, left a permanent unusable row in the operator's picker with no way to
clear it short of a restart.

**Exactly ONE device is remembered: the one an outcome-gated start last committed
to.** Going live with a device is the evidence that was missing; merely seeing it
is not. Everything else leaves the list the moment it is live-absent — its
`last_seen_devices` entry stays, invisible, because identity migration still needs
it.

- **`config.last_streamed_source` (+ `_stable_id`) is the slot**, and it is
  DELIBERATELY DISTINCT from `config.source`. A save-only edit moves the
  operator's selection freely and must not move the slot; a restart restores the
  row from the slot, never from the selection.
- **`noteStreamedSourceCommitted()` (`sources.ts`) is the only writer.** It is
  idempotent — a start landing on the SAME source writes nothing at all, which is
  what keeps an automatic restoration of an interrupted session from disturbing
  it — and it resolves the persisted id through `resolveSourceIdentity` first, so
  the slot names the hardware that actually went live rather than a node path the
  device has since left behind.
- **The commit signal is the ORCHESTRATOR's `transition("streaming")`, not
  `PLAYING`.** `onStreamCommitted` fires only after `runStartWithRetry` resolves,
  i.e. downstream of the `playing-wait` phase, which is satisfied by a direct
  `state:"streaming"` reply or a concordant `state:"streaming"` + `streaming:true`
  heartbeat. A graph reaching PLAYING says a pipeline was built, not that it
  delivered — moving the slot there would move it for attempts that then fail.
  `reconcile()` deliberately does NOT fire it: adopting a session the engine was
  already running is not a new commitment.
- **It is wired as a LAZY `import()`.** `stream-session-orchestrator.ts` is
  already reachable from the source graph, so a static edge back into
  `sources.ts` reorders module initialisation and leaves the boot-time source
  build reading a half-initialised module — observed as an EMPTY device list at
  boot, i.e. every capture row silently missing. Same hazard, same fix, as the
  engine-audio-change handler in `sources.ts`.
- **A non-camera source SUPERSEDES by taking the slot EMPTY.** A coarse, virtual
  or network source has no `resolveSelectionAnchor` identity, so nothing resolves
  to a remembered snapshot and the previously-held camera stops being remembered.
  Superseding and clearing are one operation; there is no separate clear path.
- **PRESENCE ALWAYS BEATS RETENTION.** The lost loop is unchanged: a remembered
  device that is live by node path or by stable identity renders as a normal
  selectable row. A device unplugged for two seconds and back is never
  unpickable — it is simply absent from the list while it is absent from the
  hardware.
- **`mergeLastSeenLru` retains TWO ids, not one.** `config.source` was always
  exempt from eviction; `config.last_streamed_source` now is too, because its
  snapshot IS the lost row. The two are usually the same id and come apart on a
  save-only edit — without the second exemption a dozen devices of churn could
  evict the very snapshot the slot points at. The LRU cap (12) and the
  `previousIds` cap (8) are untouched.
- **The session-seen snapshot map is no longer a lost-row source.** It survives as
  the process's own observation record (it is what proves a renumbering camera
  folded onto ONE identity instead of accumulating a row per node path) and as
  `resetEngineDeviceCache()`'s test-isolation surface. Nothing renders from it.

Coverage: `tests/lost-device-retention.test.ts` — one dedicated test per row of
the policy's state-transition table (save-only, failed gate, committed start,
non-camera supersede, stop, renumber, restoration re-commit, replug, restart)
plus the blip negative control and both LRU exemptions. Frontend half:
`apps/frontend/tests/e2e/lost-device.spec.ts` (a source must be STREAMED before
it can be lost).

