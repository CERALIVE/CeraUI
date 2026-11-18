# Concurrent WiFi station and hotspot

**Status:** [PARTIAL — host-tested product path; final VM/W6 qualification pending]

CeraUI can keep a WiFi station connection active while the same physical radio
hosts an access point. Driver capability and product qualification are separate:
the current NM-managed mechanism is qualified for the MT7925 card on legal
2.4 GHz channels. The qualification is per card, independent of the host board.
An RTL8852BE card is not qualified; a qualified card on the same host can offer
hybrid. Raw hardware capabilities remain visible.

## Capability contract

The backend maps each physical interface to its wiphy with `iw dev <ifname> info`
and parses `iw phy <phy> info`. A radio is eligible only when one complete
`valid interface combinations` alternative permits one `managed` interface and
one `AP` interface and the conservative P2P-device reservation. Group limits and
the total must fit one complete alternative both during NM's temporary
two-managed-interface initialization and in the final station/AP state.
An alternative for P2P-GO cannot
lend AP slots or channels. Running P2P groups, unknown occupancy and unexpected
running interfaces refuse before mutation.

Missing or incomplete evidence cannot admit hybrid. Capability advertisement
never creates an interface. The effective offering also uses the single
`isQualifiedNmManagedHybrid` check in `wifi-ap-sta-capability.ts`; raw
`capabilities.staApCombo` remains the driver's answer.

`parseInterfaceCombination` derives `sameChannelOnly` from `#channels <= 1`.
For that combination, the AP follows the actual associated station frequency,
including when the saved hotspot channel is explicit. Fresh link/info/UUID and
bracketed lifetime reads must agree. The frequency must occur in
`deriveApChannels` for that exact phy, with current regulatory rules and no
disabled, no-IR or radar restriction. No channel table chooses the frequency.
Product band qualification is an additional check, not a substitute for this
driver evidence. CeraUI never changes the station's channel or country to
obtain hybrid and never falls back to exclusive for a hybrid request.
Following the station changes only the activation profile. The saved channel
remains unchanged, including when a stopped profile is refreshed after its live
virtual binding has been retired.

## Runtime lifecycle

`wifi-concurrent-interface.ts` keeps the existing import surface. Its creation
module owns exact receipts and cleanup, the I/O module owns the platform readers,
and the target-record module owns the existing same-boot authority store.
`wifi-hybrid-target-selector.ts` is the only selector; target policy and station
channel checks have separate modules. No reconciler or store is duplicated.

The qualified NM-managed path adopts an existing `clap-<parent>` leg only at
saved hybrid restore or an admitted hybrid Start. The first complete discovery
records the boot and the initial lifetime, ifindex, wdev and phy of each leg on a
qualified card. A leg present then must keep all of them; a leg absent then may
be observed later in the same boot. Adoption
requires the coherent parent phy/wiphy, current parent incarnation, exact
current ifindex/wdev, NM management, an idle managed interface, readable
connection bindings with no foreign owner, and the conservative P2P slot
reservation. The existing in-memory record store receives the boot, phy,
ifindex, name and transaction identity; subsequent reuse must match exactly.
Unreadable or contradictory evidence refuses with
`hybrid-channel-not-permitted` before mutation. When the leg is absent, the same
admitted Start or saved restore reaches the creation primitive after checking
qualification, boot, parent lifetime, capacity and profile ownership. Its exact
nl80211 receipt grants creation authority. Created-leg reads use
`iw dev <leg-name> info`, which iw 6.9 on the Orange Pi accepts. The returned
name, ifindex and wdev must match the creation receipt and expected name.
Readiness and parent/object continuity precede the leg-only autoconnect write.
Receipt-owned deletion stays addressed by wdev. A leg appearing after the
absence check cannot be adopted. Prefixes and names confer no ownership.

First discovery logs `meta.event=wifi-hybrid-first-discovery` for each qualified
Wi-Fi parent. It records the expected leg name, whether NetworkManager listed
it, the operational and permanent MACs, the sysfs phy path, ifindex and wiphy,
and the `iw` witness's wdev and ifindex. The event uses the boot ID and the
timing captured at discovery. Delivery follows the existing witness read
without delaying discovery. On a default production device, this info-level
event is available in the backend debug log. `LOG_LEVEL=info` also sends it to
the journal.

