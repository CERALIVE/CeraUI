<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DEVICE STATS [EXISTS]

The browser's authenticated initial push includes the latest completed
`device-stats` sample, retained before broadcast in `device-stats-snapshot.ts`.
It does not depend on catching the next periodic tick. Samples replace whole;
an unavailable optional signal never inherits an older value, and an unsampled
backend invents no reading. This hydration boundary is independent of systemd
readiness; see [`docs/BOOT-READINESS.md`](../BOOT-READINESS.md).

`apps/backend/src/modules/system/device-stats.ts` broadcasts the original **5
signals** on a `device-stats` event every 5 seconds (S1 lock), plus **four
additive-optional signals** shipped on top of that lock: `memory`, `cpuFreq`,
`ddr`, and `gpu`.

| Signal | Description |
|--------|-------------|
| `disk` | Used/total bytes on `/data` + media type (SSD/HDD/eMMC/unknown) |
| `cpuLoad1` | 1-minute load average |
| `socTemp` | SoC temperature (wired from `sensors.ts` — no second `/sys/class/thermal` read) |
| `ifaceRxTx` | Per-interface RX/TX byte counters |
| `raucSlot` | Active RAUC A/B slot |
| `memory` (optional) | Parsed `/proc/meminfo` fields (`memTotalBytes`, etc.) — a genuinely-read `0` is kept; an unreadable source omits the keys |
| `cpuFreq` (optional) | Array of `{id, curKhz, maxKhz}` per `/sys/devices/system/cpu/cpufreq/policy*` directory, plus the additive-optional `{cpus, cpuCount, governor, label}`. `id` is the directory name verbatim — never relabeled "big"/"little" and never used to infer core counts. `maxKhz` is the hardware ceiling (`cpuinfo_max_freq`), not the governor-movable `scaling_max_freq`. Absent when nothing is measurable, never `[]` |
| `ddr` (optional) | `{loadPercent, curFreqHz, maxFreqHz}` from the DDR devfreq node. All-three-or-nothing. Probed under `/sys/class/devfreq`: a case-insensitive exact `dmc` match first, then any entry matching `/dmc/i` or `/dfi/i` (lexicographically sorted). Hz, not kHz — do not share a formatter with `cpuFreq` |
| `gpu` (optional) | `{loadPercent, curFreqHz?, maxFreqHz?}`. `loadPercent` required; frequencies independently optional, because the Mali kbase path (`/sys/class/misc/mali0/device/{utilisation,utilization,gpu_busy_percent}`, probed in that order) structurally cannot report a frequency. Falls through to devfreq GPU (`/\.gpu$/i` suffix match under the same `/sys/class/devfreq` directory) when kbase is absent. Hz, not kHz |

Adding a field to the always-present five is a deliberate contract change, not a
tweak. Every collector wraps its read in its own `try/catch` and degrades to
`null`/omission on failure — a missing `/sys` path or absent `rauc` binary must
never crash the sampling loop. The four newer signals are OMITTED (never
zero-filled or empty-array-filled) when their kernel interface does not exist —
absence on a given kernel is the expected, honest state, not a gap to paper over.
**None of the raw sysfs node paths/contents these four probes read have been
confirmed against a real board yet** — see
[`docs/DEVICE-STATS-VALIDATION.md`](../DEVICE-STATS-VALIDATION.md) leg (i) for
the outstanding capture step.

**`cpuFreq` grew ADDITIVELY, and its new fields answer "what is this policy" —
`policy0` never did.** The Settings panel showed the raw sysfs directory names
and no governor at all, which was not a data bug: the collector deliberately
emitted the kernel's directory name verbatim and never read `scaling_governor`.
It now also reads `related_cpus` (→ `cpus: "0-3"` + `cpuCount`),
`scaling_governor` (→ `governor: "performance"`), and `/proc/cpuinfo` (→ an
optional `label`), each optional-on-read-failure under the unchanged per-policy
omission contract — a policy still answers with its two frequencies or is
omitted, and a device that publishes none of the new nodes emits the
byte-identical three-field row. The S1 five-signal lock is untouched.

`label` is the one field a consumer could be tempted to fabricate, so it is the
one that is ABSENT rather than guessed: an ARM core is named only from a checked
MIDR part table (`0xd05` → Cortex-A55, `0xd0b` → Cortex-A76) and only when the
implementer is ARM Ltd, every CPU of the policy must agree, and x86 uses the
shared `model name`. GOVERNOR CONTEXT, board-proven: the fleet runs
`performance` BY DESIGN via the first-party `ceralive-cpu-governor.service`
(encode-latency rationale in the unit; overridable via `CERALIVE_CPU_GOVERNOR`),
so `cur == max` at idle on the big cores is the EXPECTED reading and the chip
renders plainly — changing the governor policy is a separate owner decision.
Full contracts: [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → CPU-FREQUENCY
METADATA and [`apps/frontend/AGENTS.md`](../../apps/frontend/AGENTS.md) → "A cpufreq
policy is rendered as the thing it governs".

**A new device signal therefore gets its OWN broadcast**, exactly as `encoder-load`
did. The CPU core count is the third one, and it exists because `cpuLoad1` above is
UNREADABLE without it: a load average is a count of runnable tasks, so `1.00` on an
8-core RK3588 is about an eighth of the board while reading as saturation to anyone
who does not already know the core count (the operator report that produced it).
`apps/backend/src/modules/system/cpu.ts` publishes a `cpu` event carrying
`{ cores: number | null }` — a BOOT FACT resolved once and re-served from the
post-auth initial-state push, not a sample, since core count cannot change without
a reboot. It is deliberately NOT `isRealDevice()`-gated (every host has CPUs, so
gating it would leave dev and CI rendering the bare load average the fix replaced),
and `cores` is nullable so a host that cannot report its topology degrades to the
raw figure rather than having a denominator invented for it. Full contract:
[`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → CPU TOPOLOGY.

The fan is the second one: `apps/backend/src/modules/system/fan.ts` publishes
a `fan` event (5 s, `isRealDevice()`-gated) reporting fan PRESENCE plus a PWM duty
cycle derived from `pwm1 / 255` — never an RPM (the board's fan is 2-wire and has
no tachometer) and never `cur_state / max_state` (an index into a devicetree table,
not a fraction of airflow). The `pwm-fan` cooling device is discovered by its `type`
string, never by a `cooling_deviceN`/`hwmonN` index — both were measured shifting
across a reboot on the reference board. On the mainline/edge kernel that cooling
device carries NO `device` backlink at all, so the collector also correlates by
the `hwmon<N>/name == "pwmfan"` string; that fallback is gated on a confirmed
`pwm-fan` cdev and reports `unknown` rather than guessing when two hwmons match.
Full contract: [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → FAN.

