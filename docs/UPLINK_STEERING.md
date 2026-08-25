# Shared-client uplink steering

**Status:** `[PARTIAL]` — the CeraUI backend and kernel-namespace regression gate
exist. The image-owned `ceralive-share.service`, teardown script, and runtime
packages land in image-building todo 12. Real-board validation remains hardware-gated.

## Scope

This subsystem steers only traffic that entered through a registered client zone:
a concurrent hotspot AP interface or an Ethernet port in `shared-lan` mode. It does
not steer locally originated traffic, does not alter SRTLA's device-bound sockets,
and owns no foreign nftables table.

The implementation lives in
`apps/backend/src/modules/network/uplink-steering/`. Its carrier effects live in
`apps/backend/src/modules/network/uplink-sharing.ts`.

## Ownership

- nftables table: `inet ceralive_share`
- desired-state file: `/run/ceralive/share.nft`
- carrier: `ceralive-share.service`
- fwmark rule priority: `110`, after the image's source rules at priority `100`
- fixed weighted-selection modulus: `10000`, apportioned by largest remainder
- foreign image table: `inet ceralive_ingest_fw`, input hook priority `-10`

The module publishes a complete nft batch and asks systemd to start/reload the
carrier. Ordinary reweights use `reload`; they never restart or stop the unit.
Sharing-off uses `stop`, whose image-owned `ExecStop` is the crash/shutdown
backstop. A temporary file is fsynced, checked with `nft --check`, then atomically
renamed before systemd sees it. A failed reload restores the prior file and reloads
that prior state.

## Flow identity and NAT

The mark layout is `0xca | stable 16-bit uplink slot | preserved low byte`:

- `0xff000000` proves client-zone conntrack provenance;
- `0xffffff00` selects the uplink route;
- `0x000000ff` remains available to another mark consumer.

The stable slot is derived from physical uplink identity, never array position, so
adding, removing, reordering, or reweighting links does not move established flows.
Only a new conntrack flow entering a positive client-zone `iifname` match runs the
weighted verdict map. Established client-direction packets restore their route mark
from conntrack. Reply packets entering from a WAN interface do not, preventing WAN
recirculation.

The generated syntax targets the device's Debian bookworm nftables 1.0.6, not a
developer host's newer parser. Conntrack save and restore are expanded per
route-supported uplink so each bitwise OR combines one runtime mark with one literal
mark; no set-statement expression reads both `meta mark` and `ct mark`. Full-table
replacement uses idempotent `add table` then `delete table`, because bookworm also
predates `destroy table`. These expansions preserve the packet mark's low byte and
the conntrack mark's high 24-bit uplink identity exactly.

Masquerade requires all three facts: the client-zone ingress interface, the
client-zone source prefix, and the namespaced conntrack mark for the selected
uplink. A host-originated packet therefore cannot enter this NAT path even if it
uses an address inside a client prefix.

## Route support

Existing usable source-routing tables are reused. The module provisions a private,
identity-derived table for otherwise-unmapped `eth*`, `en*`/`enx*`, `ww*`, and
`ppp*` uplinks. It adds a priority-100 source rule only when the source address is
unique. Duplicate-address links keep their existing device-bound behavior.

A Wi-Fi/USB route the image was expected to provision is refused when the
policy-route self-check says it is missing. An occupied foreign rule at priority
110, a route table with no usable default, overlapping client/uplink prefixes, a
client zone that remains a bond candidate, or a stable-mark collision produces a
typed `steering_unavailable` state rather than a guessed route.

On backend restart, the module inventories its namespaced priority-110 rules. It
publishes the latest ruleset first, then flushes conntrack and removes stale rules
and private tables. Desired mark/table support is retained even when the old route
temporarily lacks an interface name.

## Hard-down drain

A hard-down uplink is retired in three phases:

1. reload a transition ruleset that excludes its mark from new-flow selection but
   keeps route/NAT support for existing flows;
2. delete only conntrack entries carrying that uplink mark;
3. remove the fwmark rule, any module-owned source rule/private table, and then
   publish the final ruleset.

After successful route removal the backend emits transient
`uplink-flows-reset { iface, linkId }`. It is never post-login hydrated. Persistent
state uses `uplink-steering`: either `{state:"available"}` or
`{state:"steering_unavailable", reason, detail?}`. Both shapes are defined in
`@ceraui/rpc`.

The coordinator is single-flight, recomputes the latest desired model before each
apply, skips byte-identical models, and retries twice at bounded delays. Failure is
fail-soft: the WebSocket server is already bound, boot continues through
`guardNonCritical`, and the typed unavailable state remains visible.

## Verification

- Ruleset snapshots cover 0, 1, 2, 3, and 6 uplinks and every client-zone shape.
- Unit tests pin mark stability, fixed-modulus apportionment, route ownership,
  atomic publication/rollback, bounded retries, restart recovery, and hard-down
  ordering.
- `uplink-steering-netns.test.ts` loads every golden shape with real nftables and
  proves weighted first-flow selection, established-flow stickiness, reweighting,
  drain-window exclusion, mark-scoped conntrack deletion, reply routing, local-flow
  NAT isolation, and foreign-table survival.

The outstanding board drill needs two real uplinks and a hotspot client. It must
inspect nftables/conntrack marks while confirming SRTLA link distribution remains
undisturbed.
