<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AN ISOLATED DONGLE IS SURFACED WITHOUT ENTERING THE BOND [PARTIAL — reader only; the PRODUCER is retired]

**READ THIS FIRST: the producer described below no longer exists.** Phase-C todo
39 retired the image's router-dongle netns layer, so nothing writes
`/run/ceralive/dongles/dongle<N>.json` on any image going forward and the classified
dongle bonds through its OWN `enx…`/`eth…` interface instead (see …AND IT IS NAMED
CELLULAR WITHOUT WAITING FOR THAT LAYER). The reader below is KEPT, deliberately
and indefinitely: it is what lets a board still running an old netns image and a
board running a post-retirement image degrade to the SAME honest silence, so
deleting it would turn a graceful degradation into a crash on exactly the fleet
that still has the files. Its steady state is now "the directory is not there",
and that is a tested claim rather than an assumption —
`tests/dongle-metadata.test.ts` proves it against `defaultDongleMetadataDeps`
itself, not only against the injected seam. Everything from here down describes a
layer that WAS shipped and is being torn down; do not build anything new on it.

A router-mode USB dongle (Huawei HiLink, ZTE MF79U and relatives) hands the host
an address from its OWN embedded DHCP server, so two units of one model lease the
host the SAME address on the SAME subnet — board-confirmed on the bench, where two
physically distinct HiLink units also share one factory MAC (`0c:5b:8f:27:9a:64`)
and both lease `192.168.8.100`. The device image resolves that by claiming each
dongle into its own network namespace and handing the host a unique
`10.208.<N>.1/30` over a veth pair named `dg<N>h`
(image-building-pipeline `docs/dongle-netns-contract.md`).

`modules/network/dongle-metadata.ts` is CeraUI's INDEPENDENT reader of that
layer's runtime metadata (`/run/ceralive/dongles/dongle<N>.json`, schema v1).

- **The schema is a MIRROR, never an import.** Rule D forbids reaching into a
  sibling checkout, and the contract itself (§6.1 Rule-D note) states each repo
  carries its own reader and its own fixtures. `tests/dongle-metadata.test.ts` is
  what proves the mirror still matches the producer.
