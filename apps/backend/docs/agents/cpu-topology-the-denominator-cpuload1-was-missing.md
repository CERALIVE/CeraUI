<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CPU TOPOLOGY — THE DENOMINATOR `cpuLoad1` WAS MISSING [EXISTS]

`modules/system/cpu.ts` publishes a `cpu` event carrying `{ cores: number | null }`
— the online CPU count, `nproc`-equivalent, read from `os.cpus().length` through
an injected `CpuDeps.cpuCount` seam.

It exists because a 1-minute load average is a count of RUNNABLE TASKS, so it says
nothing on its own. On an 8-core RK3588 a reported `1.00` is roughly an eighth of
the board, but it reads as saturation to an operator who does not already know the
core count — reported live while a single software (non-accelerated) encode pegged
one core.

- **ITS OWN BROADCAST, not a sixth `device-stats` field.** That payload is frozen
  by the S1 lock and THREE tests assert its keys EXACTLY, so this follows the
  precedent `encoder-load` and `fan` already set. It is likewise not foldable into
  `sensors`, a flat `Record<string, string>` of display strings.
- **A BOOT FACT, not a sample.** Core count cannot change without a reboot on this
  hardware, so it is resolved ONCE in `initCpu()` and re-served from the post-auth
  initial-state push (`sendInitialStatus`) — the same treatment `revisions.kernel`
  gets, for the same reason. There is deliberately no polling loop and no coalesce
  entry.
- **NOT `isRealDevice()`-gated**, unlike `fan`/`encoder-load`. Those read
  board-specific sysfs nodes a dev host genuinely does not have; every host has
  CPUs, so gating this one would leave the dev and CI paths rendering the bare load
  average the signal exists to replace. For the same reason it needs no mock
  provider — the real reader already works everywhere.
- **NEVER ASSUMED.** A count that is not a positive integer — a throwing reader, a
  zero-length list, a non-integral value — degrades to `cores: null`, and the UI
  then falls back to the raw load average. Substituting a plausible count would
  fabricate the very denominator the signal exists to supply, which is the same
  class of lie as rendering a busy/idle encoder core as a percentage. Do NOT
  hardcode 8, and do NOT derive it from the board kind.

Frontend half: `apps/frontend/AGENTS.md` → "CPU load is a SHARE OF CAPACITY".
Coverage: `tests/cpu.test.ts` (the read, every unusable-count degradation, the
never-throws contract, and a no-seam case proving the shipped wiring resolves a
real count rather than only the injected double).

