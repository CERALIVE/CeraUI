<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## WIFI ADAPTER IDENTITY IS THE PERMANENT MAC [EXISTS]

Every adapter-keyed Wi-Fi structure uses the coherent lifetime sample from
`WifiRadioIdentityProducer`. A sole verified radio normally keeps its permanent
MAC as its key. Same-address radios each use `MAC@port` only when every member
has its own phy and a unique literal NetworkManager `GENERAL.PATH`. If any
member lacks that proof, the group stays limited. A port change invalidates
outstanding hotspot operations. NM hardware pins use the sampled MAC, and
exclusive profiles also carry `match.path`.

The version 2 credential store still reads released plain-MAC and version 1
records. A sole radio can seed its observed port with just the name, password
and channel. The plain record keeps its UUID and ownership history. A twin
uses its own port record and profile. An unseeded port needs first-time setup
even when there is a plain-MAC profile. The sole radio keeps its plain registry
key. Boot restore tries the independent saved profile at the verified port
only when both records have the same non-Station intent and the saved plain
profile is pinned to a different port. It holds both locks during the handoff.
It requires a fresh physical sample and will not rebind a profile whose saved
port contradicts it. After a known same-address collision, the plain profile
must have a matching port pin, including on hybrid restore. The collision
remains known for the lifetime of the service, even if discovery sees no radios.
Stop or choosing Station records station intent for the plain MAC and all its
credential-only port copies, even when the current port cannot be read.
No credentials or profiles are deleted. Stop or Station on a still-live,
independently owned port AP records Station for that port owner, not for the
sole row's plain-MAC preferences. If the port AP is already down or the
plain-MAC AP is running, Stop and Station retire the selected radio's
independent intent in addition to the plain choice and its copies. The
verified permanent MAC and literal port select that intent on both sole
and composite rows, even if a twin returns while the plain AP is live. Other
independent ports keep their preferences. The port AP will not restore when its twin
returns merely because it was started before the handoff. While that physical
port is proven, its independent Station intent also blocks fallback to the
plain-MAC profile without changing the plain preference for other ports.
No discovery transition removes a profile or stops an AP by itself merely
because a twin arrives. Address-only owned profiles disarm before the new
verified rows publish. Discovery withholds those rows when it cannot verify
the legacy profile's autoconnect state. A port swap holds both row locks in
stable order until it refreshes the new active connection identities.
When a twin arrives or leaves, discovery can expose the destination row before
it knows the active connection. Stop and Station wait up to two seconds for a
coalesced discovery refresh before taking the adapter locks. If the refresh
proves the AP target, the same request takes it down. If the target is still
unproved, the request returns `DEVICE_BUSY` without saving a mode or guessing
which connection to deactivate. Refresh and retry in that case. Start and AP
mode changes retain their immediate handoff refusal.

### Hotspot profile writes [EXISTS; native requalification pending]

The NetworkManager boundary keeps PSKs off child argv and environment. It
normalizes secret-bearing keyfile data through the existing bounded stdin
runner, writes a mode-0600 sibling, fsyncs and atomically publishes it before
asking NM to load it. First add remains inactive and autoconnect-off; submitted
SSID, security, credential and binding fields must match before the checked
receipt can grant creation or cleanup authority. Start carries that receipt.
An indistinguishable exact clone before add readback remains outside this
settings-based guarantee.

Every owned keyfile modify declares its exact delta. The existing operation
helper holds the verified old inode open, predicts the resulting bytes with
NM's own offline serializer and skips no-ops. A success adopts only exact
predicted bytes with an unchanged old inode's content. Only the canonical
`[connection]` timestamp may differ, and only when its value matches the daemon
timestamp read inside the coherent profile observation. Duplicate groups/keys,
foreign settings and every other byte remain subject to exact equality.
The resulting verified file becomes the new receipt. VersionId is diagnostic
only: NM can activate outside the adapter lock and advance it independently.
A failure with the original inode,
metadata and bytes unchanged retains the prior receipt without rebinding it.
All other outcomes preserve the profile, retire authority and degrade health.
Ephemeral descriptors, bytes and read receipts add no persistent recovery store.
Up, down and delete compare settings, file identity and bytes without adopting
new file evidence.

File observation lives in `network-manager-profile-file.ts`; read-only byte
classification lives in `wifi-hotspot-profile-readback.ts`. The existing
operation helper remains the sole dispatch/retirement owner and uses the
same credential record store.

Mixed-setting readback is keyed by the explicit NM field name through
`network-manager-output.ts`. An absent optional setting never shifts later
values; a wholly empty or malformed reply grants no evidence. Multiline values
remain literal, including colons, backslashes and whitespace. Single-setting,
scalar and fixed-list reads preserve their existing argv. Non-owned client
profiles share the protected secret writer and strict file proof without
requiring AP-mode or adapter-owner evidence. Rejected writes emit a WARN with
only the whitelisted rejecting-check code.

Mixed-section device reads project indexed fields to their requested base
field in producer order, joining multiple values with a newline. Named multiline
mode retains the original indexed labels; missing fields still yield an empty
scalar. Duplicate detection uses a canonical index without leading zeros, with
the bare label equivalent to index 1. Logical duplicates reject the entire reply
without merging their values or rewriting the retained named labels.

Native positional `--get-values` device and profile reads consume exactly one
final LF before splitting. A blank record remains an empty string, including
at the end of a tuple. An entirely empty stdout retains the scalar result
`[""]`. Spaces and carriage returns belong to the value. Explicit multiline
device reads keep their labelled-line format.

NM 1.42.4 and 1.52.1 both provide the offline stdin/keyfile serializer; native
daemon/offline byte parity is a separate gate and mismatches fail closed.
Byte-identical foreign writes after NM's rename and whole-file replacement
before its rename remain the documented limits.

#### Known limits

**LOW-1: No-op prediction can miss live autoconnect drift.** If the keyfile
still says `no`, a temporary live NM change sets `yes`, and the request returns
to `no` (A -> B -> A), byte prediction sees no file delta. Dispatch is skipped
and the ownership fingerprint excludes autoconnect, so success can leave the
live value at `yes`. No-op behavior is unchanged by this round.

**LOW-2: Option B proves resulting content, not who last wrote it.** A foreign
byte-identical replacement after NM's write is adopted and may later receive
our cleanup actions. NM can also overwrite an atomic foreign replacement
before its rename. These are accepted attribution limits, not an authorship
guarantee; VersionId remains diagnostic only.

Every authority-retiring readback emits one WARN with the reason, changed
setting names, missing-file-receipt category, numeric stat witnesses,
path/run change flags and optional VersionId. Ephemeral observation metadata
belongs to the existing receipt and never enters its persisted JSON. A loaded
receipt without per-field history reports that comparison as unavailable.
Warnings never include setting values, raw keyfiles, filenames, PSKs or argv.

### Hotspot credential rediscovery [EXISTS; host-tested only]