A selector or station-channel refusal logs `meta.event=wifi-hybrid-target-refused`
once per restore attempt. An operator Start emits the same event with `attempt`
and `maxAttempts` set to `null`. `path` identifies `activation` (ordinary
restore), `limited-restore`, or `operator-start`. `processElapsedMs` measures
time since the backend process started. `bootUptimeSeconds` measures time
since OS boot.

- `reasonCode` identifies the rejecting check. `subReason` identifies the
  failing condition when a check combines several predicates. The five
  compound selector codes are `parent-identity-mismatch`,
  `target-witness-mismatch`, `target-iw-identity-mismatch`,
  `allocated-target-not-ready`, and `target-allocation-failed`.
  The stored witness reports `stored-boot-mismatch`, `live-target-unavailable`,
  or `stored-lifetime-mismatch` according to the first failed predicate.
  For a new leg, `created-identity-query-failed` means the initial `iw` read
  failed. `created-identity-mismatch` means it returned unusable or
  nonmatching identity data.
- `witness` and `observed` show the stored and live target name, ifindex,
  wiphy, wdev and phy path where available. `iwIfindex` and `iwWiphy`
  distinguish the wireless read from sysfs. `wirelessStatus` distinguishes
  `not-read`, `pending`, `unavailable` and `observed`.
  `first-wireless-observation-unavailable` covers a missing live observation.
  `first-wireless-witness-mismatch` covers a missing or mismatched stored witness.
- `station-channel-unavailable` reports failures before target selection.
  `limited-hybrid-revalidation-failed` reports the later limited-restore check.
  `stationAssociated`, `frequencyBand` and `channelPermitted` reflect the
  available association and AP regulatory evidence. Product band qualification
  is separate from channel permission. `dfs-or-no-ir` comes from a covering
  parsed regulatory rule. A channel missing from the derived AP list reports
  `ap-channel-unavailable`. A failed driver lookup reports `unclassified`.
- Null fields mark evidence that was not read or did not produce a verdict.
  `targetSampled=false` means the live identity read did not produce a sample.
  `targetListed` refers to first discovery.

Profile secrets and station network identifiers are excluded. These diagnostics
do not grant target ownership or change the retry limit.

NetworkManager binds
the hotspot profile to that interface while the physical interface keeps its
station profile and bond membership. Start, confirmation, configuration, stop,
process restart, and profile adoption track the virtual AP separately from the
station connection. An active legacy AP is associated by its exact AP UUID and
coherent phy, so it remains visible and stoppable even on an unqualified card.
Normal Stop deactivates that UUID and retains the netdev.

Created and adopted handles remain distinct. Adoption grants reuse only,
never deletion. The retained creation primitive grants ownership only through
the exact nl80211 create reply; failed allocation can delete only that
operation's captured wireless object. That deletion also retires the selection
record bound to the deleted object, so the next admitted Start or saved restore
may create the leg again; a refused or failed delete keeps both. EEXIST, an intent, a later name lookup or
a process restart grant no deletion authority. There is no target journal and
the credential store remains version 2. Device autoconnect is disabled on the
exact borrowed leg, with its prior value recorded privately. Stop/rollback
restore exactly that value while the same boot/parent/target still matches and
the leg is idle with our value still set, including after a refusal caused by a
foreign binding; the foreign profile itself is never touched. The first readable
value other than ours retires that claim: release then leaves the setting alone,
and a later adoption records its own current prior value. One residual remains:
an external change that returns the setting to our `no` between two CeraUI reads
(an A->B->A cycle) is unobservable, because the only NetworkManager event feed
CeraUI consumes (`nmcli monitor`) reports device and connection state, not device
properties; release then still restores the recorded prior value. A retained created leg stays disarmed; Stop never restores
station autoconnect on it.