- **Every rejection is silent to the caller and logged ONCE per file+reason.** An
  unknown `version` is ignored and the file is left alone (§6.1: a reader "does
  not guess, and it does not delete"); a malformed record, a record missing a
  non-nullable field, and a record whose heartbeat has gone stale are all ignored
  the same way. Nothing here throws — it runs inside the netif poll.
- **Stale is `3 x` the 30 s heartbeat (90 s), not one missed beat.** One delayed
  heartbeat under load must never demote a healthy streaming link. A FUTURE
  timestamp (clock skew) is not stale.
- **`driver` is typed as a string, not the contract's three-value enum.** §6.1
  permits additive-optional evolution within v1 and requires a reader to ignore
  what it does not know, so rejecting a record for naming a fourth USB-ethernet
  driver would drop a working dongle over a field this consumer never reads.
- **A veth claimed by TWO records is ambiguous and NEITHER is trusted.** Picking
  either would attribute one dongle's state to the other — the duplicate-MAC pair
  above is exactly why that is not hypothetical.

**The marker is stamped onto the WIRE PROJECTION only** (`applyDongleProjection`
in `network-interfaces.ts`), and that is the whole safety argument:

- a live `dg<N>h` row gains `dongle: {slot, state}`;
- an `acquiring`/`down` dongle is UNIONED IN as a wire-only row (no `ip`,
  `enabled: false`, zero counters). Its veth is administratively DOWN and
  address-less, so it is not RUNNING and never enters the live `netif` map at
  all — and `genSrtlaIpList` reads THAT map's `enabled && ip`, so bonding is
  untouched BY CONSTRUCTION rather than by a filter someone could remove. Do NOT
  "simplify" this by inserting union rows into the map and filtering later.
- **The marker is RETRACTABLE, and that is not optional.** Publishing it
  true-only would repeat the `policy_route_missing` latch: the frontend merge
  preserves an omitted optional field, so a marker could be raised and never
  lowered. On release the backend emits `dongle: null` for exactly ONE frame — on
  the live row when it still has one, as a bare wire-only row when it does not —
  and plain absence still means "not a dongle" for a row never marked.

**The FRONTEND ingestion seam is an explicit edit, not a consequence.**
`subscriptions.svelte.ts` `case "netif"` rebuilds each entry from a
hand-maintained allowlist, so `dongle` had to be added there (spread-when-present)
or it would be dropped between the socket and `getNetif()` — the exact seam where
`tx_bps` once shipped "fully green" and rendered 0 kbps on hardware. It ALSO
prunes any row whose `dongle: null` frame arrives, including a released LIVE
dongle's `dg<N>h` row: that merge never deletes rows, so without the prune a
released dongle ghosts forever with its last IP.

**Three collaborators were extended, each minimally:**

- `policy-route-check.ts` gained `dg\d+h` ONLY. The dongle's routing table is
  named after the interface (contract §3.2), so it verifies through the existing
  derivation with no special case. **`enx*` is deliberately NOT added** — the
  image dispatcher maps only `enx*0`..`enx*7` by the ifname's LAST character, so
  roughly half of correctly-working `enx` adapters have no source rule and would
  false-flag amber. That dispatcher gap is a documented contract limitation, not
  a fault this check may report.
- `link-telemetry.ts`'s default iface resolver prefers the dongle's slot label
  (`dongle<N>`) for a `dg<N>h` row; every other interface keeps the unchanged
  first-IP-match name.
- `network-interfaces.ts` re-queues gateway election on every topology edge via
  `setQueueUpdateGwHook`. `gateways.ts`'s `updateGwQueue` is ONE-SHOT — cleared
  after a successful election, after which the periodic caller exits forever — so
  a default route lost later was never re-elected. The hook is INSTALLED BY
  `initNetworkInterfaceMonitoring` rather than statically imported: `gateways.ts`
  imports this module (a static edge back would cycle), and an unwired default
  keeps a parser-only test from dialing real DNS through `updateGw`.

**A dongle state change is invisible to the netif diff**, because a gated veth is
not in the map that diff compares. `refreshDongleState` therefore broadcasts
directly on a real edge (and re-queues gateway election), instead of relying on
`triggerNetworkInterfacesChange`.

Coverage: `tests/dongle-metadata.test.ts` (the reader matrix — valid, unknown
version, missing field, malformed, stale boundary in both directions, clock skew,
ambiguity, and the cache's edge reporting, PLUS the post-retirement block that
drives the SHIPPED `defaultDongleMetadataDeps` against an absent
`/run/ceralive/dongles` and a stale left-behind file),
`tests/dongle-netif-marker.test.ts`
(marker stamping, both union states, the union-row-vs-empty-bonded-list
assertion, both retraction shapes and their once-only property, dup-IP
preservation against the real bench collision, the policy-route candidate table
— now asserting a `dg*` veth is NOT collected — and the gateway re-queue edge),
`tests/link-telemetry-dongle-label.test.ts`
(driven through the REAL lazy-import resolver), and the frontend half
`apps/frontend/src/tests/netif-dongle-ingestion.test.ts`.

**Honest status:** no claim has been exercised against a physical dongle. The
producing layer is itself `[PARTIAL — implemented + statically gated, never run
against a real dongle]`, so every fixture here models the contract, not a board.

## …AND IT IS NAMED CELLULAR WITHOUT WAITING FOR THAT LAYER [EXISTS]

Everything above depends on the device image's netns manager writing
`/run/ceralive/dongles/*.json`. **No shipped image writes it.** So on every board
in the field a router-mode cellular dongle rendered as a nameless row under
"Ethernet" — no badge, no cellular treatment, nothing saying what it was.
Operator-reported, and reproduced on the bench: three such dongles, three
anonymous wired rows.

The descriptors that identify them were there the whole time.
`modules/network/usb-net-classifier.ts` (pure) + `router-cellular-scan.ts`
(sysfs + cache) read them and stamp a `router_cellular` marker on the netif wire
projection, with NO dependency on the netns layer, ModemManager, or any spawn.

**THE INTERFACE NAME IS NEVER AN INPUT.** Not a prefix, not a suffix, nowhere.
This bench is the proof: its two Huawei HiLink units are physically distinct
devices shipping ONE factory MAC, so the predictable-naming scheme can only name
one of them — `enx0c5b8f279a64` — and its twin falls back to `eth1`. A rule keyed
on `enx*` badges one and misses the other; a rule keyed on `eth*` does the
reverse. `classifyUsbNetDevice` is not even GIVEN a name (`UsbNetDevice` has no
such field), so the property holds by construction rather than by discipline.

**The RULE is a Rule-D mirror of modem-stack's
`control/src/backend/device-classifier.ts`**, re-derived from the same USB-IF
class codes and driver names, never imported. Precedence is that file's,
unchanged: a recognized MBIM/QMI/AT control port ⇒ `mm-managed`; an ECM / NCM /
RNDIS / CDC-data tether with NO control port ⇒ the router class; anything else ⇒
`unknown`, with an honest reason.

**One thing is ADDED, and it is the difference between the two repos' questions.**
modem-stack asks "can ModemManager drive this", so its `router-mode` verdict
means "a tether with no control port" — which is equally true of a plain
USB-to-Ethernet adapter. CeraUI is about to print the word CELLULAR on an
operator's screen, so the tether verdict alone is not enough. `cellularEvidence()`
requires a POSITIVE signal before `router-cellular` is claimed, and a tether with
none is reported as `wired-ethernet` — "this is a USB network adapter", said
plainly, rather than a guess. Two independent signals, either sufficient:

- a **known cellular vendor id** (`CELLULAR_USB_VENDOR_IDS`; both bench dongles
  are covered — `12d1` Huawei, `19d2` ZTE). The table is consulted ONLY after the
  descriptors have already proven a control-port-less tether, so a vendor id
  never classifies anything on its own and a Huawei keyboard is not a modem;
- a **mass-storage companion interface** on the same physical device — the ZeroCD
  installer LUN every router-mode dongle carries and no plain USB NIC does. This
  one is vendor-agnostic, so an unlisted vendor's dongle is still recognised
  (covered by a test). A `ID_USB_MODESWITCH` udev property counts as the same
  signal where udev supplies one.

**The read is sysfs, not `udevadm`, and that is deliberate.**
`/sys/class/net/<if>/device` names the USB INTERFACE; its PARENT is the physical
device, and only from there are the vendor/product ids and the SIBLING interfaces
visible. Reading the netdev's own interface alone would miss both the
mass-storage companion and the AT/QMI ports — i.e. exactly the descriptors the
classification turns on. Nothing is spawned, so this costs nothing on the 5 s
netif cadence and has no failure mode a spawn has. It is also the same source the
bench inventory sweep reads, so a captured fixture is byte-comparable.

**`duplicate_model` is MEASURED, never assumed.** It is true only when another
classified router-cellular device attached RIGHT NOW reports the same `vid_pid`,
so it is resolved across the whole scan result rather than one interface at a
time. Same model ⇒ same factory LAN subnet ⇒ both lease the host the same address
— board-confirmed, with both HiLink units handing out `192.168.8.100`. That is
what finally explains the `NETIF_ERR_DUPIPV4` exclusion the operator could
previously only see as an unexplained "Off".

**The marker is RETRACTABLE, and its retraction is NOT the dongle marker's.**
`applyRouterCellularProjection` emits one explicit `router_cellular: null` when a
name stops classifying, for the same latch reason as everything else on this wire.
But unlike `applyDongleProjection` it **never unions a row in** (the
classification is a statement about an interface the netif scan already
enumerated) and its `null` **keeps the row** (the interface is still there; it
merely stopped classifying). The frontend ingestion deletes the FIELD, not the
row. Do NOT "unify" the two projections.

Coverage: `tests/router-cellular-classification.test.ts` — every device fixture
is a verbatim sysfs transcription from the bench board (both HiLinks, the ZTE,
the Quectel RM530N-GL, the SIMCom), plus the plain-USB-NIC negative, the
unlisted-vendor-by-ZeroCD case, the `duplicate_model` pair-vs-lone table, the
projection, the one-frame retraction, and the name-independence proof (every
interface renamed to a prefix no rule could have an opinion about; verdicts
unchanged). Frontend half: `apps/frontend/AGENTS.md` → "A dongle is named
CELLULAR from its descriptors".

### …AND TWO OVERLAPPING SWEEPS CANNOT COMMIT OUT OF ORDER [EXISTS]

`refreshUsbNetMarkers` is driven by the 5 s netif cadence AND by anything else
wanting a fresh marker set, so two sweeps of the same sysfs tree can be in flight
at once — and a replug, which is what prompts the second sweep, is also what
makes the reads slow. Last-writer-wins meant an OLDER sweep landing late
overwrote a NEWER one's view of the very topology change that triggered it: the
retired dongle's markers, `stable_key` and physical descriptors all came back,
and nothing re-poked until the next cadence tick. Same defect class, and the same
remedy, as `sources.ts`'s `hotplugRefreshGeneration`.

- **A ticket is taken BEFORE the read and checked AFTER it.** A completion whose
  generation is no longer the newest writes nothing and answers `false` — it
  published no edge, and the sweep that fenced it out reports the real one. Only
  the newest generation can reach the commit, so the `snapshotKey` "did anything
  change" comparison is taken at commit time rather than before the read.
- **Single-flight JOINS an identical request** — same interface set AND the same
  `deps` OBJECT (identity, not shape: two different deps read two different
  trees, which is exactly what a fixture does). A second sweep of the same tree
  could only answer the same question twice and race its own twin.
- **A DIFFERENT request is never coalesced.** It starts its own sweep, takes a
  newer ticket, and fences the earlier one out — coalescing on the ifname set
  alone would answer one question with another's data.
- **The fence is scoped to THIS domain and must stay that way.** The counter
  covers the three marker caches in `router-cellular-scan.ts` and nothing else;
  putting the modem, dongle-metadata or policy-route sweeps behind one shared
  gate would let an unrelated slow read stall this one for no correctness gain.
- **`resetUsbNetMarkers()` bumps the generation too**, so a sweep still reading
  when a test resets cannot repopulate the caches that reset just cleared.

Coverage: `tests/usb-net-scan-fencing.test.ts` — the out-of-order case driven by
a manually-resolved gate (the older sweep is parked at its first sysfs read and
the newer one is AWAITED to completion before the gate opens, so the ordering is
controlled rather than timed), with a non-vacuity check that the older tree
really does describe a different SKU; plus the natural-order fence, the
join-don't-re-read proof by read count, the two-different-requests negative, the
reset fence, and the sequential control. Rule-E proof in both directions:
neutering the generation check reddens 3 tests, neutering the join reddens 1.

## …AND A DONGLE THAT NAMES A CLASS IS GIVEN ITS REAL MODEL [EXISTS]

The classification above was right and the NAME beside it was not. Both bench
HiLink units rendered as `HUAWEI_MOBILE · 12d1:14dc`, and the collision band read
"Another **HUAWEI_MOBILE** is attached" — operator-reported as a generic name
where a model belongs, and the two physically distinct units were indistinguishable
from each other.

**The device published ONE string for BOTH descriptors, so neither is an identity.**
`manufacturer` and `product` are both `HUAWEI_MOBILE`: that is a device CLASS, not a
vendor and not a model. `publishesGenericIdentity` (`usb-net-classifier.ts`) is that
MEASURED condition — the two trimmed strings comparing equal — never a name pattern,
never a vendor allowlist. A device that distinguished its two descriptors is
untouched and keeps its own words, typos included (the bench ZTE stays
`ZTE,Incorporated` / `ZTE Mobile Boardband`).

**The real model comes from udev's hwdb, and the ASYMMETRY is why the two labels
resolve differently.** `usb.ids` carries a MODEL for `12d1:14dc`
(`E3372 LTE/UMTS/GSM HiLink Modem/Networkcard`) and only a vendor for `19d2:1405`.
So `modelLabel` prefers `ID_MODEL_FROM_DATABASE` for a generic-identity device, while
`vendorLabel` prefers the curated `CELLULAR_USB_VENDOR_IDS` name over
`ID_VENDOR_FROM_DATABASE` — hwdb's vendor is the USB-IF REGISTRATION, which can name
a business unit rather than the brand on the casing (`19d2` registers as
`ZTE WCDMA Technologies MSM`, which would be a downgrade). Board-verified: both
HiLink rows now read `Huawei E3372 LTE/UMTS/GSM HiLink Modem/Networkcard`.

**THE READ IS OF THE PARENT USB DEVICE, AND THAT IS THE WHOLE POINT.** The second
HiLink's NETDEV has no udev properties at all — its database entry is a bare
`E:ID_RENAMING=1`. Root cause, confirmed on the board and **outside CeraUI**: the two
units ship ONE factory MAC (`0c:5b:8f:27:9a:64`), systemd's own
`/usr/lib/systemd/network/73-usb-net-by-mac.link` (`[Match] Path=*-usb-*`,
`[Link] NamePolicy=mac`) therefore derives the SAME name `enx0c5b8f279a64` for both,
the second rename fails `-EEXIST`, the interface keeps its kernel default `eth1`, and
udev never commits the rest of that device's properties. `udevadm info` on `eth1`
returns `DEVPATH`, `SUBSYSTEM`, `INTERFACE`, `IFINDEX`, `ID_RENAMING` and nothing
else. Its PARENT USB device is a separate udev device whose entry is complete, so
reading there makes the resolution immune to the collision instead of a victim of it
— and it is the same parent the descriptors already come from.

- **NOT a CeraUI defect, and NOT a CeraUI fix.** The duplicate MAC is a hardware
  fact about two same-model dongles; the naming collision is systemd's documented
  behaviour given that fact. The underlying identity problem is what the image's
  router-dongle netns layer exists to resolve (`image-building-pipeline`
  `docs/dongle-netns-contract.md`, whose per-slot claim keys on the USB `ID_PATH`
  precisely because MAC and ifname are both unreliable here); nothing in this repo
  should try to rename an interface. Do NOT add a udev rule, a `.link` override, or
  an ifname remap to CeraUI.
- **Read, never spawned.** `readUdevDatabaseNames` (`router-cellular-scan.ts`) parses
  `/run/udev/data/c<major>:<minor>` directly, keeping this module's zero-spawn posture
  on the 5 s netif cadence. USB devices are keyed by their CHARACTER-DEVICE number,
  not their bus id: usbfs is major 189 and packs 128 devices per bus, so
  `minor = (busnum - 1) * 128 + (devnum - 1)` from the device's own sysfs attributes.
- **The hwdb is an ENRICHMENT, never a requirement.** An image with no hwdb, a device
  udev has not processed, and an unreadable entry all leave the device NAMED — a
  missing model degrades to a worse LABEL, never to a blank identity.
- **…but the honest floor is the PRODUCT ID, never the class string.** The fallback
  chain used to end at the device's own published string, which is exactly the
  string `publishesGenericIdentity` had just MEASURED to be a class rather than an
  identity — so a device whose vid:pid usb.ids does not carry got its class name
  back. Board-confirmed (2026-08-17): two Qualcomm reference RNDIS sticks
  (`05c6:9024`, distinct serials `2b16081` / `c6125db3`) publish `Android` for BOTH
  descriptors, usb.ids has a VENDOR for `05c6` and no model, and both rows reached
  the operator titled **`Android`**. `vendorLabel`/`modelLabel` now answer
  `Qualcomm` + `9024`; `routerCellularDisplayName` composes the brand onto the
  descriptor answer as well as onto the admin one, so the row reads
  `Qualcomm 9024` — true, stable, and naming the silicon vendor USB-IF registered.
- **A twin pair gets a DISCRIMINATOR, and only a twin pair.** Two units of one SKU
  are identical in vendor, model and `vid_pid` alike, so `RouterCellularMarker.serial`
  (fed by `unitDiscriminator`, additive-optional on the wire) is the only thing that
  separates their rows — appended to the display name as `· <serial>`. It is
  withheld from a lone device (nothing to separate it from) and from a device that
  publishes no serial or republishes a string descriptor as one: the bench HiLink
  pair is a `duplicate_model` and still gets none, because none exists. Never
  fabricated, and never an input to any classification.

Coverage: `tests/router-cellular-classification.test.ts` — the bench fixtures gained
their real `busnum`/`devnum` and the verbatim `E:` lines from each device's own udev
entry, plus the recovered-model case, the device-named-itself negative (ZTE keeps its
own strings AND is not given hwdb's worse vendor), the no-udev fallback (now proving
it degrades to the product id and NOT back to the class string), and the twin-stick
naming/discriminator matrix incl. both withhold cases.

## …AND AN MM-MANAGED MODEM'S DATA FUNCTION IS NOT A SECOND DEVICE [EXISTS]

The same sysfs sweep answers a second question, and the answer had nowhere to go.
`classifyUsbNetDevice` returns `mm-managed` for a device carrying a recognized
MBIM/QMI/AT control port — ModemManager's, and therefore the Cellular section's —
and `scanRouterCellular` simply `continue`d past it. That was harmless while every
such modem's data path was a `wwan*` interface, because the frontend's
`isWiredSectionEntry` already excludes that prefix.

**An RNDIS data path is named after its MAC, and no prefix can reach it.**
Board-confirmed (2026-08-17): the bench Fibocom FM350-GL (`0e8d:7127`, seven
`option`-bound serial ports plus an RNDIS pair) is fully represented as
ModemManager modem 4 AND rendered a bare second Ethernet row `enx000011121314` —
no address, `UNKNOWN` state, no explanation. One physical device, drawn twice, the
second time as a mystery adapter.

- **The correlation is ModemManager's OWN, not a USB-parent heuristic.**
  `mmcli -m 4` reports `ports: enx000011121314 (net), ttyUSB12 (at)`, and
  `modem-registration.ts` already resolves `Modem.ifname` from exactly that field —
  so the modem row has always NAMED this interface. Nothing new had to be
  correlated; the Ethernet side simply had no way to recognise the claim.
- **`scanUsbNetMarkers` is now ONE sweep returning TWO disjoint sets**
  (`routerCellular` + `modemNet`), because both read the same descriptors off the
  same parent USB device. `scanRouterCellular` is the router half of it, unchanged
  for every existing caller.
- **`usb_modem_net` rides the netif wire and is RETRACTABLE on exactly
  `router_cellular`'s terms** — an explicit `null` for one frame, which clears the
  claim and KEEPS the row (the interface is still enumerated; it merely stopped
  classifying). Publishing it true-only would repeat the `policy_route_missing`
  latch.
- **The marker is what makes the claim SAFE to act on.** The frontend rule is
  "claimed by a modem row AND carrying a cellular-device marker", so a modem row
  naming an ordinary NIC can never take the board's management link off the
  Ethernet list. Frontend half: `apps/frontend/AGENTS.md` → "An MM-managed modem's
  data function".
- **Nothing is hidden.** The row is not suppressed — it is REPRESENTED, by the
  Cellular row for the same device, which carries the modem's state, its bond
  toggle and its whole configuration surface. In the handover window before that
  row exists (the two broadcasts are independent), the Ethernet row stays and is
  NAMED from the same descriptors (`Fibocom Wireless Inc. FM350-GL · 0e8d:7127`)
  plus a sentence saying which modem it belongs to.

Coverage: `tests/router-cellular-classification.test.ts` — the FM350 fixture, the
disjoint-sets assertion across the whole roster, and the wire stamp + one-frame
retraction.

## …AND IT IS LISTED AS A MODEM, WITH THE ONLY SURFACE IT REALLY HAS [EXISTS]

Todo 43 classified these dongles and todo 47 named them, but both left them in the
Ethernet list. The operator overruled that: *"everything should be in modems, not in
Ethernet. And we should be able to control or configure the options that can be
configured."* So `modem-wire-producer.ts` now emits a `router-ethernet` modem row per
classified dongle (`collectRouterCellularSources`), reusing the todo-43 marker cache
as the SOLE classification signal — there is no second opinion about what a device is.

**The two router adapters are NOT interchangeable, and unifying them re-breaks the
row.** `fromRouterView` describes a netns-CLAIMED dongle, which hides behind a `dg<N>h`
veth that owns the bond toggle, so its modem row must refuse one (`router_managed`).
`fromRouterCellularView` describes a CLASSIFIED dongle on an image with no isolation
layer — which is every shipped image — so its own `enx…` interface IS the bonded link,
and after the relocation it is the only row that device gets. Its availability token is
therefore `router_direct` (or `dongle_acquiring` before the lease lands), and the
frontend lets the bond toggle live. Handing it `router_managed` would tell an operator
that a dongle currently carrying bonded traffic cannot bond. `getDongleRecords()` is
unchanged and still produces the netns rows.

**The configuration surface is READ-ONLY BY EVIDENCE, not by caution.**
`router-cellular-admin.ts` reads the dongle's own LAN-side HTTP admin API — Huawei
HiLink's `/api/*` XML behind a `SesTokInfo` session, ZTE's `goform_get_cmd_process`
JSON — and publishes the normalized result as the additive `modem.router_admin`. Both
APIs answered UNAUTHENTICATED from the board. Nothing is written: every dongle on the
bench arrived SIM-less (HiLink `SimStatus 255`, ZTE `modem_sim_undetected`), so no
write could be shown to take effect, and todo 47's lesson stands — a control that
cannot be proven is not shipped. What the operator gets is the device's own truth
(model, serial, SIM presence, connection state, signal bars, APN) plus the STATED
address of the vendor UI that does own its configuration.

**`curl --interface` is load-bearing, not laziness.** The two HiLink units ship ONE
factory MAC and one factory LAN subnet, so the host holds `192.168.8.100` twice and
BOTH dongles answer on `192.168.8.1`. Addressing one specifically needs
SO_BINDTODEVICE, which Node/Bun's HTTP client cannot express — `localAddress` is
identical for the pair. Proven on the bench: the same request bound to each interface
returned two different serials (`…793` / `…872`). Do not "modernize" this to `fetch`.

The admin URL is the interface's DEFAULT GATEWAY read from `ip -4 route show default`,
never a hardcoded `192.168.8.1`, so a re-subnetted or unfamiliar dongle still resolves.
The probe runs on its OWN 30 s cadence (not the 5 s netif poll — it is the most
expensive probe in the module and the least urgent), is `isRealDevice()`-gated, and
degrades every failure to `{admin_url, reachable: false}` rather than throwing.
A vendor whose dialect is unknown still gets that reading: the address is a routing
fact worth stating even when nothing could be read behind it.

**A SIM CODE MUST BE READ IN THE DIALECT'S OWN VOCABULARY, NOT A NEIGHBOUR'S.**
The three dialects each name SIM presence differently, and getting one word wrong
costs the whole segment silently — `unknown` renders as ABSENCE OF A CLAIM, so an
unrecognised code is indistinguishable from a dongle that was never asked. The UFI
was in exactly that state: `ufiSim` knew `"valid"`, the firmware answers `"ok"`
(board-measured on `UFI_HM_SIM1_V016_240828`, beside a real IMSI and ICCID), so a
seated card reported no SIM segment at all while ZTE and Huawei rows carried one.
The fix is one accepted code, NOT the vendor's own looser rule — its bundle treats
every non-`"invalid"` value as a good card, and adopting that would report a
future locked state as healthy.

**The bond gate needed NO change, and that is the design working.**
`isSimlessForBond` gates on `"absent"` alone, so `unknown` never gated and the UFI
stayed bondable throughout; once the read was fixed, `"present"` keeps it bondable
for a REASON rather than by default, and a card pulled from it would now correctly
raise `NETIF_ERR_NOSIM`. Confirmed live: the UFI reads `SIM present` and remains
`In Bond`. This is the documented positive-evidence rule, so do not "harden" the
gate to fire on `unknown` when a dialect looks quiet — fix the DATA.

Coverage: `tests/router-cellular-admin.test.ts` (verbatim bench bodies for all three
dialects, the unjustifiable-SIM-code → `unknown` rule, the UFI's `"ok"` seated-card
capture with its unnamed-code negatives, the dev-host no-spawn gate, the
per-interface binding) and `tests/router-cellular-wire.test.ts` (the two adapters'
divergence, no fabricated status/SIM/network list, the twins keeping separate ids).

### …AND A SIM-LESS ONE NEVER JOINS THE BOND [EXISTS]

`no_sim` is ModemManager's answer, and a `router-ethernet` dongle is
architecturally invisible to ModemManager — so the bond gate, which only ever
read that field, never covered this class at all. The dongle still leases the
host a perfectly good address from its OWN embedded router, so it looked
bondable to every rule that reads only an address.

**Board-measured, and the accident that hid it:** a SIM-less ZTE MF79U
(`192.168.0.169`) and a SIM-less Qualcomm UFI were both in `genSrtlaIpList()`,
while their SIM-less Huawei siblings were out — and the ONLY thing separating
the two pairs was that the Huaweis happen to share one factory LAN subnet and so
collided on `NETIF_ERR_DUPIPV4`. Their exclusion was a different rule firing by
luck, not this one working. The operator-visible symptom was the same condition
producing three different toggle states across four dongles.

- **`NETIF_ERR_NOSIM` (0x04) is the mechanism**, set by `applyRouterSimBondGate`
  from the admin cache `router-cellular-admin.ts` already fills. Everything
  downstream then follows for free and CANNOT disagree: `setNetifError` lowers
  `enabled`, `isBondCandidate`'s existing `(error & ~DUPIPV4) !== 0` test
  excludes it, and the frontend's `isBondMember` mirror (`enabled && ip`,
  error-free) drops the row from Bonded Links. A gate that excluded the link from
  srtla WITHOUT lowering `enabled` would have left that documented mirror lying.