Empty or hidden NM secret readbacks cannot replace a known credential for
the same UUID and binding. Discovery retains the existing stored credential;
the limited active-profile view uses the same rule without admitting control.
A first Start still protects its resolved chosen credential before the durable
UUID hint is written, using the accepted UUID/binding evidence.
Every available initial or changed secret must match a fresh coherent profile
read and its persistent keyfile through NM's own serializer before publication
or persistence. A stale display value is never credential authority.
An owned write completed during verification wins over that older read.
The guarded cache/store commit emits only presence flags and short digests.
Credentials never carry into another UUID or a rejected binding.

Prepare and Start verify a selected lookup credential through
`readVerifiedNmWifiSecret` before it enters the cache or identity store.
Lookup/display tuples are hints, including when no durable UUID hint exists.
The shared verifier reads the guarded persistent keyfile and checks it through
NM's serializer; a stale display password cannot become a chosen credential.
Owned create, repair, Save and rollback writes remain checked before publication.

The same guarded file-secret observation supplies the credential component of
`readNmProfileInstance` and its submitted-field comparison. This reader does not
request the nmcli PSK display field. Empty/hidden/plaintext visibility changes
therefore cannot fail an add or change activation/cleanup authority. The
persisted secret still must match exactly, and non-secret NM settings plus
strict file/byte evidence remain mandatory. No credential store is added.

### Hotspot autoconnect policy [EXISTS; host-tested only]

`wifi-adapter-reconciler.ts` is the single policy/convergence authority.
`wifi-adapter-owner.ts` resolves observed UUID ownership and the existing D12
exception; `wifi-adapter-lock.ts` retains that exact owner for an admitted
operation. Limited registry keys, composite owner keys, Stop, mode changes,
discovery, boot restore and identity transfer share one lock domain. Health
and retry accounting retain the complete logical owner, including `@`.

Each owned UUID is observed as READ, UNREADABLE or confirmed ABSENT. Only a
successful UUID inventory can establish absence after a failed detail read.
Confirmed-absent historical UUIDs are pruned without deleting profiles or
discarding current credentials. Unreadable UUIDs retain ownership and retry.
Only positively read AP profiles with one current UUID claimant grant startup
deactivation authority. Competing unresolved claimants preserve a live AP even
when one claimant requests station; safe autoconnect disarming remains separate.
Fresh physical and connection observations remain available during an admitted
operation. A busy discovery pass defers policy writes, registry transfer and
fresh row association, not physical sampling. Stop preserves a newer station
UUID observed while deactivation was pending.
After an awaited profile read, policy retains the current aliases of its
candidate and observed/cached target rows through binding and every NM action.
The retained operation's old key therefore remains an admission barrier during
a fresh owner binding. Busy aliases defer through the existing discovery retry
without failure health; unrelated rows remain independent.
Literal path and interface pins constrain candidate owners before a same-MAC
match can qualify. Positive contradictions revoke remembered inactive bindings
and prevent the same cached UUID from restoring them. Unreadable evidence retains
valid serialization knowledge; incomplete evidence cannot revive a revoked
binding. Fresh matching pins can restore it. An admitted operation retains its
captured owner until lock release. Inactive path-pinned twins
therefore retain their separate composite owner locks and station intent.
Activation uses that logical owner for credentials and intent, while the
registry key and physical permanent MAC continue to supply NM/cache bindings.

The coherent sample also reads NetworkManager's unescaped `GENERAL.PATH`
between its two ifindex reads. It preserves colons and case exactly. Empty
paths, wildcard/operator syntax (`*?[!|&` and backticks), whitespace, control
characters and paths shared by distinct phys cannot supply a `match.path` pin.
Virtual `clap-*` interfaces do not count as additional physical radios.

An exclusive Start writes the permanent MAC, the literal `match.path` and
autoconnect off before activation, and refuses activation if that write fails.
After a successful activation it arms autoconnect only with saved `hotspot` or
`hybrid` intent, both pins and a unique address across present phys, credential
owner keys and `wifi_modes`.
Hybrid profiles explicitly remain autoconnect off. Direct Starts retain their
mode intent even when no safe autoconnect path exists; B2 restores that intent.

Start retains the verified row and lifetime obtained at lock entry. A rowless
refresh that proves the same identity at the same ifname can preserve that
exact operation binding without restoring the public token. Start still
rechecks physical identity before each activation effect, independently of
saved-profile and UUID ownership. The adapter lock orders CeraUI writers but
does not prevent the kernel from reprobeing or renaming the radio during a
NetworkManager call.

Before discovery publishes rows, it examines
every persisted current and historical owned AP UUID under Start's canonical
adapter lock, including the profile read, policy check and write. A busy lock
withholds the discovery pass until a later refresh. Unsafe autonomous
profiles first gain any missing durable `hotspot` or `hybrid` intent, then
autoconnect is disabled. A failed intent write preserves the old autoconnect
value and recovery path. The pass also handles a newly present or persisted
same-address twin. It never modifies station profiles or writes profiles without
persisted ownership. Deactivation follows saved station intent as described
below. An unresolved present radio
that could own an inactive, unpinned profile retains that recovery path, even
when several radios are unreadable and D12 restore cannot select one. Positive
same-address twins still quiesce. Every possible owner is evaluated independently:
a verified row appearing first cannot bypass another unresolved possible owner.

Saved `station` intent disables autoconnect on that owner's current and
historical AP profiles, including safely pinned inactive profiles. Explicit
station selection checks these writes before reporting success, even when the
adapter is already in station mode; refusal restores the previous intent.
Startup applies the same station rule before publication and deactivates an
active owned AP, including one whose autoconnect is already off. The mutable
connection observation is retired after confirmed deactivation, so discovery
cannot republish the connection it just stopped. A failed profile read,
autoconnect-off write or station-intent deactivation logs an error and records
`wifi-hotspot-autoconnect:<owner>` in the existing boot-readiness degradation
status. Discovery withholds virtual-interface creation and the complete row
publication until a subsequent pass succeeds. A complete successful policy pass
clears only that owner's entry; unrelated boot degradation is preserved.
Policy failure and a busy adapter lock use the existing discovery timer: one
pending retry every three seconds, bounded by the existing five-minute budget.
A busy lock alone is not degradation.
The write after activation is checked through the same failure path. Successful
policy work cannot cancel pending identity transfer or another owner's retry;
the shared timer is cancelled only when all pending owner work has converged.

Direct Stop uses the same checked current/historical owner policy for verified
and limited adapters. It always attempts the disconnect and reports
`{ success: true }` with station intent when the AP is stopped, even if policy
work failed. That failure remains degraded and is retried until the off-write
lands or the bounded budget expires. A failed disconnect still reports
`deactivation-failed` and restores the previous intent. This keeps a rejected
Stop-time off-write from leaving an AP active after reboot: startup sees station
intent, stops any active owned AP and retries the profile policy.

