<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AN EXCLUDED DEFAULT ROUTE IS NOT A CONNECTIVITY VERDICT [EXISTS]

`updateGw` (`modules/network/gateways.ts`) probes the Internet through the
current default route and, on failure, re-probes each interface before electing
a new one. The decisions it makes are the pure
`modules/network/connectivity-candidates.ts`; the effects (spawning `ip`,
issuing probes, raising/retracting `no_internet`) stay in `gateways.ts`.

**The kernel elects a default route from whatever DHCP hands it, including an
interface CeraUI has already excluded.** Board-confirmed on a Rock 5B+ carrying
the duplicate-MAC HiLink pair (two physically distinct dongles, one factory MAC,
both leasing `192.168.8.100`): their lease installs `default via 192.168.8.1 dev
enx0c5b8f279a64` with NO metric — metric 0, outranking `eth0`'s metric 101 — so
every probe went out an interface `NETIF_ERR_DUPIPV4` had already suppressed from
the bond, hit the dongle's captive `307`, and raised **"No Internet connectivity
via the default connection, re-checking all connections…"** while `eth0` answered
a clean `204`. The operator saw a standing offline warning on a device with four
working paths.

- **`probeExclusionReason(entry)`** is the single eligibility rule: a netif error
  (`NETIF_ERR_DUPIPV4` / `NETIF_ERR_HOTSPOT`) or no address disqualifies an
  interface. **`enabled === false` deliberately does NOT** — it is overloaded
  (the error flags set it, but so does the operator toggling a link out of the
  BOND), and "do not send bonded video over this link" is not "this link may not
  be used to check for Internet". Both error flags already imply `enabled:
  false`, so nothing dup-IP or hotspot escapes through that.
- **`decideConnectivityClaim`** returns `default-failed` (the elected default
  route is eligible and failed — the original message, unchanged),
  `no-eligible` (nothing is probeable, so there is no re-check to promise; this
  outranks every other arm), or `suppressed` (the default route sits on a
  known-excluded interface — say nothing, re-elect).
- **`suppressed` NEVER escalates**, even when every candidate probe then fails.
  A candidate probe steers by SOURCE ADDRESS, which selects a route only where
  the kernel supports policy routing — and this board's does not: `ip rule show`
  answers `Operation not supported`, `curl --interface eth0` (device-bound)
  returns 204 while the same request bound to eth0's ADDRESS times out, and
  `ip route get <addr> from 192.168.78.132` still resolves via the excluded
  dongle. A failed probe there is evidence about STEERING, not about
  connectivity, so claiming the device is offline would swap one false alarm for
  another. It is logged at `warn` instead, and the excluded interfaces are
  already surfaced with their reasons on the Network page.
- **`httpGet` now honours `localAddress`.** It accepted the option, threaded it
  through `HttpGetOptions`, and dropped it in its destructure — so every
  "per-interface" probe silently egressed the CURRENT default route and the
  fallback loop re-tested the very path that had just failed. Bun's `fetch` has
  no source-address option, so a BOUND probe goes through `node:http` (the one
  sanctioned exception to this app's `fetch`-only rule; the unbound probe still
  uses `fetch`, so the existing suite is unaffected). Do not "restore" the
  convention here.
- **An IPv6 literal is bracketed** (`formatUrlHost`) before it reaches a URL.
  `www.gstatic.com`'s AAAA records each produced an
  `Internet connectivity HTTP check error ERR_INVALID_URL` before the probe ever
  left the device.
- **The gateway check races ONE address per family.** From DNS's complete result,
  it selects the first A and first AAAA, starts A immediately, starts AAAA 250 ms
  later, and settles on the first success. Each underlying probe keeps the existing
  4 s bound, so two dead families settle in about 4.25 s instead of serially
  spending 4 s on every resolved address. A probe carrying an explicit
  `localAddress` skips a target from the other family; the device-bound
  `curl --interface` path deliberately keeps both because that binding names only
  an interface and has no separate family concept. This race is local to gateway
  election and is not shared with the independent apt-reachability probes.
- **The notification is retracted on PROVEN CONNECTIVITY, not on route
  installation.** `setDefaultRoute` reads a per-interface routing table and the
  shipped image provisions those only for `modem0-7`/`wlan0-4`, so on a board
  reaching the Internet through `eth0` it fails with "table id value is invalid"
  — and the old code, which retracted only after a successful install, left "No
  Internet connectivity" standing over a working link. The claim is about the
  DEVICE's connectivity; an eligible interface answering `204` settles it, and
  the route install is attempted afterwards and merely logged on failure.

Coverage: `tests/connectivity-exclusion-aware.test.ts` — the exclusion table
(incl. the operator-disabled negative), the candidate list against the board's
real roster, the `ip route show default` parser against the board's verbatim
output (metric ordering, `dev`-only routes, no-`dev` and empty negatives), the
claim matrix in all four arms, the no-escalation lock, and a REAL-socket proof
that a bound probe egresses the address it was given (the defect type-checked, so
a mocked assertion could not catch it); `tests/gateway-family-race.test.ts` — the
Rock dead-IPv6 topology, IPv6-only success, both-family failure bound, and the
source-address-vs-device-bound family split.

## …AND A PROBE THAT MUST NAME A DEVICE BINDS ONE [EXISTS]

The section above ends the "blame the default connection" false alarm by
EXCLUDING the duplicate-IP twins from the probe set. That was right while the
only steering CeraUI had was a source address — and it left the twins with no
connectivity verdict at all, which the bond now needs: todo 11 made them
BONDING-ELIGIBLE, so a link the device is willing to send video over was one it
refused to ask about.

**Two addresses, and neither one names a twin.** The bench pair ships ONE factory
MAC, both lease `192.168.8.100`, and both answer their admin API on the SAME
`192.168.8.1`. So a SOURCE address selects a pair, and a DESTINATION address
selects a pair. `SO_BINDTODEVICE` is the only thing that selects a device, and
`curl --interface` is the only client on this box that speaks it —
`router-cellular-admin.ts` already needed exactly that to read two different
serials off the two units, so this is that proven pattern applied to the WAN
question rather than a second mechanism.

`modules/network/device-bound-probe.ts` is that probe, and the split it feeds is
the connectivity twin of todo 11's bonding split:

| Question | Rule | Dup-IP answer |
|---|---|---|
| may it be a generic SOURCE-IP? | `probeExclusionReason` | still **NO** — unchanged, and a test asserts it |
| may it be probed AS A DEVICE? | `deviceBoundProbeExclusionReason` | **YES** |

`probeBindingFor` returns the binding a candidate must be probed with, so
`ProbeCandidate` now carries `binding` and `electConnectivityCandidate`
(`connectivity-election.ts`) dispatches on it. Every non-dup-IP interface keeps the
byte-identical `localAddress` probe.

- **A DEVICE-BOUND PROBE IS PER DEVICE, AND THAT IS THE POINT.** Two interfaces
  holding one address get two INDEPENDENT verdicts, so a WAN outage behind one
  twin marks that twin unreachable and leaves its sibling electable. A
  source-address probe could only ever have answered for the pair.
- **ADMIN REACHABILITY IS NOT WAN TRUTH, and neither may stand in for the
  other.** A SIM-less HiLink answers its own `192.168.8.1` happily and
  captive-portals everything else — board-measured, as an `apt-get` that fetched
  the dongle's error page. So the probe targets ONLY the externally-resolved
  check address and demands the exact `204` + EMPTY BODY contract; a `307` portal
  page and a `204` that carried a body are both unreachable. No gateway, admin
  URL or LAN address is ever a probe target, and a test asserts the probe-target
  set equals the resolved address set.
- **FAIL-SOFT, because it is a new binary dependency.** A missing/failing `curl`,
  a timeout, or a non-204 all resolve `false`: the interface loses an election
  round, which is byte-identical to the behaviour before dup-IP links were
  probeable at all. It never throws into the 2 s gateway loop. Registered in
  `SPAWN_POLICY` as `connectivity.deviceBoundProbe` (bounded-probe): curl's own
  `--max-time` inside a `spawnWithTimeout` outer cap.
- **The ifname reaches argv as its OWN element**, guarded by `SAFE_IFNAME_RE` —
  which `router-cellular-admin.ts` now imports instead of keeping a second copy,
  so the two `curl --interface` sites cannot disagree. Its first character
  excludes `-`: `--upload-file` is otherwise a well-formed member of the old
  character class and curl would read it as a flag rather than as the value of
  `--interface`.
- **The `suppressed` claim is untouched.** `decideConnectivityClaim` still reads
  `probeExclusionReason` for the DEFAULT route, so a default route sitting on a
  dup-IP dongle still withholds the offline claim rather than blaming the device.

### THE TWIN-GATEWAY ELECTION (two × `192.168.8.1`)

Which twin's `192.168.8.1` does a probe talk to? **Neither — a probe never dials
it.** The election is decided by the socket's DEVICE binding, and the route that
follows is installed BY DEVICE:

- `setDefaultRoute` reads a PER-INTERFACE table (`ip route show table <ifname>`),
  so the line it gets back already belongs to that device;
- `parseDefaultRouteLine`/`buildRouteAddArgv` replay EVERY token of that line, so
  the `dev <ifname>` clause survives into `ip route add` verbatim — two twins
  produce two DIFFERENT argvs from two identical `via` addresses;
- `parseDefaultRouteInterface` reads the `dev` clause, never the gateway.

Do NOT "simplify" `buildRouteAddArgv` to a `via`-only form, and do NOT identify
an uplink by its gateway address anywhere on this path.

**Honest status:** no claim here has been exercised against a real twin-modem
board. Every fixture models the contract. Coverage:
`tests/connectivity-device-binding.test.ts` (argv binding, the 204/portal/killed
response table, per-twin independence, the WAN-down-on-one-twin fixture, the
never-dial-the-gateway assertions, and the unchanged ordinary roster) +
`tests/connectivity-exclusion-aware.test.ts` (both exclusion rules on one
roster).

## …AND AN INFERENCE THAT CANNOT NAME A DEVICE IS WITHHELD [EXISTS]

`policy-route-check.ts` matches a rule's `from <srcip>` back to an interface.
That is a source-IP inference, and it holds only while an address names ONE
interface. `ambiguousSourceIps` measures the exception off the live snapshot —
every address held by more than one interface, counting DISABLED holders too,
since a disabled twin still owns the address that makes its sibling's rule
unattributable — and `derivePolicyRouteMissing` WITHHOLDS a verdict for it (and
for a source that dispatches to several tables) instead of guessing. The
withheld interface reports as un-flagged, never as "checked and faulty": a fault
claim about an interface the check cannot identify is a guess, and the condition
that produces it already has its own operator-visible band.

It is measured from the SNAPSHOT rather than read off `NETIF_ERR_DUPIPV4` for
two reasons: `network-interfaces.ts` imports this module, so importing the flag
back would cycle; and the flag lags the condition (a station↔AP transition, a
suppressed pair) while the snapshot does not.

**MEASURED, and worth knowing before you reason about this check: the bench
HiLink twins are NOT in its candidate class at all.** They enumerate as
`enx0c5b8f279a64` and `eth1`, and the class is `wlan|usb|ww` plus the netns
veth — `enx*` is deliberately excluded (the NM dispatcher maps only
`enx*0`..`enx*7`) and `eth*` never was. So this check has never published a
verdict about a twin and the amber band cannot be attributed to one. The
ambiguity guard is therefore about any same-address pair INSIDE the class — two
same-model `usb*` modems on a vendor-default lease — and about todo 14's `.link`
renaming prototype, which could move cellular NICs into it. A fixture that uses
the twins' real names asserts nothing; a test pins that fact so it is not
re-derived wrongly.

**The `dg<N>h` netns branch is REMOVED (phase-C todo 39).** Todo 13 isolated the
naming convention behind one predicate precisely so that retiring the image's
router-dongle netns layer would be a single deletion here, and todo 39 made it:
`isNetnsDongleVeth` and `DONGLE_VETH_RE` are gone, and `dg*` is no longer in the
bonded class, so it is no longer a candidate and no verdict about it can be
published. Do NOT re-add it. An OLD-image board caught mid-retirement can still
be holding a `dg0h` veth WITH its source rule installed — that state belongs to
the image's own teardown path (`ceralive-dongle-netns-retire.service`), not to a
check whose dispatcher no longer has an opinion about the interface, and flagging
it amber would report a layer being removed as a routing fault. Coverage:
`tests/policy-route-check.test.ts` — the ordinary / dup-IP / no-netns matrix, the
withhold cases, the twins-out-of-class pin, the retired-seam locks, and a
STALE-netns board (its `dg0h` rule still in the fixture, its table deliberately
default-less) getting the control's verdict and never being queried.

