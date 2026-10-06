<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE ETHERNET PORT ROLE — UPLINK OR SHARED LAN [EXISTS]

`modules/network/ethernet-role.ts` (leaf: persistence + the candidate rule),
`ethernet-role-transition.ts` (the NM transition + boot reconcile) and
`ethernet-role-outcome.ts` (the ONE frame builder) let an operator declare a
wired port either an ordinary bonding `uplink` or a `shared-lan` router port
that serves DHCP/DNS to LAN clients via NetworkManager's `ipv4.method shared`.

**The persisted key is `config.eth_roles`, keyed by IFNAME, and absent means
`uplink`.** An untouched device is byte-identical to before this landed, and the
boot reconciler acts on a stated `shared-lan` only — re-writing `ipv4.method
auto` onto every ordinary port at boot would touch profiles nobody asked us to
touch. The ifname key is the ONE defensible instance of name-keying in this
directory: `wifi_modes` keys on a permanent MAC because a radio's name follows a
udev rename, but this is not a claim about a DEVICE — it is an operator
statement about a SOCKET, and the NM profile it drives is itself bound by
`connection.interface-name`, so the two agree by construction.

**`NETIF_ERR_SHAREDLAN = 0x08` is the exclusion mechanism**, stamped by
`applySharedLanBondGate` in the same two places, and for the same reasons, as
`applyConcurrentApBondGate`: `isBondCandidate` refuses the port structurally so a
caller holding a hand-built entry is covered, and the gate stamps the flag into
the netif map so the wire, `probeExclusionReason`, the connectivity election and
the same-subnet grouping inherit the exclusion through the flag they already
read. It runs on EVERY pass, beside its two siblings — a role flip moves no
interface, address or counter, so a topology-gated stamp would never fire.

**It is the ONE gate here that also RELEASES.** The SIM-less gate clears its flag
and deliberately leaves `enabled` false, because a SIM reappearing is a hardware
event the operator did not ask for. A flip back to `uplink` IS the operator
asking for the port to bond again, and the flag is the only thing that lowered
`enabled` — so releasing it undoes its own effect, honouring a separate bond
opt-out and leaving the port down if any other error still stands.

**The transition is persist-first with rollback**, on `wifi-adapter-mode`'s
terms: the role is written before NM is touched (so a device that dies
mid-transition comes back trying for the operator's role) and RESTORED the moment
NM refuses, so a failed flip leaves neither the config nor the netif flags
half-applied. Every exit path publishes exactly one terminal `eth_role` frame,
preceded by exactly one `pending` frame on an admitted transition; the
already-applied branch publishes its terminal frame directly, because nothing was
dispatched and no NM answer will ever settle.

**Wire shape** (`@ceraui/rpc` `network.schema.ts`), frozen for the frontend role
UI:

```ts
netifEntry.ethRole?: 'uplink' | 'shared-lan'   // EXPLICIT on every ethernet row
rpc.network.setEthernetRole({ name, role })    // input is .strict()
  -> { success, applied?, error? }             // ethernetRoleErrorSchema, 5 members
broadcast "eth_role" -> { eth_role: { name, role?, pending?, success?, error? } }
```

`ethRole` is published EXPLICITLY on every ethernet row, `uplink` included —
never present-only-when-shared. The consumer merge preserves an omitted optional
field, so a one-directional role could be raised and never lowered (the
`policy_route_missing` latch, exactly). ABSENT means "not an ethernet port, or an
older backend", and is never read as `uplink`. Frontend ingestion allowlist:
`subscriptions.svelte.ts` `case "netif"`.

**The UI STAGES the role and applies it on Save; none of the above changed for
it.** `setEthernetRole` is now called from `NetifDialog.save()` alone rather than
from the role control's own click, because a role change reconfigures the port
and can drop the LAN path the operator is reading the page over. That is purely a
consumer-side decision: same procedure, same `.strict()` input, same persist-first
rollback, same one-pending-then-one-terminal frame contract. Do NOT add a
"staged" or "deferred" notion to this module — the device applies what it is told,
when it is told. Frontend contract: `apps/frontend/AGENTS.md` → "The wired port
ROLE is STAGED, and Save is its ONLY dispatch site".

**A shared-lan port registers as a client zone for the steering layer, and
NOTHING installs a table.** The nftables client-zone work is the steering
module's (HALTED pending the Wave-0 kernel-capability verdict); this todo marks
the port and extends the READ-ONLY policy-route check only.

Coverage: `tests/ethernet-role.test.ts` (driven through the REAL
`processIfconfigOutput`, `genSrtlaBondEntries` and
`configureNetworkInterfaceProcedure`), `tests/network-mutation-action-guard.test.ts`
(the S7 device half), frontend `tests/netif-eth-role-ingestion.test.ts` (both
directions).

### …AND THE POLICY-ROUTE CHECK NOW COVERS WIRED UPLINKS, ON WEAKER TERMS [EXISTS]

`collectEthernetPolicyRouteCandidates` adds `eth*`/`en*` to the check with
`flagWhenRuleAbsent: false`, and that flag is the whole contract. The image's
routing hooks map `usb*`/`enx*` onto tables 100-107 and `wlan0-4` onto 120-124
and NOTHING else, so a plain `eth0` has no per-uplink table at all — "no source
rule" is the documented steady state, not a fault, and flagging it would amber-band
every correctly-working wired uplink in the fleet (the same reason `enx*` was
excluded from the bonded class outright). What a wired candidate CAN be judged on
is a rule that EXISTS whose table has no default route — the fault todo 9's
steering module would produce once it installs one.

- **`collectPolicyRouteCandidates` is UNCHANGED**, deliberately: its answer is
  the dispatcher-mapped class, a contract other code and its tests read directly.
  The two classes are collected separately because they are judged differently.
- **An ethernet candidate on an ambiguous address is dropped BEFORE the spawn** —
  it could only ever be withheld, and asking `ip` a question whose answer is
  already known costs a spawn on the 5 s netif cadence for nothing. It is also
  what keeps the bench-twins case spawning zero `ip` calls.
- **A `shared-lan` port is excluded for free**: the netif gate lowers its
  `enabled`, and the collector already requires an enabled interface. A port
  serving its own clients is not an uplink and has no source-routing to verify.

