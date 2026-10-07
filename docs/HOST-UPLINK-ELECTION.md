# Repository-aware host uplink election

Status: **source/CI implementation; not hardware-qualified**.

## Update-specific transport selector (Todo 33; fixture-proven)

`modules/system/update-transport/` supplies a separate, stateless choice for a
single APT or OS-update job; it does not mutate or replace the host default-route
election below. Its pure core ranks complete per-uplink/per-family observations:
all required hosts must pass, non-metered before metered, then Ethernet, Wi-Fi,
dongle, cellular, then measured latency. `none` is a typed refusal. Each call
re-discovers the `netif` candidates, NetworkManager metering, ModemManager
interfaces and USB router classification and re-probes both address families.
No family choice or route preference is persisted. The NetworkManager reader
uses `GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.METERED` with `device
show`: `DEVICE,TYPE,STATE,GENERAL.METERED device show` is **invalid** on the
installed NetworkManager CLI (it mixes status and detail field names).

The APT profile checks the first-party HTTP 204/empty-body endpoint, the
mTLS `/__tls-probe` JSON (`certVerified:false` means credentials invalid, not
offline), and every configured Debian InRelease URI/suite pair with that stanza's
own `Signed-By` keyring. Debian hosts have no `/generate_204` endpoint. The OS
profile checks images' HTTP 204 endpoint and the channel/board `.json.sig` HEAD.
Resolution is interface-scoped with `resolvectl -i`, and curl connects to that
resolved address with `--resolve` while keeping the hostname for SNI and TLS
verification; each transfer binds with `--interface if!<name>`. Redirects are
never followed. Netns tests exercise real socket/TLS/GPG behavior against signed
fixture indexes and the two endpoint contracts. Add-on artifact fetches present
the fleet certificate only for the exact `apt.ceralive.tv` hostname, retaining
plain fetch for other hosts and devices with no credentials.

**Live verification against the real Todo-12-deployed `apt.ceralive.tv` is
deferred until Todo 12 deploys and provisions credentials.** This implementation
is fixture-proven; it is not a production network, certificate or hardware receipt.
The update orchestrator now exists (see
[DEVICE-UPDATES.md](./DEVICE-UPDATES.md)), and it adopted this selector for the
OS agent only. Every package transaction, on legacy and `apt-all-packages`
images alike, still uses the apt preflight and route repair described below.

## Transaction pin and failover (Todo 34; kernel-netns tested)

`update-transport/pin.ts` accepts the selector's ranked `(uplink, family)` pairs;
`pin-rules.ts` owns the kernel route/rule installation and crash cleanup.
Each attempt runs one **awaited job step** under a private UID policy rule. APT uses the
image capability file's `apt_uid`, RAUC streaming uses `ota_uid`; UID zero and
equal job UIDs are refused. A startup sweep runs once before update admission,
deleting owned priority-120 rules and both private tables after a crash. A
foreign rule at that priority refuses the sweep and leaves pinning disabled,
rather than deleting another owner's policy. For each attempt the chosen family
looks up table 100000 (APT) or 100001 (OS); the other family has a `prohibit`
rule for the same UID. The table copies the chosen interface's parsed default
route from the main or interface table and includes an unreachable fallback so
a lost DHCP route cannot fall through to the main table. Neither main-table
routes nor the shared-client steering rules/tables (30000–95535, priority 110)
are changed. The rules are removed and both table families flushed in `finally`
on **every** exit, including a partial setup or a throwing job. A transfer error
or timeout marks only that `(interface, family)` unhealthy for 15 minutes and
retries the next ranked clear pair, at most three attempts. Non-transfer errors
propagate without failover. Each APT callback receives exactly one per-invocation
`-o Acquire::ForceIPv4=true` or `ForceIPv6=true` option; nothing writes apt
configuration. The step must await the whole network transfer, not merely start
a detached process, before the pin is released.

### Who uses the pin (final state)

| Job | Caller | Pinned? |
|---|---|---|
| `os` (UID `ota_uid`, table 100001) | `checkOsChannel()` fetches the channel manifest and `.sig`; `stageOsBundle()` runs `rauc install` to completion | yes, both through `updatePinController.run("os", ...)` |
| `apt` (UID `apt_uid`, table 100000) | none | implemented and netns-tested, no production caller |