Identity observation retries limited as well as unverified discovery witnesses
at 250 ms, 1 s and 4 s, for at most three retries. Retry publication awaits the
same checked quiesce pass before transferring registry keys or delivering a
token, then notifies mode reconciliation. A failed pass withholds that
publication and schedules the existing bounded discovery retry.

Moving a known adapter to a new port preserves its credentials; its old path
does not autoconnect there. Bound restore refuses a contradictory saved port
pin and leaves it unchanged. A moved USB adapter with a stale pin needs a
fresh hotspot Start to bind the new port. Hybrid and pathless restore depend
on CeraUI starting.
Verified hybrid restore checks both interface selectors and the port before
allocating a leg and rechecks before creating it or setting its device
autoconnect policy. A stale AP-leg name can be rebound only if a live
interface inventory proves the old name absent and the saved UUID, permanent
MAC and literal port prove the same owner. Up checks the selectors against
the selected leg without allowing stale names. Boot restore does not prune
superseded hotspot profiles.
Eligible stale profiles can remain until the next operator Start.

An explicit Start can rewrite the port pin for a recorded
AP with autoconnect off, a matching unique permanent MAC and a roster that
positively establishes the old port is empty. Missing or ambiguous physical
port witnesses do not prove absence. A sole verified radio whose own path is
unreadable may ask NetworkManager to activate its exclusively recorded AP
as saved, without changing its port pin or autoconnect settings. A fresh,
complete `iw phy` inventory must match the roster and show no other physical
radio. The same inventory check gates absence claims about a legacy MAC or
vacant port and any new autonomous activation policy. It counts registered
PHYs, independent of AP capability or the presence of an interface. Discovery
shares one lazy probe across policy and profile reads in each identity pass.
The proof is tied to both the Wi-Fi identity publication and the network
topology generation at roster capture. An observed netdev change invalidates
it before the next identity publication; the current pass does not probe again.
An unreadable, incomplete or stale inventory is unknown, not evidence of a
duplicate MAC or a vacant port. Unknown evidence neither authorizes a profile
change nor withholds the roster. Explicit Start can retain a correctly pinned
profile's policy without the probe; a new binding starts with autoconnect off
and is not armed if the inventory is unknown.
An inventory-backed write carries its proof through the final NetworkManager
permit. The writer rechecks both generations after its last async pin or
profile check, before modify, keyfile publication/load, or inventory-dependent
exact deactivation. If a post-Up proof
has gone stale, Start still succeeds and leaves autoconnect off.
The activation names the proven interface.
Discovery logs and skips conflicting profile mutations without withholding the
unrelated radio roster; a real write failure still uses the bounded retry. Cold
Start can repair the recorded AP's observed legacy scan MAC if no other
adapter claims it. Neither repair follows a conflicting pin introduced after
Start's initial pin read.
These are host-tested policies, not physical NetworkManager qualification.

### Concurrent target reuse [PARTIAL; host-tested, VM/W6 pending]

`wifi-concurrent-interface.ts` retains the public import surface; the one
NM-managed hybrid selector lives in `wifi-hybrid-target-selector.ts`.
Driver combinations, grouped/total/P2P occupancy and exact-phy derived AP
channels are necessary; the separate card qualification check is also required.
Neither a board model nor a parser-positive unqualified card enables hybrid.
Discovery only observes capability and existing AP UUID/phy associations.
Saved hybrid restore or an admitted hybrid Start may adopt the existing eligible
leg using the immutable first-discovery boot/ifindex witness. Its same-boot record
must match on later reuse. An admitted Start or saved restore can create an absent
leg after the same qualification, occupancy, parent and binding checks. A leg
appearing after absence was admitted is foreign and cannot be borrowed. Missing
identity or foreign evidence still refuses with O3. Exact nl80211 replies alone
own creation cleanup; parent and exact-object continuity also fence the created
leg's autoconnect write and later lifecycle checks. Deleting a rolled-back created
leg retires the record bound to that object, so a later admitted attempt may
create it again; a refused or failed delete keeps both.
Adoption and name recognition never confer deletion authority.
Selection binds the record to the object it admitted and rechecks identity and
bindings under the lock around its device write; Start rechecks before each
profile write. Autoconnect writes read the prior value, perform a final identity
check after profile scans and immediately check identity after the write. A
mismatch refuses and compensates only while the setting is still our value.
NM can address device-set only by name, leaving a one-call replacement window;
the pre-write value and compensating write cannot prove a replacement's own
history or exclude another replacement. The exact-object deletion fence remains
unchanged; see `docs/AP-STA-CONCURRENT-MODE.md` for the residual windows.
Restoring our pre-write `yes` can overwrite a replacement's own deliberate
`autoconnect no`. Every compensation attempt logs WARN with the interface name,
our pre-write/written values and identity-loss reason; unavailable post-write
reads or failed restores log ERROR without raw command errors or secrets.
Compensation failure preserves the normal hybrid Start refusal for either leg
kind and the existing best-effort release behavior.

The selected leg's runtime device-autoconnect change records its prior value.
Stop/rollback restore only that exact current object and retain its netdev.
Retained created legs remain disarmed. The existing record store, runtime policy
and station/regulatory checks have separate modules without a second reconciler.
Legacy AP details and UUID Stop remain available independently of offering.
Profile priority/binding normalization finishes under the shared adapter lock;
background discovery defers while it is busy, while owned refresh runs inline.
SCC comes from `#channels`; its effective channel comes from the live associated
station and current regulatory derivation. Saved channel intent is preserved.
An illegal or unqualified associated channel refuses AP up through the existing
reason field, without changing the station or country. See
`docs/AP-STA-CONCURRENT-MODE.md` for the lifecycle and remaining qualification.

Configure RPC awaits the shared configuration transaction before returning its
existing acknowledgement. The shared dispatcher returns that completion while
retaining the terminal-frame error handler. Additional identity reads cannot
make the acknowledgement race lock entry or leave the request's work detached.

`ifconfig` and `GENERAL.HWADDR` report the operational address, which
NetworkManager randomizes while scanning. They cannot supply identity, including
through a remembered interface name or an operational-address alias. The
standalone `resolveWifiPermanentMac` reads sysfs only and returns undefined
when the permanent address is unreadable. Its old fallback tiers are removed.

The producer brackets ifindex, resolved `phy80211` path, wiphy index and
permanent address with a second ifindex/path read. Its cache uses the complete
`(ifindex, wiphy, phyPath)` tuple, survives a same-lifetime read failure, and
is pruned when a lifetime disappears or becomes incoherent. Zero or malformed
addresses never use that read-failure cache. Phy zero is valid.

Classification finishes before discovery publishes a row:

- **Verified:** a readable or same-lifetime cached address is unique across
  distinct phy paths, and the phy has one non-`clap` interface. Key: the MAC.
- **Limited:** a coherent lifetime lacks an attributable address, shares its
  address with another phy, or has multiple non-`clap` interfaces. Key:
  `limited:<ifindex>:<wiphy>`.
- **Unverified:** the lifetime bracket is incomplete or inconsistent. Key:
  `degraded:<ifname>`.

