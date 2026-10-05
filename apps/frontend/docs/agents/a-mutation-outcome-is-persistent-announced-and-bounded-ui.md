<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A MUTATION OUTCOME IS PERSISTENT, ANNOUNCED, AND BOUNDED (UI pass 2) [EXISTS]

`DESIGN.md` §8 opens with the rule this section enforces: *an outcome the
operator cannot see is an outcome that did not happen*. Three modem-surface
mutations were failing it in three different ways, and one component and one
state machine now carry all of them.

**`lib/components/custom/MutationOutcomeBand.svelte` renders BOTH halves, and
that is the whole point of it being one component.** A persistent visible band
plus the two sr-only live regions, from one call site — because shipping either
half alone is exactly what happened before. `RouterDongleDialog` answered every
router write with a `toast`, which on a PESSIMISTIC surface (where a refused
write correctly leaves the control unmoved) was the ONLY thing separating
"refused" from "never attempted" — and it expired in seconds. The GPS and FCC
toggles rendered their failures as a bare `<p>` with no role and their successes
as nothing at all, so an operator using a screen reader flipped a switch and
received silence. Six properties are load-bearing:

1. **BOTH REGIONS MOUNT UNCONDITIONALLY (LR-1)** — outside every `{#if}`, with
   the surface rather than with the outcome. A region created when the answer
   arrives announces nothing, which is the commonest silent failure here.
2. **THE VISIBLE BAND CARRIES NO LIVE ROLE (LR-3).** The announcement rides the
   sr-only regions; a `role="status"` on the band too would announce every
   outcome twice. `outcomeBandRole()` exists to write that down rather than
   leave it as an absence someone "fixes".
3. **POLITENESS FOLLOWS THE KIND, NOT THE SURFACE (LR-2)** —
   `outcomeIsAssertive` in `lib/modem/mutation-outcome.ts`, resolved once.
   Success is polite; a refusal and an unknown outcome interrupt.
4. **THERE ARE THREE KINDS, AND `unknown` BORROWS NEITHER NEIGHBOUR.** Applied /
   refused / unknown each get their own word, glyph, tone and `data-outcome`.
   Colour is reinforcement; every band prints its sentence.
5. **THE MESSAGE ARRIVES ALREADY LOCALIZED (LR-4).** The module never sees a
   wire token, so it structurally cannot leak one — each caller resolves its own
   typed refusal through its own keyed copy, which keeps the refusal
   vocabularies where they already live instead of growing a second catalog.
6. **IT IS STATIC CSS**, so both motion freezes cover it and no outcome is ever
   carried by movement.

**`lib/rpc/router-write-flow.ts` bounds the wait — the sibling of
`usb-mode-flow.ts`, on the same three rules.** Pessimism was right and had no
bound: with no confirming broadcast the spinner simply stopped and the dialog
looked untouched. Now the observation confirms (`applied`), the RPC refusal
refuses (`refused`), and the window expiring produces the honest third answer
(`unconfirmed` → the `unknown` band), never a success and never a refusal.
**The OBSERVATION is the authority, not the reply**: `result.controls` is
deliberately NOT consumed as a confirming read, because that would let the band
claim applied while the switch still showed the old value — the exact
contradiction the pessimistic design exists to prevent. A match seen before the
reply is BUFFERED; the bound is armed at RPC RESOLUTION, never at dispatch; and
every settled phase is inert, so a late broadcast can neither resurrect a
refusal nor retroactively upgrade an `unconfirmed` write the operator has
already been told about.

**GPS and FCC do NOT get a window, and that asymmetry is deliberate.** Their
replies CARRY the device's own re-read state (`result.state`/`result.status`),
so success is already confirmed at resolution and there is nothing left to
bound. Do not add one.

**A stale reading is MARKED (§2 IH-4).** `router_admin.signal.freshness` has
distinguished a live reading from a carried-over one since todo 20 and the
Cellular row has rendered that since todo 21; `RouterDongleDialog` printed the
same numbers with no marker at all. It now bands `dongle-stale` — and the values
still render beneath it, because a blanked panel is worse. `unknown` freshness
marks NOTHING: the device told us nothing about the reading's age, and a "stale"
badge over that is a claim we cannot make. A device that reported no
`router_admin` at all gets `dongle-unavailable` rather than a blank dialog, and
neither state is ever a spinner.

**The raw tokens MOVED, they did not disappear (§3 OL-2/OL-3/OL-4).**
`router-dongle-fields.ts` now splits its table in two: `detailFields()` is the
operator half, `diagnosticFields()` is every row whose VALUE is a raw vendor or
3GPP token — the band family (`B4`, `LTE_BAND_3`), serving-cell identifiers,
ARFCNs and bandwidths, the vendor's numeric `network_mode` index, the subscriber
identifiers. Both render in BOTH consumers (`RouterDongleDialog`'s
`dongle-diagnostics` disclosure and the Cellular row's `router-admin-diagnostics`
block), values verbatim, `data-testid="dongle-detail-<id>"` / `router-detail-<id>`
unchanged. The blocks are marked by a testid containing `diagnostic` on purpose:
the operator-text gate excludes them BY SELECTOR, so it never has to know which
of two dozen field ids happen to be raw. Do not fold these rows back into the
operator table, and do not rename those testids.

**…AND THE SPLIT IS PER VALUE WHERE THE FIELD IS A VOCABULARY.** One dialect
answers `network_type` with `LTE` and the next with `hspa-plus`, so which table a
row belongs in cannot be decided by its field alone. A spec marked `vocabulary`
is partitioned by `isMachineIdentifier(value)`: a display string stays in the
operator half, a wire token is rerouted into the marked diagnostics half —
relocated, never dropped. It is opt-in per field ON PURPOSE, and only
`network_type` / `registration` / `roaming` carry it: an `ssid` is the operator's
own text and may legitimately be lowercase with a hyphen, so rerouting it on its
shape would hide the operator's own setting from them.

**And the dongle's UNIT table sits in that same disclosure (todo 29).**
`dongle-unit` (model, firmware, hardware revision, IMEI, serial) used to lead the
`dongle-status` card — above the network readings and above every control, so the
first table an operator met on a dongle whose mobile data was off was its
firmware revision. §2 ranks hardware trivia below state, signal and actions, and
`identityFields` already crosses the same redaction boundary as the dump beside
it, so the two are filed together. They stay two BLOCKS rather than one because
`firmware` is a row id in both sets and one `{#each}` cannot key it twice; the
disclosure is therefore gated on `diagnostics.length > 0 || identity.length > 0`.

**AN IN-PROGRESS EDIT SURVIVES AN INCOMING OBSERVATION.** `ModemConfigDialog`'s
`formData` was already a one-shot snapshot seeded on the OPEN EDGE rather than
live-synced from the `modem` prop — nothing pinned it, and
`ModemConfigDialog.draft.test.ts` now does, typing into the rendered input and
driving observation bursts through it. The mirror property is asserted too (a
re-open DOES re-seed), or the suite would pass on a dialog that had stopped
reading the device altogether.

Coverage: `lib/modem/mutation-outcome.test.ts`, `lib/rpc/router-write-flow.test.ts`,
`main/dialogs/RouterDongleDialog.outcomes.test.ts`,
`main/dialogs/ModemConfigDialog.liveRegions.test.ts`,
`main/dialogs/ModemConfigDialog.draft.test.ts`, plus the `@a11y` axe leg in
`tests/e2e/modem-a11y.spec.ts`.