So the selector and the pin cover only OS transfers. A package check or install,
from the orchestrator or the Settings button, reaches the repository through the
host's default route after the awaited election and fresh family reading in
"Applying the election and admitting apt" below. The selector's last answer is
recorded by `recordTransportSelection()` for the Updates dialog's Connection
section. Stream admission (D8) and cellular policy are documented in
[DEVICE-UPDATES.md](./DEVICE-UPDATES.md).

The boot sweep is `updatePinController.sweep()`, called from `main.ts` after the
control server binds. Until it succeeds every pinned step is refused with
`sweep-required`.

**DNS is not pinned by `uidrange`.** The selector's probes already verify the
chosen uplink's own resolvers (`resolvectl -i`); this kernel rule controls the
job's sockets, not systemd-resolved's separate process. If a device uses a
direct upstream resolver reachable only over the *other*, prohibited family
(rather than the local `127.0.0.53` stub), the job's own DNS sockets cannot
reach it. The resulting name lookup failure is classified `dns-failed` and
fails over to another pair. That is an expected scope limitation, not permission
to remove the prohibit rule or to pin global DNS configuration.

The privileged two-veth namespace test executes curl under a test UID, proves
the non-selected uplink unreachable to that UID, drops the first link during a
transfer, observes failover, and dumps both real kernel rule families during
and after the transaction. It then leaves simulated crash rules behind and
proves the startup sweep removes them. This is not an on-device or live-origin
qualification.

## Policy change

This changes **host default-route selection policy**, not streaming/bonding or
forwarded-client steering. A NIC can answer the generic plain-HTTP connectivity
probe while resetting repository TLS before a certificate arrives. Previously:

1. The generic HTTP probe supplied no repository/TLS evidence; an unbound HTTP
   success also returned before considering candidates.
2. Election stopped at the first HTTP-successful eligible candidate.
3. Apt refresh stderr merely queued a fire-and-forget election. Repository
   preflight refusal returned before even reaching that trigger.
4. A thrown route installation still returned success, disarming queued retries.

The policy is now a **two-tier ranking**, not an eligibility filter:

- Prefer an eligible NIC that reaches every configured repository probe over
  verified HTTPS on one common address family. IPv4 wins a within-NIC tie;
  IPv6-only success selects an IPv6 route operation.
- If none passes, keep the first ordinary-connectivity-successful candidate.
  A sole TLS-impaired uplink therefore remains usable for host connectivity;
  its winning HTTP address family is retained for route application. Repository
  failure is logged, not relabelled as working TLS.
- The current IPv4 default is tried first; otherwise existing interface record
  order breaks ties. There is no LAN-over-cellular heuristic, weight, fixed
  metric, adapter identity, or NetworkManager route-metric controller.
- Existing eligibility exclusions remain. Repository failure does not mark a
  NIC down in the shared health model. HTTP success cannot bypass TLS ranking,
  and failure to resolve the generic probe domain cannot prevent repository probes.

Ranking rather than filtering matters when a repository is unavailable, the clock
or trust store is wrong, or the only uplink is impaired: none is permission to
strand the board by refusing every path. The scan stops on a top-tier success;
otherwise it examines the whole eligible set before accepting the HTTP fallback.

## One signal, one binding primitive

`apt-reachability.ts` keeps its existing deb822 reader, HEAD builder, curl
classification, dual-family fold, and time bounds. Its optional `ifname` composes
`device-bound-probe.ts::deviceBindingArgs`, using `--interface if!<name>` for
**every** candidate, including ordinary unique-address NICs. It retains the
configured hostname for DNS, TLS SNI and certificate verification; no CDN IP is
pinned. For the election only, legacy HTTP probe URLs use their HTTPS equivalent
without writing any apt source. An HTTP-only mirror may consequently cause fallback.

Each NIC's observation is uncached and cannot read or populate the unbound host
cache. Curl ignores `.curlrc` and proxy environment routing for repository probes
(`-q`, `--noproxy '*'`), so those cannot bypass the requested path or TLS checks.
There is no new probe implementation or new process runner.

**Probe attribution correction (F-R8-2).** Generic HTTP candidate probes now also
use `--interface if!<name>` for every eligible NIC, not only duplicate-address
twins. `localAddress` selected eth0's source address but did not constrain its
egress: the real kernel routes `from 192.168.78.131` through an owned WLAN 242/49
or foreign metric-zero winner. Unique addresses and simultaneous link-local/global
addresses do not require source-only binding. Repository probes already used
device binding; the old `from …` log described the generic probe, not repository
curl's binding. Both device-probe paths ignore `.curlrc` and proxy routing.
Probes never add routes/rules or change sysctls. Namespace packet-counter tests
prove actual eth0 egress with both competing route protocols and the dual-address
and duplicate-address fixtures, with route/rule dumps unchanged.

