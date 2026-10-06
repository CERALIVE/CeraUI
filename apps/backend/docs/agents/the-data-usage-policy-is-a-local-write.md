<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE DATA-USAGE POLICY IS A LOCAL WRITE [EXISTS]

`modems.configure` accepts two additive fields — `data_usage_cycle_day` and
`data_usage_threshold_bytes` — and persists them through
`@ceralive/modem-control`'s `setUsagePolicy`. They are the WRITE half of the usage
meter; `modem.data_usage` is the read half.

**ModemManager has no data-usage API, so this cannot be a modem write.** Verified
against the bench board's live MM 1.24.2 rather than recalled: a D-Bus
introspection of a real `…/ModemManager1/Modem/N` shows the only `Setup`/threshold
surface on the whole object is `Modem.Signal.Setup` / `Signal.SetupThresholds`,
whose keys are `rssi-threshold` and `error-rate-threshold` — RADIO QUALITY, not
bytes. The only byte counters MM offers are the per-BEARER read-only `Stats`, which
reset with every connection and so cannot carry a monthly cycle. The policy is
therefore durable local state in a versioned, 0600, fail-soft file owned by the
package (`modem-usage-policy.json`, beside `config.json` so it survives an OTA slot
swap). `Modem.Signal.Setup` is separately forbidden by the shadow-mode
mutation-freedom contract; nothing here goes near it.

- **The package is imported STATICALLY.** `setUsagePolicy` landed in
  `@ceralive/modem-control@1.0.0`, so while `package.json` pinned the `0.2.0`
  floor this module resolved it through a lazy `import()` plus a structural probe
  and answered a typed `usage_policy_unsupported` refusal when the pinned release
  did not publish it. The pin is now `1.3.0` EXACTLY, so `tsc` and `bun install`
  answer that at build and install time — both strictly stronger than a
  `typeof === "function"` check, which can only report the gap after a write has
  been attempted. `isUsagePolicySupported()` is therefore constant, and it stays a
  named function only because `supported` is an EXPLICIT wire field.
- **`modem.data_usage_policy` is its OWN wire block, not more fields on
  `data_usage`.** `data_usage` is produced only by the D-Bus backend's observation
  fold, and no shipped device runs that backend, so on every board in the field it
  is ABSENT — a policy folded into it would be unreportable, and therefore
  unsettable, on exactly the devices this exists for. A policy is knowable before a
  byte is counted.
- **`supported` is published EXPLICITLY on every row**, never
  present-only-when-true: the frontend merge preserves an omitted optional field,
  so a true-only flag could be raised and never lowered — the
  `policy_route_missing` latch, exactly.
- **Both input fields are TRI-STATE.** `undefined` leaves the persisted value
  alone, so an APN-only save cannot silently drop a cycle day it never mentioned;
  an explicit `null` clears it. A request mentioning NEITHER field writes nothing
  and is never refused, so an ordinary APN save still succeeds on a device whose
  pinned package cannot write a policy.
- **The policy is filed under `stable_key` when the device has one**
  (`usagePolicySlotKey`), because it is a durable statement about hardware and the
  legacy numeric id is an MM index a re-enumeration re-issues. A device with no
  ID_PATH falls back to the legacy id — worse, but still stable within a boot, and
  the alternative is no policy at all.
- **The write runs OUTSIDE the modem lock and only after the radio config landed**,
  so a save that failed at the radio never leaves a meter bound half-changed. It is
  stamped onto the wire by an injected projector dep, so a status-only partial
  broadcast stays status-only.
- **The cache exists because the wire build is synchronous**
  (`buildModemsWireMessage` cannot await a file read): an async
  `refreshUsagePolicies` writes a snapshot and a sync getter serves it — the
  `policy-route-check.ts` precedent. It refreshes once, before the first discovery,
  so the operator's bounds are on the very first `modems` payload a client sees.

Board-verified on `192.168.78.132` (Quectel RM530N-GL): set day 17 + 10 GiB → both
in the applied echo and read back on `modems.getAll`; an APN-only save preserved
them; an explicit-null save cleared both; the file landed mode `600` and the policy
survived a `systemctl restart`. Coverage: `tests/modem-usage-policy.test.ts` (which
drives the REAL pinned package throughout, and asserts that the exact pin
GUARANTEES the write the wire advertises). Frontend half:
`apps/frontend/src/main/dialogs/modem-usage-policy.ts`.

