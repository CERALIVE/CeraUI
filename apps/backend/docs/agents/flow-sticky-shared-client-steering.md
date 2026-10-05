<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FLOW-STICKY SHARED-CLIENT STEERING [PARTIAL — backend complete; image carrier + board drill pending]

`modules/network/uplink-steering/` is the desired-state controller for hotspot and
Ethernet `shared-lan` client traffic. It owns only `inet ceralive_share`, the
priority-110 namespaced fwmark rules, and private route tables 30000–95535. The
image's `inet ceralive_ingest_fw` table (input hook priority -10) is foreign and is
never named by generated rule text. The carrier effects are isolated in
`modules/network/uplink-sharing.ts`: fsynced temp → `nft --check` → atomic rename
→ systemd start/reload, with prior-file reload on failure.

**The invariant in one sentence: only forwarded client-zone traffic is steered or
NATed, and only the client band is ever capped.** Everything below is how that is
made structural rather than intentional. Every mode transition that can create or
retire a client zone — station / hotspot / hybrid, and the Ethernet `uplink` /
`shared-lan` role — runs under the one permanent-MAC adapter lock described in
EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK, so a zone can never be registered
against a half-applied adapter state.

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
skips byte-identical state, and retries at 100/500 ms only. On process restart it
inventories its priority-110 rules, publishes the latest model first, then flushes
and removes stale support. Any overlap, mark collision, foreign priority owner,
missing route, nft failure, or rollback failure is fail-soft and surfaces
`steering_unavailable`; it never blocks the already-bound WS server.

The CeraUI half is complete and kernel-netns tested. It cannot activate on a fleet
image until image-building todo 12 ships `ceralive-share.service`, its teardown
script, nftables/conntrack packages, and the CeraUI unit ordering. Full contract and
hardware gate: [`../../docs/UPLINK_STEERING.md`](../../../../docs/UPLINK_STEERING.md).