- **It runs on EVERY pass, not inside the `intsChanged` branch its dup-IP sibling
  lives in.** The netif map is byte-identical across a SIM being pulled from a
  dongle that keeps its lease, so a topology-gated check would never fire for the
  case it exists for. Pinned by a test that drives two passes with an unchanged
  interface set.
- **`sim: "absent"` is the ONLY gating answer.** It is reachable only from a
  device-stated code the dialect parser was willing to justify — an unreachable
  dongle carries no `sim` field at all and a doubtful one reads `unknown` — so a
  missed 30 s probe cycle can never take a working uplink out of a live bond.
  Do NOT "harden" this to gate on `unknown`.
- **The rule itself is `@ceraui/rpc` `capabilities/sim-bond-eligibility.ts`**,
  shared verbatim with the frontend's toggle. Same argument as
  `device-mode-truth.ts`: a live toggle over a link the device refuses, and a
  disabled toggle over a link the device is bonding, are both lies.
- **Recovery is an operator action, exactly like dup-IP's.** `clearNetifError`
  drops the flag but does not restore `enabled`, so inserting a SIM leaves the
  link excluded until the operator toggles it back in. That is the existing
  behaviour of every netif error flag and is deliberate — the device stops
  refusing, the operator decides to bond.

Coverage: `tests/no-sim-bond-gate.test.ts` — the production path (real
`processIfconfigOutput` against the real admin cache) asserting `genSrtlaIpList()`
and the wire's `enabled`/`error`, the self-correction, the no-topology-change
pass, and the four positive-evidence negatives. Frontend half:
`apps/frontend/AGENTS.md` → "A SIM-LESS LINK CANNOT BE TOGGLED INTO THE BOND".

