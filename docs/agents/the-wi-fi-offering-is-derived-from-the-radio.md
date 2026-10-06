<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE WI-FI OFFERING IS DERIVED FROM THE RADIO [EXISTS]

The three-value band enum (`auto` / `auto_24` / `auto_50`) is still the **wire
vocabulary** and did not change. What changed is that nothing hardcodes which rungs are
*offered*. `wifi-capabilities.ts` derives per-adapter truth from `iw phy` and
`iw reg get` — bands, generation, per-band max width, SAE support, regulatory domain —
and publishes it on the additive, optional `wifiInterfaceSchema.capabilities?`. Absent
means "older device", and the UI must render today's legacy set for it, never an empty
offering. A DOM byte-comparison regression lock pins exactly that.

**Bind the adapter to its wiphy, never by position.** `iw dev` lists phys in
*descending* order (`phy#1` before `phy#0` on a dual board), so any positional read
binds the wrong radio. The binding is `basename(readlink('/sys/class/net/<if>/phy80211'))`,
which resolves for a virtual AP interface too.

**Generation keys on non-zero EHT, not on EHT presence.** The shipped RTL8852BE prints
`EHT MAC Capabilities (0x0000)` with every MCS/NSS `Rx=0, Tx=0` — an all-zero stub.
Keying on presence claims Wi-Fi 7 for a Wi-Fi 6 part; dropping the non-zero check
reddens six tests.

**A parse failure drops the cache; a spawn failure retains it.** The first says the
shape we knew how to read is gone. The second is a statement about the *read*, not
about the hardware. Self-managed wiphys get a shorter TTL (60 s vs 5 min) because their
domain moves with no operator action.

**Three degraded states, and collapsing any pair is the bug.** A radio that does not
carry a band renders **zero** nodes. A radio that carries it under a non-permitting,
non-self-managed domain keeps the chip, marks it `aria-disabled`, and offers "Set
country". A **self-managed** wiphy keeps the chip with a calm info band and **no
button** — it intersects or ignores a country hint, so the dialog is a control that
provably cannot act. Pointing the reason chip at the country dialog for a radio with no
6 GHz band at all would be the mirror error: blaming regulation for missing silicon.

**`00` is a kernel token, not a country.** The world-domain case gets its own sentence
rather than interpolating `00` into "the domain in force here ({country})".

### …AND A BAND'S AP RIGHTS COME FROM THE RULES, NOT THE CHANNEL FLAGS

Board-proven twice, and the second half is the part worth remembering. Under the
kernel's world domain `00` an RTL8852BE lists 5180/5200/5220/5745 with **no `no IR`
marker at all** — the per-channel flags are clean — yet every 5 GHz *rule* in
`iw reg get` reads `PASSIVE-SCAN` and the AP dies `Failed to start AP functionality`.
`PASSIVE-SCAN`, `NO-IR` and the ancient `NO-IBSS` are three spellings of one nl80211
flag published at rule level. `buildApInitiationGate` (`wifi-regulatory-rules.ts`) is
the single predicate, and four of its properties are load-bearing:

- **Band-scoped, not channel-scoped.** The world domain's `(2457 - 2482)` rule is also
  PASSIVE-SCAN, so a per-channel check would silently retire `ch_12`/`ch_13` — 2.4 GHz
  behaviour this defect does not touch.
- **Not a hardcoded 5 GHz block.** Replacing the rule-derived gate with `band !== "a"`
  reddens nine tests, including three pre-existing ES/US derivation cases.
- **Fails OPEN.** An unreadable or silent `iw reg get`, and any span no rule mentions,
  permits the band.
- **A per-phy section outranks the global one.** A self-managed wiphy can legally
  initiate on 5 GHz while the global scope still reads `00`.

**Two producers write into one offered list, so the gate is asked twice.**
`parseIwPhyChannels` builds the explicit `ch_*` entries; `wifi-interfaces.ts` pushes the
band-wide `auto_*` rungs from the adapter's *nmcli* band capability, one layer above.
A fix applied to the first alone left `auto_50` offered, accepted, and failing exactly
as the original defect did. `deriveApInitiationBands()` asks the same predicate one
layer up. **Only a rung that NAMES a band may be retired with that band** — the plain
`auto` rung was measured on the board before the fix was designed (it writes no band,
NM settles on 2462 MHz, activates cleanly), so withholding it would remove a control
that works. The suite refuses an over-reaching gate as well as an under-reaching one.

**`WifiHotspot.bandCapability` exists to avoid a one-way door.** `refreshHotspotChannels`
used to recover the adapter's band capability by filtering the autos out of
`hotspot.availableChannels`. The moment a rung is withheld from that list, the next
refresh reads a list that no longer contains it — the radio's 5 GHz capability is
forgotten **permanently** and the rung can never return when the operator sets a
permitting country. Any time a derived list is both the output and the input of a
recomputation, filtering it latches.

**Hosting and joining WPA3 are deliberately asymmetric.** Hosting needs positive proof
(`wpa3Sae: "supported"`); joining needs only the absence of disproof, so only a positive
`"unsupported"` withholds a row. NM 1.42.4 publishes no SAE key at all, so `unknown` is
the shipped fleet's answer and refusing on it would take WPA3 away from every board.
And `WPA2 WPA3` transition-mode APs must NOT pin `sae` — the AP accepts a plain WPA2
association, so pinning refuses the very leg a SAE-incapable adapter uses.

**6 GHz hotspot is refused STRUCTURALLY, not by a filter.** `HOTSPOT_BANDS` is
`["2.4","5"]` and the wire schema has no `'6'` key to emit into, so a Wi-Fi 7 adapter
with a self-managed US domain and `is6GhzLegal: true` still yields zero 6 GHz entries.
This is a NetworkManager/hostapd capability limit on the AP path, **not** a legal or
regulatory decision — see `docs/DIY-POSTURE.md` in the workspace root.