A `clap-*` interface is sampled as another witness of its phy, never counted
as another physical radio, and never published as an adapter row. A ready
limited/unverified row carries `degraded_reason: "permanent-mac-unresolved"`;
there is no new status field. Unavailable and operational-address-missing rows
retain their existing degraded reasons and not-ready key rule: only the same
coherent predecessor witness can retain a verified key.

Classification keys are not physical steering identities. Shared-client
steering reads the coherent permanent address for the exact sampled registry
object, so a limited classification cannot rotate an unchanged station's
mark or retire its routes. A registered radio without that proof leaves
steering pending, including after an apply; it never supplies a provisional
key as a permanent MAC. This does not gate station operations or alter
credential-store ownership.

Discovery never adopts credentials, repins a profile, writes autoconnect or
allocates a virtual interface for an unresolved key. Limited keys never enter
the credential store. Non-MAC keys are rejected before hotspot credential
resolution or profile adoption. Verified store keys and credential continuity
are unchanged. Limited-mode requests and read-only live-profile handling follow
the rules below.

**A monitor event carries an ifname, never a MAC.** `getWifiInterfaceByIfname()`
(`wifi-connections.ts`) is the bridge; do NOT route a device-state event through
`wifiDeviceListGetMacAddress()` — that returns the operational address and will
miss the registry.

### Hotspot profile ownership [EXISTS; host-tested only]

A replacement adapter no longer inherits another adapter's saved hotspot
credentials when it receives the same interface name. The credential store
arbitrates every current and previous UUID across all entries, including
absent adapters. A UUID recorded for another address cannot be adopted, used
by prepare/start (including the complete in-memory cache and already-active
shortcut), saved through the live editor, or remembered for this adapter.
Existing collisions loaded from disk retain their ownership evidence and
refuse reuse with the existing activation/save errors.

The explicit-MAC active path, saved-profile sweep, interface-name and
`clap-<ifname>` matches, stored UUID hint, permanent-MAC match and persisted-SSID
fallback all apply that check. A pin naming another present or persisted
adapter is conflicting evidence even without a UUID claim. SSID equality
cannot override either kind of conflict or establish ownership by itself.
Discovery repairs stale scan-time pins only for recorded profiles. An
unrecorded saved profile is left alone; Prepare and Start resolve credentials
without reusing its UUID. An independently active AP can still be observed
without granting saved-profile edit authority.

Ownership is checked again after awaited lookup, repair, save, activation and
rollback work, using the current cache as well as the selected UUID. An empty
lookup result does not exempt a cache populated while that lookup was pending.
An SSID fallback is checked again after the remaining profiles have been read.
If discovery loses ownership, it removes only the matching rejected UUID and
credential pair from that adapter's cache, leaving NM active-state observations
intact. Replacing that rejected cache invalidates operations already waiting
on it, so clearing a provisional UUID cannot turn a refused prepare into a
successful credential suggestion. This is internal cache invalidation, with
no wire token or identity-resolver change.

The selected profile's MAC pin is carried beyond the lookup and checked with
the UUID at prepare/start return and write boundaries. One shared guard also
checks the current cache and the selected target after awaits. Pin evidence
lives in private weak metadata, so neither registry values nor wire frames gain
fields. A successfully completed binding refreshes that evidence to its actual
new pin; an in-flight binding retains the original selection evidence until
its final ownership check.

Ownership arbitration remains independent of lifetime admission. Its existing
UUID and pin checks apply to verified keys; unresolved keys cannot enter profile
adoption or credential resolution. Returning verified adapters retain their own
credentials. Composite same-MAC physical identity and activation fencing remain
outside this classification change. This change claims host proof only.

Coverage: `wifi-hotspot-ownership.test.ts` exercises O1-O9 through real
discovery, saved-sweep, prepare/start and configure boundaries, all stored
owners, after-await checks, orphan migration and unrelated-profile survival.
`wifi-radio-equivalence.test.ts` retains the recorded main bytes for verified,
rename and replug fixtures, and explicitly checks the isolated limited keys
and mutation-free outcomes of the four unresolved fixture families. The orphan byte fixture
also runs against unchanged main. The pruning regression loads a legacy
collision from disk because new store writes can no longer create one; its
existing assertions are unchanged.
Deferred race coverage also runs the competing-discovery/empty-lookup schedule,
complete-cache credential returns, repair/save continuations, live rollback,
late SSID selection and new/existing-profile activation against the reviewed
pre-fix head. Single-adapter discovery and verified/unverified prepare/start
controls retain the existing results. These tests prove dispatch and return
behavior at the host boundary; they do not qualify physical NM scheduling.

### First hotspot profile [EXISTS; host-tested only]

First Start uses `nmApConnAdd` to create a persistent AP profile with its bind
and security fields and `autoconnect=no` in one command. The helper generates
the UUID before dispatch and accepts only that UUID in the add receipt.
Lock-entry admission precedes creation and activation; internal callers retain
the existing ownership and limited-row rules. Ownership checks and NM refusal
remain the checks between add and up. Fresh physical re-admission belongs to
the later in-operation admission change.

A dispatched add failure or receipt mismatch deletes only the generated UUID,
including when NetworkManager created the profile before the runner rejected.
Start retains that exact-UUID cleanup until the transaction accepts success.
Ownership loss, saved-refresh or autoconnect failure, activation refusal and
post-up exceptions attempt a checked autoconnect-off write, deactivate an
attempted activation and delete the new profile. An unsuccessful teardown
retains the exact UUID, matching cache/store adoption and allocation receipt
as an input to the logical owner's reconciler. Start, Stop and discovery consume
that obligation under the same owner lock. It reports `cleanup-pending` and logs the checked
suppression/deactivation results instead of pretending the profile is gone.
Failed cleanup uses the existing five-minute discovery retry budget. Stop attempts
the retained UUID even when the row has not observed its activation; a successful
disconnect reports stopped while unfinished deletion or policy remains degraded
and retryable. An unsuccessful disconnect retains the existing failure result.

Before the atomic add, the generated UUID is written as `pendingCreation` in the
existing credential ownership record. The store stays version 2; ordinary
adoption preserves this private field but cannot create it. A failed record write
refuses the add. Confirmed activation, completed cleanup or confirmed absence
retires only the matching UUID. A profile rename preserves creation evidence;
an observed replacement settings object retires the old resource's record.
Before up, the record is durably bound to the exact NM settings path, NM run
identity, resource fingerprint and keyfile filename/device/inode/ctime.
Startup checks that instance at observation and again
before down/off writes. Mismatch, including a same-path settings replacement,
retires the record without touching the profile; unbound records grant no
teardown authority. The fingerprint excludes the cosmetic profile name while
including its literal path binding.
The NM profile ID is again the cosmetic `Hotspot`, with no provenance authority.
There is no separate durable store. Before legacy missing-intent backfill or
restoration, startup requires positive owned-AP evidence and a unique UUID owner;
without saved hotspot/hybrid intent it deactivates the observed AP and checks
autoconnect-off. Failed reads or actions retain owner degradation and bounded
retry. It never deletes by name. An unstamped legacy profile keeps B5's upgrade
preservation rule; saved hotspot/hybrid intent keeps the chosen AP available.

