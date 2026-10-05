<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## BOOT FAIL-SOFT [EXISTS]

`main.ts` is a top-level-`await` module. S6 hardened its boot chain so a failed
init can no longer brick the device in the field. Two helpers classify every
awaited init (`helpers/boot-guard.ts`):

- **`runCritical(name, fn)`** — config load, WS-control-server bind, then systemd
  readiness notification (production notify services only). A failure is
  logged loudly and re-thrown so the process aborts (systemd restarts cleanly).
  The WS control server is bound **before** any non-critical init — it is the
  operator's only lifeline, so it must come up even when identity, the cloud
  channel, or the engine never do (and even if a non-critical init *hangs*).
- **`guardNonCritical(name, fn)`** — identity, control-channel, pipelines, RTMP
  ingest. A throw/rejection is logged, flags the subsystem on the boot-readiness
  surface (`markBootDegraded`, `modules/system/readiness.ts`), and is swallowed so
  boot continues in a readiness-reduced (degraded-but-up) state.

The degraded flag is surfaced read-only on the local `/api/health` endpoint
(`getLocalObservability().readiness = { degraded, degradedSubsystems }`) — no
remote egress. Contract coverage: `src/main.test.ts`. Do NOT move a non-critical
init ahead of the critical WS-server bind, and do NOT downgrade the config /
WS-bind classifications to fail-soft.