Profile normalization shares the adapter transaction. Discovery defers its
profile writes when that adapter is busy; transaction-owned refresh is awaited
inline. Routing lookup is read-only; pin repair, duplicate policy and
association all happen after taking the existing adapter lock. The next
discovery pass resumes normalization of the same associated
UUID after the transaction releases, rather than treating it as a duplicate.
Priority, checked interface-name pin, security and SCC writes finish
before activation. Immediately before up, the borrowed leg's observed ifindex,
wdev and phy must still match the transaction record and the current parent's
incarnation. A same-name replacement refuses activation and is never deleted.
Selection binds its record to the ifindex, wdev and phy it admitted from the
interface dump; every later sample must be that same object. Identity and
connection-binding authority are rechecked under the adapter lock immediately
before and after the device-autoconnect write, and Start rechecks them before
each profile write. A mismatch found before the adoption write refuses with
`hybrid-channel-not-permitted` before any write. A mismatch arriving during the
adoption write refuses and restores the immediately pre-write autoconnect value
only while the current value is still ours. Both created and borrowed writes,
including release, read that value before a final identity check, issue the write
with no intervening profile scan, then immediately check identity again.
NetworkManager device-set is name-addressed, not wdev-addressed: a replacement
within that one call can receive a transient write. The pre-write value cannot
prove a replacement's own prior value if replacement occurs after that read, nor
can the compensating name-addressed write exclude another replacement. These
windows require an object-addressed or conditional NM API to eliminate; they do
not grant deletion or activation authority. Otherwise a leg lost after adoption
refuses with the same reason before the next write.
Restoring our pre-write `yes` can overwrite a replacement's own deliberate
`autoconnect no`: the replacement's prior value is unknowable. A new interface
normally starts at `yes`, and skipping compensation would leave our `no`.
Every compensating write emits a warning with the interface name, our pre-write
and written values, and the identity-loss reason. An unavailable post-write
property or failed restoring write emits an error with the same non-secret
context. A failed compensation still produces the normal hybrid refusal for
created and borrowed Start; release retains its best-effort completion.
The associated station is checked again after those awaits;
NM's connected AP state, UUID, actual role and SCC frequency must agree after up.
Configuration and safe rollback use the same station-derived channel. A roam
that withdraws AP legality, or a station gap in which the association cannot be
freshly confirmed (no connected UUID, link or matching channel), stops only the
observed AP and reports `hybrid-channel-not-permitted`. There is no grace period.

Hybrid AP profiles always have `connection.autoconnect=no`. A successful direct
Start persists `hybrid`, and a successful direct Stop persists `station`; after discovery,
CeraUI restores the saved intent through the normal adapter transaction.
During an upgrade, discovery saves any missing hybrid intent before disabling
legacy autoconnect. If saving the intent fails, it preserves autoconnect.
Changing autoconnect alone does not stop an AP that is already running.
Station profiles and AP profiles without persisted CeraUI ownership are untouched.

Exclusive APs may autoconnect only with a permanent MAC and literal
NetworkManager `match.path` pin, with the address unique among present physical
radios and persisted owner keys. Missing or unsafe paths leave autoconnect off
and use the same intent restore. A moved adapter keeps its credentials but must
be restored at the new port. An older backend retains the path pin after a
rollback, so a moved USB adapter may need a fresh Start.

Arming autoconnect also requires saved `hotspot` or `hybrid` intent. Choosing
station disables autoconnect on every current and historical owned AP profile,
even when the adapter is already in station mode. The writes must succeed
before the choice reports success. Startup also applies saved station intent
before creating virtual interfaces or publishing discovery, so a hotspot the
operator switched off stays off after reboot.

Discovery checks each owned profile under the same adapter lock as Start. A
busy lock defers the pass without marking the adapter degraded. Failed profile
reads and rejected autoconnect-off writes record recoverable degraded readiness
for that owner and withhold creation and publication. The existing discovery
timer retries every three seconds for at most five minutes. A fully successful
owner policy pass clears only that owner's degradation.

For both verified and limited adapters, Stop always attempts the disconnect.
When it succeeds, Stop reports `{ success: true }` and saves station intent,
including when a current or historical owned profile cannot yet be disarmed.
That policy failure is degraded and retried, rather than changing the Stop
reply. A failed disconnect keeps the existing `deactivation-failed` result and
restores the previous intent. An already-stopped Stop applies the same owned
profile checks. Limited adapters use the same uniquely resolved logical intent
owner; an unresolved registry key never becomes a credential-store key.

Startup and identity-retry reconciliation deactivate active owned AP profiles
when their owner's saved intent is station, even if autoconnect is already off.
They then check autoconnect-off writes and retire the observed AP state before
publication. If an off-write was rejected at Stop and NetworkManager brings the
AP up on reboot, station intent therefore shuts it down again. Failed policy
or deactivation work stays degraded and follows the bounded discovery retry.

Every possible profile owner is evaluated independently of roster order. Any
unreadable present radio that could own a profile keeps its recovery policy
unless there is positive same-address twin evidence or an explicit station
choice. This includes disconnected radios without an interface pin and mixed
verified/unreadable rosters. Identity observations retry limited as well as
unverified radios, at 250 ms, 1 s and 4 s, with three retries maximum. A recovered
sample passes quiesce before rekeying or publication and notifies mode restore.

