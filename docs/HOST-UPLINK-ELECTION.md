# Repository-aware host uplink election

Status: **source/CI implementation; not hardware-qualified**.

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
  repository failure is logged, not relabelled as working TLS.
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

`gateways.ts` remains the host election coordinator. Its route transaction is in
`default-route.ts`, re-exported through the existing API. It first uses the
candidate's observed main-table DHCP default, with the existing named-table path
as a fallback; it never creates policy-routing tables. The complete route,
including its device and observed metric, is validated before defaults are
removed. Deletions are bounded to that snapshot. An apply failure attempts to
restore the snapshot and still fails; rollback failures are retained in the
typed error's cause. The other address family's defaults are untouched.

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
`gateway-route-repair`, `apt-gateway-precondition`, and `repository-probe-socket`
under `apps/backend/src/tests/`. The socket test runs real curl against private,
ephemeral loopback HTTP/TLS listeners with an ephemeral trusted certificate. The
route tests inject the OS runner and never mutate the workstation network.

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
