<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A DEVICE IS ANNOUNCED BEFORE ANY MODEM SERVICE CAN DESCRIBE IT [EXISTS]

Between a USB attach and ModemManager exporting the modem there is a real gap —
the daemon has to probe ports, talk to the radio, and only then publish — and the
authoritative paths above cannot shorten it. Until it closes, an operator who has
just plugged a stick in is looking at a device list that does not mention it, and
the 30 s reconciliation poll means the WORST case is a full poll interval of
apparent nothing.

`modules/cellular/` closes that gap with an OPTIMISTIC row and three modules:
`udev-cellular-events.ts` (pure decoding), `udev-provisional-cache.ts` (the rows
+ the precedence rule), `udev-monitor.ts` (the supervised child). The row claims
exactly ONE thing — this device exists — and carries `availability_reason:
"modem_initializing"`, which the frontend bands as "Modem detected"
(`apps/frontend/src/main/network/cellular-row.ts`).

**PRECEDENCE IS ONE-DIRECTIONAL, AND IT IS STRUCTURAL.** The provisional rows are
appended LAST in `collectSources()` (`modem-wire-producer.ts`) and are handed the
set of keys the authoritative sources have ALREADY claimed, so an mmcli row, a
D-Bus row or a classified dongle for the same identity replaces the optimistic
one inside the SAME synchronous wire build. A provisional row can never displace,
enrich or delay a real observation, because it is never consulted until they have
all been collected. A superseded entry is RETIRED rather than hidden — keeping a
shadow alive would let the row reappear the moment that observation blinked.

**The merge key is the `ID_PATH`-derived `stable_key`, NOT todo 10's identity
key**, and that is a deliberate divergence. The identity ladder is `usb-serial` >
`id-path` > `ifname` with no alias table between rungs, which is right for
identity and wrong here: a udev `usb_device` add publishes `ID_SERIAL_SHORT` and
would anchor on the serial rung, while a D-Bus row carries only `Modem.Physdev`
and anchors on the path rung — so comparing identity keys would never match and
the provisional row would sit BESIDE its own authoritative row. `stable_key` is
the one key both sides always carry, it is what todo 17's consumers correlate on,
and it survives the Qualcomm `9024`⇄`9091` flip for free: that transition changes
VID:PID and the interface name but keeps the device in the same USB port.

**…BUT "both sides always carry it" only became true once the two ENCODINGS were
reconciled.** ModemManager anchors on `Modem.Physdev`, which it publishes as a raw
sysfs DEVPATH, while the udev side publishes an `ID_PATH` — two spellings of one
socket, and `claimedKeys.has(entry.stableKey)` is a string-equality test. Measured
on `ceralive2` (todo 24, 2026-08-18): `platform-xhci-hcd.0.auto-usb-0:1.4.1`
against `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1`
for port `1.4.1`, so the authoritative row could never retire the provisional one
and TWO rows for one stick reached the wire on 10 of 10 power cycles. The
supersession logic was right; its INPUTS were not.
`deriveModemStableKey` now normalizes a sysfs path into the `ID_PATH` shape before
reducing it (`@ceraui/rpc` `sysfsDevpathToIdPath` — udev's own `path_id` USB rule,
not a fuzzy match), and `dbus-view-fold.ts` `readIdPath` stores the normalized
anchor, so both sides MINT the same key. Todo 18's fixtures paired ID_PATH against
ID_PATH on BOTH sides, which is exactly why its suite stayed green while the board
did not; the pairing the board actually produces is now covered in
`udev-provisional-rows.test.ts` §4 with those two verbatim strings.

**Four refusals do the ghost-prevention work**, and each is load-bearing:

- only `DEVTYPE=usb_device` is read. A composite modem publishes one of those and
  several `usb_interface` children, so keying on anything else draws one stick as
  three to seven rows;
- only `add`. `bind`/`change` describe a device that is already present;
- an attach with NO `ID_PATH` is DROPPED, because the merge key is what makes the
  row retirable and a row nothing can supersede is precisely the ghost class this
  must not introduce;
- a repeat `add` for a key already held is a no-op, so a modeswitching composite
  cannot reset the authoritative-cycle history already accumulated for it.

**The lifecycle is cycle-based, never timer-based.** An attached device starts at
`modem_initializing`. Two successful authoritative roster cycles that still cannot
describe it move a strong-evidence row to `undriveable`; no elapsed-time deadline
may erase that physical presence. Strong evidence means `ID_MM_DEVICE_PROCESS=1`,
`ID_MM_CANDIDATE=1`, or a known cellular vendor. The row then remains until an
authoritative source claims its `stable_key` or udev proves physical detach.

**Descriptor shape alone is weak evidence, not a permanent modem claim.** Wireless
controllers are admitted only by the full `e00103` RNDIS triplet; `e00101`
(Bluetooth) and `e00104` (Bluetooth AMP) veto shape-only admission even beside an
otherwise eligible descriptor. Classes `02`, `0a`, and `ff` retain class-byte
matching. `ID_MM_DEVICE_IGNORE=1` excludes a device before any positive evidence.
Weak rows are dropped and listeners notified on the second authoritative miss.
Their internal stable-key tombstones survive repeat adds and monitor-respawn
inventory while attached; only observed detach, complete-inventory absence, or
process teardown clears them. Evidence strength and tombstones never reach the
wire. These rules are covered by `tests/udev-provisional-rows.test.ts`, including
the Rock `13d3:3572` capture and the unchanged strong `05c6` lifecycle.

**The source is a SUPERVISED `udevadm monitor --property --udev` CHILD, never the
npm `udev` binding.** That binding is an unmaintained native addon compiled
against the running ABI, which a `bun build --compile` single binary shipped to a
toolchain-less device cannot use; `udevadm` ships with systemd. `--udev` is
load-bearing — the `--kernel` events that precede rule processing carry no `ID_*`
properties at all, so a monitor without it would see every attach and be able to
say nothing about any of them. The supervisor is the direct twin of
`NmcliMonitorManager` (same backoff, same `watcher` spawn class,
`monitor.udevMonitor` in `SPAWN_POLICY`). On startup and every child respawn, the
supervisor reads `udevadm info --export-db` through the same property parser and
atomically replaces physical inventory. Rows still attached retain their lifecycle;
a detach that happened while monitoring was down is retired by its absence.

`initUdevProvisionalMonitor` is `isRealDevice()`-gated and skipped under mocks,
and `readProvisionalSources` answers mocks with NOTHING — this row exists to
close a hardware latency gap a dev host does not have, so a mock fixture would be
a parallel mechanism rather than the scenario roster.

Coverage: `tests/udev-provisional-rows.test.ts` — the decode/refusal table, the
precedence and retirement rules, the `9024`⇄`9091` flip folding onto one row,
detach, the two-cycle transition, repeat-attach retention, the supervised
child (split chunks, EOF flush, malformed block, respawn inventory, stop), and the
row reaching the REAL `buildModemsWireMessage()` payload plus its replacement
there by an mmcli row for the same port. Rule-E proof: deleting the claimed-key
check reddens 3 tests; dropping inventory reconstruction or lifecycle retention
across restart reddens the supervisor cases.

**Board-measured, no longer modelled.** On `ceralive2` (RK3588, SIMCom
SIM7600G-H, 9 plug cycles) the optimistic row reaches an authenticated WebSocket
client a **median 2 ms** after the udev attach, and the authoritative MM row
replaces it a **median 16 ms** after `InterfacesAdded`. Both are budgeted and
asserted — see PLUG-TO-UI LATENCY HARNESS below. What the row is covering is
ModemManager's own probe time, measured at **~29.3 s** on that hardware.

