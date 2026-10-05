<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE BLUETOOTH FOUNDATION [EXISTS]

`modules/bluetooth/` observes BlueZ over the system D-Bus and publishes one snapshot:
adapter rows, the device registry, service/observation state, the pairing-agent state,
and a total capability-claims registry. Ten `bluetooth.*` procedures sit on top.

**Bluetooth reuses the five-state claim VOCABULARY without joining `CAPABILITY_MODULES`.**
That enum is closed, modem-only and default-off-forever, so registering Bluetooth in it
would put a headset behind a *cellular* feature gate — invisible by design. What is
shared is `supportClaimStateSchema` and `resolveSupportClaim`;
`bluetoothCapabilityClaimsSchema` is its own total registry
(`adapter`/`pairing`/`audio-input`/`battery`), gated on the operator's persisted
preference.

**The unit name is `bluealsa.service`; `bluealsad` is the binary.** Debian's
`bluez-alsa-utils` renamed the daemon upstream in bluez-alsa 4.x and kept the unit name.
Getting it wrong fails in the invisible direction: `systemctl enable --now
bluealsad.service` exits non-zero, the preference is still persisted, and the board comes
up with Bluetooth on and no ALSA PCM behind it. Bookworm's 4.0.0-2 actually installs
`/usr/bin/bluealsa`, so `BLUEALSA_BINARIES` accepts both spellings.

**`systemctl is-enabled` prints NOTHING on stdout for a unit systemd cannot find.** An
inline `stdout.trim() === "enabled"` reads that as "disabled", the reconciler reports
success forever, and nothing ever says the unit does not exist.
`parseUnitEnabledState` types the empty case separately and turns it into a
`unit_missing` record.

**Operator disable MUST be `disable --now`.** A stop-only disable leaves the unit
enabled, so "Bluetooth off" survives exactly until the next reboot and then reverses
itself — with `bluealsad` holding a headset's SCO leg on a device whose UI says
Bluetooth is off.

**`deviceClass` and `scoCapable` are two questions and the split is load-bearing.**
`audio-input` asks "can this be a source of audio at all"; `scoCapable` asks "can the
board open its mic over `PROFILE=sco`", which needs HFP (`111e`/`111f`) or HSP
(`1108`/`1112`) specifically. The forcing case is an A2DP-**source**-only device
(`110a` alone): genuinely an audio input, no SCO leg, so deriving `scoCapable` from "has
an audio UUID" publishes a row whose every open fails. `shortUuid` refuses to fold a
UUID outside the SIG base.

**BlueZ's `PropertiesChanged` is a DELTA.** An omitted key means *unchanged*, never
`false` — writing defaults for absent keys is how a headset that merely reported a new
RSSI publishes as un-paired and un-trusted. An unknown path is dropped rather than
minting a device from a partial view. And `InterfacesRemoved` is not a whole-object
delete: BlueZ retracts a single `Battery1` as readily as the whole device, so only
`Device1` removal retires a row.

**Board-proven: the projection tracks live BlueZ, and the fix was not where it looked.**
The registry delta rules were correct all along. Every live signal was being discarded
one layer earlier, in the shared transport's local sender filter: D-Bus accepts
`sender='org.bluez'` in `AddMatch` and then delivers with BlueZ's **unique** name
(`:1.x`), which `signalMatches` compared literally against `org.bluez`. Bluetooth
subscriptions now omit that predicate and keep the interface/member filters.

**The pairing agent is a real exported D-Bus object, on its own connection.**
`@httptoolkit/dbus-native` — already transitive — ships `exportInterface`, inbound
dispatch and `requestName`; the shared `DbusTransport` merely hides them.
`bluez-agent-exporter.ts` uses that object-server surface, and the **same** connection
both exports Agent1 and issues `RegisterAgent`/`RequestDefaultAgent`, because BlueZ
binds an agent path to the registering caller's unique bus name. No well-known name is
needed. `exportAgent` completes before `RegisterAgent`; an export failure returns
`export_failed` and registers **nothing** — registering a path nobody answers makes
BlueZ block on every callback until it times out, which is strictly worse than no agent.

**`NoInputNoOutput` ⇒ Just Works ⇒ `RequestAuthorization` is the only security gate**,
and it is gated on operator *intent*: the window is opened by `stack.pair(devicePath)`
for that device only and closed in a `finally`. Without that gate the agent accepts any
pairing from anyone in radio range, silently. Every PIN/passkey arm rejects rather than
inventing `0000`.

**The S5 lock keys on the ADAPTER path, not the device path** — two devices on one
controller contend for the same radio. Refusal (`ADAPTER_BUSY`, naming the holder)
rather than a queue: a "Forget" queued behind a "Pair" completes by forgetting the
device that was just paired, seconds after the operator stopped looking. Boot reconnect
is sequential for the same reason, and latched to once per process.

**The stack's `bt_unavailable` is NOT the operator's answer, and BOTH the mutation path
and the read path have to re-apply the gate order.** `BluetoothStack` records an
operator-disabled device as `bluez_unavailable`, truthful from its own point of view and
the exact opposite fact to an operator. A card rendering `unavailable.cause` literally
would band "the Bluetooth service isn't responding" over a radio the operator switched
off two seconds ago. One documented divergence in the ladder: `emulated` is answered
*before* the preference gate, because telling someone to switch Bluetooth on when the
host has no radio is advice they cannot act on.

**All fourteen typed refusals render INLINE, so `osCommand` gets `classify: () => ({ok:true})`.**
A structured `{success:false}` must stay `ok` as far as the async-op store is concerned,
or the operator gets the reason twice — once inline, once uselessly in a toast. A
*thrown* RPC still takes the toast path, correctly. `bluetoothRefusalKey` is typed
`Record<BluetoothMutationRefusal, string>`, so a fifteenth refusal fails `tsc` rather
than reaching an operator as its own dotted path.

**Absent is not `false` for the persisted preference.** `read()` answers `undefined`
when the operator has never decided, and the boot reconciler does **nothing** for it —
otherwise the first boot after an update disables `bluetooth.service` on every board in
the field on the strength of a file nobody has written yet.

**Ordering contracts, all pinned by tests:** reconcile the units *before* observing
BlueZ (a field board's `bluetooth.service` is disabled by the old image policy, so the
bus name has no owner and observation would report broken hardware); subscribe *before*
snapshot; export the agent object *before* `RegisterAgent`; write the BlueALSA drop-in
*before* `bluealsa.service` starts.

**Known gap, deliberately not papered over:** the dev mock provider
(`mocks/providers/bluetooth.ts`) has **no consumer** — `getBluetoothStatusMessage()`
builds the live payload from the real stack with no `shouldUseMocks()` seam, so a
session booted on `bt-mic-paired` broadcasts the dev host's honest "Bluetooth is off".
The e2e specs drop-and-inject over the page socket
(`tests/e2e/helpers/bluetooth-wire.ts`) and keep the scenario annotation so wiring the
seam is a one-file deletion. A boot-the-mock-service parity test is owed with it.