### …AND THE ZTE/UFI READS EXPANDED WITHOUT GAINING A WRITE [EXISTS]

`modules/network/router-details.ts` (pure) reads the NON-SIGNAL half of what
those two dialects publish — network type, operator, serving cell and band for
the ZTE; radio mode, WAN address, IMSI/ICCID, WiFi name and product record for
the UFI — into the additive `router_admin.details` block
(`routerAdminDetailsSchema`). Todo 20's signal model is untouched: a radio
quantity has to say WHY it is missing, and these are strings the device either
published or did not.

- **The ZTE reads stay ONE request.** `goform_get_cmd_process` takes a
  `multi_data` key list, so the detail keys are appended to `ZTE_READ_KEYS` and
  ride the existing GET. Per-field requests would multiply the module's slowest
  probe by the field count for no new information; a test asserts exactly one
  fetch carrying every key.
- **Absence renders as absence, and an empty block is not a block.** A field the
  device did not state is OMITTED, the vendor's own `-` placeholder (the UFI
  answers it for an unset WAN address, IMSI and ICCID) is dropped at the parser,
  and a device that stated nothing carries no `details` at all — an empty detail
  surface reads as a failed read rather than as a device with nothing to add.
- **Candidate spellings, not one guess per field.** `network_provider`/`provider`
  and `lte_band`/`band` are both asked for, because a second key on an existing
  `multi_data` list costs no request and the device echoes what it does not know
  as an empty string, which this reader already treats as "not stated". Same
  shape as `parseUfiSignal`'s two-command dBm ladder.
- **The block rides todo 10's identity**, so it lands on the physical row rather
  than on an interface name the twin HiLinks swap on replug.
- **NEITHER DIALECT GAINS A WRITE, and the fence is tested three ways**
  (`tests/router-read-expansion.test.ts`): the module source is greped
  comment-stripped for the ZTE set endpoint / `SET_` verbs / `CONNECT_NETWORK` /
  the UFI usb-tether setter (so this prose may name them), `router-details.ts`'s
  export list is enumerated for a mutating name, and every request both probes
  issue is inspected — the UFI posts only `login` and `get*`, the ZTE posts
  nothing at all. `applyRouterCellularControl` still refuses both vid:pids.

Coverage also proves the auth path is the file's existing canon rather than a new
one: a UFI cycle answering `SessionOut` opens exactly TWO sessions (re-auth once)
and then reports `auth-expired` with no detail block, and a cycle whose re-auth
itself fails reports an unreachable dongle.

### …AND THE HiLINK CAPABILITY IS DISCOVERED BEFORE ANYTHING IS OFFERED [EXISTS]

`modules/network/router-capabilities.ts` (pure) reads the HiLink firmware's OWN
network-mode catalog — `/api/net/net-mode-list` plus `/api/net/net-mode`, both
GETs — into the additive `router_admin.capabilities` block
(`routerAdminCapabilitiesSchema`). It exists because "no control" and "we never
asked" were the same thing on screen: the write was correctly refused (the bench
unit answers error `112008` instead of applying it, so its success could not be
observed), and nothing then reported the capability at all.

- **A REFUSAL IS A READING, not silence.** `parseHilinkCapabilities` ALWAYS
  answers. `reported` carries the catalog verbatim (plus the mode the device says
  is selected); `unavailable` carries WHY, in `routerSignalMetric`'s own
  vocabulary plus `refused` — which carries the vendor's own code, so `112008`
  reaches the operator as `112008`.
- **`125002` is SPLIT OUT from every other error code.** It is what every HiLink
  endpoint answers without a valid session token, so folding it in with a
  firmware refusal would tell an operator their dongle cannot do something it may
  do fine. It resolves to `auth-expired`.
- **There is deliberately NO `writable` field, and that IS the staging seam.**
  Proving a setting writable means WRITING it, which this stage does not do, so a
  `writable: true` could only repeat the vendor's own claim — the hearsay
  `applyRouterCellularControl` exists to refuse. `controls` still holds exactly
  the two proven writes; no net-mode control is offered for any firmware.
- **"Before any control renders" is satisfied STRUCTURALLY.** The two reads are
  appended to the URL list `probeHilink` already spawns ONE `curl` for, so
  `capabilities` and `controls` land in the SAME atomic reading — a consumer
  cannot receive one without the other, and the per-unit `--interface` binding
  (the only thing separating the twin HiLinks) is unchanged. A dialect that ran
  no discovery omits the block ENTIRELY rather than shipping an empty one.
- **An entry with no `<Index>` is DROPPED, never given a synthetic id** — the
  index is what a write would have to NAME. A refused or unreadable `net-mode`
  yields no `current` rather than a guess.

**THE DISCOVERY MODULE IS STILL READ-ONLY — the WRITE it gates lives elsewhere.**
Stage B added the `/api/net/net-mode` write and the `/api/dhcp/settings` subnet
rewrite, in `router-cellular-control.ts` / `router-subnet-hygiene.ts` over the
shared `hilink-session.ts` / `hilink-documents.ts`. The fence here was RETARGETED
rather than dropped, and it is strictly stronger: the write tokens must appear in
the write modules and in NEITHER `router-capabilities.ts` nor
`router-cellular-admin.ts`, and a HiLink READ cycle must still POST nothing at
all (its `postViaInterface` throws in the test). Coverage:
`tests/router-capability-discovery.test.ts` +
`tests/router-net-mode-write.test.ts`. Render side:
`apps/frontend/src/main/dialogs/router-dongle-fields.ts` (`netModeCapability`) +
`RouterDongleDialog.svelte`, which offers a control in the REPORTED arm and none
at all in the refused one.

### …AND ITS OWN WEB UI IS REACHED THROUGH A DEVICE-BOUND REVERSE PROXY [EXISTS]

Every setting a router dongle really owns lives in its OWN embedded admin web
UI, and until now CeraUI could only STATE that address: the page is on the
dongle's network, which the operator's browser is not on, so an anchor would
have been a control that cannot work. `modules/network/router-admin-proxy.ts`
(pure) + `modules/ui/dongle-admin-proxy.ts` (effects) +
`modules/ui/dongle-admin-session.ts` (auth) carry that page through CeraUI's own
origin instead, at `/dongle-admin/<wireId>/…`.

**THE PATH NAMES A DEVICE, NOT AN ADDRESS, AND THAT IS THE WHOLE POINT.**
Identical units ship one factory LAN subnet, so the bench pair BOTH lease the
host `192.168.8.100` and BOTH publish `192.168.8.1` as their admin address — a
destination names a PAIR. It is worse than ambiguous: board-measured, the ZTE
(whose own gateway is `192.168.0.1`) also ANSWERED a request addressed to
`192.168.8.1`, because what selects the unit is the BINDING, not the address.
Resolution therefore runs in one direction only —
`wire id → routerCellularIfnameForWireId → that interface's own default route` —
and the request goes out `curl --interface`, the same `SO_BINDTODEVICE`
mechanism `router-cellular-admin.ts` and `device-bound-probe.ts` already use.
Proven live: the two twins' proxy paths returned serials `…872` and `…793`.

**AUTH IS A TOKEN EXCHANGED ONCE FOR A SCOPED COOKIE.** A preview is one socket,
so its single-use token authenticates the whole thing; an admin UI is a browsing
session of many requests, so a single-use token cannot. `system`-style minting
happens over the ALREADY-AUTHENTICATED RPC socket (`modems.openRouterAdmin`),
and the first request swaps it for an `HttpOnly; SameSite=Strict` cookie scoped
to `Path=/dongle-admin`, then REDIRECTS to strip the spent token so it never
lingers in history or in a referrer the dongle would see. No `Secure` — the
device legitimately serves plain HTTP on the LAN, where a `Secure` cookie would
silently never be stored.

**FIVE THINGS ABOUT THE RESPONSE, EVERY ONE OF THEM BOARD-FOUND:**

- **A CONTENT-TYPE THE DONGLE DID NOT STATE IS SNIFFED, or the page DOWNLOADS.**
  The UFI's httpd infers its type from the URL's file EXTENSION, so an
  extensionless path answers with the header ABSENT — board-measured, `GET /`
  returns 200 and a full `<!DOCTYPE html>` body with no content-type, while
  `GET /index.html` returns the same bytes WITH `text/html`. The other two
  dialects never reach that state because both REDIRECT `/` to an explicit
  `.html` path. Absence is not neutral: `Bun.serve` labels a content-type-less
  response `application/octet-stream`, so the browser is handed a positive
  "this is a file" and DOWNLOADS the admin page — and the same absence silences
  `shouldRewriteBody`, so the page's own `/static/…` refs stay pointed at
  CeraUI's origin. One defect, two symptoms. `sniffAbsentContentType` applies
  the mimesniff HTML prefixes, and ONLY when the device stated nothing — a
  dialect that named a type is byte-untouched, whatever it named. No charset is
  asserted; the document's own `<meta charset>` knows better than a sniff.
- **`--compressed` is mandatory.** The HiLink serves its scripts PRE-GZIPPED and
  answers `Content-Encoding: gzip` even to an explicit `Accept-Encoding:
  identity`. Without the flag the browser gets gzip bytes under a
  `text/javascript` label. `content-encoding` is stripped from what we forward
  ONLY because curl already decoded it — the flag and the strip belong together.
- **Header capture goes to a TEMP FILE, never `/dev/stderr`.** Against a Bun PIPE
  that form never completes: `exitCode` comes back `null` with both streams
  EMPTY, while the identical argv writing to a file exits 0 with a full header
  block. It works under a shell redirect, which is exactly why a hand-run
  `curl … 2>/tmp/h` looks fine and the same command under `Bun.spawn` does not.
