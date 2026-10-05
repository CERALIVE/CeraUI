<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DURABLE PER-ADAPTER HOTSPOT IDENTITY [EXISTS]

A hotspot's SSID and password are generated **once per physical adapter and
reused forever** — across station↔hotspot switches, backend restarts, and
reboots. Before this, every start took the "no hotspot connection yet" branch
and minted a new pair; a test device accumulated six NetworkManager profiles
(`Hotspot`, `Hotspot-1` … `Hotspot-5`) with six different SSIDs and passwords,
none of which the operator's phone had been told about consistently.

**Discovery runs BEFORE generation.** `startHotspotLocked`
(`wifi-hotspot-activation.ts`) resolves the profile to activate in this order:
the in-memory `hotspot.conn` → `findHotspotConnForAdapter()` → generate. The
lookup (`wifi-hotspot-discovery.ts`) is deterministic, never name-guessing: the
persisted UUID first, then the profile whose `802-11-wireless.mac-address` binds
it to this exact permanent address, and only as a last resort a profile matching
the persisted SSID (for profiles written before the MAC binding was
trustworthy).

**The repair must land BEFORE the activation.** `hotspotProfileFields(permMac)`
is re-asserted with `nmConnSetFields` and only then is the profile brought up —
a profile carrying a randomized binding is one NetworkManager will refuse, so
activating first and repairing after (the old order) fails every time. This also
removes the misleading `result="fail"` audit line that used to accompany every
otherwise-successful start.

**`hotspot_credentials.json` is the BACKSTOP, not the source of truth.**
NetworkManager's own `.nmconnection` files remain primary. The store
(`modules/wifi/hotspot-credentials.ts`, atomic JSON per
`docs/CONFIG_PERSISTENCE.md` — **not** SQLite) exists for the one case
NetworkManager cannot cover: a profile deleted out from under CeraUI. The
credentials are then reused to recreate an identical hotspot rather than mint a
new identity. It is written on generation (**before** activation, so a start
that dies mid-flight cannot strand credentials the UI already displayed), on
adoption (`handleHotspotConn`), and on operator rename
(`reconfigureHotspotLocked` — otherwise a later recreate would restore the stale
generated pair). Writes are inert until `initHotspotCredentials()` runs, so a
unit test that never opts in cannot litter the working directory.

**Duplicate consolidation requires POSITIVE ownership evidence, and ABSENCE is
never evidence.** `pruneDuplicateHotspotConns()` runs best-effort after a
successful start (never blocking or failing it) and deletes a profile only when
ALL of the following hold: its uuid is one the credential store positively
claims, no adapter is currently using it, and it is still an AP-mode profile
carrying the nmcli-generated id (`Hotspot`, `Hotspot-N`).

The claim is computed by `collectSupersededHotspotConns()` — the union of every
adapter's current `conn` and its `previousConns` history, MINUS every adapter's
current `conn`. So a profile that is some adapter's live identity is protected
even when that adapter also appears in another's history, and a uuid the store
has never seen is simply unknown and always survives.

The retired rule also deleted a generated-name AP profile "bound to an address
no present adapter has". That reads absence as abandonment, and a temporarily
unplugged (or not-yet-enumerated) radio looks exactly like it — so the cleanup
could destroy the SSID and password an operator's phone already knew, with the
credential backstop above powerless to help because the profile it points at was
the thing deleted. There is now no code path in which a profile is deleted
because something is missing.

**The name pattern is a narrowing filter, never evidence.** An operator who runs
`nmcli device wifi hotspot` themselves gets the same `Hotspot-N` id and can pick
the same `CERALIVE_`-shaped SSID. Neither is ours to delete, and neither appears
in the store.

**This is why the store keeps a history at all.** It holds ONE current `conn` per
adapter, so a profile that CeraUI itself superseded would otherwise carry no
evidence and become permanently undeletable. `previousConns` (`string[]`, oldest
first, capped at `PREVIOUS_CONNS_LIMIT` = 8, drop-oldest) records the retired
uuid whenever `conn` is REPLACED — one known uuid giving way to a different known
one. Every other write leaves it untouched, so the failure direction is
forgetting evidence (the profile becomes unknown, hence undeletable) rather than
inventing it. It is maintained by the store; a value passed to
`rememberHotspotCredentials` is ignored.

**Schema migration is version 1 → 2.** A v1 file (no `previousConns`) loads
unchanged and gains an empty history at load (`migrateEntry`); saves write
`version: 2`. The reader accepts both versions, so a downgrade mid-rollout still
parses.

**Side effect worth knowing:** with the binding correct, `autoconnect=yes` +
`autoconnect-priority=999` finally work, so a hotspot left on now survives a
reboot. `wifiHotspotStop` still sets `autoconnect=no`, so a hotspot turned off
stays off.

Coverage: `tests/wifi-hotspot-identity.test.ts` (permanent-MAC ladder, first-ever
generation from the permanent suffix, restart reuse with zero profile creation,
recreate-after-external-delete, repair-before-activate ordering, multi-adapter
isolation across a restart, store round-trip, deterministic lookup, and the four
prune negatives). Rule E proof captured in both directions: neutering the
discovery-before-generation step reddens 5 tests; swapping the repair/activate
order reddens the ordering test alone.

