<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEVICE TRUTH IS ENFORCED AT THE SAVE PATH, NOT THE DIALOG [EXISTS]

cerastream ADR-0008 §10 settles the contract: a device's per-`media_type` mode
ladder is the ONLY truth, the engine reports it VERBATIM, and "the UI and the save
path may never invent or union". The frontend already honoured it for what it
OFFERS; nothing honoured it for what gets PERSISTED, so a 1080p60 written against a
device whose H.264 ladder tops out at 30 survived on disk, was re-sent on every
start, and failed `not-negotiated` every time with no operator-visible reason.

**The rule lives ONCE, in `@ceraui/rpc` (`capabilities/device-mode-truth.ts`)** —
`evaluateDeviceMode` / `nearestDeliverableMode`, shared verbatim with the frontend
`ValidationAdapter`. An offering the save path would reject is a lie told to the
operator; a save the offering would have disabled is a bypass. Two implementations
of one rule drift, and the #244 defect was exactly that class one layer up. Do NOT
fork a second copy.

**`modules/streaming/device-mode-guard.ts`** is the backend binding of that rule:
it resolves WHICH ladder governs (through `resolveSourceIdentity`, so a persisted
id that went stale across a replug still finds its device) and hands it to the
shared evaluator.

- **SAVE-TIME (`verifySaveDeviceMode`)** — called from `streaming.setConfig`
  (`rpc/procedures/streaming.procedure.ts`) and returning the typed
  `device_mode_unsupported`. Three orderings are load-bearing: it runs BEFORE the
  first config mutation (a refusal leaves disk byte-identical); both axes resolve
  `input.X ?? config.X`, because a half-save is still a full pairing against the
  hardware; and the source checked is the one being SAVED, since validating the
  persisted one waves through exactly the ladder switch that makes the combo
  illegal. It lives at the PROCEDURE, not the dialog, so a direct RPC call is
  covered too.
- **LOAD-TIME (`modules/streaming/persisted-mode-clamp.ts`)** — for the fleet that
  already has a bad pairing on disk. There is no "config load" moment at which this
  can run: `loadConfig()` is at boot, long before `list-devices` answers, and only
  the ladder can judge the pairing. The first moment it is known is the first
  `sources` build, so `reconcilePersistedDeviceMode` hangs off `broadcastSources`
  beside `reconcileConfiguredSourceIdentity`. The clamp is DOWNWARD-biased —
  clamping up would hand the operator a mode they never chose — and both axes come
  from ONE real enumerated mode, so the result is never a synthesised pairing. It
  reports once via the keyed `notifications.encoderModeClamped`.

**Fail-open is deliberate and load-bearing.** A source with no reported ladder, a
coarse/virtual/network source, and an un-normalizable payload all PASS. Refusing on
an unknown would block a save the hardware can honour — the same dishonesty in the
other direction. Do not "harden" these into refusals.

**The rejection is rendered, never swallowed.** `setConfig` RESOLVES with
`{success:false}` rather than throwing, so a caller that only try/catches reports a
refusal as "Saved". Both save paths read the flag and route the reason through
`lib/streaming/encoderSaveError.ts` (`apps/frontend`). The dialog itself is
unchanged: options are still rendered DISABLED WITH A REASON, never hidden.

Coverage: `tests/capability-truth-save.test.ts` (the per-`media_type` rejection
table driven through the REAL procedure, the persistence-untouched guarantee, and
the fail-open negatives) + `tests/capability-truth-clamp.test.ts` (the Osmo
1080p60-on-H.264 migration, the one-time notification, and the never-clamp cases).

## …AND AN OVERRIDE THE PIPELINE CANNOT HONOR IS RESIDUE, NOT INTENT [EXISTS]

The section above is about an override the DEVICE cannot deliver. This is the
adjacent case — an override the PIPELINE has no use for at all — and the two
resolve in opposite directions on purpose.

`intersectCaps` collapses a non-override source's offering to its own
`default_resolution`/`default_framerate`, so the Encoder dialog never renders the
axis for an rtmp/srt ingest row: the geometry is whatever the publisher sends. A
`resolution`/`framerate` sitting on such a config is therefore always RESIDUE from
a previous source, and the wire cannot say otherwise — a start carries the WHOLE
persisted config, so an echoed value and a typed one are the same bytes.

Board-measured on a Rock 5B+ (2026-08-30). A `config.json` holding `720p`/`30` from
an earlier HDMI session, with the RTMP row selected, failed EVERY start:

```
PipelineOverrideError: Pipeline does not support resolution override
start_invalid  phase=params  retry=not_retriable
```

The operator could not clear it from anywhere — the axis is not on their source
row — so the device was unstreamable until the config was hand-edited over SSH.

`unsupportedPipelineOverrides` (`@ceraui/rpc` `capabilities/pipeline-override-truth.ts`)
is the shared rule, in `@ceraui/rpc` for the reason `device-mode-truth.ts` is: a
start that dies on a field the save path was happy to persist is the same
offering-vs-save disagreement one layer down. Two seams consume it:

- **The START drops it** (`streaming.ts` `validateConfig`, which no longer calls
  `validatePipelineOverrides`) and warns. This is the operator-visible half.
- **The SAVE clears it from disk** (`streaming.procedure.ts`, beside the existing
  merge) so the config self-heals on the next write of any kind — including the
  source switch that created the residue.

**An EXPLICIT override for such a pipeline is still REFUSED, unchanged.** That is
an operator action and answering it is the point; only the carried-forward value
is cleared, decided by whether `input` mentions the field. Do not "unify" the two
adjacent blocks in `setConfig` — they look contradictory and are not.

The per-axis scoping is load-bearing: each field is judged against its OWN support
flag, so a pipeline that refuses a resolution override while accepting a framerate
one drops exactly one of them.

Coverage: `packages/rpc/src/capabilities/pipeline-override-truth.test.ts` (the pure
rule, incl. the absent-override and per-axis cases) +
`tests/pipeline-override-residue.test.ts` (both seams driven through the REAL
`validateConfig` and the REAL `setConfig` procedure, the board's own config shape,
the honors-the-axes negatives, and the still-refused explicit write) +
`tests/pipeline-validation.test.ts` (the start path's per-axis drop; its
resolution-refusal case was INVERTED by this change and says so).

