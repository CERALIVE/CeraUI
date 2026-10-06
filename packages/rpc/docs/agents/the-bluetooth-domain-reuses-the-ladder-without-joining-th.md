<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE BLUETOOTH DOMAIN REUSES THE LADDER WITHOUT JOINING THE REGISTRY [EXISTS]

`schemas/bluetooth.schema.ts` + `contracts/bluetooth.contract.ts` are the wire
half of the BlueZ foundation (`apps/backend/src/modules/bluetooth/`). Ten
procedures: `getStatus` plus `enable` / `disable` / `scanStart` / `scanStop` /
`pair` / `trust` / `forget` / `connect` / `disconnect`.

**`bluetooth` is deliberately NOT a `CAPABILITY_MODULE`, and it uses the
five-state ladder anyway.** `CAPABILITY_MODULES` is a CLOSED, modem-only,
default-OFF-forever enum whose gates live under `config.modem_capabilities` with
no `RUNTIME_CONFIG_DEFAULTS` entry — registering Bluetooth there would make the
whole surface invisible by design, and an operator would have to enable a
*cellular* feature gate to see a headset. What IS reused is
`supportClaimStateSchema` and `resolveSupportClaim`, because the question is the
same one: shipped, switched on, proven on THIS hardware, certified.
`bluetoothCapabilityClaimsSchema` is a SEPARATE registry
(`adapter` / `pairing` / `audio-input` / `battery`) and is TOTAL for the same
reason `capabilityModuleClaimsSchema` is — a claim published only when true can
be raised and never lowered on a consumer that merges. The GATE is the operator's
persisted Bluetooth preference, so "Bluetooth off" resolves `implemented`.

Four shape decisions carry weight:

- **`paired` / `trusted` / `connected` / `blocked` are REQUIRED.** They are
  RECOVERABLE facts, and a present-only-when-true flag is the
  `policy_route_missing` latch: a device that disconnects could never say so.
  `battery` and `rssi` are the opposite case and stay optional — absent means the
  device exposes no battery service / is not advertising, which a `0` would lie
  about.
- **The mutation refusals are ONE shared enum** (`bluetoothMutationRefusalSchema`,
  the `modemMutationRefusalSchema` lesson). Fourteen members, none collapsible:
  `adapter_busy` (wait) is not `pairing_failed` (retry) is not
  `unit_missing` (the image lacks a unit) is not `service_start_failed` (an installed
  unit refused to start) is not `bluetooth_disabled`
  (turn it on), and `bluez_unavailable` / `bus_unreachable` / `no_adapter` send
  someone to three different places.
- **`pairing_agent_unavailable` names a gap this build really has.** The shared
  `DbusTransport` is a CLIENT — no object export, no name ownership — so there is
  no `org.bluez.Agent1` for BlueZ to call back into, and the stack registers
  NOTHING rather than naming a dead path (which would make BlueZ block on every
  callback). The same fact rides `getStatus().agent.reason` as
  `exporter_unavailable`, so it is stated BEFORE an operator taps as well as when
  a pairing is refused. Do not paper over either half.
- **`transport` is positive-evidence-only.** `bredr` is claimed from a
  BR/EDR-only SIG profile the device actually advertises; nothing on a registry
  row proves LE, so `le`/`dual` exist for a future read that can prove them and a
  device that proves nothing reads `unknown`.

Every mutation input is `.strict()`: an unknown extra key on a surface that
powers a radio, opens a pairing window or removes a trusted device must be
REJECTED, never ignored. Coverage: `schemas/bluetooth.schema.test.ts` (the
required-boolean negatives, one strict-input negative per procedure shape, the
exact refusal enum, the claim totality, and the contract↔schema file-name
convention). Device contract: [`apps/backend/AGENTS.md`](../../../../apps/backend/AGENTS.md)
→ THE BLUETOOTH DOMAIN IS WIRED.

