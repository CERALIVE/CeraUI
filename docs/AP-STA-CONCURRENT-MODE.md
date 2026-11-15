# Concurrent WiFi station and hotspot

**Status:** [PARTIAL — implemented and fixture-tested; physical-radio validation pending]

CeraUI can keep a WiFi station connection active while the same physical radio
hosts an access point, but only when the kernel driver positively advertises a
valid `managed` + `AP` interface combination and a virtual AP interface can be
created successfully.

## Capability contract

The backend maps each physical interface to its wiphy with `iw dev <ifname> info`
and parses `iw phy <phy> info`. A radio is eligible only when one complete
`valid interface combinations` alternative permits one `managed` interface and
one `AP` interface, with `total >= 2`. Group limits are respected, alternatives
are evaluated independently, and `#channels <= 1` is accepted because it means
the two interfaces must share a channel rather than forbidding concurrency.

Missing, malformed, unsupported, or unparseable output resolves unsupported.
The optional wire field `supports_ap_sta_concurrency` is emitted only after the
capability probe and virtual-interface creation both succeed. Older backends and
unsupported radios omit it, so the frontend never infers support.

## Runtime lifecycle

For a proven radio, the backend creates a deterministic `clap-<parent>` virtual
interface with cfg80211 type `managed`. The row model records that type, and an
existing interface is reused only after its type is confirmed; an incompatible
or unproven instance is refused without deletion. NetworkManager binds
the hotspot profile to that interface while the physical interface keeps its
station profile and bond membership. Start, confirmation, configuration, stop,
process restart, and profile adoption track the virtual AP separately from the
station connection.

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
at most three activation attempts per unchanged restore edge; capability and
streaming prerequisites remain pending without an activation. Exhaustion marks
that owner's restore health degraded, and observed AP success clears it.
Accepted activation remains pending until confirmation; a failed confirmation
keeps bounded recovery. Inactive same-MAC twins resolve their own logical
owners from compatible literal path/interface pins, and activation keeps that
owner separate from the physical MAC used for NetworkManager pins.
Stop still reports the actual disconnect result under the contract above.

If support is absent, CeraUI retains the existing exclusive station-to-hotspot
switch. The UI states that starting the hotspot will disconnect WiFi and remove
that link from the bond; it never presents dual mode as available.

## Validation still required

The parser includes realistic Realtek `rtw89` and MediaTek MT7925-shaped fixtures,
and automated tests cover fail-closed parsing, wire projection, virtual-interface
creation, station-preserving start/stop, and legacy exclusive behavior.

No physical RTL8852BE or MT7925 radio has completed the end-to-end drill yet.
Required hardware checks are:

1. Verify virtual-interface creation and NetworkManager adoption.
2. Keep a station association and bond membership while starting/stopping the AP.
3. Confirm same-channel behavior when the driver advertises `#channels <= 1`.
4. Reboot with the hotspot enabled and verify profile re-adoption.
5. Exercise driver/firmware refusal and confirm the UI reports failure without
   disturbing the station connection.

Until those checks pass, support is implemented but hardware-validation-pending;
the capability advertisement is not a claim that every driver/firmware revision
will activate successfully.
