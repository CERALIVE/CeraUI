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

The existing probe semantics remain deliberately narrow: any HTTP response after
verified TLS (including 403/404/5xx) proves transport reachability, not package
availability. The first-party endpoint remains its public origin root rather than
the mTLS-protected index. Neither a client certificate nor an apt authentication
configuration is copied into curl. No redirects are followed.

## Applying the election and admitting apt

`gateways.ts` remains the host election coordinator. Its serialized route
transaction is in `default-route.ts`, re-exported through the existing API;
`default-route-model.ts` owns the parsed route model. It first uses the
candidate's lowest-metric **foreign** main-table default, with the existing
named-table path as a fallback. An owned preference is never evidence that the
NIC still has a default. No policy-routing table or rule is created.

**F-ROUTE-1 ownership correction.** Protocol **242** is reserved exclusively for
CeraUI's host default preferences in the main table. Inventory uses `ip -N route
show default` for IPv4 and IPv6, so protocol ownership is numeric regardless of
local `rt_protos` aliases. A foreign route is never deleted, replaced, demoted,
or re-added: NetworkManager/DHCP/RA remains its owner, and every NIC retains its
own baseline route for the next bound probe. No NM profile is written.

When the elected NIC is already strictly lower-metric than every competitor,
no preference is needed. Otherwise the backend adds **one** marked default for
the winner at `lowest competing metric - 1`. The copy carries the observed
gateway, device, source address and onlink requirement, not the foreign protocol,
metric or RA expiry. A named-table import is marked too. Range validation occurs
before mutation; ambiguous named-table replies, multipath/source-specific defaults
and a link-down selected route refuse rather than inventing a routable copy.

There is a real representability limit: IPv4 cannot beat a metric-0 competitor;
IPv6 cannot beat metric 1 because Linux normalizes metric 0 to 1024. Those cases
return typed `GatewayRouteError(reason: "metric-exhausted")` with no mutations,
not a falsely successful election. They require an owner-directed baseline or
policy decision; this path never edits a competitor to create room. The bench
baselines (Rock Ethernet 50, OPI Ethernet 100, Wi-Fi 600) have room. No kernel
qualification of those limits or the new preference is claimed by host tests.

Reconciliation removes only marked obsolete defaults, including an old-family
preference when the winning family changes, then installs the new one. An
unchanged winner performs zero mutations. The metric depends only on current
foreign routes, never earlier preferences, so election flaps cannot ratchet it.
An apply/release failure undoes completed commands in reverse order across both
families and still rejects; rollback failures survive in the typed aggregate
cause. The command sequence is not a crash-atomic netlink transaction, and a
switch has a short baseline-routing interval between delete and add.

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
`default-route-lifecycle`, `default-route-edge`, `gateway-route-lifecycle`,
`apt-gateway-precondition`, and `repository-probe-socket`
under `apps/backend/src/tests/`. The socket test runs real curl against private,
ephemeral loopback HTTP/TLS listeners with an ephemeral trusted certificate. The
socket suite also reproduces a peer that accepts TCP and resets immediately after
ClientHello without sending a certificate, while serving HTTP successfully. The
route unit tests drive an exact-token mutable route-table fake through the OS
runner seam and never mutate the workstation network. They cover foreign-route
preservation, minimum-metric selection, repeated elections, family changes,
crash sweep, removal/release, shutdown races, rollback failures and 512 seeded
random winner/family/release transitions. This is injection proof, not execution
of the kernel's route-selection algorithm. Existing opt-in privileged netns
suites are unchanged; no new sudo or namespace privilege is required.

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