### Logical-owner reconciliation [EXISTS; host-tested only]

One reconciler owns profile policy, Stop, mode convergence and boot restoration.
All operations and identity transfers use the same logical-owner lock, including
limited registry aliases and composite persisted owners. An operation retains
that owner while it changes intent. Observed UUID ownership takes precedence
over D12's existing sole-radio exception, so Stop can identify its profile owner
even when several radios have unreadable permanent addresses.

Profile observations distinguish confirmed absence from failed reads. Confirmed
absent history is pruned; unreadable profiles retain ownership and retry. Startup
deactivation requires a positively read AP profile. A failed read can never
authorize disconnecting a station. Fresh connection observations can reach an
operation already in progress, while policy, identity transfer and publication
wait for its lock; Stop therefore preserves a newer station UUID.

Every rejected policy write, including the write after activation, and every
failed restore uses the same bounded discovery retry mechanism. Recovery state
is keyed by the exact logical owner. Successful policy work cannot cancel a
pending identity transfer or another owner's retry. Failed boot restoration has
at most three activation attempts for its chosen mode before observed success; capability and
streaming prerequisites remain pending without an activation. Exhaustion marks
that owner's restore health degraded, and observed AP success clears it.
Accepted activation remains pending until confirmation; a failed confirmation
keeps bounded recovery. Inactive same-MAC twins resolve their own logical
owners from compatible literal path/interface pins, and activation keeps that
owner separate from the physical MAC used for NetworkManager pins.
Stop still reports the actual disconnect result under the contract above.

### Hotspot loss recovery [EXISTS; host-tested only]

An NM loss event or completed discovery that observes a previously active AP
disappear re-arms the same reconciler when saved intent is hotspot or hybrid.
A reprobed adapter gets a fresh recovery budget on its current physical
lifetime and interface. An unchanged active AP is left alone; a driver event by itself
does not prove loss.

Recovery makes at most three activation attempts per loss or changed physical
`(ifindex, wiphy, phyPath)` tuple. Availability-token rotation alone cannot refill
the attempt budget or its recovery window; unknown samples retain the prior
physical witness. Recovery continues
using the existing bounded discovery timer. Accepted activations that never
confirm also consume this budget. Busy locks, pending operations, unavailable
identity, streaming and capability prerequisites cannot dispatch another
activation or consume an activation attempt. Explicit Stop or station intent
keeps the AP off. D12's limited-adapter activation authority is unchanged.
Exhaustion degrades that logical owner's restore health; observed success clears
only its restore entry. No interface is deleted by name to force recovery.

This detects observed AP loss. It does not detect silent client-traffic failure
while NetworkManager still reports an active AP, or qualify encrypted-client
recovery after a firmware reset.

The saved channel is preserved for hotspot-only mode. While hybrid is selected
and the driver's combination requires SCC, settings explain: "In hybrid, the
hotspot follows the connected Wi-Fi channel. Your saved channel still applies to
hotspot-only mode." The refusal says: "Hybrid is unavailable because the connected
Wi-Fi channel does not permit starting a hotspot. Wi-Fi stays connected."
Both use the existing dialog, reason field and localization machinery.

Explicit exclusive requests retain the existing station-to-hotspot path and
streaming guard. Unqualified hybrid remains unavailable/pending. The
RTL8852BE kernel/qualification prerequisite is engineering debt
`TD-rtl8852be-hybrid-kernel-7-4`; this is not a promise of future support.

## Validation still required

The November 15, 2026 W2 spike demonstrated the retained NM-managed MT7925
lifecycle and station-derived 2412 MHz SCC. Independent NM auto choice at
2462 MHz against that station failed; the evidence does not establish sole
causality. W2 does not qualify this product implementation or cold boot.
Required VM/W6 checks remain:

1. Verify virtual-interface creation and NetworkManager adoption.
2. Keep a station association and bond membership while starting/stopping the AP.
3. Confirm same-channel behavior when the driver advertises `#channels <= 1`.
4. Reboot with the hotspot enabled and verify profile re-adoption.
5. Exercise driver/firmware refusal and confirm the UI reports failure without
   disturbing the station connection.

No physical RTL8852BE exclusive activation is authorized by B6. Its regression
proof is the host exclusive-path controls plus the orchestrator's read-only
profile/state comparison. No backport or separate supplicant path is introduced.
