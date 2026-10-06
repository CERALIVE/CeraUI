<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## HOTSPOT CHANNELS ARE DERIVED FROM THE KERNEL, NEVER FROM A TABLE [EXISTS]

`modules/wifi/regdomain.ts` turns an operator-declared country into the set of
channels the hotspot may actually use. **It contains no country→channel table and
must never gain one.**

The reason is that such a table is wrong the moment it is written: which channels
a country permits depends on the kernel's `wireless-regdb` version, the radio's
own capabilities, and whether the adapter is self-managed (carrying its own
regulatory rules that override the global domain). So the flow is
apply-then-read-back: `iw reg set <CC>` hands the country to the kernel, the
kernel rewrites every wiphy's per-frequency flags, and `iw phy` is parsed to
enumerate what is left. A table would be a second, silently-diverging opinion
about the same question.

**What "AP-usable" excludes, and why none of it is optional:**

| Flag | Why an access point may not use it |
|------|-----------------------------------|
| `disabled` | not permitted at all |
| `no IR` | NO_INITIATING_RADIATION — the radio may listen but not transmit first, which is exactly what starting an AP does |
| `radar detection` | DFS; legal for an AP only with a full radar-detection + channel-availability-check implementation, which CeraLive does not have |
| a BAND the regulatory RULES permit no initiating radiation on | the fact lives in `iw reg get`, NOT in the per-channel flags — see below |
| 6 GHz | NetworkManager's `802-11-wireless.band` has no value for it, and AP operation there additionally requires WPA3-SAE |

`no IR`'s pre-NO_IR spellings (`passive scanning`, `no IBSS`) are treated
identically — an older kernel expresses the same restriction with different words,
and excluding a channel is the conservative direction.

**THE PER-CHANNEL FLAGS ARE NOT THE WHOLE REGULATORY TRUTH — the rule data is the
other half.** Board-proven on a Rock 5B+ (RTL8852BE, 2026-08-22): under the
kernel's world domain (`00`) that adapter's `iw phy` dump lists 5180/5200/5220/5745
with **no `no IR` marker at all**, so a derivation reading only those flags offered
`ch_36` — and the AP then died, identically for WPA2 and WPA3-SAE, while `ch_6`
succeeded for both on the same board and attempt:

```
Config: added 'frequency' value '5180'
wpa_supplicant: wlan0: Failed to start AP functionality
state change: config -> failed (reason 'supplicant-timeout')
```

`iw reg get` is where that fact was: every 5 GHz rule under domain `00` reads
`PASSIVE-SCAN`, which is the same nl80211 flag (`NL80211_RRF_NO_IR`) the
per-channel `no IR` names. `wifi-regulatory-rules.ts` is the pure parser for that
rule data and `buildApInitiationGate` narrows the SOURCE map with it inside
`parseIwPhyChannels` — the structural shape `HOTSPOT_BANDS` already uses to refuse
6 GHz, never a downstream filter on an already-built offering. Four properties are
load-bearing:

- **It is BAND-scoped, and the band is refused only when EVERY rule overlapping it
  forbids initiation** — "PASSIVE-SCAN only". That is what the world domain does to
  5 GHz and deliberately does NOT do to 2.4 GHz, whose `(2402 - 2472 @ 40)` rule
  carries no such flag: channels 1-11 are offered exactly as before, and the
  per-channel flags still exclude 12/13/14. It is NOT a hardcoded "block 5 GHz",
  which would withdraw the band from every properly-configured country.
- **It FAILS OPEN.** An absent, empty or unparseable `iw reg get` derives
  byte-identically to the pre-gate behaviour, and a frequency span no rule mentions
  is permitted — absence of a rule is not evidence of prohibition, and a failed read
  is a statement about the READ. Same rule as `refreshDerivedApChannels`'s
  retain-on-empty and `planHotspotRegdomainChange`'s refusal to clamp on an empty
  derivation.
- **A per-phy section outranks the global one.** A self-managed wiphy carries its
  own domain, so a board whose global scope is still the world domain can have a
  radio that legally initiates on 5 GHz — and only that section says so. This is
  the same per-phy rule `parseIwRegDomains` already applies to `is6GhzLegal`.