Cleanup authority captures the NM settings object path, its bus-scoped unique
NM owner and a fingerprint of the profile's binding, credentials and AP settings.
Paths are compared only within the same identified NM run. Passive observations
and pre-action checks always require unchanged file identity. Across runs, matching
settings and unchanged file identity rebind the existing creation record and cleanup progress to the new run
before actions; the next same-run replacement still invalidates them. Every cleanup action
re-reads that evidence. A changed or absent instance drops the obligation
without suppressing, disconnecting or deleting a replacement with the same
UUID. A changed or unreadable file drops authority with visible hotspot health
degradation. Checked add readback establishes the initial receipt. A successful
modify refreshes it only when same-run object continuity, the held old inode
and NM's exact byte prediction agree. A failed or lost modify reply with unchanged
resource, metadata and bytes retains the prior receipt without rebinding; every
other failed outcome retires authority and leaves the profile untouched.
Up/down/delete retain strict evidence checks; they never authorize a changed file.
A restart between commit and readback
cannot establish continuity and leaves the profile untouched. Dropping stale authority also
invalidates its cached active aliases before Start can accept an already-active
shortcut.

Confirmed removal (including an authoritative UUID list after a lost delete
reply) clears matching provisional adoption and cached active aliases.
Deletion epochs fence delayed discovery only while those continuations remain
in flight; their scoped disposers retire the tombstones at settlement.
Replaced hotspot objects, replacement store entries and unrelated profiles
remain intact. A failed fresh
add cannot restore the deleted UUID from an older cache snapshot.

Retained cleanup remembers checked autoconnect suppression and disconnection.
A retry never substitutes UUID Down for a missing active path. It may proceed
without another Down if NM's UUID/active inventory proves the profile inactive.
The same inactivity proof is required immediately before deletion, because
Delete also disconnects active users of the profile. Active or unreadable
evidence leaves the profile and the bounded recovery path in place.
A complete inventory that confirms the profile is absent clears the cached
UUID and retires the durable creation record, even when no activation path
was captured. Retain the record while the owned profile is still active and
cleanup remains pending; restart recovery can still need that evidence.
The Up path is scoped to the original NetworkManager bus and daemon run.
The shared Down seam checks the bus ID, verifies the active object's UUID
and device on that bus, and addresses the recorded unique daemon. It waits
for that path to reach `DEACTIVATED` or leave the daemon's active list; the
method reply is only acknowledgement. Missing proof or a bounded wait
expiry refuses completion. A daemon mismatch allows recovery from fresh
inventory only, never reuse of an old activation path. Save does not turn
pathless timeout readback into a cleanup receipt, and both forward and
rollback hybrid Up must confirm the command's exact path and channel. An
acknowledged rollback with failed profile readback still runs confirmation
and exact cleanup. Save rechecks the original connected activation on the
same leg after refreshing saved profiles and before writing credentials.

Monitor events trigger confirmation rather than proving it. The pending
activation captures its UUID, hotspot object, activation interface, profile
instance and the active-connection path returned by NM's up receipt.
Production confirmation waits for the shared discovery flight, brackets an
AP-profile mode read with device-state/UUID/active-path reads, and compares the
profile instance on both sides. After the final roster await it rechecks the
captured settings instance and active path, while retaining the original queued
discovery order. A replacement during that await cannot confirm. It accepts only state 100 on the captured
activation and profile in AP mode. A station reconnect or same-name connection
cannot publish hotspot success. The existing bounded timeout still applies.

Command failures and malformed receipts never log the passphrase. Regressions
are split across `wifi-first-ap-add-then-up.test.ts`, `wifi-first-ap-cleanup.test.ts`,
`wifi-first-ap-discovery.test.ts`, `wifi-first-ap-confirmation.test.ts` and
`wifi-first-ap-instance.test.ts` and `wifi-first-ap-reconcile.test.ts`, with command and instance fixtures under
`helpers/wifi-first-ap-*.ts`. Real NM qualification uses the local-only
`test-harness/wifi-hwsim/checks/first-ap.ts` VM check and remains separate.

### Sampled lifetime identity [EXISTS; host-tested only]

The sample is authoritative for registry keys. One active discovery and one
queued discovery still bound legacy device listings; queued callers share a
fresh run begun after their calls and retain that run's result or original
error. Confirmation polls use the same queue. The initial identity sample is
awaited inside that run, with the producer's 1000 ms deadline. A lost sample
publishes an isolated uncertain row rather than an operational-address key.

Guarded RPC requests require the expected token at request and transaction-lock
entry; frame correlation remains separate from that authority. The sampled
registry, numeric-id and credential-store key rules above remain authoritative.

The four-operation physical read budget remains shared across producers. A
cancelled or timed-out physical read holds its slot until it actually settles.
At saturation no fifth read starts; sampling resumes when capacity returns.
Discovery does not wait indefinitely for capacity. The latest deferred sample
can recover the retained row without an unrelated network event.
Its exact row bindings remain scoped to the observation generation while the
sample is deferred. A same-lifetime rename through an unavailable observation
retains the full sampled-key row, including its AP capabilities.
A new unavailable observation retires the parent's active UUID, AP mode and
connection fields while retaining its capabilities and cached hotspot settings.
The missing-operational-address branch retires the same three fields. Device
and matching connection-down events do likewise; virtual-leg events retire only
that leg and preserve the parent station. An unrelated old connection event
cannot clear a newer connection.

Retry and failed-listing recovery preserve the complete last physical witness
roster, including unpublished `clap-*` interfaces. Current published rows are
bound separately from that roster; registry membership never proves uniqueness.
Any incomplete lifetime bracket in that still-listed roster withholds verified
classification for the sample. A failed sysfs read cannot establish that a
duplicate disappeared. Verification resumes after coherent sampling or a fresh
successful listing that removes the missing witness. Same-phy Rock and the
single-interface Orange topology retain their normal verified classification.

A private weak association binds each sampled token to the exact registry
object and observation generation before scan refresh or other discovery
broadcasts can publish it. Discovery invalidates the row's publication marker
before sampling. If the current physical sample has no row, it can carry the
previous exact row and its original stamp only for an unchanged identity at the
same ifname. This preserves ownership for an already-bound operation that still
owns the registry row and passes its live checks. The old stamp does not match
the new marker, so status stays tokenless and fresh requests cannot use the
carried association. Fresh admission needs a coherent association with the
current row marker and a live recheck. A sample older than the latest committed
observation cannot publish.

Witness, classification and degraded edges rotate incarnations; repeated
evidence and true same-lifetime renames retain them. An incomplete or failed
proof has no wire incarnation. A failed-proof replacement uses a fresh
degraded object/id and removes the predecessor's registry entry; it never
inherits the predecessor's token. Recovery gets a fresh token, while a
successful same-lifetime recovery keeps its token.

