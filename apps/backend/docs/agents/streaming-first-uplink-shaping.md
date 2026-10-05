<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STREAMING-FIRST UPLINK SHAPING [PARTIAL — backend complete; image backstop + board drill pending]

`modules/network/uplink-shaper/` consumes `readDesiredSteeringState()` as the single
authority for which uplinks currently carry shared client traffic. Its explicit
idle/streaming machine is lifecycle-edge driven: stream start installs a conservative
bootstrap client cap before telemetry, stale telemetry holds, and stream stop removes
ceilings without waiting for telemetry absence.

The streaming hierarchy is root `prio`: tc band 1 is the design's zero-indexed
local band 0 and carries only `fq_codel`; tc band 2 is selected by the steering
`CLIENT_FLOW` fwmark/mask and alone receives CAKE `bandwidth`, or HTB `rate == ceil`
plus an `fq_codel` leaf when the bounded CAKE child apply is refused. AIMD uses RTT
inflation, NAK delta, and sustained client-child backlog on a 5 s cadence. All
constants are in `SHAPER_CONFIG`; current `bitrate_bps` is never treated as capacity.

Root ownership is fail-closed: recognized kernel defaults may be recorded and
replaced under reserved handle `ca00:`; that handle is restart-idempotent; a custom
foreign root produces `shaper_unavailable` before any mutation. Removed interfaces
and module shutdown restore their recorded roots. The persistent `uplink-shaper`
wire state reports the realized CAKE/HTB algorithm or `priorityDegraded: true` while
steering and sharing continue independently. Full command, ownership, controller,
failure, and netns proof is in [`../../docs/UPLINK_SHAPING.md`](../../../../docs/UPLINK_SHAPING.md).

## …AND THE TWO NAT LAYERS ARE WATCHED, NEVER ARBITRATED [EXISTS]

`modules/network/sharing-diag/` is the read-only coexistence diagnostic for the
two masquerade layers the shared-client path deliberately runs at once:
NetworkManager's own shared-mode NAT (the working FLOOR, which keeps the hotspot
usable even while the steering layer is down or degraded) and CeraUI's
per-uplink, `CLIENT_FLOW`-scoped NAT inside `inet ceralive_share`. It is the
sibling of `policy-route-check.ts` and inherits its discipline verbatim: an
indeterminate reading is withheld, never guessed, and the strongest verdict the
whole module can reach is `degraded` — nothing here gates a stream, an
interface, a bond or a mutation.

**IT IS READ-ONLY BY CONSTRUCTION.** Four readers, no writer: the NM config
files, `ip rule show`, `nft list ruleset`, and an `nmcli` enumeration of the
ACTIVE `ipv4.method shared` profiles. There is no apply, no rollback and no
teardown anywhere in the module, and a failed read degrades exactly ONE check.

**FOUR CHECKS, EACH AN EXPLICIT TRI-STATE** (`ok` | `degraded` | `unknown`), on
the `sharing_diag` broadcast (`@ceraui/rpc` `sharingDiagSchema`). `unknown` is
EMITTED, never expressed as an omitted field — the consumer merge preserves an
omitted optional, so a raise-only check is the `policy_route_missing` latch
again. The rollup is `degraded` ≻ `unknown` ≻ `ok`, so it can never claim `ok`
while a check is withheld.

| Check | `degraded` when | Withheld when |
|---|---|---|
| `firewallBackend` | no explicit `firewall-backend` pin (`firewall_backend_unpinned`) or an explicit non-`nftables` one (`firewall_backend_mismatch`) | no NM config file could be read |
| `steeringRules` | an owned fwmark rule runs at or before source routing (`steering_rule_shadows_source_route`) or off `FWMARK_RULE_PRIORITY` (`steering_rule_priority_drift`) | `ip rule show` unreadable or unparseable |
| `sharedNat` | an active shared prefix has no NM masquerade (`shared_nat_missing`) or more than one (`shared_nat_duplicated`) | ruleset unreadable, NM unenumerable, or a shared interface holds no address yet |
| `foreignTables` | `ceralive_ingest_fw` moved its declared hook/priority, or now carries CeraLive client-flow rules (`foreign_table_modified`) | ruleset unreadable, or the ingest firewall is not installed |

Six decisions carry weight, and each was the tempting wrong answer first:

- **A PRE-PIN IMAGE IS `degraded`, NEVER A MISMATCH AND NEVER AN ERROR.** The
  `firewall-backend=nftables` pin ships in the image (plan todo 12), so a device
  that predates it is a normal, expected state — it simply cannot be confirmed.
  It is also deliberately NOT resolved to NetworkManager's compiled-in default:
  what that default is depends on the daemon's build and on whether it found an
  `nft` binary at start-up, so substituting one would be a claim this reader
  cannot support.
