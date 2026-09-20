# Composition lifecycle repair [PARTIAL — candidate verified, unreleased]

## Release preparation

CeraUI 2026.9.2 includes merged PRs #362 (composition/lifecycle) and #363
(child-owned E2E backend readiness). The companion binary is released as
cerastream 2026.9.5; its npm binding version remains independently numbered.
The receipts below describe candidates, not qualification of the released
CeraUI package. That package still needs live-disable, kill/restart and
fractional-input allocation checks through CeraUI's real product path.

## Live disable

`streaming.setConfig({composition:null, apply_now:true})` formerly wrote config
and returned without dispatch: composition was absent from `APPLY_NOW_FIELDS`.
The field now joins the existing staged transaction. Null is retained through
the delta and clears persisted composition only after an `applied` result;
refusal/rollback leaves the previous value. Without `apply_now`, save-only
semantics are unchanged.

The producer correction merged in cerastream #170 before publication of
**`@ceralive/cerastream@2026.9.8`**, registry `gitHead`
`fcb9737d95160fcc96a7fbc638ea5bfd5a23c053`. Both backend and shared RPC consumers
now pin published 2026.9.10/schema 0.20.0, retaining that correction; its publication
receipt is in [raw capture classification](RAW-CAPTURE-CLASSIFICATION.md).
A clean 2026.9.8 registry install compiled an imported
`ChangeConfigParams` with `composition: null` and preserved null/object/omitted
values through the exported schema. The committed binding-contract regression
fails against the former 2026.9.6 pin and passes against 2026.9.8.

The hardware-verified adapter's narrow raw-request path is unchanged, with
producer-owned ordinary params and result validation. No local wire-shape
declaration, package link or vendored tarball is introduced. The npm release
ships the control contract, not the Rust engine binary; engine delivery remains
separate from this consumer merge.
An older engine rejects null before changing its graph; the existing transaction
classification reports that rejection rather than echoing a completed clear.

A crash marker cannot infer composition from encode dimensions. A non-empty
engine switch roster positively proves a clear; a silent or empty roster cannot
distinguish composition, passthrough and an unknown graph, so reconciliation
defers. Object-valued composition changes likewise remain deferred when the
engine cannot report their complete settings. Idle retains the previous config.

## Engine death

The original failure is a chain, not a slow systemd restart:

1. The session poll proves the control connection dead and retires that client.
2. The independent stop dial fails while systemd is still restarting the engine.
3. The adapter logged the failure but never called `onStopped`; `stopGeneration`
   remained pending, including sender/listener cleanup.
4. The outer 12-second deadline entered `stop_failed`, retaining streaming status.
5. Restoration queried engine idle directly, without reconciling the orchestrator.
   It therefore kept seeing a busy lifecycle and eventually gave up.

`stop` now has an optional failure callback. Both outcomes clean up local
resources; only acknowledged success publishes idle. The error reaches the
orchestrator immediately instead of waiting for its safety deadline. Restoration
uses `reconcileStreamSession`, which adopts authoritative idle before admission
and preserves unknown/in-flight states. It remains one-shot, with no new retry
or widened deadline.

The restoration snapshot intentionally has no composition. Its merge with
persisted config previously reintroduced that omitted value. The launch merge
now preserves the snapshot's absence, returning to switching without changing
ordinary starts. A successful recovery also retracts an earlier persistent
`stream_recovery_failed` band.

## Verification

Failing-first and mutation-proven regressions:
`composition-live-disable.test.ts`, `cerastream-stop-ack.test.ts`,
`engine-loss-lifecycle.test.ts`, and the restoration/ordinary-start controls in
`preview-config-replay.test.ts`. They exercise the actual procedure, bridge,
adapter, session cleanup and production restoration reconciliation. Removing
dispatch, failure completion, reconciliation, snapshot scoping or notification
retraction independently causes an assertion failure.

OPi baseline: librga R1 `1.10.5+ceralive.1` ELF
`07b6b6c466c6bddbcf7006e5b678d68de372b44686e6eb8ea3fcf00ce1cb6b74`,
plugin `1.14.4+ceralive.6`, engine `2026.9.4`, installed CeraUI
`2026.9.1-20260906T194131.f3c52d5`. Both failures reproduced before edits.
No package installation, reboot or slot write was used.

Final functional candidate: CeraUI ELF
`95fb43788c9a04364e67510db0eba24cc876d8b743341dba4c9390624f80f0ff`,
engine ELF `a00566a5c10a51ce03f56d6f8cc8e483307da00c28dbc0dd837fe4d33b4a0a5c`;
released plugin/librga, kernel `7.2.0-ceralive-rk3588` and libmpp `1.5.0-1`
unchanged. The engine additionally fixes a pre-videorate allocation-cadence
refusal that blocked the ordinary switching graph after the lifecycle repair.

- **Live disable PASS:** 07:06:07.646→07:06:09.645 UTC, `applied`, independently
  decoded inset present before and absent after, populated capture/synthetic
  switch roster. An ordinary switching start supplies a separate positive control.
- **Kill/recovery PASS:** SIGKILL at 07:10:28, systemd `NRestarts` 0→1,
  one restoration completed at 07:10:40.230 with runner elapsed 11.590 seconds.
  The engine reports switching targets and independent decode shows primary-only
  output. Browser reports LIVE / Healthy. A subsequent start completed normally
  at 07:12:40.508, not `START_IN_PROGRESS`.
- **Notification caveat:** an earlier failed candidate's persistent recovery
  band remained beside that healthy browser state. Its retraction fix and final
  stop-log wording correction are host-tested additions after the above binary;
  neither is misrepresented as present in its hardware receipt.

Initial candidate failures and harness errors are retained in private bundle
**opi-lifecycle-20260917**, not discarded. No new video-rate claim uses
`frames_emitted`. Installed hashes, config and engine state were restored;
browser idle, B booted/good, A good, budgets 3/3. No release, pin bump, merge
or plan-checkbox change is implied.
