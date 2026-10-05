<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A MODEM IS CORRELATED BY `stable_key`, AND BY NOTHING ELSE [EXISTS]

`schemas/modems.schema.ts` carries the Phase-B additive-optional modem delta. Ten
of the eleven new fields are ordinary read-only observations (`device_class`,
`availability_reason`, `slot_label`, `recovery_state`, `usb_mode`,
`recommended_usb_mode`, `data_usage`, `firmware_revision`, `esim`, `cell_info`).
The eleventh, `stable_key`, is a contract in its own right.

**Every other identifier a modem carries is unstable across the one moment a
consumer most needs to follow it.** A USB-composition switch re-enumerates the
device, so the legacy numeric id — a ModemManager index — is re-issued; the switch
also moves the device BETWEEN adapter classes (router-ethernet ↔ mm-managed), so
any per-adapter derivation changes at exactly that instant; and the ifname is no
better, because the bench holds two physically distinct HiLink units shipping ONE
factory MAC, which makes their predictable names race. `stable_key` is the only
identifier a consumer may use to say "this is the same device as before".

**`deriveModemStableKey(idPath)` is ONE rule for every adapter**, and that is the
point rather than a tidiness preference — three adapters (mmcli, D-Bus, router)
observe the same physical device, and a device that crosses between them mid-
transition must keep its key. The rule reduces a udev `ID_PATH` to the `usb_device`
PARENT path every interface of one physical unit shares. The fallbacks are STATED,
not invented: no usb parent (a PCIe FM350) ⇒ the device's own `ID_PATH` verbatim;
no `ID_PATH` at all ⇒ `undefined`, and the optional field is OMITTED rather than
faked. It lives beside the field it produces so the two cannot drift, and it is
emitted verbatim (no prefix, no hash) so no adapter can disagree about a
formatting step — the key is opaque BY CONTRACT (equality only), not by encoding.

**…and "one rule" now covers the INPUT, not only the reduction.** The adapters do
not all observe an `ID_PATH`: ModemManager publishes `Modem.Physdev` as a raw
sysfs DEVPATH. Board-measured on `ceralive2` (todo 24, 2026-08-18), ONE socket was
keyed two ways at the same instant — `platform-xhci-hcd.0.auto-usb-0:1.4.1` from
the udev-sourced rows, `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1`
from the ModemManager row — so the authoritative row could never retire the
optimistic udev row for its own device and the wire carried two rows for one stick
on 10 of 10 power cycles. `sysfsDevpathToIdPath` closes it AT THE DERIVATION:
`deriveModemStableKey` normalizes its input first, so both encodings MINT the same
key rather than being fuzzy-matched at compare time. It is a transformation, not a
heuristic — udev's own `path_id` USB rule (nearest `usb_device` component →
`usb-0:<port-chain>`, its controller → `platform-…`/`pci-…`) — and a path it
cannot confidently convert is returned UNCHANGED, which is the pre-existing
behaviour. `canonicalModemIdPath` is the same conversion exported for an adapter
that STORES an observed path rather than only keying on it (the D-Bus fold does).

**The provisioning gate is echoed READ-ONLY, as a TRISTATE.**
`configMessageSchema.modem_provisioning` (`schemas/streaming.schema.ts`) is a
one-way projection of the backend runtime key `modems.setUsbMode` gates on. It is
deliberately NOT on `streamingConfigInputSchema` — there is no UI write path, and
adding one is a separate decision. `false` means the device SAID provisioning is
off (the switch pre-renders disabled-with-reason), `true` means it is on, and
ABSENT means a backend that does not publish the key at all, which must keep the
control OFFERED so the device's own typed `provisioning_disabled` refusal is what
withdraws it. Collapsing absent into `false` hides a working control on every
older device. `streaming.getConfig` echoes it too — the pull and the broadcast
must not disagree.