Monitor events still carry ifnames. A virtual/non-Wi-Fi unavailable event
cannot cancel another radio's sample. A real unavailable event rotates only
its current row. The synchronous disconnect broadcast withholds the token
through a private publication fence, released in finally without overwriting
a newer discovery generation. Captured request tokens supply echoed config/mode metadata; request and
transaction-lock admission enforce the expected token separately.

A timed-out, rejected, superseded or incomplete sample retains L0's bounded
retry schedule: 250 ms, 1 s and 4 s, at most three retries. A retry samples the
current registry with a fresh generation, applies recovered keys and degraded
reasons, then projects its token. A failed NetworkManager listing also queues
the retained rows. Successful publication or new discovery resets the retry
budget. Explicit stop/termination cancels without a warning or retry.

Each lost sample emits the exact string-only warning
`Wi-Fi identity sample lost (<reason>) for <ifnames>; retry <n>/3`, or
`; no retries left` on exhaustion. No status or credential enters that log.
Read failures, timeouts and unexpected observation exceptions retain the
internal `getWifiRadioShadowFailures()` counter. Capacity saturation logs
one string-only held-count warning per episode.

A changed token is delivered locally. When the normal discovery broadcast
already carries it, no extra local frame is needed; otherwise one local
Wi-Fi status frame carries the change. Retry publication does the same.
No projected change means no frame. Local token delivery never acknowledges
global hotspot-roster membership or changes the cloud projection.

Observation stop is reusable; termination is permanent. The awaited sample
propagates cancellation to discovery so a shutdown cannot continue into a
fallback row, saved-profile refresh or scan scheduling. Discovery also owns
its terminal abort signal, queued callers, scan refreshes, backoff waits and
unavailable-device retries. The composition root injects observation and
discovery termination into the graph-free shutdown helper. Observation,
discovery and scan timers remain unreferenced and explicitly cancellable.

Coverage includes `wifi-identity-keys.test.ts` (unsafe cache rejection,
per-phy uniqueness, separate same-phy limited rows and every equivalence fixture),
`wifi-radio-read-liveness.test.ts` (the exact sample deadline/retry,
local token delivery and terminal cancellation),
`wifi-incarnation-publication.test.ts` (all eight replacement/proof cases on
all four status surfaces), the unchanged B1 bound and shutdown assertions,
and L0 retry/physical-read/native process-lifetime tests.
`wifi-radio-equivalence.test.ts` preserves the recorded verified bytes and
checks the four authorized limited fixture deltas without regenerating the
golden file. Its three observational mutation controls still reject the same
id, registry-key and id-map writes.

### Request admission [EXISTS; host-tested only]

One shared RPC middleware binds guarded requests
and their transaction-lock entry to a fresh physical sample. Internal callers
without request context retain their base behavior. The request context is
one-shot: the transaction lock-entry check consumes it on admit and refuse, and
middleware retires it in `finally` on every exit. The record belongs only to
its device, so another adapter's internal work never inherits the requirement.
Configure retains the record until its dispatched lock attempt enters or exits,
without awaiting the writer. Mock effects consume it synchronously; outcome
publishers and restore edges run without it.
Captured config/mode
metadata has a separate context, remains fixed for the dispatch, and never
grants admission by itself.

RPC entry refusals keep their existing result and Start/Configure/mode frame,
but send that frame only to the requesting socket. They never publish a
terminal to another client's accepted transaction. Prepare remains RPC-only;
transaction publishers and internal callers retain their existing broadcasts.
Every mode refusal before pending follows that private route, including
station's token-free busy path, transaction preflight/lock exits and mocks.
A one-shot request publication scope supplies an optional reply callback through
the existing publisher hook; internal two-argument calls are unchanged. The
existing sequence envelope separates private replies from broadcast terminals,
so the frontend no longer infers request ownership from matching targets or
filters busy terminals from observers. The additive protocol contract records
the exact routing and attempt rules.

The [additive protocol contract](../../../../docs/WIFI-INCARNATION-PROTOCOL.md)
continues to define token shape, frame correlation, remote stripping and the
shared package boundary. Token validation, bounded current-unobserved recovery
and exact frontend attempt ownership follow that same contract. This host-tested mechanism does not qualify physical
radios or NetworkManager activation.

### Limited operation [EXISTS; host and mock-browser proof only]

Prepare (both load and save), Start, Configure, and selection of hotspot or
hybrid refuse with `radio-unverified` before credentials, NetworkManager or
virtual-interface effects, including an already-active shortcut. Configure also
sends its captured terminal `config: {error: "radio-unverified"}` frame.
These checks live in the shared backend transactions, so direct and legacy
callers receive the same refusal as RPC clients. Guarded RPC tokens are enforced separately; these transaction checks also
protect direct and internal paths.

Display, Copy, Stop and station operations remain available. Discovery reads
the AP profile NetworkManager reports active on the exact device into memory
only. Existing virtual APs remain observable when a fresh concurrency probe
fails, unless coherent parent and virtual samples positively identify different
phy paths or wiphy indices. Such a contradiction clears the virtual association.
`transitionVirtualBinding` is the single writer of immutable virtual bindings.
It privately owns the associated UUID and retired Stop authority for discovery,
Start, confirmation, refresh, monitor-down, Stop, rollback and registry removal.
Invalidation retires live authority while preserving a reusable inactive profile
hint; a hint cannot block adoption of a freshly observed parent AP. Positively
invalid physical associations discard their matching cached target. A legitimate
exclusive parent target is preserved independently.
A fresh complete parent listing naming that same known UUID preserves it even
when the current profile or mode read fails.

Complete-listing disappearance, rename, replug and cross-phy contradiction are
evaluated against the whole roster before any parent AP adoption. A failed or
malformed/partial listing cannot establish disappearance. Confirmation records
its selected UUID through the same owner even before any discovery refresh.
Registry-key transfer preserves the binding; actual row removal retires it.
The 126-cell production-graph matrix in `wifi-virtual-binding.test.ts` covers
discovery, Start-confirmation and refresh across all lifecycle events and
present/absent/changed parent APs, preserving foreign profiles throughout.
The observed exclusive or concurrent UUID remains stoppable even when
its profile cannot be read; a changed UUID clears the previous profile details
before reading the new profile. Same-UUID exclusive discovery retries the
read-only details and preserves loaded credentials when a refresh fails.
Both exclusive and concurrent detail changes use the normal Wi-Fi status
broadcast, including recovered reads and changed credentials. Saved-profile
refresh waits for AP adoption before its callers publish.
A readable non-AP profile retires its provisional hotspot target.
Discovery does not search for a replacement profile, adopt credentials, repair
a pin or priority, or write an unresolved key into the credential store.
Stop deactivates the observed UUID without virtual-interface deletion. When the
logical intent owner can be resolved, it also checks that owner's current and
historical AP autoconnect policy under the Stop contract above.
New station joins do not pin a limited registry key as a MAC address.
When a regulatory change requires restarting a limited AP, the backend stops
it instead and logs a warning; that maintenance path leaves mode intent intact.