- **THE SHARED PREFIX IS THE INTERFACE'S LIVE ADDRESS, never `10.42.0.0/24`.**
  NetworkManager picks a shared subnet itself unless `ipv4.addresses` is set, so
  the PROFILE usually states none — the profile answers WHICH interface is
  shared, and the netif map answers what prefix it actually leased. An interface
  that has not leased its gateway yet is INDETERMINATE, never missing NAT.
- **THE FLOOR IS IDENTIFIED BY TABLE PROVENANCE.** `ceralive_share` masquerades
  the same prefix by design, so a masquerade rule inside it can never stand in
  for NM's floor — the reader excludes the owned table before counting. A test
  removes NM's table and asserts the floor still reports missing.
- **THE ORDERING FLOOR IS THE HIGHER OF THE CONSTANT AND THE OBSERVED RULES.**
  `SOURCE_ROUTE_RULE_PRIORITY` is the contract, but an image whose own source
  rules moved must still be protected, so a steering rule legal against the
  constant alone and yet ahead of the real source rules is still a shadow.
- **AN ABSENT `ceralive_ingest_fw` IS `unknown`, NOT `degraded`.** The ingest
  gateway is operator-disable-able and is not provisioned on every image, so its
  absence is a statement about the IMAGE rather than evidence that the steering
  layer touched it. Only an installed table that no longer matches
  `FOREIGN_NFT_TABLES`' declared hooks — or that now carries client-flow rules —
  is degraded.
- **EVERY CONSTANT IS READ, NEVER RE-DERIVED.** `FWMARK_RULE_PRIORITY`,
  `SOURCE_ROUTE_RULE_PRIORITY`, `SHARE_TABLE`, `FOREIGN_NFT_TABLES`,
  `CLIENT_FLOW_NAMESPACE` and `UPLINK_MARK_MASK` all come from
  `uplink-steering/contracts.ts`, and the provenance-byte regex is BUILT from
  `CLIENT_FLOW_NAMESPACE` so a change to the mark layout cannot leave this reader
  hunting for a marker the steering layer no longer writes.

**Its `ip rule` reader is deliberately NOT a re-use of `route-policy.ts`.**
Those readers are scoped to `FWMARK_RULE_PRIORITY` because their job is to find
the rules the steering layer OWNS; this one must see a steering rule that has
DRIFTED off that priority, which is exactly the fault it exists to report. The
line shapes are the same and are shared by regex shape, not by import.

**Cadence + spawn class.** Its own `SHARING_DIAG_INTERVAL_MS` (30 s) `unref`'d
interval, `isRealDevice()`-gated, wired at boot through
`guardNonCritical("sharing-diag", …)`. `nft list ruleset` is registered
separately in `SPAWN_POLICY` as `network.nftRead` (**bounded-probe**), distinct
from the steering layer's `network.nft` (**bounded-command**) write: a read on
its own slow cadence has neither that site's caller nor its failure semantics,
and collapsing the two would let a future write inherit a read's justification.

**Wire registration is all four steps, deliberately.** Schema in
`packages/rpc/src/schemas/network.schema.ts`, event re-exported from
`rpc/events.ts`, a `case "sharing_diag"` + state slot + `getSharingDiag()` in the
frontend `subscriptions.svelte.ts`, and post-login hydration on the PRODUCTION
path — `buildInitialStatus()` plus an explicit emission in
`rpc/adapter.ts::sendInitialStatusToClient`, NOT the legacy `modules/ui/status.ts`
relay enumeration. The signal broadcasts on CHANGE only and its slowest input is
a 30 s poll, so a missed hydration leaves a fresh browser on the pre-check
all-`unknown` state indefinitely; `tests/sharing-diag-initial-push.test.ts` pins
both halves for the same reason `cpu-initial-push.test.ts` does.

**`checkedAt` is excluded from the broadcast change key**, or an identical
verdict would re-broadcast on every tick; the cached status still carries the
fresh stamp.

Coverage: `tests/sharing-diag.test.ts` (the verdict table — healthy, shadowed,
priority drift, duplicated NAT, missing NAT, missing backend pin,
foreign-table-modified, and every ambiguous arm, plus the nft reader's priority
spellings and its null contract), `tests/sharing-diag-ordering.test.ts` (the band
ordering, built ENTIRELY from the two constants — that file contains no priority
literal), `tests/sharing-diag-initial-push.test.ts` (both hydration halves and the
end-to-end shadowed-device wire proof), and the frontend half
`apps/frontend/src/tests/sharing-diag-ingestion.test.ts`.

**Honest status:** every fixture models captured device output; no verdict has
been produced against a real board's `nft list ruleset`. The image-side
`firewall-backend=nftables` pin this diagnostic checks for ships in plan todo 12,
so on today's images the `firewallBackend` check is expected to read
`firewall_backend_unpinned` — that is the tri-state tolerance working, not a
finding.