The raw Rock repository `ipv4 blocked` result is **not explained** by the generic
source-binding defect: it is an independently device-bound timeout. No raw packet
capture, curl argv/exit timing or `rp_filter` reading was retained on that board.
The host did not reproduce link-local source selection with device binding; strict
reverse-path filtering, DNS and concurrent arm changes remain unqualified causes.
This correction proves probe egress attribution, not that every timeout disappears
on the board. Re-drill the isolated impaired-WLAN and HiLink windows.

The existing probe semantics remain deliberately narrow: any HTTP response after
verified TLS (including 403/404/5xx) proves transport reachability, not package
availability. The first-party endpoint remains its public origin root rather than
the mTLS-protected index. Neither a client certificate nor an apt authentication
configuration is copied into curl. No redirects are followed.

## Applying the election and admitting apt

`gateways.ts` remains the host election coordinator. Its serialized route
entrypoint is in `default-route.ts`, re-exported through the existing API.
`default-route-inventory.ts` separates cleanup from candidate parsing,
`default-route-acquisition.ts` chooses the preference and checks main-table FIB
ordering, and `default-route-transaction.ts` applies and unwinds mutations.
`default-route-model.ts` owns parsed attributes and mutation serialization. It uses the
candidate's lowest-metric **foreign** main-table default, with the existing
named-table path as a fallback. An owned preference is never evidence that the
NIC still has a default. No policy-routing table or rule is created.