The boot restore has one private exception (D12). Exactly one hotspot-capable
adapter and one logical non-station intent must remain. Plain MAC and MAC@port
keys for the same address count as one. All address groups with any non-Station
record are counted before precedence is applied. A non-Station plain MAC record
and its owned AP profile are required; a port-only record is not eligible.
A saved port pin requires a matching live path.
Only a pathless plain owner with no known collision can use the unidentified
radio exception. The profile's stored channel must be `auto` or
among the currently derived permitted
channels for that adapter's bands. Streaming must permit the transition.
Hybrid also requires proven concurrency and a profile already bound to the
current fixed virtual-interface name; otherwise it stays pending rather than
becoming exclusive.

Only boot restore may activate that existing profile on a limited adapter.
After its profile recheck, restore refreshes radio and leg evidence and checks
any available permanent address and port against the saved owner. For hybrid
Up, the last asynchronous guard rechecks the station channel. Up passes the
UUID and selected interface to NetworkManager; an exclusive profile pinned
to any other interface is refused. Cancellation, roster,
row, intent, profile ownership, streaming and channel eligibility still apply.
Hybrid restore does not write the profile or device autoconnect policy. On
same-channel hardware, a saved channel or band that conflicts with the live
station is refused before activation.
Cold hybrid selection rechecks the parent after the restore guard and submits
`iw` creation by wiphy index, not by the parent interface name. NetworkManager
still resolves an interface name for Up; the kernel still resolves the wiphy
index for creation. Those commands do not atomically compare the sampled
lifetime or station channel. A replacement reusing the same identifier or a
roam after the final applicable read remains a residual window.
An incompatible or invisible existing interface is refused without deletion.
Creation records private kernel ifindex/wdev evidence from the add command's own
nl80211 NEW_INTERFACE reply. `iw --debug` exposes that reply on stderr; its
family, sequence, socket port, command, interface name and attribute lengths are
checked before granting ownership. A subsequent mutable-name read never confers
deletion authority. Missing or malformed receipts refuse ownership and report
the failure without deleting an unproven object. A captured reply remains usable
after a command timeout; failed later metadata reads cannot erase the obligation.
Object-bound metadata also checks that the created object still has the target
name before handoff.

Cleanup addresses that exact wireless device, not its mutable name, and never deletes a
reused or replacement interface. Cancellation retires activation authority while
preserving cleanup authority. The allocation remains owned through activation;
refusal, failure, exception and cancellation roll back the operation's own target.
Discovery retains the handle until row insertion and releases it on pre-handoff
abort or exception. A rejected activation await also runs the existing state
rollback, clearing transition and concurrent state while preserving the original
error, before releasing its exact created resource.
It does not change credentials, credential-store contents, autoconnect or mode
intent. Hybrid uses the existing fixed-interface allocator until the target
allocator step lands. A successful restore logs exactly
`hotspot restored on an adapter that could not be identified`; every refusal
logs its failed condition once per unchanged restore edge.
Accepted restoration is identified by the selected logical owner and mode;
an unrelated station preference cannot dispatch that accepted activation again.
Stop and station selection resolve the same logical persisted intent, so the
stopped hotspot is not restored again. This recovery requires the same sole
hotspot-capable adapter condition; with another such adapter present, a limited
radio cannot clear that other adapter's persisted intent.

Accepted limit: a replacement that discovery already selected before restore
can receive the same boot restore for an unpinned plain owner with no known
collision. A lifetime change detected at recheck refuses dispatch. An
exclusive profile independently auto-activated by NetworkManager remains
observable and stoppable outside D12. Physical limited-radio restore is
unqualified; both lab radios have verifiable identities.

Coverage: `wifi-limited-mode.test.ts`, the active-profile discovery case in
`wifi-identity-keys.test.ts`, the four explicit limited equivalence deltas and
`hotspot-limited-mode.spec.ts`. The `wifi-limited` mock scenario retains live
details and safe controls and refuses direct guarded RPC requests.

### Chosen mode and boot restore [EXISTS; host and mock-browser tested]

The pushed Wi-Fi row's `observed_mode` reports the three-way operator display
separately from the physical `mode`; Hybrid still has physical mode Station.
An unreadable active profile or plausible unresolved virtual AP leg is not
proof of Station. Publish `null` if neither an AP binding nor a settled Station
can be verified. A confirmed disconnect clears the active connection to `null`
and publishes before rescanning. `getAdapterModes` still supplies the offered
modes and persisted preference; the pushed observation does not authorize an
operation or change the credential checks.

Explicit Start and Stop remember the chosen mode through an optional recorder in
the existing transaction dependencies. RPC and legacy dispatch keep their call
shapes. The real recorder uses the same `wifi_modes` store functions as explicit
mode selection; all three paths resolve the logical intent key through
`resolveWifiAdapterModeIntentKey`. Keys and values remain readable by an older
backend. The mock mode offering reports the mock's chosen mode as `desired`.

Start records the actual hybrid or exclusive target inside the adapter lock,
after path validation and before allocating a virtual interface or changing
NetworkManager. A recorded hybrid choice cannot fall back to exclusive mode:
false or unknown concurrency refuses with `activation-failed`, without effects
or a persistence write. An explicit hybrid mode switch retains its existing
`capability-unproven` refusal. With absent or station intent, a proven non-hybrid
radio still starts exclusively. If concurrency is unknown, the existing
exclusive path remains available. Every successful exclusive Start records
`hotspot` for reboot, including unknown-capability and already-active Starts,
so an AP without safe autoconnect has a restore intent. An observed hybrid
Start records `hybrid`; refused Starts still restore their previous intent.
Before any already-active exclusive shortcut can succeed or record, an explicit
hybrid choice with absent or unknown concurrency is refused with
`activation-failed`. An already-active hybrid topology keeps its shortcut.
Start and boot restore consume the same current capability cache. The legacy
discovery probe's `false` also represents read failure, so that row flag is not
proof of absent concurrency. A later successful capability publication can
restore pending hybrid without recreating or manually repairing the row. Actual
concurrent-interface allocation remains the final admission check; successful
allocation updates the row's concurrent path state before confirmation.