- **`X-Frame-Options` / CSP / HSTS are stripped.** A dongle must not dictate
  framing or transport policy for the DEVICE's origin; an HSTS pin in particular
  would lock an operator out of a board that serves plain HTTP on the LAN.
- **`Set-Cookie` is re-pathed onto the per-device prefix.** Two identical twins
  issue cookies of the SAME name, so without it they overwrite each other's
  session on CeraUI's one origin.

**URL REWRITING IS BEST-EFFORT, AND ITS LIMITS ARE MEASURED, NOT ASSUMED.**
`rewriteAdminBody` re-points root-relative references so an opaque vendor SPA
loads under a path prefix. Three rules exist only because each was found
breaking a real page on the bench, and every one of them is a REFUSAL to rewrite:

1. **A path must name a DIRECTORY outside CSS** (`"/api/…"`), because a regex
   literal may END in a quote — jQuery 1.7.2 ships `replace(/'/g, …)` and
   `/ jQuery\d+="(?:\d+|null)"/g`, which are character-for-character
   indistinguishable from a quoted path. Rewriting them produced
   `SyntaxError: Invalid regular expression flags` and took jQuery out entirely.
2. **`(` is a delimiter in STYLESHEETS only**, because in JS it also opens a
   regex: `replace(/-/g, …)` became `replace(/dongle-admin/1001/-/g, …)`, and
   `main.js` then defined nothing and threw `create_button is not defined`.
3. **A DATA payload is never rewritten**, whatever the content-type claims — the
   HiLink API answers XML under `text/html`, so the header alone would sweep
   every session token and API document into the transform. A bare `"/"` is
   likewise left alone: it is the same three characters as `split('/')`.

So a single-segment `"/index.html"` is NOT rewritten. That is the accepted cost —
corrupting a script the device depends on is a far worse failure than one
unrewritten link, and the BINDING, which is what decides WHICH physical unit
answers, does not depend on any of it.

**TWO ADDITIONS, both forced by the UFI's Vue/webpack SPA and both narrowed
rather than generalised:**

4. **An UNQUOTED attribute is still an attribute.** Everything above keys on a
   QUOTE, and html-minifier output has none: the UFI's index is
   `<link href=/static/css/app.css>` / `<script src=/static/js/app.js>`, so every
   asset reference survived untouched. The extra pass is deliberately NOT a bare
   `=` delimiter — `re=/foo/` is exactly that shape in JavaScript, the same trap
   `(` was banned for — but is restricted to `text/html` bodies AND to the fixed
   set of attributes HTML DEFINES as URL-valued.
5. **A bundler's public path is the one assembled URL that CAN be followed.** The
   standing "a URL built at runtime out of fragments cannot be followed" caveat
   has exactly one important exception: a webpack runtime carries a SINGLE
   literal (`n.p="/"`) and composes every lazy chunk as `n.p + "static/js/" + …`.
   Board-measured, that sent chunk 0 to CeraUI's origin root, which answered with
   CeraUI's own index under a `text/html` label — so the vendor SPA loaded its
   shell and mounted NOTHING. Re-basing that one literal fixes every chunk it
   will ever assemble, and it is gated on the body positively BEING a webpack
   runtime (`webpackJsonp`/`__webpack_require__`), so an unrelated `.p="/"` is
   out of reach.

**Board-proven end to end, twice.** (2026-08-18, two Huawei E3372 twins): each
twin's button opens its own session, the vendor SPA runs its full API sequence
through the proxy with ZERO page errors, and each lands on its own unit —
`Y4QDU17621000872` (`enx0c5b8f279a64`) and `Y4QDU17621000793` (`eth1`).
(2026-08-18, Qualcomm 4G UFI `enx020a53313630`, fresh Playwright context with
`serviceWorkers: 'block'`): the button RENDERS the vendor SPA instead of
downloading it — `content-type: text/html`, zero downloads — the operator logs
into the dongle, and sub-navigating to its Wifi settings page keeps **every**
request under `/dongle-admin/1003/`: zero requests escaped to CeraUI's origin.

Coverage: `tests/router-admin-proxy.test.ts` — the bench default-route fixture
producing two different bindings from ONE address, the end-to-end binding proof,
the token/session matrix, the rewriter's refusals (the two verbatim jQuery
regex literals, the XHTML self-closing tag, the XML payload, the separator
literal), and the UFI's verbatim content-type-less index driven end to end
(served as HTML, assets re-pointed) with its stated-type and unquoted-attribute
negatives plus the webpack public-path pass. Rule-E proof: resolving the binding
by ADDRESS instead of by identity reddens exactly the two tests that carry that
correctness claim; dropping the sniff or the unquoted-attribute pass reddens
three more.

### …AND THE WRITES IT GATES ARE STAGE B [EXISTS]

`router-cellular-control.ts` (net-mode + the two proven toggles),
`router-subnet-hygiene.ts` + `router-subnet-plan.ts` (the LAN-subnet rewrite),
`router-subnet-rollback.ts` (its replay handler) and
`rpc/procedures/modems-router.procedure.ts` are everything this build writes to a
router dongle. `router-cellular-admin.ts` reads and nothing in it mutates
(808 → 683 pure LOC; the extraction todos 20, 23 and 22-Stage-A each recorded as
owed).

- **THE NET-MODE WRITE IS CAPABILITY-GATED, NOT VERSION-GATED.** It re-reads
  `/api/net/net-mode-list` in ITS OWN cycle and refuses BEFORE building any
  request document when the firmware will not name a catalog — so the bench unit,
  which answers `112008`, is never POSTed to and the operator is told `112008`.
  Reading the 30 s poll cache instead would act on a capability that was true
  minutes ago. `capability_unavailable` (the firmware declined), `not_offered`
  (the catalog exists and lacks that index) and `unsupported` (this build has no
  net-mode write for that dialect) are three different facts and are never
  collapsed. It takes the LEASE and is NOT journaled: a radio-mode selection
  cannot cost the LAN path, so there is nothing a rollback would restore that the
  next write cannot simply set.
- **THE SUBNET REWRITE IS OPTIONAL HYGIENE AND NEVER A BONDING PREREQUISITE.** A
  twin pair on one factory subnet already bonds — `bind-map.ts` describes each
  uplink by INTERFACE and the sender binds `SO_BINDTODEVICE` — so nothing on the
  bonding path may call into it. The fence is on the IMPORT GRAPH (a bonding
  module that cannot name it cannot require it), not on prose.
- **IT IS THE ONE ROUTER WRITE THAT IS JOURNALED**, under todo 25's
  `withJournaledModemMutation` with its own `router-subnet` kind, its own
  pre-state shape (the whole `/api/dhcp/settings` record + ifname + target) and
  its own registered rollback. Ordering is the safety argument: preflight (all
  reads) → journal armed → re-read under the lease and refuse `state_drifted` if
  it moved → `markExecuting` → write → DHCP renewal → confirm.
- **THE OLD ADDRESS IS RETAINED AND PROBED.** After a failed confirmation the
  device is at exactly one of two addresses — the new one (the write landed, the
  host could not follow) or the old one (it never landed) — and only asking BOTH
  can tell those apart. `locateDevice` matches on the RECORD as well as the
  address, so "something answered there" is never mistaken for "the device is
  there" on a shared factory subnet.
- **THE ROLLBACK IS CANCELLED ONLY AFTER REACHABILITY IS RECONFIRMED.** `applied`
  (reached at the new address) and `reverted` (restored AND reconfirmed at the old
  one) both leave nothing outstanding, so the journal entry is cancelled — keeping
  a device blocked that was just proven healthy would be fail-closed theatre.
  `blocked` (answered at neither) is the ONLY outcome that leaves the entry
  `failed`, which is exactly the case the journal exists for.
- **Only /24 is accepted, and only RFC1918.** Re-hosting a DHCP pool across an
  arbitrary prefix means guessing which bits are the host part, and a wrong guess
  writes a pool that does not contain the addresses it serves. Everything except
  the address family is CARRIED — pool bounds, lease time, DHCP/DNS flags — and a
  DNS entry pointing at the dongle ITSELF follows it while one pointing elsewhere
  is left alone.
- **`SUBNET_CONFIRM_ATTEMPTS` × `SUBNET_CONFIRM_DELAY_MS` (6 × 2 s) is bounded on
  purpose**: an unbounded wait is a mutation that never resolves and a lease that
  is never released.

**HONEST STATUS: none of this has been exercised against a real dongle.** The
`112008` code is a real bench measurement; every document shape is derived from
the dialect. The auto-restore path in particular is fixture-proven only, and the
`nmcli device disconnect`/`connect` renewal has never run on a board.

**The subnet rewrite DOES have an operator surface now, and the shape it takes is
what carries that honest status.** It is not a toggle: the operator names the
target address, and an explicit second act confirms it against a sentence that
SAYS the restore has been proven against recorded replies and never yet against
real hardware. It is offered only where `router_admin.controls` is published —
i.e. only for the dialect whose writes were round-trip-proven, which is the same
dialect `prepareSubnetRewrite` accepts — so a dongle that would be answered
`unsupported` never renders the field. Nothing about the device side changed:
`confirm: z.literal(true)`, the per-device lease, the durable journal and the
armed rollback are exactly as described above, and the UI is a caller like any
other. Coverage: `tests/router-net-mode-write.test.ts`,
`tests/router-subnet-hygiene.test.ts`, `tests/router-stage-b-interlock.test.ts`;
operator half: [`../frontend/AGENTS.md`](../../../frontend/AGENTS.md) → THE ROUTER
ACTION SURFACE.

### …AND WHETHER IT NEEDS A LOGIN IS ONE OF FIVE STATES [EXISTS — UNPROVEN ON A LOCKED DEVICE]

`modules/modems/modem-lock-state.ts` (the pure model + its session) and
`modem-credential-verify.ts` (the device-facing attempt) turn todo 7's credential
store into a state an operator can act on. The wire fields are
**`modem.lock_state`** — exactly `open` / `locked` / `unlocked` / `auth-failed` /
`locked-out` — and **`modem.lock_detail`**.

