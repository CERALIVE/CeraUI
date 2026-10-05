<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## NETWORK COLLISION SURFACING + POLICY-ROUTE SELF-CHECK [EXISTS]

Two informational/warning netif signals surface interface-topology issues WITHOUT ever
gating a stream or an interface — both ride the existing 5 s `netif` broadcast.

**`same_subnet_group`** (additive-optional `string`,
`packages/rpc/src/schemas/network.schema.ts` `netifEntrySchema`): the CIDR (e.g.
`"192.168.0.0/24"`) shared by two-or-more DIFFERENT-IP interfaces on the SAME subnet
(computed synchronously in `apps/backend/src/modules/network/network-interfaces.ts`
`netIfBuildMsg()`). This is NOT an error — bonded links commonly share a subnet via policy
routing. The AP/hotspot interface is excluded via the existing `dupIpSuppressedIfaces`
transition marker + `NETIF_ERR_HOTSPOT` confirmed-state marker (no new hotspot-detection
code). Distinct from — and computed AFTER, so excluded from — the existing dup-IP detection
(`NETIF_ERR_DUPIPV4`).

**`policy_route_missing`** (additive-optional `boolean`, same schema, **TRISTATE**):
flags a bonded wifi/modem interface (`/^(?:wlan|usb|ww)/`) whose `ip rule`/
`ip route` tables are missing a default route — the policy-routing self-check
(`apps/backend/src/modules/network/policy-route-check.ts`) found the interface is
enabled + IP-bearing but its source-routing table has no default route. Computed via an
async `ip rule show` / `ip route show table <t>` spawn (`isRealDevice()`-gated, degrades
to `null` on any parse/spawn failure), cached and polled on the netif interval, attached
synchronously in `netIfBuildMsg()` via a `Set<string>` cache
(`refreshPolicyRouteFlags`/`getPolicyRouteVerdict`) — mirror this cache+poll+sync-getter
split for any future async-derived netif flag; a purely-sync-derivable flag should instead
compute in place like `same_subnet_group`. Table numbers are NEVER hardcoded — derived
from `ip rule show` / `ip route show`, matching image-building-pipeline's
`dispatcher.d/90-srtla-wifi-routing` convention.

**This field is emitted as an explicit `false`, NOT omitted, whenever the check
completed.** It is present-only-when-true's counter-example, and the asymmetry is
load-bearing: the frontend netif merge deliberately PRESERVES an omitted optional
field (`subscriptions.svelte.ts`), so a flag that is only ever published as `true`
can be raised but never retracted. That latched the amber band in a live operator's
session — `wlan0` was flagged while it was a bonded station, then switched to
AP/hotspot mode, which correctly drops it from the bond (`setNetifHotspot` →
`enabled: false`) and correctly stops it being a check candidate; the backend went
quiet and the band stayed up with `ip rule list` carrying nothing but the three
kernel defaults. `getPolicyRouteVerdict()` returns the tristate — `true`/`false` are
both authoritative, `undefined` only for an indeterminate check — and absence is
reserved for "no verdict this tick". Do NOT collapse `undefined` into `false`, and
do NOT re-narrow the emitter to true-only. Any FUTURE additive netif flag that can
RECOVER needs the same treatment; `same_subnet_group` shares the latent latch (it is
a calm info band, so it was left alone deliberately).

**Frontend surfacing** (`apps/frontend/src/main/network/CollisionBands.svelte`, mounted in
`NetworkView.svelte` right after `BondedLinksSection`): a CALM info band
(`bg-status-info/10`, `data-testid="same-subnet-info"`) lists the shared CIDR(s); an AMBER
warning band (`bg-status-warning/10`, `data-testid="policy-route-warning"`) fires when any
interface carries `policy_route_missing`. Both are static/CSS-only (e-ink-freeze safe).
i18n: `network.collision.*` (10 locales). **NEVER gate an interface or a stream on either
signal** — both are informational/warning only.