**F-ROUTE-1 ownership correction.** Protocols **242 and 243** are reserved exclusively for
CeraUI's host default preferences in the main table. Inventory uses `ip -N route
show default` for IPv4 and IPv6, so protocol ownership is numeric regardless of
local `rt_protos` aliases. A foreign route is never deleted, replaced, demoted,
or re-added: NetworkManager/DHCP/RA remains its owner, and every NIC retains its
own baseline route for the next bound probe. No NM profile is written.

**Exclusive protocol reservation is a deployment prerequisite, not independent
ownership proof.** No NetworkManager profile, DHCP hook, administrator or other
service may install a main-table default with either reserved protocol. A collision is treated
as CeraUI-owned: startup/release removes that row and reconciliation may replace
or retain it. There is no provenance discriminator beyond this reservation and
no safe automatic way to identify its actual author. Audit both families for
foreign use of 242/243 before deployment; resolve a collision through its real owner
before enabling this controller. Non-main defaults and the UID-pin tables are
outside this inventory.

When the elected NIC is already strictly lower-metric than every competitor,
no preference is needed. Otherwise the backend adds **one** marked default for
the winner at `lowest competing metric - 1`. The copy carries the observed
gateway, device, source address and onlink requirement, not the foreign protocol,
metric or RA expiry. A named-table import is marked too. Range validation occurs
before mutation; ambiguous named-table replies, multipath/source-specific competitors
in the elected family
and a link-down selected route refuse rather than inventing a routable copy.

Cleanup does not depend on that candidate gate. The inventory preserves multiline
multipath records and parses only marked defaults for release/startup sweep, so a
foreign source-specific or multipath default cannot strand an owned route. Delete
and rollback-add argv carry only parsed gateway, device, source, protocol, metric
and required `onlink`; kernel display flags such as `linkdown` and `dead`, RA
expiry and preference text are never replayed as mutation arguments. New rows
carry **no realm or classid**: the shipped RK3588 kernel has no
`CONFIG_IP_ROUTE_CLASSID` and erases those attributes. A legacy observed
`realm`/`realms` is range-parsed and retained only in its exact cleanup/undo
selector; it is never a generation mechanism. Unknown/duplicate owned attributes
refuse acquisition rather than being projected into a broader delete. Cleanup
records that row's error but still attempts other valid owned rows and families.

**IPv4 aliases, including the metric floor.** IPv4 always uses `prepend`, at
**any** metric: ordinary `add` fails EEXIST when another default occupies that
priority, even for another device/protocol. A competing metric-0 default
(including a DHCP default with no metric) is beaten by a metric-0 owned alias.
This changes equal-metric ordering without touching foreign rows. Acquisition
must prove that `ip -N route get 203.0.113.254 fibmatch` selects a **main-table default**
with the exact owned gateway/device/source/metric/onlink/protocol identity; omitted
table notation or numeric `table 254` is accepted, never another table's matching
copy. An acknowledged prepend is not
proof. No packet is sent. The documentation-range destination tests the default
FIB path; an overriding more-specific/policy route or unreadable FIB refuses,
never grants success. Every matching existing preference is retained only if
that same FIB check still chooses it. A foreign equal-metric prepend can therefore
trigger a staged generation replacement on re-election rather than silently retain
a losing row.

**Same-winner repair needs distinct kernel identities.** New preferences normally
use protocol 242. A same-identity IPv4 repair stages protocol 243 when an old
242 alias exists, or 242 when only 243 exists. Protocol is part of the kernel's
route identity and delete selector without an optional classid configuration.
Verification includes the staged protocol; deletion names the old protocol.
On rejection, only the staged generation is removed: an old preference between two
foreign equal-metric rows has not moved. Real-kernel experiments found exact duplicate
prepend refused, and `ip route replace` overwrote the first foreign alias rather than
targeting the old owned row; neither is used as a shortcut.

If several generations match the desired identity, the proven FIB winner stays
in place and the other rows are swept. An identical-tuple same-protocol prepend
is still EEXIST; the fake models this, along with ordinary duplicate-priority add.

**IPv6 limitation (explicit).** A metric-1 competitor still returns typed
`GatewayRouteError(reason: "metric-exhausted")` before mutation: Linux normalizes
metric 0 to 1024, and equal-metric IPv6 prepend can merge a nexthop into a foreign
multipath default. IPv6 never uses prepend. Resolve this limit through an
owner-directed baseline/policy decision, not competitor edits by this path.

IPv4 stages and verifies a distinct replacement **before** removing equal-priority
obsolete defaults. A stale owned route at a **lower** priority would mask that
proof; it is retired first only when the snapshot supplies a safe restoration
operation. IPv6 retires same-family owned rows **before ordinary add**, because its prepend
merges nexthops instead of staging an independent alias. IPv6 also requires a
main-table default FIB proof (`2001:db8::ffff`, no packet sent).
An unchanged winner performs zero mutations while its preference still wins.
The metric depends only on current
foreign routes, never earlier preferences, so election flaps cannot ratchet it.
An acquisition failure undoes completed commands in reverse order across both
families and still rejects; rollback failures survive in the typed aggregate
cause. Restoration is derived from the **ordered snapshot**, never from metric 0
alone: a sole IPv4 snapshot peer uses **prepend**, not add, because the staged
replacement may still occupy that priority at undo time. A sole IPv6 peer uses
add only after reverse-order undo removes its same-family staged replacement.
With foreign equal-metric peers, the sole owned IPv4 first/last endpoint uses
prepend/append. The protocol-pair stage leaves an interior old row untouched
on verification rejection. IPv6 tied or multiple-owned peer groups have no
assumed restoration operation. At
most one unrestoreable row may be removed as the final command, after all verification
and reversible deletions; more than one, or a later acquisition, refuses before mutation.
Acquisition refuses unsupported rollback shapes before mutation with typed
`rollback-order-unavailable`; this gate never applies to release. No foreign
anchor is edited to make rollback possible.

**Release is forward-only, never rollback-admitted.** Empty election, natural
failback, startup and shutdown attempt every safe owned selector in both families,
even with several interior crash rows. Successful deletions are not resurrected.
Read, parse and delete failures are aggregated and reported; the next sweep
retries remaining residue. Legacy tagged selectors precede realm-zero wildcards;
if a tagged deletion fails (or that tagged row is retained), a matching wildcard
is withheld with an error so it cannot delete a different legacy generation.
New protocol generations do not have this ambiguity.

**Natural failback hysteresis (F-R8-1).** While an owned preference is held,
each serialized gateway sweep also device-probes repository HTTPS on the lowest
metric **foreign** defaults in the held family. Every tied foreign winner must
be eligible and healthy in that family: probing only the current owned winner
could never discover recovery, and releasing onto an unprobed tied peer is unsafe.
Three consecutive completed healthy sweeps spanning at least **10 seconds** are
required. A failed/unknown result, changed owned/foreign inventory, missing candidate,
backwards clock or observation gap exceeding **30 seconds** resets the streak.
Use the monotonic completion clock; immediately before release re-read both
families' inventories and evaluate the final clock again. The wrapper keeps
maintenance queued while a preference remains, including while the natural path
is still impaired, so recovery does not depend on another operator Check.

The trade-off is a short, bounded recovery dwell rather than immediate failback:
three observations and ten seconds prevent a one-off success or rapid Check clicks
from bouncing the route, at the cost of briefly retaining a Wi-Fi/metered winner.
There is no bandwidth/cost ranking or persistent preference state. An ordinary
HTTP-only natural path does not count as recovered while repository HTTPS remains
unusable; the existing connectivity fallback remains available if the elected
path fails. With no continuing sweeps, failback latency has no wall-clock guarantee.
Both-family residue, unsupported foreign shapes and topology churn refuse automatic
failback rather than guessing the post-release path. The streak is process memory
only; crash cleanup is still the existing 242/243 startup sweep.
Recovery's snapshot key uses routing path/protocol/metric identity, never legacy
realm/classid display metadata; the target kernel drops those attributes. Legacy
metadata stays confined to the existing exact cleanup selectors. A real-kernel
host test changes only a retained foreign realm and proves recovery does not reset.

Recovery invokes **release**, not acquisition of the natural NIC: all safe owned
selectors in both families are retired forward-only with no rollback resurrection,
metric ratchet, foreign-route mutation or new rule/table. It does not claim atomicity
against a NetworkManager renewal after the final inventory check. Real-kernel
gateway regressions prove the recovered FIB and unchanged foreign defaults/rules,
as well as reset on impairment, topology drift, a stale gap and rapid Checks.

The sequence is not crash-atomic or locked against NetworkManager. Exact ordered
rollback assumes successful undo commands and no concurrent foreign/topology change;
failed undo reports uncertainty, not success. IPv6 and stale-lower-priority
retirement have a short foreign-baseline interval; normal IPv4 generation
staging retains the old preference. A renewal after proof may overtake the owned
alias until the next election; no multi-command lock against NM is claimed.

`gateway-route-lifecycle.ts` sweeps marked crash residue before its first
election (also wired as the noncritical `host-route-preference` boot step), joins
startup callers and retries a failed sweep on the next apply. Every election
reconciles even if the observed default already names the winner. An empty
election releases the preference, including after interface removal. SIGTERM /
SIGINT cleanup closes admission, drains submitted route writes and releases
owned defaults before backend exit; a late election cannot recreate them.
Abrupt death is handled by the next startup sweep, not by an exit-time promise.
Foreign defaults in either family remain byte-identical to the observed baseline.

**Legacy residue cannot be safely auto-repaired.** The prior demotion code left
unmarked `proto dhcp` metric copies, indistinguishable from routes owned by NM.
The protocol sweep deliberately leaves them alone. Re-drills must start from an
owner-established clean baseline rather than treat startup as legacy cleanup.

The updater returns false on failed application and re-arms maintenance. Concurrent
callers join one in-flight promise, which releases on every outcome. Apt's explicit
request bypasses the queued scheduler's rate/no-work shortcuts, not its serialization.

Refresh, read-only discovery, and detached installation all await the same
`prepareAptNetwork` precondition: await election/application, then take a **fresh
unbound** repository/family reading. Failed repair refuses apt with the existing
`repos_unreachable` result. The stderr fire-and-forget trigger is removed; stderr
still controls the existing refresh retry cadence. The next operation always
performs awaited admission instead of relying on that earlier hint.

The existing per-run family option reaches apt unchanged. No persistent ForceIPv4
setting, sandbox-user change, TLS/hostname/signature/date-verification bypass,
destination exception, or interface argument to apt is introduced. The installing
apt transaction remains a PID-1-owned transient service.

## Evidence and limits

Regression suites: `repository-uplink-election`, `gateway-repository-policy`,
`gateway-route-repair`, `gateways-migration`, `default-route-ownership`,
`default-route-lifecycle`, `default-route-edge`, `default-route-oracle`,
`default-route-kernel`, `default-route-board`, `default-route-parser`, `gateway-route-lifecycle`,
`apt-gateway-precondition`, and `repository-probe-socket`
under `apps/backend/src/tests/`. The socket test runs real curl against private,
ephemeral loopback HTTP/TLS listeners with an ephemeral trusted certificate. The
socket suite also reproduces a peer that accepts TCP and resets immediately after
ClientHello without sending a certificate, while serving HTTP successfully. The
route unit tests drive a mutable route-table fake through the OS
runner seam and never mutate the workstation network. They cover foreign-route
preservation, minimum-metric selection, repeated elections, family changes,
crash sweep, removal/release, shutdown races, rollback failures and 512 seeded
random winner/family/release transitions. Every transition asserts the intended
winner and exact preference presence/family/metric independently of the route
builder, as well as preservation and metric bounds. `default-route-rollback` covers
ordered fake/FIB observations, rejected staging with and without prior ownership,
endpoint undo, interior protocol-generation repair, nested rollback failures,
final-command retirement failure and main-table-only verification. The private
table fixture copies an owned row from the **unfiltered** numeric dump, because
`show default proto 242` suppresses the protocol token and would make this proof
vacuous. Strict board-mode fakes erase realms/classid and reproduce EEXIST and
ESRCH with nonzero exit codes. Kernel regressions include Rock-shaped and
Wi-Fi/modem A→B→A switches in both families, 100 unchanged floor elections,
carrier loss, and real product children SIGKILLed at each ordinary transaction
mutation boundary. Recovery drives start/apply/release/stop through the same API.

`default-route-kernel.test.ts` probes `unshare -Urn` availability and launches
the Bun test process itself in a fresh user/network namespace for each scenario.
The injected runner executes plain `ip` commands inside that namespace; the real
`setDefaultRoute` and lifecycle code run over dummy/veth links. Tests prove the
metric-zero FIB winner, unchanged re-election, equal-metric foreign reorder,
failback/re-acquisition/release, and carrier-loss cleanup at all three lifecycle
boundaries. Source-specific and real multiline multipath IPv6 dumps do not block
startup/release. Two additional regressions reject a third-uplink election behind a
more-specific verification route with the full ordered `ip -4 route show table all`
dump and unrelated `ip route get 8.8.8.8 fibmatch` byte-identical, and refuse a
destination-rule-selected matching protocol-242 copy in table 100001. On a host
refusing user/network namespaces these NEW cases skip
with the probe's stated stderr reason; fixture tests remain mandatory. The original six
kernel scenarios passed on Linux 7.2.9 / iproute2 7.2.0 using Bun 1.4.2 on
2026-10-06, without sudo; the new counterexamples were reproduced against that source
before correction. All eight scenarios passed after correction on the same host on
2026-10-07, including exact ordered rollback and non-main-table refusal. An additional
kernel control confirmed one mutation across 100 unchanged elections, protocol-qualified
release with equal gateway/device/metric, and DHCP delete/re-prepend recovery on the
next election. This proves kernel mechanics, not RK3588/NM/DHCP
behaviour. Existing opt-in privileged netns suites are unchanged.

Board re-drills remain owed on BOTH Rock 5B+ and Orange Pi 5+, from an
owner-established clean foreign-route baseline: C2a failback/C9 restoration,
flapping elections, carrier loss, shutdown/restart sweep, IPv4/IPv6 selection,
HiLink no-metric recovery, APT admission, UID-pinned OS transport coexistence
and Wi-Fi second-uplink arms. No board was contacted for this correction.

Non-vacuity was checked by temporary behavioral mutations: removing HTTPS caused
the resetting peer to pass; returning the first HTTP success elected the impaired
NIC; detaching the apt repair let family probing run before route completion and
admitted a failed repair; returning true after a refused route write disarmed the
next retry. Each mutation failed its targeted regression and was restored before
the passing run. The IPv6-only fallback additionally failed before its winning
family was retained.

Not covered or claimed:

- No board contact, deployment, hardware qualification, image build, package
  publication, or fleet retrofit. Board build `f3c52d5` lacks the existing apt
  family probe; this fix ships forward from released-source baseline `7b53288`.
- No proof of mTLS authorization, authenticated index/payload fetches, repository
  signatures or contents. Apt remains responsible for those checks.
- The existing reader covers deb822 `.sources`, not legacy `.list` files, custom
  apt proxy transports, or per-source trust configuration. DNS uses the system
  resolver; `--interface` binds transfer sockets, not resolver traffic.
- No new candidate inventory: addressless NICs remain excluded, including an
  IPv6-only NIC absent from the existing netif IPv4 inventory.
- No continuous TLS monitor, full-transaction route lease, cross-process route
  lock, or crash-atomic netlink transaction. NetworkManager/topology can change
  after admission; an OS/rollback refusal remains a reported failure, not a promise
  of recovery. Equal-tier ranking is intentionally not bandwidth/cost optimization.
- Streaming bind maps, `uplink-steering`, `uplink-shaper`, and retired SRTLA
  source-policy routing are untouched.
