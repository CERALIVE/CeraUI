<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AN UNCHANGED TICK MUST BE A NO-OP [EXISTS]

`lib/rpc/value-identity.ts` (`isSameWireValue` / `preserveWireIdentity`, pure and
rune-free) is the rule `subscriptions.svelte.ts` applies before publishing
replace-whole and merged snapshots. Every broadcast is `JSON.parse`d, so a
snapshot whose fields did not move still arrives as a brand-new object graph.
`status`, `sensors`, `device-stats`, `encoder-load`, and partial-map `addons`
updates now follow the same identity-preserving rule as `modems` and `netif`:
identical wire values retain the previous public getter reference, while any
changed value publishes a new one. This removes the idle 5 s invalidation of
every `$derived` beneath those feeds without changing status preserve-on-omission,
stop-edge clears, or netif field/key authority.

All subscription slots that hold replace-whole wire objects or immutable merged
snapshots use `$state.raw`. Ingestion replaces those slots; it never mutates a
published snapshot in place. Scalar lifecycle/connection slots remain ordinary
`$state`, where deep proxying is irrelevant.

- **Equality is STRUCTURAL, not shallow.** A shallow compare cannot preserve
  anything here: `modem.status` and `modem.router_admin` are freshly parsed
  objects on every tick, so a reference check on them always differs. The wire is
  Zod-parsed plain JSON — no cycles, no class instances — so a bounded recursive
  compare is both correct and cheap.
- **The key set stays AUTHORITATIVE.** Identity preservation applies to ENTRIES
  and to the map only when the key COUNT also matches; an id or ifname the frame
  stopped publishing is still a change, and `netif-modem-staleness.test.ts`
  remains the contract for that half. Do not "simplify" the length check away.
- **Merge semantics stay authoritative.** Status still preserves omitted optional
  fields and still applies explicit false/null retractions plus the
  `active_encode`/`linkTelemetry` stop-edge clears. `addons` remains a partial map
  merged by id; identity preservation never turns it into a replace-whole feed.
- **This is not what made the row unclickable** (see the disclosure contract
  above) — it is the wasted-work half of the same report, and it is measured as
  such, not assumed.

## …AND THE ROW IS KEYED ON ITS ROSTER ID [EXISTS]

`CellularSection`'s `{#each}` is keyed on `id` — the modem map's own key, unique
by construction, and already what the row's disclosure state is filed under
(`openDetails[id]`). It used to be `modem.ifname || id + '-' + index`, and both
halves of that fallback are remount triggers: the bench HiLink twins ship ONE
factory MAC between them so they rename against each other
(`enx0c5b8f279a64` ↔ `eth1`) on replug, which SWAPS two rows' keys and makes
Svelte destroy and rebuild both — discarding their open disclosures and detaching
whatever the operator was reaching for — and an `ifname` that appears or
disappears flips a row between the two halves. Do not key a row on an interface
name anywhere; that is the same lesson `linkRowKey` already carries for
`BondedLinksSection`. Coverage: `CellularSection.density.test.ts` → "a row
survives its interface being renamed".