**`own_numbers` is an ARRAY that cannot be empty, and that is the contract.**
The SIM's own number (MSISDN) is `z.array(z.string().min(1)).min(1).optional()`,
so the schema can express "these numbers" and "not reported" — and deliberately
NOT "an empty list", which a consumer would render as a finding rather than as
silence. Most SIMs carry no MSISDN at all, so absence is the common case. It
stays an ARRAY because MM's `Modem.OwnNumbers` is `as` and a dual-number SIM is
expressible; collapsing to a first element would silently drop the tail. It is
SENSITIVE — the device redacts it from every log (`helpers/logger.ts`
`isOwnNumberSensitiveKey`) even though the UI displays it behind an explicit
reveal; nothing about it being rendered makes it loggable.

**`sim_presence` is `no_sim`'s INPUT, not its replacement.** `no_sim` answers a
BOND question — a link either may join the pool or may not — so the device folds
`absent` and `unknown` onto one `true` (`claimsNoSim` is `presence !== "present"`).
Right for bonding, lossy for reporting: an unreadable slot became indistinguishable
from an empty one. `simPresenceSchema` publishes the pre-fold reading beside the
claim so a consumer can tell them apart. Three rules: the two fields TRAVEL
TOGETHER (a device emitting one emits the other, or neither when its slot is
opaque); `absent` is reachable only from a device-stated fact, so everything not
`present` is `unknown`; and the bond gate still reads `no_sim` alone, which is
what keeps this additive — `isSimlessForBond` is unchanged, and routing it through
`sim_presence` would change which links bond.

**A network scan is an attempt, not a changed list.** `modem.network_scan`
carries a monotonic `generation` and `scanning | completed | failed` phase, with
the typed terminal failure where applicable. `modems.scan` returns the admitted
`scanGeneration`; completion arrives later on the modem broadcast. This is what
lets a consumer confirm a successful scan whose operator list is byte-identical,
and fence a late older result across the independent `status` and `modems`
sequence domains. Absence remains legacy-compatible.

**`modems.configure` deliberately carries NO usage-policy write.**
`modemDataUsageSchema` REPORTS `cycle_day` / `threshold_bytes`; the matching input
fields are absent because `@ceralive/modem-control@0.2.0` publishes no
usage-policy setter to map them onto. Declaring inert input fields would let the
device accept and echo a policy it silently drops, and a UI built on that would
show the operator's setting reverting with no explanation. Adding them once the
package ships the setter is purely additive. Do NOT add them before it does.

**`setUsbModeInputSchema` is `.strict()` with `confirm: z.literal(true)`, and both
halves are load-bearing.** The mutation re-enumerates a modem and drops its bond
link, so an unknown extra key must be REJECTED rather than ignored and an omitted
or falsy `confirm` must never reach the handler. The SIX refusals
(`provisioning_disabled` / `streaming_active` / `unavailable_in_emulated_mode` /
`uncertified` / `transition_in_progress` / `transition_failed`) each name a
different thing the operator can do about it and are never collapsed into a generic
error. `transition_in_progress` is distinct from `streaming_active` because the
lifecycle interlock has TWO holders: an admission answers "stop the stream", another
transition answers "wait".

**`transition_failed` additionally carries a typed `reason`**
(`setUsbModeFailureReasonSchema`: `identity_unresolved` / `engine_unavailable` /
`preconditions_refused` / `postcondition_mismatch` / `transaction_error`). `error`
names what the operator asked for and did not get; `reason` names WHY, and the last
two are deliberately not collapsed — "the device came back as something else" and
"the transaction blew up" call for different actions. It is additive-optional and
present ONLY alongside `transition_failed`.

Coverage: `schemas/modems.schema.test.ts` — the legacy-payload byte-compat fixture
(a pre-Phase-B entry parses to a byte-identical payload and gains no defaulted
field), the `stable_key` derivation table incl. the same-unit/different-port/
non-USB/absent arms, and the strict-input negatives.

