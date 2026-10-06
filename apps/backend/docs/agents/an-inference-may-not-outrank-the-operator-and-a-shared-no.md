<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AN INFERENCE MAY NOT OUTRANK THE OPERATOR, AND A SHARED NODE PATH NAMES NOBODY [EXISTS]

`reconcileConfiguredSourceIdentity` self-heals a persisted `config.source` across
a re-enumeration, and it is right to. But it is an INFERENCE about hardware
written into the same field an operator writes their INTENT into, and it had no
rule for what happens when the two disagree. Both failure directions were
confirmed on a board (192.168.78.131).

**A stale engine view may not overwrite a newer operator write.** The reconciler
decides against `getSourcesMessage()`, built from the engine-device cache that
`tryRefreshEngineDeviceCache` deliberately RETAINS across a failed fetch. During a
~5 minute cerastream outage every `list-devices` timed out, so the cache was
minutes old — and it still authorized a config MUTATION 7 ms after an operator
`setConfig({source})` saved a different, correct id:

```
20:05:47.125 debug sources: engine device fetch failed; retaining last-known device cache
20:05:47.132 info  sources: configured source re-enumerated under a new node path
                         — migrated by stable identity {"from":"/dev/video0","to":"/dev/video3"}
```

Retain-on-failure is the right contract for a device LIST and the wrong one for a
config write: "this device is no longer live", drawn from a view known not to have
been refreshed, is not a verdict. The fix is a compare-and-set on a monotonic
**selection token** (`sources.ts`, "Selection write token"):

- `noteSourceSelectionWrite()` advances `sourceSelectionToken` at every site that
  persists a STATED selection — `streaming.setConfig`, the `start` path's
  `updateConfig` (`streaming.ts`), and the durable live `switchInput` follow. Miss
  one and the reconciler can still overrule that selection.
- `engineViewSelectionToken` records the token as it stood when the evidence
  behind the current view was **REQUESTED**. It is captured inside
  `probeEngineDevices` BEFORE the round-trip and carried on the probe to
  `commitEngineDevices` — not sampled at commit — so a probe already in flight
  when the operator saved cannot authorize a migration either.
- The reconciler writes only while the two are equal.

The reconciler's OWN write deliberately does not advance the token (it would
refuse itself forever), and a failing probe commits nothing — so the stamp simply
stops advancing and the reconciler stands down until the engine answers again.
That IS the engine-freshness gate this defect needed, with no wall-clock bound to
tune and no permanent suppression: the next answered probe re-authorizes it, and
a migration still true then still fires.

**A node path several devices answer to identifies none of them.**
`findRememberingId` breaks that tie by PREFERENCE — whoever holds the path
outright beats whoever merely retired it — which is correct for choosing a lost
row and wrong for deciding what hardware a saved selection means. The board's own
`last_seen_devices` had FOUR entries answering to `/dev/video3` (the HDMI-RX and
the Osmo both remembering it as a retired alias, plus a pre-`stableId` snapshot
holding it outright), so the preference alone decided which camera the operator
had picked. `resolveSourceIdentity` now resolves through `unambiguousStableId`,
which requires the claimants of a path to fold to exactly ONE identity key.

- **Duplicate SNAPSHOTS are not ambiguity** — they share an identity key, so a
  `config.json` predating the identity fold still migrates and still self-heals.
- **It is suppression-only.** A refusal leaves the literal id standing, which the
  engine then answers about honestly (`resolveSourceRouting` fails closed;
  `resolvePreviewStartFrame` passes it through to the engine's typed
  `source-unavailable`). It never adopts anything new.
- `findRememberingId` is UNCHANGED and still owns `collectLostCandidates` — the
  two rules answer different questions and must not be merged.

Board proof (same board, same drill, before/after the fix): an ambiguous path
(`/dev/video9`, claimed by the HDMI-RX AND the Osmo) was silently re-pointed to
`/dev/video0` and persisted by the pre-fix binary, and left byte-identical by the
fixed one; an UNAMBIGUOUS retired alias (`/dev/video8`, one claimant) still
migrated to its live successor, so genuine renumber is unweakened. An operator
save during a real engine outage then survived 45 s of reconcile ticks AND the
engine's return with `config.json` byte-identical.

Coverage: `tests/source-selection-stale-cache.test.ts` (the F10a repro driving the
REAL `setConfig` procedure against a pre-save engine view, the re-authorization
control, the post-save genuine-renumber control, and the F10b claimant table).

