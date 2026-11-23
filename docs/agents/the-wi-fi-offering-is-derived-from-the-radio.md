<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE WI-FI OFFERING IS DERIVED FROM THE RADIO [EXISTS]

**Hotspot drafts belong to one radio lifetime [EXISTS].** The gate and live
editor preserve edits on same-device/token status patches, including renames.
Rebinding reloads the form and withdraws consent; session, link and attempt
fences reject obsolete continuations. Save and mode outcomes use the dispatched
token echoed by the producer. Tokenless rows remain visible with Stop available,
but guarded actions require identification. The backend now enforces the
expected token at request and request-bound transaction-lock entry and retains
safe Stop, station and internal actions. Request admission is separate from
frame correlation metadata. Port-scoped identity remains separate work. See
[the binding contract](../HOTSPOT-DRAFT-BINDING.md).

**Security offerings are partial, nonempty maps [EXISTS].** A radio without
positive SAE proof emits only `wpa2`; the shared output schema accepts that
subset without inventing `wpa3-sae`. An omitted map remains valid for older
devices. An explicit empty map remains invalid, as do unknown mode keys,
non-object entries and non-string names. Parsing a complete map retains the
previous enum order (`wpa2`, then `wpa3-sae`), including when input keys arrive
in reverse order; existing valid output bytes do not change.

The exhaustive enum record introduced in `d505f5ff` (first released in
`v2026.8.2`, August 24, 2026) rejected real WPA2-only hotspot rows.
`wifi.getStatus` explicitly parses its result, and `status.getStatus` validates
its aggregate output through oRPC, so the latter could reject reconnect status
hydration while an unproven-SAE hotspot was present. Initial status pushes and
Wi-Fi broadcasts bypass that output validation; the frontend stores those rows
and checks each offered key before reading its name. This repair changes the
shared decoder only; radio derivation, producer messages and frontend controls
keep their existing behavior. It does not establish radio identity or hardware
qualification.

**Hotspot membership is pushed within one five-second poll [EXISTS].** While
an AP is up, the backend reads its own station dump (`clap-<parent>` in Hybrid).
Unread state resolves on the first successful poll; joins, leaves and roster
removal broadcast once. Count and sorted station MACs determine membership;
signal and rates refresh with other Wi-Fi broadcasts without triggering them.
The poll forces each read past the cache TTL and remains single-flight per AP.
The key includes every parsed MAC before the 32-row display cap. Notification
history records only the roster `broadcastWifiState` sends to all subscribers,
clearing it when the block is omitted. `wifiBuildMsg` projects the roster
without acknowledging it: private RPC and new-client snapshots cannot consume
a pending broadcast to existing viewers. Polls compare the
same live-AP projection with that record; structural Wi-Fi broadcasts therefore
acknowledge roster removal too. That projection prunes inactive AP caches and
flights synchronously. A flight token protects cache writes, so an obsolete
dump cannot revive an AP or account for delivery.

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

Well-formed bands outside the represented 2.4/5/6 GHz schema are omitted rather
than invalidating neighbouring radios. Their frequencies may omit channel
suffixes, as S1G does in iw 6.9. Malformed frequency blocks and supported-band
rows without channel numbers still fail. Grouped interface limits use the same
slot accounting as concurrency discovery: managed and AP need two slots, even
inside a shared group, and each alternative retains its own total/channel bounds.

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

**An empty station password requires explicit open scan security [EXISTS].**
The dialog, `wifi.connectNew` schema, and backend join plan use the shared station
security classifier. Only explicit open security admits a blank password and
omits the NetworkManager password argument. Missing or unknown security is not
open. OWE and OWE transition labels are not admitted as open until that join
path is qualified; WEP and enterprise provisioning are separate. Legacy callers
can still omit scan security when supplying a valid nonempty password.

**Fresh open joins preserve the selected AP.** The scan can report an observed
open network without a usable BSSID. Keep that row visible: the missing
identity does not erase the observation or saved and connected state. The
current dialog shows scan-again guidance locally and sends no fresh join
request for that row. When the row carries a validated BSSID, the dialog
forwards it on the blank-password request.
Before any mutation, re-read the selected radio and require that exact BSSID,
the same SSID, explicit open security, empty WPA and RSN flags, and no
contradictory row. A replacement AP, even if open and named identically, is
not a match. A supplied join BSSID must be a nonzero six-octet address at the
RPC boundary. Missing proof returns `open-target-unverified` with scan
guidance; the field remains optional and nonblank joins keep their legacy
behavior.

**A cached UI must refresh before retrying a blank join without a BSSID.**
The service worker reloads an already-open client when it activates an update,
but some tabs have no active worker or reconnect before it updates. No client
build is sent on the wire, so the device can only recognize this legacy path
when it receives a blank join without a BSSID. It refuses before touching
NetworkManager and sends `notifications.updateAvailableDescription` only to
the requesting socket as both a 60-second toast above the dialog and a
persistent notice in the page and notification panel. Neither is retained or
replayed by the device; the old tab keeps them across a socket reconnect while
the toast is active. Another refusal replaces both entries rather than
stacking them. After the toast expires, the old dialog still shows its generic
password advice; close the dialog to read the notice band. After a device
update, reload the page or close and reopen the app before joining Wi-Fi.
Reopen the Wi-Fi selector, scan, and retry the open network without a password.

Activate the fresh open profile by UUID on the verified BSSID. If the AP
disappears after verification, activation can fail after the profile is added:
retain it with autoconnect disabled, report the generic terminal error, and do
not fall back to another AP or bind the profile. Autoconnect is enabled only
after successful activation and adapter binding. Status-based confirmation
for a fresh open join also requires the selected AP.

**A saved SSID is not proof of profile compatibility.** The device publishes
observed key management by saved UUID, without reading secrets for that
projection. The dialog reuses a UUID only when its key management matches the
scan classification. In particular, no observed key-management setting (`''`)
means an open profile; `none` is WEP and absent evidence cannot prove either.
New joins retain the existing WPA personal/PSK compatibility check before a
secret can be replaced. Neither path uses Forget to resolve a collision.
Ordinary 802.1X may reuse `wpa-eap`, never `wpa-eap-suite-b-192`. An enterprise
label that does not identify an AKM cannot authorize saved reuse.

