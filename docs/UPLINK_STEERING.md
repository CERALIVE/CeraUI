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
- fwmark rule priority: `110`, after steering-owned source rules at priority `100`
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

`uplink-steering/route-table-ownership.ts` owns managed table provisioning,
partial-failure rollback, and flushing; `route-manager.ts` coordinates route
discovery and the source/fwmark rule lifecycle.

Existing usable foreign source-routing tables are reused without claiming them.
Every supported uplink class (`wl*`, `usb*`, `eth*`, `en*`/`enx*`, `ww*`, and
`ppp*`) without a source rule gets a private, identity-derived table. A table
matching that identity remains steering-owned on re-plan for every interface
class, so teardown removes its owned support. A priority-100 source rule is added
only when the source address is unique; duplicate-address links use their own
fwmark tables without an ambiguous source rule.

Never-created tables are empty observations only when iproute2 returns numeric
exit code 2, whitespace-only stdout, and an exact IPv4 or IPv6
`FIB table does not exist` diagnostic. Reads require `Dump terminated`; flushes
require `Flush terminated`. CRLF is normalized and surrounding whitespace is
trimmed before matching stderr. Planning and provisioning can then install the private
default route before its rules. Restart discovery retains an owned rule even if
its table never existed, and removal or rollback accepts the same proven absence
when flushing. Permission errors, timeouts, unrelated diagnostics, and partial
route output still fail preparation. Manual table routes are unnecessary for
this cold-start case.

APT ownership retains its separate, unchanged legacy absence contract. It does
not inherit steering's exit-code, stdout, or flush-diagnostic policy.

Provisioning compares a managed table's default device, gateway, protocol, and
metric with the planned route. Managed plans prefer the interface's live
main-table default, including when an existing source rule already selects the
managed table. If that query succeeds with empty output, an existing usable
managed default selected by the source rule is retained, as before; query errors
still fail planning. Without that existing support, an absent live default fails
preparation.

A gateway or protocol change at the same metric uses one `ip route replace`.
Different metrics are distinct kernel route keys, so a metric change adds the
desired route before deleting the exact old route. Rollback restores the old
route before deleting the added replacement. A failed add leaves the old route
untouched; a failed old-route deletion removes only the new route. The table
always retains a default during these successful writes, and each completed
change or rollback leaves one default. Neither path flushes or touches another
uplink's table. An identical route needs no replacement and, when its rules
already exist, reports no change.

When a managed table has one plain default on another device, a failed reload
restores that replaced route and its attributes instead of flushing the table,
including when the replacement changes the metric. Multiple-default and
TOS-specific inventories retain their existing behavior.

For `ip -4 route show default dev <ifname>`, iproute2 omits the `dev` clause.
The planner supplies that query's interface when absent and rejects a conflicting
`dev`; unfiltered table output must explicitly name the matching interface.

Image-building-pipeline PR #115 removed the dispatcher source rules. The stale
policy-route self-check, its netif field, mock provider, and warning band are
retired. Its pure parsers now live in `uplink-steering/route-parsers.ts`.
The unused `network.collision.policyRouteTitle/Body` translations and frozen
rendered fixtures remain unchanged. The steering refusal reason
`policy_route_missing` remains valid for actual route preparation failures.

An occupied foreign rule at priority 110, a route table with no usable default,
overlapping client/uplink prefixes, a client zone that remains a bond candidate,
or a stable-mark collision produces a typed `steering_unavailable` state rather
than a guessed route. Preparation still succeeds or fails as a whole.

On backend restart, the module inventories its namespaced priority-110 rules. It
publishes the latest ruleset first, then flushes conntrack and removes stale rules
and private tables. Desired mark/table support is retained even when the old route
temporarily lacks an interface name.

Recovery also inventories priority-100 source rules in managed tables, including
source-only support left by a crash. Planning ignores stale managed references
before checking foreign-table ambiguity; provisioning removes obsolete source
rules and restores them on rollback. Cleanup retries retain each source rule
independently while desired support remains protected by mark and table.

An in-place interface rename retains the continuing identity's table and fwmark
rule without flushing its flows, including when final ruleset publication fails.
Route retention matches identity, table, and mark; the interface name is mutable.
A departing identity still follows the hard-down drain below.

Once the latest ruleset is committed, a stale-route cleanup failure keeps the live
ruleset and newly provisioned routes intact, completes the forwarding step, and
logs each distinct failure once. Failed retirements remain in memory. After every
successful, unchanged, or backoff-skipped reconcile, the coordinator retries their
conntrack flush and route removal without degrading the applied state. A pending mark/table pair
that becomes desired again is dropped without flushing it. A backend restart
rediscovers any remaining stale support.

## Hard-down drain

A hard-down uplink is retired in three phases:

1. reload a transition ruleset that excludes its mark from new-flow selection but
   keeps route/NAT support for existing flows;
2. delete only conntrack entries carrying that uplink mark;
3. remove the fwmark rule, any module-owned source rule/private table, and then
   publish the final ruleset.

Conntrack's numeric exit 1 is successful only when stdout is whitespace-only and
stderr contains solely its versioned `0 flow entries have been deleted.` summary.
An empty mark is already drained. Other exits or diagnostics retain the original
failure and prevent retiring route support.