Stop and Station try to record station under the live AP's owner before
teardown, including the already-stopped shortcut. A config write failure does
not block Down. Bounded owner reconciliation retries persistence and suppresses
runtime AP restore while the choice is not saved. A reboot before a successful
retry can still read the last durable choice. A disconnect refusal or throw
undoes the choice, deleting a previously absent key. Historical profile repair
and unrelated pending cleanup do not veto a confirmed live Down; they retain
their own recovery status. Stop and discovery Station policy require a
daemon-bound activation path observed on the selected radio or AP leg.
When this port has an independent Station intent, a later explicit Hotspot
or Hybrid choice on the sole verified row supersedes it on that port only.
On refusal, the prior durable and unsaved Station intent is restored for
each affected owner, including the primary owner. Deferred intent suppresses
restore until persistence recovers; it does not survive process loss.
Neither independent
profiles nor Station choices on other ports are changed.
No roster or UUID-only Down is permitted. Credential-only Prepare does not supersede an
unsaved Station choice or its retry.
An accepted Start that is still activating is not already stopped: Stop
disarms its selected profile, retires pending confirmation, and requires
terminal proof for the selected activation before reporting success. On
unproved teardown it reports `deactivation-failed`, requests a rescan, and
does not release the leg. Cached Station requires a fresh local check before
reporting `applied: "station"`. A late connected event cannot confirm that retired
Start. Create/up work still holding the adapter lock continues to refuse Stop
with DEVICE_BUSY and leaves intent and NM state untouched.
The selected UUID is captured before awaited disarm. An absent observer
transition does not prove inactivity: before the inactive shortcut succeeds,
NM's uuid,active inventory must prove that UUID inactive or absent. An NM
active connection includes activation in progress and must take the normal down
path. Unreadable or malformed inventory cannot authorize the shortcut; normal
down must supply its receipt instead. This also covers immediate retry after
failed down and committed-down/lost-reply recovery, without retained parallel
teardown state.
Start has one undo at the lock exit,
including failure before an activation rollback exists; an accepted but
`not-confirmed` activation keeps its target. Undo applies only while the stored
value is still this operation's target, so an older failure cannot overwrite a
newer choice.
Both persistence and restoration roll back their in-memory map on a synchronous
write exception. Reads therefore keep the last successfully persisted value or
absence, even if an undo's own write fails. A failed initial preference write
cannot leave an unpersisted hotspot choice eligible for later restore.

Explicit mode changes hold one adapter lock across persistence, intermediate
teardown and activation. Internal delegates do not reacquire that lock and omit
the recorder by destructuring, so a hybrid/hotspot switch's intermediate Stop
cannot replace its target with station. Regulatory reconfigure requires a
verified binding for the original registry row before entering the writer.
It and its rollback use that binding through the existing direct activation
path and never record a new mode choice.
After confirmed teardown, Stop retires matching parent aliases independently of
virtual cleanup. It examines the current concurrent observation even when none
existed at entry, matching the captured virtual name or the parent's canonical
`clap-` name. The stopped UUID or an idle marker on that interface is retired.
A different active UUID, another interface name, or newer parent observation is
preserved. This covers discovery introducing the idle marker during disconnect;
later repopulation while virtual release is awaited remains a follow-up below.

While streaming, an exclusive Start or a switch to hotspot that would replace a
connected station link refuses with `DEVICE_BUSY`, logs once and writes nothing.
Hybrid Start, Stop, and station or hybrid selection remain available.

Boot restore is apply-only. It waits for the first completed discovery
publication, then follows discovery, capability-publication and streaming-clearance
edges. Failed activation reuses the bounded discovery timer, with at most three
attempts for the current boot choice until observed AP success. Acceptance
alone never completes restore: the actual confirmation outcome settles it,
and failed confirmation retains bounded recovery. Exhaustion records
`wifi-hotspot-restore:<logical-owner>`; successful restoration clears that entry.
Station intent cancels the current cycle entry even while activation is pending.
A late terminal requires that exact live attempt and unchanged registry/intent;
it cannot recreate a cancelled entry or its degradation. Cycle-less apply calls
retain their local settlement contract.

Confirmation captures the selected UUID, actual AP interface, row and available
physical lifetime. Device events concern that AP interface; a station event on a
hybrid parent's interface supplies no AP evidence. Names and positive poll hints
trigger observation but cannot settle activation alone. NM must report the
captured AP interface connected on the captured UUID, and the pending record,
selection and lifetime must still match after the read. A held old poll cannot
settle its replacement or manufacture state using the row's newer UUID.
The existing poll helper retains queued discovery; its status boolean is only a
candidate for the pending monitor's mandatory AP-specific check.
If discovery discards a vanished virtual target and its cached UUID, the exact
current pending record still retires its own transition. Cache/binding cleanup
keeps its separate UUID fence, so replacement state is preserved. The abandoned
transition cannot block bounded recovery until the retry window expires:
failed confirmation continues toward three attempts and owner degradation.
Every new activating/deactivating transaction supersedes prior confirmation
observers synchronously before it claims the transition flag. This ownership
handoff occurs before awaited NM activation/deactivation, not at later confirmation registration.
An old failed poll therefore cannot clear a replacement Start's flag while its
NM request is pending. Start, reconfigure and Stop share the claim operation;
Stop retains its existing terminal settlement before claiming deactivation.
No new registry, timer or wire field is involved.

Each attempt re-reads current
intent and the registry under the adapter lock, never calls the persisting mode
setter, and skips station intent, active or observed APs, and owned pending
activations. Streaming leaves a disruptive restore pending with one warning.
An unavailable hybrid capability leaves hybrid pending with `activation-failed`.
An unchanged capability edge cannot dispatch an immediate duplicate; scheduled
retries follow failed activation. A late adapter,
capability arrival or cleared stream re-arms pending work. Pending accepted
activations are not duplicated by unrelated edges; failed confirmation can retry.
Observed AP loss or a positively changed physical lifetime re-arms recovery.
Its budget is keyed by (ifindex, wiphy, phyPath), not the availability token.
Unknown samples retain the prior physical witness; token churn alone cannot
refill exhausted attempts or the recovery window. Accepted, unconfirmed starts
consume the same three-attempt budget. Busy/pending work defers without charge,
station intent cancels it, and observed success clears only owner restoration
health. No name-based deletion or expanded D12 activation authority is added.

Capability edges come only from successful cache publication or an invalidation
that changes evidence. A failed read retaining the same expired cache emits no
edge, so a pending restore cannot turn one discovery event into an endless probe
cycle. Single-flight cleanup remains in `finally`, independent of publication.
Each interface also carries an internal equality revision of its phy binding and
concurrency proof. Invalidation and recovery advance that evidence even when
restore coalesces the events during a waiting activation. Pending-attempt dedup
includes this revision, so true-to-unknown-to-true recovery is not lost after a
definite activation refusal. Identical proof/binding publications leave it
unchanged. Observed success completes restoration; acceptance remains pending.
The producer retains only
the latest mapped interface set or its invalidation; revision reads start no IO.

The event source is a graph-free leaf, introduces no wire field, and has a
cancellable subscription. Shutdown retires restore before terminating identity
observation. It cannot start another adapter after cancellation.
Verified restore uses its matching intent key. Limited restore uses the D12
exception above; composite physical identity remains a later step.

### Inherited follow-ups outside B2 round 4 [PARTIAL]

- Bound retries when the initial capability read fails with no retained cache.
- Run one trailing capability computation for a newer interface set joining an
  older flight.
- Preserve virtual ownership if discovery repopulates while release is awaited
  (the separate B7 teardown follow-up).

