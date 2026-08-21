# mmcli Retirement Gate — Runbook `[PARTIAL]`

**Status: `[PARTIAL]` — the MECHANISM exists; the gate has not been run, and this
effort does not run it.**

This document describes how evidence is collected for the decision to retire the
mmcli modem backend in favour of the D-Bus one, and what that decision requires.
It describes a process, not a completed result.

> **This effort never flips the default.** `config.modem_backend` has no schema
> default and `initCellularStack()` resolves an absent key to `"mmcli"`
> (`apps/backend/src/modules/cellular/cellular-stack.ts`). Nothing in shadow mode
> reads its own evidence to change behaviour, and nothing writes `modem_backend`.
> Flipping the default is a separate, deliberate, human change made only after
> every criterion below is satisfied — see [Out of scope](#out-of-scope).

---

## 1. The criteria

Inherited verbatim from the Phase-B annex's locked decisions:

| # | Criterion | Who evaluates it |
|---|-----------|------------------|
| G1 | **≥14 complete days** of shadow observation | per-device, from the evidence file |
| G2 | on **≥2 physical devices** | a human, by collecting one bundle per device |
| G3 | **zero unexplained divergences** | a human, reviewing every divergence record |
| G4 | **HIL parity** — hardware-in-the-loop behaviour matches on both backends | a human, from a drill |
| G5 | **rollback drill** performed and passed | a human, from a drill |
| G6 | **one release shipped with the D-Bus backend opt-in** before it becomes the default | release management |

Only **G1** is machine-summarisable, and only per device. G2–G6 are human
judgements this repo deliberately does not automate: a gate that grades its own
homework is not a gate.

---

## 2. Enabling shadow mode on a device

Shadow mode is opt-in and orthogonal to which backend actually drives the modems.
A device in shadow mode is still driven by mmcli.

```jsonc
// config.json
{
  "modem_shadow": true
}
```

`modem_shadow` has **no default**. Absent, `false`, and any non-boolean value are
all "off" — the strict `=== true` check is asserted by
`src/tests/cellular-shadow-audit.test.ts`. A device with the key absent never even
loads the D-Bus client.

Restart `ceralive.service` after the edit. Shadow mode is wired at boot (todo 25);
until that lands it must be started explicitly.

**Do NOT also set `modem_backend: "dbus"` on a gate device.** The point of the
window is to observe the D-Bus path while mmcli remains authoritative. A device
running the D-Bus backend is a *different* experiment.

---

## 3. What is collected, and where

| | |
|---|---|
| Path | `/data/ceralive/shadow/shadow-evidence.jsonl` (+ rotated `.1`…`.4`) |
| Permissions | `0600`, directory `0700` |
| Format | one JSON object per line, `v: 1` |
| Ceiling | 256 KiB × 5 files = 1.25 MiB, oldest generation dropped |
| Overrides | `CERALIVE_SHADOW_EVIDENCE_DIR`, else `CERALIVE_DATA_DIR` |

Two record kinds:

**`heartbeat`** — appended every 15 minutes, plus once at session start. It is the
positive statement *"shadow was observing during this window"*. Without it a day
with no divergences and a day the device spent powered off are indistinguishable,
and the gate would happily count the second.

```json
{"v":1,"at":1786953600000,"day":"2026-08-01","kind":"heartbeat","observationOk":true,
 "modemKeys":["d-6f291062365298d9"],"mmcliModems":1,"dbusModems":1,"divergences":0,
 "unjoinableMmcli":0,"unjoinableDbus":0,"refusals":0}
```

**`divergence`** — one per disagreement per comparison pass.

```json
{"v":1,"at":1786953612345,"day":"2026-08-01","kind":"divergence",
 "deviceKey":"d-6f291062365298d9","divergence":"field-mismatch",
 "fields":{"networkType":{"mmcli":"4G","dbus":"3G"}}}
```

### Privacy

No record contains an ICCID, EID, IMSI, IMEI, MSISDN, APN, APN username/password,
SIM PIN or PUK. Three layers enforce that, and
`src/tests/cellular-shadow-redaction.test.ts` proves it by string-searching the
raw bytes on disk for real-shaped fixtures rather than by trusting any layer:

1. the compared state is a six-field non-secret allowlist;
2. every record crosses `redactShadowPayload` at the single append seam;
3. records are keyed by an **opaque** device id (`d-<16 hex>` — a digest of the
   interface name), never by an ifname or a serial.

The opacity is a deliberate trade: it costs per-modem readability during review,
and buys a persisted artifact that can be copied off a device without a privacy
review. Correlating an opaque key back to a physical modem is done on the device,
not from the bundle.

---

## 4. Reading the evidence

`summarizeShadowEvidence(readShadowEvidence())`
(`apps/backend/src/modules/cellular/shadow-evidence.ts`) folds a device's records
into:

```ts
{
  days: [{ day, heartbeats, divergences, complete }],
  completeDays,          // ← G1, for THIS device
  distinctModems,        // ← modems on this board; NOT G2
  totalDivergences,
  divergencesByKind,     // only-in-mmcli | only-in-dbus | field-mismatch
}
```

### A day is "complete" only with ≥72 heartbeats

`MIN_HEARTBEATS_PER_COMPLETE_DAY = 72` against a nominal 96/day at the 15-minute
cadence — 18 of 24 hours. The plan does not fix this number; it is a recorded
choice. It tolerates a reboot, an OTA window and a couple of hours of downtime
without discarding the day, and refuses to count a day the device spent mostly
off. Raising it makes the gate stricter and slower; dropping it below ~48 would
make "14 days of shadow" a weaker claim than it sounds.

### `distinctModems` is NOT criterion G2

G2 counts **physical CeraLive units**. One board with two modems reports
`distinctModems: 2` and satisfies nothing. G2 is met by collecting one evidence
bundle from each of ≥2 boards and confirming each independently reaches
`completeDays >= 14`.

---

## 5. Reviewing divergences (G3)

"Zero unexplained divergences" is not "zero divergences". Each record must be
reviewed and either explained or investigated.

The classifier is deliberately quiet, so a record that *does* appear is worth
reading. Two behaviours account for most of what it does **not** report, and
neither should be mistaken for the gate passing:

- **A field only one side reports is never a mismatch.** The observer's snapshot
  has no signal-quality and no operator-name field, so those dimensions are
  mmcli-only today and are simply not compared. They are *unproven*, not *proven
  equal*.
- **A row that cannot be joined is dropped and counted**
  (`unjoinableMmcli` / `unjoinableDbus`), never turned into an `only-in-*`. The
  join key is the modem's data interface name. **A persistently non-zero
  `unjoinable` count means large parts of the fleet were never actually compared
  — treat it as a gate blocker, not a footnote.**

| Class | Typical explanation | Investigate when |
|---|---|---|
| `only-in-mmcli` | the observer had not yet enumerated a just-plugged modem | it persists across many passes |
| `only-in-dbus` | mmcli dropped a modem the bus still reports | ever — mmcli is authoritative today |
| `field-mismatch` on `present` | a sampling race across a plug/unplug edge | it persists, or is not near a hotplug |
| `field-mismatch` on `networkType` | a genuine RAT-reporting disagreement | always |
| `field-mismatch` on `registration` | roaming reported differently | always |

A non-zero `refusals` count on any heartbeat means something attempted a
non-allowlisted D-Bus call through the shadow path. Shadow is mutation-free by
construction and survives a refusal by design, but a refusal is a **defect
signal** and must be root-caused before the gate can pass.

---

## 6. Collecting a bundle

```sh
# on each gate device
sudo tar czf "shadow-evidence-$(hostname)-$(date -u +%Y%m%d).tar.gz" \
  -C /data/ceralive/shadow .
```

Retain one bundle per device for the whole window. The 1.25 MiB ceiling means a
sufficiently noisy device can rotate a day out — collect bundles at least weekly
rather than only at the end.

---

## 7. Out of scope

This effort builds the mechanism only. It does **not**:

- flip `modem_backend` to `"dbus"`, by default or otherwise;
- read the evidence at runtime to change any behaviour;
- run the 14-day window, the HIL parity drill (G4), or the rollback drill (G5);
- decide that the gate has passed.

Retiring mmcli is a separate change that must cite satisfied evidence for G1–G6.

---

## References

- `apps/backend/src/modules/cellular/shadow.ts` — session runner, opt-in gate
- `apps/backend/src/modules/cellular/shadow-divergence.ts` — comparable state + classifier
- `apps/backend/src/modules/cellular/shadow-evidence.ts` — durable retention
- `apps/backend/src/modules/cellular/shadow-redaction.ts` — the three-layer redactor
- `apps/backend/src/modules/cellular/dbus-audit-transport.ts` — the fail-closed guard
- `apps/backend/src/tests/cellular-shadow-{audit,divergence,redaction,retention}.test.ts`