**`open` IS DETECTED, AND ITS ONLY EVIDENCE IS A DOCUMENT THAT STATES IT.** Every
dongle on this bench answers unauthenticated, so `open` is the COMMON case and
prompting for a password at one of them is the dishonesty this surface exists to
remove — but "nobody refused us" is not the same claim, because a refusal can
also be a read that never happened. HiLink's `/api/user/state-login` answers the
question directly (`State: 0` ⇒ usable with no credential presented, `-1` ⇒ a
login is required), so it rides the batch the 30 s admin cycle already spawns and
is read on a FRESH session — which is what makes `0` mean "no credential needed"
rather than "somebody logged in earlier". ZTE goform and Qualcomm HIMI publish no
equivalent, so they resolve `locked`. An UNANSWERABLE read DROPS the cached
evidence rather than retaining it — the deliberate opposite of this codebase's
usual retain-on-failure rule, because `open` is the only value that WIDENS what a
row offers and a claim we can no longer support must be withdrawn.

**`protocol-mismatch` IS NOT `auth-failed`.** Todo 6's ZTE vocabulary
(`lockout` / `auth-rejection` / `protocol-mismatch` / `auth-accepted`) maps onto
the states through `classifyAuthAttempt`, and three of the four map directly. The
fourth does not: the dialect answered a login shape this build ships no proven
implementation for, so the credential was never presented and reporting it as a
rejection would tell an operator their password is wrong. It resolves `locked`
carrying `lock_detail.sub_reason: "unsupported-profile"`.

**THE RESOLUTION ORDER IS THE CONTRACT.** A live lockout outranks everything (it
is the only state that forbids an action rather than describing one, and an
`open` device can never have produced a lockout record); positive open evidence
then outranks any session history, because a device that currently states it
needs no login needs none whatever was tried at it earlier; below that it is the
session's own last word, and a device that has said nothing is `locked` — the
honest floor.

**`unlocked` MEANS THIS SESSION, so the session map is in memory.** Todo 7's
persisted `lastOutcome` is the right shape for "what this credential last did"
and survives a reboot; a boot that has presented nothing has unlocked nothing.

**THE CAPABILITY EXPANSION RIDES THE EXISTING SURFACE, NOT A NEW ONE.**
`gateRouterAdminByLock` withholds `router_admin.capabilities` and
`router_admin.controls` — the two blocks that describe what an operator may DO to
the dongle — while the lock does not permit an authenticated session, and the
same rebuild offers them again the moment a verify lands. Every OBSERVATION on
the block (admin URL, model, SIM, signal) passes through untouched: those are
facts rather than offers, and withholding them would report a reachable device as
unreadable. Today's fleet detects as `open`, so the reading is byte-unchanged for
every device currently on the bench.

**The three procedures are `authedProcedure`, NOT `modemProcedure`**
(`rpc/procedures/modems-credentials.procedure.ts`), for the reason
`modems.getCapabilities` is: a router dongle is architecturally invisible to
ModemManager, and an operator most needs to fix a credential exactly while the
cellular stack is initializing — which is when `cellularReadyMiddleware` refuses
everything. They take no lease and touch no radio.

- **`verifyCredentials` presents the credential EXACTLY ONCE.** There is no
  retry: every dialect here counts a failed login toward a lockout the operator
  cannot clear, so a retry spends the attempts that would have let them fix a
  typo. A device already inside a lockout window is refused BEFORE a transport is
  opened, so it costs ZERO device requests.
- **A rejected device transport is `unreachable`, never an authentication
  verdict.** Both the open-detection read and the single login attempt translate
  a rejected transport promise into the typed refusal. Detection failure also
  withdraws any cached `open` evidence, because that claim widens the row and the
  device can no longer support it. Neither rejection records `auth-failed`, and
  neither is retried.
- **`setCredentials` verifies before storing.** Its request-local candidate is
  presented once through the existing login port; only accepted authentication
  writes the existing mode-0600 atomic store. Failed candidates never enter the
  entries map, and failure outcomes never reserialize an old credential.
  An `open` device remains refused as `device_open`. The additive `verification`
  field distinguishes `admin_unreachable`, `credentials_rejected`, and `verified`;
  unsupported profiles and lockouts retain their existing distinct refusals.
- **Clearing a credential drops the session verdict with it**: a credential that
  no longer exists cannot keep a row `unlocked`. It also cancels pending
  verification so a late successful reply cannot resurrect the forgotten login.
- **No output carries a password.** `modemCredentialsOutputSchema` is a plain
  `z.object`, so a field added upstream by mistake is STRIPPED, and
  `rpc-logging.ts` omits these three procedures' args entirely (a per-PROCEDURE
  set beside the `auth.*` namespace one, because the rest of `modems.*` is
  ordinary and blanking all of it would throw away real diagnostics).
- **`initModemCredentials()` is wired at boot**, beside `initCellularStack` and
  ahead of the modem loop: the first `modems` payload carries every row's lock
  state, and an unloaded store reports a device with a stored login as having
  none.

**HONEST STATUS: no locked device exists on this bench.** All three dialects
answered unauthenticated, so the `open` path is the only one hardware has
exercised. The HiLink login derivation is modem-stack's certified one
(`providers/huawei-hilink/session.ts`, password types 3 and 4) re-stated for Rule
D and NOT run against a device that demands it; ZTE and HIMI ship no login at all
and answer `protocol-mismatch` deliberately, because an unproven credential
derivation would burn a real operator's attempts against a real lockout counter.

The public defaults live in `network/router-credentials.ts`; the existing UFI
read session consumes its generic-RNDIS `admin` pair. HiLink and unknown profiles
have no implicit credential. No new login protocol is added: the captured ZTE
row's password outcomes are injected in regression tests, not hardware-proven.
Persistence and session-draft contract: `../../docs/CONFIG_PERSISTENCE.md`.

Coverage: `tests/modem-credential-persistence.test.ts` (real temporary store,
failed replacement, pending clear, mode-0600 restart reload),
`tests/router-credentials.test.ts`, and `tests/modem-credential-unlock.test.ts` — all five states reachable and
EXPLICIT on the wire (including the no-admin-surface negative), the resolution
ladder with its withdraw-the-open-claim case, the four refusal mappings with the
`protocol-mismatch` ≠ `auth-failed` assertion, the capability withhold/offer pair
and its observations-survive control, the zero-request lockout, the no-retry
proof by attempt count, the password-absence assertions (schema strip, real
verify outcome, and the derived login document), the rpc-logging omission with
its diagnosable-namespace control, and static locks that the SHIPPED producer
really calls the gate and the SHIPPED admin cycle really reads the login-state
document. Rule-E proof in both directions: neutering the capability gate reddens
2, folding `protocol-mismatch` into `auth-failed` reddens 2, moving the lockout
check below the transport reddens 1, dropping the procedures from the log
omission set reddens 1, and encoding `open` as absence reddens 2.

## …AND ONE RESOLVER DECIDES WHICH PHYSICAL DEVICE IT IS [EXISTS]

`modules/modems/physical-identity.ts` is the SINGLE resolver of a physical-device
record, and the single authority that MINTS the opaque per-link `link_id` the
bind-map writer publishes and the telemetry registry consumes. Before it, the
same stick was described by two resolutions that could not agree: `fromMmcliModem`
anchored on the udev `ID_PATH`, while `fromRouterCellularView` had no anchor at
all and keyed on the interface NAME — the one property this fleet has already
proven unusable.

**The identity ladder, and why each rung is where it is** (board-measured on
`ceralive2`, 2026-08-17, todo 2 — every rung is a reading, not a preference):

| Rung | Applies to | Why |
|---|---|---|
| `usb-serial` | the Qualcomm dual-mode sticks (`2b16081`, `c6125db3`) | a `uhubctl` power cycle flipped one from `05c6:9024`/`rndis_host` to `05c6:9091`/`qmi_wwan` under the SAME serial, so VID:PID is PROVEN not to be an identity and the serial is proven to survive the one transition that moves a device between adapter classes |
| `id-path` | the two HiLink twins | they expose NO usable USB serial (freshly re-read, not assumed) and share one factory MAC, so only the PORT separates them. Identity is SAME-PORT stability: stable across a replug into the same port and across a composition change, and DELIBERATELY different when a unit is moved to another port |
| `ifname` | anything with neither | the honest floor; the record says `anchor: "ifname"` rather than looking stronger than it is |

**There is deliberately NO alias table unifying rungs.** A port alias pointing at
a serial-anchored identity would hand the NEXT device plugged into that port the
previous unit's identity — a silent misattribution far worse than a re-minted id.

**`stable_key` is NOT `identityKey`, and this todo did not re-key it.** The wire's
`stable_key` keeps its exact meaning — the ID_PATH-derived key from the ONE shared
`deriveModemStableKey` rule — because todo 17's consumers correlate on it, the
usage-policy store files under it, and the projection fixtures lock it. What
changed is that the DIRECT router adapter now HAS one: the sysfs sweep reads the
parent USB device's `ID_PATH` out of its udev entry, so a classified dongle is
keyed by port instead of by ifname. `identityKey` is the internal correlation key
that additionally admits the serial rung, and `link_id` derives from THAT.

**`link_id` is `lnk_` + the first 16 hex chars of `sha256(identityKey)`.** A hash
rather than a counter, for three reasons the consumers require: it is stable
across reloads with NO persisted state (a counter would need a store whose failure
renumbers every link), stable across composition changes, and it carries no
secret — a USB serial must not ride the wire, and a digest stays
equality-comparable, which is the only operation consumers may perform.

**The descriptor sweep covers mm-managed devices too, and that is load-bearing.**
`scanUsbNetMarkers` now also returns a `physical` map (`UsbPhysicalDescriptor`:
vid/pid/serial/`ID_PATH`/hwdb + resolved labels) for EVERY classified USB net
device, not only router-class ones — that is what lets the same stick resolve to
ONE identity in both of its compositions. Nothing in that map reaches the `netif`
wire; the two existing markers are untouched. Its `serial` is carried
unconditionally, unlike the wire marker's twin discriminator, because an identity
anchor is needed by a lone device just as much as by a twin.

**Display-name precedence**: the MM identity observation — which IS the existing
HIMI firmware-string chain (`modem-identity.ts` `modemHardwareName`), layered on
rather than replaced — then the dongle's own admin API, then the descriptor/hwdb
labels, then `vid:pid`. The descriptor floor is NOT filtered through
`isUninformativeIdentity`: that rule judges mmcli's own answers, where a bare
numeral is measured garbage, whereas here a bare numeral is the PRODUCT ID that
the classifier deliberately chose as its honest floor (`Qualcomm 9024`).