- **`parseRegulatoryRuleLine` is the ONE rule-line parser**, shared with
  `wifi-capabilities.ts`'s `is6GhzLegal` derivation, so the ranges the capability
  block reads and the ranges this gate reads can never drift apart.

`probeApChannels` reads `iw reg get` alongside `iw phy` through the same `runIw`
seam and logs one `warn` naming any band the rules withheld — otherwise the 5 GHz
options simply vanish from the operator's dialog with nothing on the device saying
why. Coverage: `tests/wifi-regdomain-channels.test.ts` → "W1 — a PASSIVE-SCAN-only
band is withheld from the AP offering", driven by the board's own
`iw-phy-rock5bplus-rtl8852be.txt` + `iw-reg-get-rock5bplus.txt` fixtures, with a
non-vacuity check that the phy dump really carries no `no IR` on those channels.
Rule-E proof captured in both directions: deleting the gate reddens exactly the
named world-domain test, and replacing it with a hardcoded "block 5 GHz always"
reddens 9 — including the regression lock that a permitting domain still offers
them.

- **Radios are kept APART.** `parseIwPhyChannels` returns a per-wiphy map and
  `deriveApChannels` takes ONE radio (the first, absent a name). A dual-radio
  board's wiphys can differ, so unioning them would offer one radio a channel only
  the other can host — the same class of defect as the retired device-mode union
  (ADR-0008 §10).
- **`ch_<n>` is the channel id** (`wifi-channels.ts`). Shape validation
  (`isWifiChannelName`) answers "could this name a channel"; **legality is
  `isChannelOffered`**, which tests the runtime-derived set. `wifiHotspotConfig`
  uses the latter, so a well-formed-but-underived channel is rejected.
- **An underived channel has no NetworkManager mapping BY CONSTRUCTION.**
  `nmSettingsForChannel` resolves the band/number pair out of the derived list, so
  even if validation were bypassed an illegal channel cannot reach `nmcli`.
- **`refreshHotspotChannels` drops the previous explicit channels first.** Keeping
  them would carry an old domain's now-illegal channels into the new set; the
  adapter's own band capability is recovered from its auto entries, so the fold is
  idempotent.
- **A live AP is RESTARTED, not updated in place** (`planHotspotRegdomainChange` →
  `reconfigureHotspotForRegdomain`). NetworkManager bakes the band/channel into the
  activation. A channel the new domain retired is clamped to `auto` — not to the
  band-matching auto, because a domain change can withdraw the whole band. Two
  refusals are deliberate: an INACTIVE AP is left alone (the next start picks the
  new set up), and an EMPTY derivation never clamps a live AP off the air, because
  a failed `iw phy` probe proves nothing about legality.
- **The image must ship BOTH `wireless-regdb` and `iw`.**
  `checkWirelessRegdbSupport` probes `/lib/firmware/regulatory.db` (modern) and
  `/usr/lib/crda/regulatory.bin` (legacy), fails closed, and warns at boot when
  neither is present — without a database the kernel keeps the world domain and
  `iw reg set` is inert. The `iw` binary gap is separately real: `wireless-tools`
  ships only the legacy WEXT `iwconfig`/`iwlist` binaries, NOT `iw` (see
  `image-building-pipeline/AGENTS.md` → "`iw` in `shared.list`").
- **Board safety.** `buildRegdomainRestoreCommand` constructs a `systemd-run
  --unit=dqw3-net-restore --on-active=10min … iw reg set <pre-state>` timer, armed
  BEFORE any mutation so a drill that loses its operator still returns the radio to
  a known domain. Argv-only (no `sh -c`), and a malformed pre-state THROWS rather
  than arming a timer that would do nothing.

Every effectful call routes through `setRegdomainRunner` (the `set<Name>Runner`
convention shared with `ssh.ts` / `software-updates.ts`), so no test can move the
host's own regulatory domain. Coverage: `tests/wifi-regdomain-channels.test.ts`,
driven by real-shaped `iw phy` transcripts in `tests/fixtures/wifi/` (world / ES /
US / legacy-flag / 6 GHz).

