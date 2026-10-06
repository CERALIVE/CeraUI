<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FAN — A DUTY CYCLE, AND THE FILES NAMING IT MOVE [EXISTS]

`modules/system/fan.ts` reports whether the board has a controllable fan at all
and, if it does, what duty cycle it is being driven at. It publishes its own
`fan` broadcast on a 5 s cadence (coalesced at 5 s, seeded into the post-auth
initial-state push). Wire schema: `@ceraui/rpc` `fanSchema`.

- **It is its OWN broadcast, NOT a sixth `device-stats` field** — that payload is
  frozen by the S1 lock, so extending it is a deliberate contract change rather
  than a tweak. Same decision, same reason, as `encoder-load`. It is likewise not
  foldable into `sensors`, a flat `Record<string, string>` of display strings
  that cannot express present-vs-absent.
- **DISCOVERY IS BY TYPE STRING, NEVER BY INDEX.** The scan reads every
  `/sys/class/thermal/cooling_device<N>/type` and keeps the one that reads
  exactly `pwm-fan`, then follows that device's `device` symlink to the platform
  device that owns it and reads `pwm1` from the hwmon listed underneath. Both
  index spaces are registration-order artefacts: the reference Rock 5B+ was
  measured at `hwmon8` = `pwmfan` bound to `cooling_device4`, and BOTH indices
  SHIFTED across a reboot in the same session. A hardcoded `cooling_deviceN` or
  `hwmonN` is how a working reading silently starts reporting an unrelated
  device. This is the same algorithm the shipped `ceralive-fan-curve` service
  already uses (`image-building-pipeline/v2/mkosi/runtime/ceralive-fan-curve.sh`),
  in TypeScript. Kernel ABI: `Documentation/ABI/testing/sysfs-class-thermal`.
- **…AND THAT `device` BACKLINK DOES NOT EXIST ON EVERY KERNEL.** Board-confirmed
  on the reference Rock 5B+ running `7.1.5-ceralive-rk3588` (mainline/edge, NOT
  the vendor 6.1 BSP): `cooling_device4` lists `cur_state max_state power/
  subsystem type uevent` and NO `device` entry at all (nor `of_node`), because
  that driver's `thermal_cooling_device_register()` sets no parent `struct
  device`, so the class-device machinery never creates the backlink. The FORWARD
  link is fine — `/sys/devices/platform/pwm-fan/hwmon/hwmon8` exists and
  `hwmon8/device -> ../../../pwm-fan` — it is only the cdev→device direction that
  is missing. The first shipped collector therefore reported `unknown` forever on
  a board whose fan was present, running and measurable at `pwm1=120`. So a THIRD
  step exists: when the cooling device carries no `device` entry of its own, scan
  `/sys/class/hwmon/hwmon<N>/name` for the exact string `pwmfan` and read `pwm1`
  from the single hwmon that matches. Note the two strings are spelled
  DIFFERENTLY (`pwm-fan` cdev type vs `pwmfan` hwmon name) — neither may be
  derived from the other. Three scoping rules are load-bearing:
  - it is GATED on an already-confirmed `pwm-fan` cooling device, so it never
    becomes a "find any fan on the system" mechanism;
  - it fires ONLY when the backlink is ABSENT. A backlink that exists but whose
    `pwm1` read failed reports `unknown` — starting a class-wide scan there could
    adopt a different fan on a multi-fan board;
  - MORE THAN ONE `pwmfan` hwmon is genuinely ambiguous and reports `unknown`
    rather than resolving by order.
- **THE INVARIANT: the only sanctioned magnitude is `pwm1 / 255`.** That is a
  real fraction with a real denominator — the register's own 8-bit full scale.
  Two derivations are banned outright:
  - **RPM.** The reference fan is 2-wire: its hwmon exposes `pwm1` and
    `pwm1_enable` and NO `fan1_input`, so there is no tachometer and no speed to
    report. No field, log line, or comment here names one.
  - **`cur_state / max_state`.** Those levels are an INDEX into the devicetree
    `cooling-levels = <0 120 150 180 210 240 255>` table, not a linear scale of
    airflow, so `2 / 6 = 33 %` fabricates a denominator the hardware never
    produced — the exact sin the three-state encoder-load model forbids for a
    busy/idle core. The collector does not read those nodes AT ALL, which is the
    cheapest way to keep the derivation unreachable, and a test pins that.
- **FOUR states, and `absent` is a positive claim.** `running` (duty > 0), `off`
  (a MEASURED zero — a real reading, never a gap), `absent` (this board has no
  `pwm-fan` cooling device: a real shipping configuration, cf. x86-minipc), and
  `unknown` (a fan is present but its duty could not be read this tick). A shape
  that cannot tell `absent` from `unknown` is the whole defect this signal exists
  to avoid, so the two are never collapsed: a MISSING `/sys/class/thermal`
  (ENOENT) is a statement about the BOARD and reports `absent`, while any other
  read failure is a statement about the READ and reports `unknown`.
- **`initFan` is `isRealDevice()`-gated.** A dev/emulated host publishes NOTHING
  — not even `absent`, which would be a claim about hardware it does not have.
  The frontend renders `unknown` for a broadcast that never arrives, and that
  silence IS the real-vs-mock seam (same rule as `encoder-load`; do not add a
  backend mock provider or a build-flag branch for this signal).
- **Degradation follows `device-stats.ts`/`encoder-load.ts`:** every sysfs read
  is in its own try/catch, one unreadable candidate falls through to the next,
  and a tick can never throw. Privilege: none is escalated — these are sysfs
  nodes read through the same plain `Bun.file()` seam as `sensors.ts`.

Coverage: `tests/fan.test.ts` — every fixture tree deliberately numbers its
cooling device and hwmon DIFFERENTLY from the reference board (and two of them
number the same board differently from each other), so a collector that hardcoded
an index could not pass. Plus the four states, the ENOENT-vs-EACCES split, the
per-read degradation, the emulated-host gate, and the negative locks that no
export or code path names an RPM or touches `cur_state`/`max_state`. The
backlink-less kernel has its own describe block driven by a fixture that OMITS
the `device` entry from the cooling device's listing exactly as the kernel omits
it (never merely made to throw), with the three negatives that matter: a
differently-named hwmon is not adopted, two `pwmfan` hwmons are ambiguous, and a
backlink that EXISTS but failed its `pwm1` read does not start the scan.