**A router row's wire id can no longer be parsed back into an interface.** Its
allocation key is now an `ID_PATH`, which names a port, so
`routerCellularIfnameForWireId` reads a mapping the last collection recorded
explicitly and answers `undefined` for anything it did not record — never a
neighbouring interface.

`physical-identity-source.ts` is the one place that assembles an observation from
the live caches; the resolver itself reads no device.

Coverage: `tests/modem-physical-identity.test.ts` — the dual-mode stick's identity
and `link_id` across the 9024⇄9091 flip (both bench sticks, with the two-sticks
negative), its coherent titling in both compositions, the twins resolving DISTINCT
port-anchored identities, same-port replug stability under a name change, the
deliberate different-port divergence, hwdb model recovery, the minting contract
(determinism, no serial leakage), the router adapter's real `stable_key` plus its
ifname fallback, the mmcli row's byte-identical `stable_key`, and the preserved
HIMI chain.

### The two `05c6:9024` sticks are RNDIS + read-only UFI devices [EXISTS]

Historical pre-RAUC evidence below records why the kernel fix was required. Todo
61 enabled `CONFIG_USB_NET_RNDIS_HOST=m` and both units now enumerate as
`enx020754023235` and `enx020a53313630`. Todo 69 then probed each interface with
its own `curl --interface` binding: both default routes use `192.168.100.1`, and
both return HTTP 200 with an HTML page titled `4G UFI`.

The current CeraUI admin surface recognizes vendor `05c6` as the `ufi` dialect and
reads only that root HTML shell into `router_admin.model`. It publishes no status
fields and no controls: the shell is proven reachable, but no settings endpoint
or write round-trip has been proven. Keep the interface binding and the
read-only/no-fabrication rule. Evidence and tests: root
`.omo/notepads/modem-stack-phase-b/learnings.md` Todo 69 entry and
`tests/router-cellular-admin.test.ts`.

Historical pre-fix evidence (before todo 61) follows:

```
1-1.4.1:1.0  icE0isc01ip03   ← Wireless Controller / RF / RNDIS  (control)
1-1.4.1:1.1  ic0Aisc00ip00   ← CDC Data                          (RNDIS data)
1-1.4.1:1.2  icFFisc42ip01   ← vendor-specific (Android ADB)
   driver link exists: NO DRIVER BOUND   (all three, both units)
```

`icE0isc01ip03` is the RNDIS host-facing Ethernet function. The only driver that
binds it is `rndis_host`, and on the shipped kernel it does not exist:

```
$ zcat /proc/config.gz | grep RNDIS_HOST
# CONFIG_USB_NET_RNDIS_HOST is not set
$ modprobe rndis_host
modprobe: FATAL: Module rndis_host not found in directory /lib/modules/7.1.7-ceralive-rk3588
$ find /lib/modules/$(uname -r) -name '*rndis*'
/lib/modules/7.1.7-ceralive-rk3588/kernel/drivers/usb/gadget/function/usb_f_rndis.ko   ← GADGET, not host
```

`modules.alias` carries no entry claiming `ice0isc01ip03` at all, so udev never
even has a candidate to load. `cdc_ether` is loaded and cannot substitute —
`rndis_host` is a separate module that depends on it. Every other USB-net driver
IS built (`cdc_ncm`, `cdc_mbim`, `qmi_wwan`, …); RNDIS host support is the single
omission.

**Out of this repo's scope, and the fix is one Kconfig symbol.** The device
image's kernel needs `CONFIG_USB_NET_RNDIS_HOST=m` (`drivers/net/usb/Kconfig`,
depends on `USB_NET_CDCETHER`, which is already `=m`). Owner:
`image-building-pipeline` — same class of gap as todo 35's modem udev policy that
existed in source and never shipped. Nothing in CeraUI should paper over it: with
no netdev there is no `netif` key, so there is correctly no row, and inventing one
from `lsusb` would be a device the operator cannot bond, act on, or explain.

## …AND THAT IDENTITY IS PUBLISHED AS A BIND-MAP, SO TWIN MODEMS BOTH BOND [EXISTS]

