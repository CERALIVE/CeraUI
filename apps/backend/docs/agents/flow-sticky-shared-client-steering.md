<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FLOW-STICKY SHARED-CLIENT STEERING [PARTIAL — backend complete; image carrier + board drill pending]

`modules/network/uplink-steering/` is the desired-state controller for hotspot and
Ethernet `shared-lan` client traffic. It owns only `inet ceralive_share`, the
priority-110 namespaced fwmark rules, and private route tables 30000–95535. The
image's `inet ceralive_ingest_fw` table (input hook priority -10) is foreign and is
never named by generated rule text. The carrier effects are isolated in
`modules/network/uplink-sharing.ts`: fsynced temp → `nft --check` → atomic rename
→ systemd start/reload, with prior-file reload on failure.

**Only forwarded client-zone traffic is steered or NATed, and only the client band
is ever capped. Preserve physical-identity marks and established flows.**
Everything below is how that is made structural rather than intentional. Wi-Fi
station / hotspot / hybrid transitions run under the permanent-MAC adapter lock
described in EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK. Ethernet `uplink` /
`shared-lan` changes and boot reconciliation share one promise chain per port.
The whole persist -> NetworkManager -> restore sequence completes before the next
operation on that port begins; other ports proceed independently. Reconciliation
reads the role again after taking ownership, and drained queue entries are removed.

**Client provenance is structural.** New-flow selection, conntrack mark restore,
and masquerade all require a positive registered client-zone `iifname`; NAT also
requires the zone prefix and the namespaced conntrack mark. There is no output
hook. A locally-originated packet therefore cannot enter this path even when its
source is inside a client prefix, and a WAN reply never restores the client flow's
mark and recirculates out the WAN.

**Marks are physical-identity keyed.** The high byte `0xca` proves client-zone
provenance, the next 16 bits select the uplink, and the low byte is preserved.
The fixed 10000-bucket verdict map uses largest-remainder apportionment. Reorder,
add/remove, and reweight never change a surviving mark, so established flows keep
their original route while only new flows see the new weights.

**The emitted nft syntax targets Debian bookworm's nftables 1.0.6.** A set
expression may read only one runtime mark when applying a bitwise OR, so save and
restore lift the known uplink value into a literal per-uplink statement; combining
`meta mark` and `ct mark` dynamically is forbidden even though newer nftables parses
it. Whole-table replacement is `add table` then `delete table`, never the newer
`destroy table`. Both rules are production compatibility constraints, not CI
workarounds; the packet low byte and conntrack high 24 bits remain byte-identical.

**A hard-down is three phases:** publish a transition ruleset excluding the mark
from new-flow selection while retaining its NAT/route support → delete conntrack
entries carrying exactly that mark → remove route support and publish the final
ruleset. The transient `uplink-flows-reset {iface,linkId}` follows successful
route removal and is never hydrated. `uplink-steering` is persistent and carries
the shared `@ceraui/rpc` typed availability/refusal state.

The coordinator is single-flight, re-reads the latest model before every apply,
skips byte-identical state, and retries a newly failing state at 100/500 ms.
After those retries fail, identical desired states leave the unavailable status
untouched and skip apply for 5 seconds. Each later failed apply doubles that delay
up to 60 seconds, with one apply per window. A different desired state or success
clears the backoff. On process restart it
inventories its priority-110 rules, publishes the latest model first, then flushes
and removes stale support. Any overlap, mark collision, foreign priority owner,
missing route, nft failure, or rollback failure is fail-soft and surfaces
`steering_unavailable`; it never blocks the already-bound WS server.

Keep committed steering through stale-route cleanup failures: sharing, provisioned
support and the forwarding step stay intact. The applier retains pending
retirements and warns once per distinct failure; the coordinator alone retries
them after successful, unchanged, or backoff-skipped reconciles. A pending
mark/table pair desired again by a successfully applied state is discarded without
a flush. The cleanup
snapshot advances only after forwarding succeeds and apply returns normally; a
failed activation cannot discard pending work. Before commit, a failed transition
restores removed support and reloads the previous ruleset before rolling new routes
back.

The CeraUI half is complete and kernel-netns tested. It cannot activate on a fleet
image until image-building todo 12 ships `ceralive-share.service`, its teardown
script, nftables/conntrack packages, and the CeraUI unit ordering. Full contract and
hardware gate: [`../../docs/UPLINK_STEERING.md`](../../../../docs/UPLINK_STEERING.md).

