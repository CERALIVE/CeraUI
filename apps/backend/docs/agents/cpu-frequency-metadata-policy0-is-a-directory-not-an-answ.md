<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CPU-FREQUENCY METADATA — `policy0` IS A DIRECTORY, NOT AN ANSWER [EXISTS]

`modules/system/collectors/cpufreq.ts` emitted `{id, curKhz, maxKhz}` and nothing
else, so the Settings panel showed `policy0` / `policy4` / `policy6` and no
governor at all. Neither was a data bug: the collector deliberately emits the
kernel's own directory name (a policy is NOT a cluster — see the module header),
and `scaling_governor` was never read. What was missing is that the kernel was
already answering three more questions in the same tree.

- **`related_cpus` → `cpus` + `cpuCount`.** Compacted to the kernel's own range
  notation (`"0-3"`), so the row can say WHICH cores it governs — which is also
  the only thing separating RK3588's two identically-clocked A76 policies.
- **`scaling_governor` → `governor`.** Guarded by a name shape, so a truncated or
  binary read is dropped rather than shown to an operator as a token.
- **`/proc/cpuinfo` → `label`.** THE ONE FIELD THAT COULD BE FABRICATED, and
  therefore the one with the strictest rule. An ARM core is named ONLY from
  `ARM_CPU_PARTS`, a table of MIDR part numbers that have been checked
  (`0xd05` → Cortex-A55, `0xd0b` → Cortex-A76), and ONLY when `CPU implementer`
  is ARM Ltd (`0x41`) — a vendor-implemented core may reuse a part number, and
  printing "Cortex-A55" over somebody else's silicon is worse than printing
  nothing. Every CPU of the policy must resolve to the SAME label; one silent CPU
  or two disagreeing ones yield nothing. On x86 it is the shared `model name`.
  Extending the table requires a verified part number, never a plausible guess.

**All three are ADDITIVE and INDEPENDENTLY optional, under the UNCHANGED
per-policy omission contract.** A policy is still emitted only when BOTH
frequencies parsed; each new node omits its own field on a read failure and
changes nothing else. A device that publishes none of them emits the
byte-identical three-field row — pinned by a `toEqual` plus an explicit key-set
assertion, so an accidental `cpuCount: 0` or `label: ""` fails rather than ships.
The five-signal S1 lock is untouched: this rides the existing optional `cpuFreq`
field.

**GOVERNOR CONTEXT, board-proven.** The fleet runs `performance` BY DESIGN via
the first-party `ceralive-cpu-governor.service` (encode-latency rationale
documented in the unit; overridable via `CERALIVE_CPU_GOVERNOR`), so `cur == max`
at idle on the big cores is the EXPECTED reading rather than a stuck clock. The
governor is REPORTED and never written — there is no governor control anywhere in
this backend, and adding one is a separate owner decision.

`/proc/cpuinfo` is read ONCE per tick, and only when at least one policy
enumerated. The dev provider serializes it back from the fixture through
`ARM_PART_FOR_LABEL`, so the mock states the LABEL and the REAL collector still
does the naming — a provider that echoed the label would prove nothing about the
derivation.

Frontend half: `apps/frontend/AGENTS.md` → "A cpufreq policy is rendered as the
thing it governs". Coverage: `tests/collectors-cpufreq.test.ts` — the RK3588
3-cluster fixture, the 12-thread x86 fixture, the metadata-absent byte-compat
lock, and the five non-fabrication legs (unknown part, non-ARM implementer,
disagreeing CPUs, a CPU `/proc/cpuinfo` never mentioned, an unparseable
`related_cpus`), all driven against a REAL fixture tree on disk.