CeraUI is the WRITER of the `srtla` sender's ADR-003 bind-map contract
([`docs/adr/ADR-003-bind-map-contract.md`](https://github.com/CERALIVE/srtla-send-rs/blob/main/docs/adr/ADR-003-bind-map-contract.md)).
The sender identifies an uplink by its local SOURCE IP, and two identical HiLink
twins both lease `192.168.8.100` — so the sender's pool builder silently
collapsed the second one and the operator saw ONE link with two modems plugged
in. The mapping that resolves it is information only this backend has.

**Two files, one writer, one order.** `bind-map.ts` (pure: document shape, row
validation, collision groups) + `bind-map-writer.ts` (atomic publication).
`BIND_IPS_FILE` stays **BYTE-UNCHANGED** — pinned by `streaming-bun-io.test.ts`,
which now proves the two-file publisher did not move a byte of it — and the
mapping rides a separate versioned JSON sidecar (`setup.bind_map_file`, default
`<ips_file>.bindmap.json`) that describes it **POSITIONALLY**: the Nth row
describes the Nth accepted IP line. Publication order is ips-file rename →
**sidecar rename (COMMIT POINT)** → SIGHUP, each through a unique temp sibling
(`<target>.<pid>.<n>.tmp`), `open`+`writeFile`+`fsync`+`rename`, mode **0600**
(the reader REFUSES a group- or world-writable sidecar, so `Bun.write` — which
neither fsyncs nor sets a mode — is deliberately not used here).

- **`link_id` is MINTED BY TODO 10** (`physical-identity.ts` `mintLinkId`) and
  never invented here. One id authority, or the bind-map writer and the telemetry
  registry attribute the same operator's link to two different devices.
- **…and a link it cannot answer for is UNMAPPABLE, not renamed.** A failed
  identity resolution used to fall back to `` `lnk_${ifname}` `` — a string with
  the exact shape of a minted id, keyed on the one property this fleet has
  already proven is not a device. The bench twins ship ONE factory MAC, so
  systemd can name only one of them predictably (`enx0c5b8f279a64`) and the other
  falls back to `eth1`; a replug can swap which is which, and an id keyed on the
  name follows the NAME, handing the next device in that socket the previous
  unit's telemetry row. `describeBondEntry` now answers with `bind-map.ts`'s
  `unmappableBondEntry(ip, iface)` — no id, and no way to pass one in — which
  stamps the explicit `identityState: "unmappable"`. Four properties are
  load-bearing:
  - **The entry is KEPT.** It is still returned, its IP still goes in
    `BIND_IPS_FILE`, and the link still carries traffic. What it loses is the
    CLAIM that we know which device it is — a dropped entry would be the silent
    loss this whole contract exists to end.
  - **It cannot become a sidecar row**, by construction: `isMappableEntry` is a
    type predicate answering `entry is MappedBondEntry` (an entry carrying a
    minted id), and `buildBindMapDocument` takes only those. So the writer's
    EXISTING undescribable-link path runs unchanged — the IP list is published,
    the sidecar is retired, and the launch reports `degraded` through the ONE
    normalized disposition rather than through a new vocabulary.
  - **The consequence for a DUP-IP link is deliberate, and is the documented
    rule rather than a new one:** `admitEntry` already admits a duplicate-IP link
    ONLY when it can be described, so a twin whose identity resolution failed is
    now excluded instead of joining the bond under a name-keyed id. In practice
    this is unreachable — `resolvePhysicalDevice` always resolves, falling back
    to its stated `anchor: "ifname"` rung — so the catch fires only on a genuinely
    broken descriptor read.
  - **`setBondIdentityResolverForTest` is the seam** (the `set*ForTest`
    convention) that makes the failure drivable without a module mock.
- **The degraded state RIDES THE WIRE as `linkTelemetry.links[].identity_state`**
  (`@ceraui/rpc` `bondLinkIdentityStateSchema`), emitted only as `"unmappable"`.
  `link-telemetry-rows.ts`'s `unmappableByIface` is SUPPRESSION-ONLY: it can
  never promote a row to an identity (no `link_id`, no `port_label`, no
  `serial`), so the legacy `conn_id` rung's rows stay byte-identical and the
  marker only ever answers the question the ladder's silence leaves open — is
  this link KNOWN-unidentifiable, or merely unresolved on this rung. Absence
  therefore makes NO claim in either direction. Do NOT widen it into a rung that
  resolves an identity by the derived interface name: `legacyIface` picks the
  first interface holding a shared address, which is exactly the ambiguity rung 3
  is gated on.
- **`generation` is monotonic per WRITER PROCESS** and increments on EVERY
  publication, including one whose IP bytes did not change. That is the only
  signal a MAPPING-ONLY change can produce — moving a link between interfaces
  leaves the digest identical — so the session's SIGHUP is keyed on
  `publication.changed`, never on an IP-list diff.
- **A failed sidecar write RETIRES the sidecar.** One that survives its own failed
  republication describes bytes no longer on disk, which the reader can only call
  a hash mismatch; absent is the honest state (`missing_file`).

### THE DUPLICATE-IP POLICY SPLIT

**Wire projection:** `netifEntrySchema.error` is an optional string.
`netIfBuildMsg()` obtains it from `getNetifErrorMsg()`, which returns ONE matching
bit's description, not the complete bitmask. `NETIF_DUPLICATE_IPV4_ERROR` in
`@ceraui/rpc/schemas` names the existing spelling without changing serialized
bytes. A compound error can therefore carry that same string; only the paired
`enabled:true` projection proves `isBondCandidate()` admitted the link. The HUD
mirror consumes that pair, not telemetry availability. Characterization coverage:
`tests/bond-eligibility-wire.test.ts` (mappable, unmappable, opted-out and compound
cases through the real projection and sender-list generator).

`NETIF_ERR_DUPIPV4` answered two questions with one bit, and they have OPPOSITE
correct answers once a mapping exists:

| Question | Answer | Why |
|---|---|---|
| may it be a generic SOURCE-IP? | still **NO** | an operation steering by source address cannot tell the twins apart. `probeExclusionReason` is unchanged, and a test asserts it. |
| may it join the BOND? | **YES**, when a row can be published | the row names the INTERFACE too, and the sender binds `SO_BINDTODEVICE` |

The flag stays raised on the per-interface `netif` wire, and `isBondCandidate`
answers bond membership separately. **Two identical lines in `BIND_IPS_FILE` are
LEGAL** and covered. `enabled` still governs membership — but a dup-IP link's
`enabled` is forced false by the flag itself, so the operator's own choice lives
in `operatorBondOptOut` (`setBondOptOut`, written by `handleNetif`) rather than in
a bit the error path overwrites. A link that cannot be DESCRIBED
(`isMappableEntry`: valid iface name, valid `link_id`, non-empty ip) is not made
eligible by wishing.

**…AND THE NOTICE THE OPERATOR SEES IS A SEPARATE, RE-EVALUATED DECISION.**
The flag above answers a policy question; `netif_dup_ip` answers an honesty one,
and it is decided by `decideDupIpNotice(groups, deps)`
(`network-interfaces.ts`) rather than read back off the flag. Three properties
are load-bearing, and each was a defect before it was one:

- **It is a WARNING, never an error.** An excluded twin is a DEGRADATION of the
  bond, not a failure of the device — and the retired band asserted a fault at
  `"error"` severity while its own message ended "…they can still be bonded when
  per-interface link mapping is active", i.e. it raised an alarm and then
  explained the alarm was handled.
- **A FULLY MAPPED GROUP IS SILENT.** The notice consults `isBondMappingActive()`
  — the ONE authority on whether the (ip,iface) mapping is really in force — and
  then `isBondLinkMappable()` per member, so a band is produced only for a group
  that is genuinely still ambiguous: no mapping (the sender collapses duplicate
  source IPs and one link really is missing), or a mapping in force with an
  `unmappable` member (no row can be published for it, so it is excluded from the
  very mechanism that would have disambiguated it). Silence loses nothing: the
  per-interface `error: "duplicate IPv4 addr"` still rides the `netif` wire and
  the Network page still renders it.
- **IT IS DECIDED ON EVERY PASS, OUTSIDE `intsChanged`.** Both the raise and the
  retraction used to sit inside that branch, and a bond-mapping transition moves
  no interface, no address and no flag — so nothing re-evaluated and the band
  could never clear. Same raise-but-never-retract family as
  `policy_route_missing`. `duplicateIpGroups()` is likewise recomputed from the
  live addresses each pass rather than read back off `NETIF_ERR_DUPIPV4`, whose
  flags are only refreshed on a topology change.

`DupIpNoticeDeps` is installed (`wireDupIpNoticeDeps`) rather than statically
imported, because both facts live under `modules/streaming/`, which imports this
module. The defaults answer NO to both, which is the fail-safe direction: an
unwired process REPORTS the collision rather than silently claiming it is
handled.

### THE PRE-SPAWN CAPABILITY PROBE — the backward-compat guarantee

`bind-map-spawn.ts` `resolveBindMapArgs` runs `<sender> --capabilities-json`
(`srtla-capabilities.ts`, `spawnWithTimeout`, 3 s, registered in `SPAWN_POLICY` as
`srtlaSend.capabilityProbe`) **BEFORE the argument vector is built**, and passes
`--bind-map` ONLY on a valid `bind_map: true` document. **Non-zero exit,
unparseable JSON, or a timeout ⇒ NO SUPPORT** — matched on NOTHING, not the code
and not the message, so a new CeraUI against an OLD sender emits the
byte-identical legacy vector. Passing an unknown flag would make that binary exit
with a usage error, i.e. a failed stream rather than a graceful downgrade. Do NOT
move the probe below `buildSrtlaSendArgs`, and do NOT "simplify" the probe into a
try-and-react.

### THE TYPED-DISPOSITION PRODUCER BOUNDARY

`bind-map-disposition.ts` is the ONE normalized stream the UI consumes (todo 12);
it NEVER infers. Two launch paths exist that the sender structurally cannot report
— an old binary that was never given the flag, and a mapping the writer could not
put on disk — and CeraUI knows exactly what it published and which rows collide,
so it SYNTHESIZES the verdict WRITER-SIDE using **todo 8's exact value names**:

| Cause | `bind_map_status` | `disposition` |
|---|---|---|
| bind-map passed | `active` | `mapped` |
| probe: no support | `degraded(unsupported)` | `startup_collision_excluded` + groups, else `legacy_unique_only` |
| mapping write failed | `degraded(missing_file)` | same rule |

`noteSenderBindMapReport` REPLACES the synthesized value once telemetry arrives
(`source: "sender"`); `noteWriterBindMapReport` retires a previous session's
sender claim. `bind-map-notification.ts` turns the typed disposition into the
operator band and **the second link is never dropped in silence**:
`retained_last_valid` → degraded-but-both-twins-running; `startup_collision_excluded`
→ names the colliding IP and the LINE positions (never `conn_id`s), and refuses to
name WHICH physical twin survived because legacy mode cannot know;
`legacy_unique_only` → unique links normal, a collision group would be absent.
The band is retracted on stop (`clearBindMapReport`) — a persistent notification
never expires on its own.

Coverage: `tests/bind-map-writer.test.ts` (the twin fixture producing 2 bonded
rows + a coherent file pair, the flag/probe split, the opt-out, mode 0600,
mapping-only `changed`, unmappable + failed-sidecar retirement, and the static
SIGHUP-wiring lock), `tests/bind-map-spawn.test.ts` (every probe failure mode →
legacy vector; a disposition on EVERY branch), `tests/bind-map-disposition.test.ts`
(the capability-document table, writer synthesis, sender-replaces-writer, and all
seven degraded reasons reaching a band),
`tests/bond-entry-degraded-identity.test.ts` (a forced resolution failure driven
through the REAL netif scan → `genSrtlaBondEntries` → writer → registry →
`status.linkTelemetry`: the entry is kept, carries no id, cannot become a row,
still publishes its IP, and reaches the wire as `identity_state: "unmappable"` on
both the legacy rung and a sender that echoes its interface — plus the
byte-compat control that a healthy bond gains no marker anywhere), and
`tests/link-id-authority-gate.test.ts` (the comment-stripped repo walk: no
`lnk_` template/concatenation invention anywhere including fixtures, the prefix
literal confined to `physical-identity.ts` in shipped code, a self-proving
detector, and a non-vacuity check on the scan scope).

**Honest status:** no claim here has been exercised against a real twin-modem
board. Every fixture models the contract.

## …AND A TELEMETRY ROW IS A PHYSICAL DEVICE, NOT A FILE POSITION [EXISTS]

The writer publishes `link_id`; this is the READER that keys a rendered row on
it. `conn_id` is a POSITION in `BIND_IPS_FILE` (todo 8 says so outright), so a
SIGHUP that republishes the bond in a different order hands the same modem a
different one — and a row keyed on it moves an operator's RTT/NAK onto the other
twin.

**The old resolution could not describe twins at all.** `resolveIface` looked a
`conn_id` up as an IP and then scanned `netif` for the FIRST interface holding
that address. Twins share one address, so BOTH connections resolved to ONE
interface: one row showed the wrong device's numbers and the other joined
nothing. The frontend's join is by `iface`, so this was invisible from the UI
side — the fix has to be here.

**`link-registry.ts`** holds what the writer published (`link_id` → iface / ip /
`ID_PATH` / port label / serial), replaced WHOLESALE on every publication so a
link that left the bond stops resolving instead of lingering with stale numbers.
`registerSrtlaBond` (`link-telemetry.ts`) is its ONE call site, from
`publishSrtlaBond`, and it keeps the legacy conn_id registry in step.

**`link-telemetry-rows.ts` is the ladder**, strongest evidence first:

| Rung | Evidence | Notes |
|---|---|---|
| 1 | the sender's own `link_id` echo | it names the row it really bound; nothing outranks it |
| 2 | the sender's own `iface` echo | |
| 3 | `conn_id` as a FILE LINE position | ONLY while the mapping is in force |
| 4 | `conn_id` → unique-IP order → interface | byte-identical to the pre-mapping behaviour |

- **Rungs 1-2 read fields the PINNED binding stripped.** The retired npm binding at
  2026.6.2 predates todo 8 and its Zod reader drops unknown keys, so today every
  launch resolves on rung 3 or 4 and the stronger rungs light up on a republish
  with no further change — the same defensive-read discipline `bytes_sent_total`
  already follows. Twin disambiguation therefore works TODAY off the writer's
  own record.
- **Rung 3 is GATED on the disposition, not on the telemetry's shape.** Without a
  mapping the sender collapses duplicate source IPs, so its ids count UNIQUE
  ADDRESSES rather than lines and the two numberings diverge exactly where the
  twins are. The gate reads `isBondMappingActive()`, never a guess.
- **`port_label` is derived from the published `ID_PATH`** (`USB <bus>-<chain>`,
  the kernel's own notation) and is what separates two units of one SKU. A path
  with no USB ancestry yields NOTHING rather than a raw path.
- **A serial rides a row ONLY when the device reports one.** Todo 10 measured the
  HiLink twins publishing none; the resolver answers `undefined` and no tail is
  rendered. Do not invent one.

**`link-mapping-report.ts` is the consumer of todo 11's three seams** —
`noteSenderBindMapReport` (the sender's verdict REPLACES the synthesized one),
`onBindMapReportChange` (the operator band follows the stream for the session,
subscribed in `startLinkTelemetry`) and `getNormalizedBindMapReport`. Two rules:
an ABSENT `bind_map_status` leaves the writer's verdict STANDING (a sender build
that cannot report is not a sender that retracted), and the sender's verdict is
handed over on CHANGE only, or the band re-broadcasts once a second.

`status.bond_mapping` carries that ONE normalized stream to the UI as an EXPLICIT
value — `null` when no bond is described — because the frontend status merge
preserves an omitted field, so a raise-only band could never be retracted.

Coverage: `tests/link-telemetry-registry.test.ts` (the port-label table, the twin
rows resolving to different interfaces and ports, the ORDER-SWAP reload proving
each twin keeps its own stats, the sender-echo precedence, both legacy rungs, and
the disposition's trip to the wire). Rule-E proof: keying the registry so a
reload is a no-op reddens the order-swap test; letting the file position outrank
the sender's echo reddens the precedence test.