After successful route removal the backend emits transient
`uplink-flows-reset { iface, linkId }`. It is never post-login hydrated. Persistent
state uses `uplink-steering`: either `{state:"available"}` or
`{state:"steering_unavailable", reason, detail?}`. Both shapes are defined in
`@ceraui/rpc`.

The coordinator is single-flight, recomputes the latest desired model before each
apply, skips byte-identical models, and retries a newly failing state twice at
100/500 ms. Only after those retries fail does it record backoff for that desired
state. Reconciles with the same state skip apply for 5 seconds and leave the
published unavailable status untouched; pending cleanup still runs. Later failures
get one apply per window, with the delay doubling to a 60-second cap. A different
desired state or a success clears the backoff. Failure is
fail-soft: the WebSocket server is already bound, boot continues through
`guardNonCritical`, and the typed unavailable state remains visible.
If an apply fails after publishing the transition but before committing the final
state, the applier restores removed support and reloads the previous ruleset before
rolling back newly provisioned routes.

## Verification

`apps/backend/src/tests/uplink-steering-route-kernel.test.ts` probes unprivileged
user/network namespaces and re-executes itself in a fresh namespace. It first
proves the raw read rejects for a never-created table and records the exact flush
reply, then exercises planning, provisioning, teardown, and orphan-rule recovery
through the real command runner. A skipped namespace probe is not kernel proof.

- Ruleset snapshots cover 0, 1, 2, 3, and 6 uplinks and every client-zone shape.
- Unit tests pin mark stability, fixed-modulus apportionment, route ownership,
  atomic publication/rollback, bounded retries, restart recovery, and hard-down
  ordering.
- `uplink-steering-netns.test.ts` loads every golden shape with real nftables and
  proves weighted first-flow selection, established-flow stickiness, reweighting,
  drain-window exclusion, mark-scoped conntrack deletion, reply routing, local-flow
  NAT isolation, and foreign-table survival.
- This test measures a REAL weighted packet distribution through a real netns +
  nftables setup, so its statistical bound (`ratio < 5.5` against a 4:1 weight
  target) only holds with CPU headroom — bundled inside the ~5400-test backend
  suite it is load-sensitive (observed at 5.667 locally under parallel load and
  5.897 in CI's bundled run). It gates on `CERALIVE_NETNS_ISOLATED=1` via
  `describe.skipIf`, so it skips inside the bundled `Unit tests (bun)` step and
  runs instead in its own dedicated `netns-semantics` CI step
  (`.github/workflows/build-check.yml`, `test-be` job) after the main suite. Run
  it locally with
  `CERALIVE_NETNS_ISOLATED=1 bun test apps/backend/src/tests/uplink-steering-netns.test.ts`.

The outstanding board drill needs two real uplinks and a hotspot client. It must
inspect nftables/conntrack marks while confirming SRTLA link distribution remains
undisturbed.

## Known-down recovery

`UplinkHealthEngine` keeps an already-down path down on `passive_degraded` or
`captive_portal`. Both observations reset consecutive success evidence without
lifting the path into steering. An up path can still become degraded on either
observation.

For an already-down path, any observed removal, re-addition, address change or
device-bound eligibility change discards counted successes and restarts the
15-second hold-down synchronously at the interface event. This also applies when
the interface changes and returns entirely between health ticks or during a
probe batch. In-flight evidence from the old generation remains invalid.
The same events do not change an up path's health state.

A missing interface retains its down verdict and resets its recovery streak, so
brief reappearance still requires five fresh successful probes. Normal health
ticks prune missing down records 24 hours after the interface was last seen.
At most 32 missing records are retained; excess records are evicted in order of
longest absence. A pruned interface that reappears is treated as brand-new, using
the existing initial-up behavior. These two bounds limit history under interface
churn without forgetting brief disappearances.
While streaming, down paths use active probes at the existing five-second cadence
instead of passive sender metrics. They rejoin only after the existing five-success
and 15-second hold-down requirements are met. Other streaming paths continue to use
passive telemetry without active probes.

Model and steering-selection regressions live in
`apps/backend/src/tests/uplink-steering-state.test.ts`; all three recovery paths
are covered in `apps/backend/src/tests/uplink-health-recovery.test.ts`.

## Asynchronous health observations

Health rounds snapshot candidate addresses and interface generations before resolving the probe target. The runtime synchronously advances an interface's generation on network-interface events that remove it, change its address or change its device-bound eligibility. This rejects old evidence even when removal/re-addition or an address/eligibility change returns to the original state entirely between health ticks. Before each batch and before recording its results, the runtime checks the generation, current address and device-bound eligibility. A newer observation for that interface or a completed newer round supersedes older evidence. Starting another pending round alone does not discard valid slow evidence; counters, bond selection and equivalent entry replacement do not advance generations. Removed-interface sample bookkeeping is retired after completed rounds without reusing generations. Deferred-resolution, probe and batch regressions live in `apps/backend/src/tests/uplink-health.test.ts`; between-tick event regressions live in `apps/backend/src/tests/uplink-health-interface-generation.test.ts`.
