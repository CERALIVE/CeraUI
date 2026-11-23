# Wi-Fi incarnation and entry admission [PARTIAL; host proof only]

PR P exposes one optional `incarnation` string on each local Wi-Fi status row.
It accepts the same optional input on hotspot prepare (load and save), start,
stop, configure, and every adapter mode switch, including station.
The shared schema requires 1-128 ASCII characters from `A-Z`, `a-z`, `0-9`,
underscore and hyphen when present. It does not trim, coerce or parse a UUID.
Empty, oversized, non-string or other-character values fail input/output
validation. Valid values remain opaque and equality-only. An absent field
retains the legacy shape.

Guarded requests now require the expected token at RPC admission and again
at their transaction lock entry. Config and mode requests also supply the captured
metadata for the asynchronous frames below. Start also retains the proof it
obtained at transaction entry. Same-address radios with independently verified
ports keep separate rows and admission tokens. An unsafe or missing port leaves
the whole address group limited. Port-qualified requests recheck the captured
literal path alongside the existing lifetime witness. The wire shape and
localized refusal keys are unchanged. Physical same-address qualification is
still pending.

A sole adapter uses the plain MAC record, including when returning from a
verified pair. Discovery preserves independent port state for the next proven
pair. During a port swap, token-free Stop and Station can wait briefly for
discovery to prove the live target instead of requiring a second request. They
do not guess the target when that proof does not arrive in time.

A successful Stop or Station retires the independently saved intent of the
selected radio's verified permanent MAC and literal port. It does so on
both sole and composite rows, including when the AP is already down or the
plain-MAC AP is running. Other independent ports keep their intent.
If the selected live AP belongs to the current port, only that owning port
gets Station; otherwise the plain record and its credential-only copies
also get Station. An unsaved Station choice blocks restore for the affected
owners while its write is retried. An accepted explicit Hotspot or Hybrid
supersedes it; a refused choice reinstates the previous durable and deferred
intent. The deferred retry is in memory and cannot survive power loss while
configuration is still unwritable.

Boot restore rechecks current physical proof and refuses to rebind a profile
with a contradictory saved pin.
Verified hybrid checks both saved interface selectors and the port before
allocating or mutating the AP leg. An old AP-leg name may be rebound only when
it is absent from the live interface list and the saved UUID, permanent MAC
and literal port prove the same owner. The selectors must match the new leg
before Up. Boot does not prune superseded profiles; eligible stale profiles
can remain until the next operator Start.
The service remembers observed address collisions across empty discovery passes.

## Backend limited mode [EXISTS; host and mock-browser proof only]

Rows with unresolved permanent identity retain
`degraded_reason: "permanent-mac-unresolved"`. No status field is added.
Prepare load/save, Start, Configure and mode selection of hotspot/hybrid return
`radio-unverified` before any credential or radio effect. The toggle and mode
error schemas accept that additive enum member. Configure sends the same token
in its terminal `wifi.hotspot.config.error`; its optional incarnation follows
the capture rules below. Stop and station actions remain available.

The live AP's name and password come read-only from the profile NetworkManager
reports active on that device. Copy and Stop remain available; Stop deactivates
the UUID without rewriting autoconnect. Discovery neither adopts credentials
nor repairs a limited profile. A regulatory change that would restart that AP
stops it with a warning instead, leaving persisted mode intent unchanged.

Boot alone may restore an existing owned profile under D12: one hotspot-capable
adapter, one address group with non-Station intent (MAC and MAC@port count as
one), a non-Station plain MAC record with an owned profile, a currently
permitted stored channel or `auto`, and no disruptive streaming transition.
Hybrid requires proven concurrency and an already-correct interface pin; any
fixed channel must match the live station on same-channel hardware. D12
requires a live matching path when the profile has a saved port pin.
An unpinned plain owner is eligible only without known collision history.
D12 rechecks the selected radio and uses UUID plus interface for Up; the last
asynchronous hybrid Up guard samples the live station. Cold hybrid creation
rechecks the parent and addresses its sampled wiphy index. D12 does not
write the profile, credentials, device autoconnect or mode intent.
Every failed condition logs once per unchanged edge; success logs
`hotspot restored on an adapter that could not be identified`.
A replacement already selected at discovery can still receive an eligible
pathless plain profile if there is no contradictory evidence. The checks
refuse a detected change but are not atomic with NetworkManager's interface
resolution or the kernel's wiphy lookup. Same-identifier reuse and station
roam after the last applicable read remain possible. D12 is proven on the
host only.

The frontend maps the refusal to existing localized unverified copy without
adding strings. The `wifi-limited` mock scenario and
`hotspot-limited-mode.spec.ts` exercise details, Copy, Stop, absent setup/Save/
start controls and direct RPC refusal. Older tabs accept the additive error
through the existing plain JSON client and use their generic error copy.

## Request admission

| Call | Token policy |
| --- | --- |
| Prepare load/save, Start, Configure, mode to hotspot/hybrid | The caller must supply the current token |
| Stop, mode to station, other station operations | Missing and stale tokens never cause a binding refusal |
| Boot restore, regulatory reconfigure, monitor and direct module/handler calls | No request-admission context; retain their existing internal behavior |

All guarded Wi-Fi router procedures use one admission middleware. It establishes
the request binding exactly once, including an explicitly missing client token.
Transaction checks consume that context; its absence means no incoming guarded
request is being admitted. Internal callers do not acquire a token requirement.
A mode change to hotspot or hybrid is checked at the transition's lock entry.
Its delegates use the proof captured by that transaction. The request
admission is one-shot: the transaction lock-entry check consumes it whether it
admits or refuses. It applies only to the recorded device; another adapter's
internal transaction does not inherit it. Middleware retires the record in
`finally` on every exit, including a failed lock attempt, refusal or throw.
Configure's dispatch acknowledgement waits only for the lock callback to enter
or the lock attempt to exit before retiring the record, never for the writer.
Mock providers consume it before their synchronous effects. Nothing that runs
afterwards reads it again: not the transaction, not the caller's terminal frame
or broadcast, and not any timer,
poll, prune or rescan either one starts. Outcome publishers also leave the
admission scope when a refusal bypasses lock entry. Adapter-mode restore edges
are delivered without it.
Existing limited-radio and profile-ownership rules still apply.

Each mutation takes `withWifiAdapterLock` directly in its owning module, with
`admitWifiRequest` inside the lock callback. Configure's entry receipt tracks
only when that callback enters or the attempt exits; it never owns the lock.

Request admission and config/mode frame metadata use separate asynchronous
contexts. Frame correlation can never supply a missing request token. There are
no explicit token parameters to forward through module or internal delegate APIs.
The router structure and entry-to-lock rotation are tested for every guarded
procedure, including both Prepare forms and both AP-mode targets.

On an existing limited row, guarded calls return `radio-unverified` before
credentials, NetworkManager, mode persistence or virtual-interface effects.
On a healthy row a missing client token returns `binding-required`; a stale
token returns `radio-changed`. Already-active shortcuts follow admission.
Normal contention, unsupported-device and NetworkManager failures still apply.

An entry refusal is returned by RPC and its existing Start, Configure or mode
frame is sent only to that requesting socket. Prepare retains its RPC-only
refusal. Other clients receive no entry-refusal frame, even when the captured
token is also the key of their accepted transaction. The requester's frame
retains its previous members, order and token capture. Accepted transaction
publishers retain their existing broadcasts.

This also covers every refusal before a mode transaction publishes pending:
the device lookup, busy probe, lock contention, lock-entry binding check,
limited/unsupported/capability checks and streaming guard. Station retains its
token-free path but its RPC preflight refusals are private too, including mocks.
The RPC's mode transaction claims its entry-reply publisher once, before any
await; a bypassed consumer retires that publisher on return or throw. Internal
calls retain their existing two-argument publisher behavior. Entry replies use
the shared frame builder and publisher hook with an optional reply callback;
that callback is never serialized and conveys no admission authority.

Admission holds the canonical adapter lock, preserves the config id-map and
mode registry resolvers, and compares a new coherent sysfs lifetime sample
against the producer's current witness for the exact row. The last status
broadcast alone cannot admit a request. A row replaced before transaction
lock acquisition is refused before any effect.

If the row has no currently projectable token, admission waits for its running
identity observation, with a total budget of two seconds including the fresh
read. An observation that lands inside the budget can admit the request;
otherwise the refusal is `radio-changed` with `reason: "current-unobserved"`.
Losing the current publication proof during the fresh read uses that same
transient reason; a replaced registry row remains a changed-radio refusal.
Admission does not launch discovery or manufacture a token for the caller.
The same missing/stale/limited policy applies to mock requests.

### Start lifetime checks [EXISTS; host proof]

Start retains the original row, registry key, token, permanent MAC and
network-device/phy lifetime. After taking the adapter lock it checks that
lifetime before cleanup, recording intent, target allocation and the
already-active shortcut. It rechecks at profile pin, inactive creation, Up
and autoconnect dispatch, then before remembering credentials and registering
confirmation. Existing profile and hybrid target ownership checks still apply.
Missing or changed proof during Start yields the existing `radio-changed`
refusal without `current-unobserved`, so it cannot trigger an automatic replay.

Confirmation checks the captured entry after reading the actual AP target
lifetime. It samples the parent radio first and then the AP leg. A positively
identified active instance on a changed radio may be stopped under the same
adapter lock. Down names its captured D-Bus active path, so a later activation
of the same profile stays up. It publishes `radio-changed`, including
`deactivation-failed` as the reason if Down fails.
Without exact activation evidence, ordinary bounded confirmation still
applies. Start rollback restores only its own cache entry.

Prepare rechecks after resolving credentials and inside the shared repair or
Save callback. It checks again before returning credentials or committing the
Save. Active Configure and regulatory restart use the same writer. It checks
the selected radio and profile before the forward write, reactivation, any
rollback, and the credential commit. If proof is lost before dispatch, the
operation refuses without effects. If a write may already have changed the
profile, Configure reports `activating` and suppresses further writes and Up.
An exclusive restart needs a fresh physical port observation and matching
saved profile pins. If proof is lost after a forward or rollback Up, Configure
and regulatory restart use the captured active path and daemon identity to
take down only their own activation, never a later activation of the UUID.
Both forward and rollback hybrid Up require confirmation of the command's
active path and daemon, on the selected AP leg with the expected UUID, as
well as the station/AP channel check. UUID and channel alone cannot confirm
Save. The same active path, daemon, UUID and connected AP leg are rechecked
after refreshing saved connections and before committing credentials. A
rollback whose Up acknowledged but whose profile readback failed still
undergoes hybrid confirmation and exact cleanup; it is not a clean refusal.
If confirmation fails, cleanup uses only the command receipt. Before Up,
channel refusal may stop an AP proven active on the selected leg. Stop, Station and discovery
policy obtain a fresh device activation path on the selected radio or AP leg;
a saved UUID, cached live state or global roster never authorizes Down.
Station checks a fresh device roster even when its cached mode is Station.
An unreadable or unclassified local activation requests a rescan and returns
`deactivation-failed`. When the radio has no selected AP to stop, a failed
owner policy pass refuses Station and restores the prior intent; the owner's
policy retry remains scheduled. This does not gate Down of a live AP.
Legacy Wi-Fi Disconnect has only a UUID on the wire:
it requires one unambiguous selected Station row, or returns `generic`.
An Up timeout is uncertain, not a clean refusal. Re-read the selected AP leg
and compare it to the pre-Up path and profile instance; do not dispatch a
rollback Up on timeout. A live AP positively re-observed on the unchanged
target can settle the Save. That observation never becomes a command receipt.
If confirmation fails or continuity is lost, only a daemon-returned receipt
authorizes cleanup. An interrupted Save reports `activating`, not success,
and logs unproved cleanup. A channel refusal whose exact Down cannot be
proved reports `activation-failed` with reason `deactivation-failed`.
The same path requirement applies to limited-radio regulatory Stop.

The credential writer stages the keyfile, re-reads the profile and requires
the same NetworkManager resource, and only then requests the operation's
proof. Publication is two back-to-back synchronous calls: a hard link keeps
the current keyfile aside, and a rename puts the staged file in its place. The
writer then checks that the kept file is the original device, inode and bytes,
and requests the proof again before `nmcli connection load`. If the keyfile
was replaced or the proof was lost, the kept file is renamed back, so the newer
or original bytes stay and nothing is loaded (`publish-target-replaced`,
`publish-proof-changed`). For first-profile Start, the proof is also checked
between inactive creation and the credential write.

After NetworkManager acknowledges Up, a replacement can still cause refusal.
While holding the adapter lock, Start compares the captured profile file
and active D-Bus path, then requests Down for that active path
(`nmcli connection down apath <path>`), never for the profile UUID. A later
activation of the same profile therefore stays up. An unverified or failed
Down is reported as `radio-changed` with reason `deactivation-failed`.

A hybrid Start binds its original AP leg lifetime into the operation guard
right after allocation (`bindLeg`). Every later `check` and `permit` then
samples the parent radio and then that leg, so a same-phy leg replaced during
the parent sample is refused. That covers the saved pin, credential repair,
the nested credential permit, Up, post-Up commits and both keyfile writer
permits. Hybrid Configure binds its captured leg identity the same way, so its
staged keyfile, restart Up and credential commit are covered too.

A Start can release only the allocator receipt it acquired. Every hand-back
after a rollback goes through `releaseHybridLeg`: Start's own rollback,
deferred confirmation after its Down, and a retried created-profile cleanup
after its Down. With the receipt, the release restores a borrowed leg's
autoconnect only while the selection is still this Start's and the leg is
idle, so a successor's selection is left alone. A stale Start waits for its
exact-instance Down to settle before it rolls back state or releases the leg.
If Down fails, the leg is still active. The release then leaves its policy
alone and the selection keeps the recorded prior value for a later release.

The Start request and terminal frame accept an optional `attempt` UUID.
The backend echoes the captured UUID even when the NetworkManager monitor
publishes after the reply. The incarnation still controls admission.
The dialog reserves a fresh UUID for each dispatch, including the one allowed
retry. An accepted Start can consume a refusal for its UUID, device and
socket epoch even if the same dialog already displays the replacement radio.
A refusal may arrive before or after the dispatch acknowledgement. The dialog
shows the existing changed-radio notice when cleanup succeeded and the
existing unknown-mode notice when Down could not be verified. The latter
does not reopen the credential gate automatically.

The status snapshot still confirms Start and Stop. Older backends can ignore
the request field and continue sending their existing status and terminal
frames. Older senders omit the UUID and receive the previous frame shape.
Uncorrelated Start frames cannot resolve another client's pending operation.
Closing the dialog, changing device or link, and settling or timing out the
pending operation retire its receipt. Stop and station do not use the UUID.
A failed Start reply keeps the correlated refusal its frame delivered first,
even if the row token rotated before the reply.

### Residual limits [EXISTS; host proof]

The adapter lock orders CeraUI operations, not independent NetworkManager or
filesystem writers. The following checks reduce the remaining windows and
report uncertain outcomes rather than claiming an atomic transaction.

- **Keyfile publication and restoration.** Park the live file, verify the
  parked identity and bytes, and publish by linking into a vacant pathname.
  The live path can briefly be absent, but an independent writer that takes
  it first is not overwritten. Verify the live staged inode and bytes again
  after the final radio permit and after load readback. Before load, a
  refusal or inspection error restores the parked file only if the pathname
  is vacant or still holds the staged file. Recheck the moved file before
  restoration; if a successor won the race, relink it instead of the backup.
  Preserve and log recovery files when an external writer wins the relink
  or ownership cannot be established. The tests replace the live keyfile
  during both permit outcomes and throw during the post-publication permit
  (`wifi-credential-publish-radio.test.ts`).
- **Final proof to load.** A radio or leg replaced after the last permit, while
  `nmcli connection load` runs, lets NetworkManager read the credential into
  the profile, which stays bound to the original radio. The next effect's
  proof refuses, so no Up, autoconnect or commit follows, a first-profile
  Start deletes its new profile, and the operator sees `radio-changed`
  (`wifi-hybrid-leg-boundaries.test.ts`). An independent keyfile change
  inside load cannot undo that dispatched load; even a same-byte successor
  is detected on readback and is not reported as our commit
  (`wifi-credential-publish-radio.test.ts`). Restored files retain their
  bytes and inode, not their original ctime.
- **Activation rollback and profile deletion.** Rollback binds the Up path
  to its original NetworkManager bus and daemon identity. The shared Down
  primitive checks the bus ID on a non-reconnecting connection and sends
  `DeactivateConnection` to the recorded unique daemon owner, by path, after
  checking the active object's UUID and device. Method acknowledgement alone
  is not completion: the same bus must prove the exact object deactivated
  or removed within the bounded wait. An unproved Stop keeps live state and
  returns `deactivation-failed` for retry, without releasing the AP leg.
  A missing path, a different run,
  or unreadable identity never authorizes a Down by path or UUID. Cleanup
  checks fresh activity instead. If activity is unknown or the profile still has
  an active connection, retain it and issue the existing unknown-mode
  notice (`cleanup-pending` or `deactivation-failed`). First-profile deletion
  also checks inactivity immediately before dispatch; a successful exact
  Down alone is not sufficient. The host tests start a same-profile
  successor both before and after Down and observe that it survives.
  A complete inventory that shows the profile gone retires its cached
  references and creation record without issuing Down or Delete. Explicit
  Stop of a pending first profile may also confirm inactivity after an
  unacknowledged Down, without repeating the command.
  NetworkManager does not offer a delete-if-inactive transaction: an
  independent activation after the final inventory answer can still race
  Delete. The remaining `nmcli` operations, including Up and Delete, cannot
  bind dispatch to a daemon run, so NetworkManager can restart after their
  last check. Exact Down is not an `nmcli` operation: its D-Bus call targets
  the captured daemon owner on the verified bus. The CLI renumbering tests
  cover restarts before the check, not inside the CLI dispatch gap.
- **Deferred borrowed-leg release.** Expiry and failed exact Down both try
  release using Start's allocator receipt under the owner lock. Only the
  still-owned idle leg can regain its previous autoconnect. Busy or
  unreadable state retains a release obligation with a bounded automatic
  retry schedule and produces the unknown-mode notice. Confirmed removal or
  replacement retires the old claim without restoring policy on a successor.
  A parent-only incarnation change does not retire the claim: the same
  managed leg can still recover its saved autoconnect policy once idle.
  Tests cover idle expiry, release after busy expiry, a committed Down whose
  reply was lost, a replaced leg, and a parent reset with the same leg.
- **Explicit Stop during hybrid Start confirmation.** Stop settles the
  pending Start before issuing Down. If the leg is still busy, the Start
  terminal can report `deactivation-failed` and readiness stays degraded
  until reconciliation completes the release, even if Stop succeeds.

### Recorded deviation: the Start `attempt` correlation id

Plan todo 24 (`ceraui-hotspot-radio-enforcement.md:437`) says the Start
outcome frame keeps its current shape and carries no token. B8 deliberately
deviates by adding the optional `attempt` field. On November 20, 2026, the
owner delegated the decision ("whatever makes the most sense, safest, best
user experience") and root approved keeping the field. Without it, the
initiating dialog could only time out after a deferred refusal instead of
showing the keyed refusal notice.

The deviation is bounded:

- `attempt` is a random UUID generated for each send. It is never a radio,
  incarnation or credential token and grants no admission, mutation or
  release authority. The incarnation alone admits the request.
- Only the Start request accepts it. Stop, station and the other procedures
  do not.
- The backend echoes it only on that Start's terminal frame and only when the
  request carried one. Without it, the frame bytes match the previous shape.
  `apps/backend/src/tests/wifi-start-attempt-wire.test.ts` pins both cases for
  an accepted Start and a refusal.
- Entry refusals published by the admission middleware do not carry it. Their
  RPC reply is the requester's result.

Compatibility: an older backend strips the unknown request field, and the new
dialog confirms from status as before. An older client omits the field and
receives the previous bytes. A frame without a matching UUID, device and link
epoch cannot settle a dialog's operation.

Mode to hotspot or hybrid checks before recording intent, then passes the
captured row and lifetime through Down and Start. A replacement after a
confirmed Down blocks Start and settles the original mode operation with
`radio-changed`. A failed Down remains `deactivation-failed`. A refusal can
restore only the intent written by that operation under the held owner lock.

The frontend keeps a `current-unobserved` request pending for the next Wi-Fi
status frame containing that row, for at most three seconds. It sends the same
call once with that frame's token. A frame without a token, or the absence of a
frame within the window, selects the existing binding-unsupported notice and
sends nothing. A second refusal uses the existing changed-radio handling;
there is no retry loop. Transient config/mode terminal frames do not settle
the pending operation as failed.

Configure's asynchronous acknowledgement is unchanged. Its frontend owner
joins that acknowledgement with the existing captured config terminal before
completing admission recovery. Deferred transient refusals feed the same
bounded helper as RPC refusals, with the future-status wait registered when
the refusal is received; a plain changed-radio refusal reloads the draft.
Unverified terminals retain their inline operator feedback. The receipt is
cancelled with the owner or its existing operation lifetime. Normal writer
settlement and mode publication/attempt rules are unchanged.

Config receipt ownership is per local dispatch, not merely device/incarnation.
The receipt helper reserves before RPC and owns its acknowledgement and terminal
together. A client `NotSentError` or a Configure RPC error releases the position:
this procedure's fixed success ack follows dispatch, while RPC errors precede
writer admission. Normal entry refusals send their frame before the RPC reply.
Uncertain transport timeouts/reset failures retain possible terminal debt.
Same-socket reservations retain a retired dispatch's place only while its
terminal may still arrive, suppressing settlement and recovery for a newer Save.
Only the live reservation can notify its retry owner. Every delivered terminal
drains its reservation before UI token filtering, including old-token outcomes;
delivered outcomes cannot accumulate across rotations. A changed socket epoch
retires the old queue because those frames cannot reach the new socket.
Cancelled Configure owners also reject their later RPC result and feedback
through their own admission controller. This uses local state only; the wire
and the one-terminal-per-valid-dispatch contract remain unchanged.

Stop and station remain independent of the Start binding. This contract makes
no physical-radio qualification claim.

The `wifi-limited` mock scenario supplies an unidentified `wlan0` with an
already active hotspot for the same admission policy and safe Stop/station
controls. It does not implement limited-radio boot restore or change the live
identity producer, profile ownership, or internal transaction policy.

The frontend consumes the protocol for draft ownership, expected-incarnation
requests and bounded recovery from an unobserved sample. See
[the frontend binding contract](HOTSPOT-DRAFT-BINDING.md).

## Asynchronous config and mode settlement [EXISTS; host proof only]

Only `wifi.hotspot.config` terminal frames and `wifi.adapter_mode`
pending/terminal frames gain optional `incarnation`, with the same strict
1-128-character ASCII bound as the row token. The frontend now dispatches,
displays and settles config and mode operations with token-qualified keys.
`subscriptions.svelte.ts` ignores echoed tokens that disagree with the current
row and routes matching frames to their captured lifetime's key. A tokenless
frame retains the legacy key only when the current row is also tokenless.

The schema-valid expected token is captured when supplied, including one that
will be refused as stale. Otherwise the exact row's proven token is captured
synchronously for refusal correlation, before the RPC admission probe or any
transaction await. This metadata never fills in a missing admission token. The
existing config id-map lookup and mode registry lookup remain distinct. An
unproven capture stays absent even if another row becomes proven later.
Publication never looks up the latest row. Capture does not call the status
builder, start discovery, compare tokens for admission or wait for sysfs.

A private asynchronous dispatch context carries this metadata without changing
RPC inputs, results or internal call arguments. Core config continuations and
their unexpected-throw wrapper retain the captured value. Mode publishers close
over it for direct refusals, pending state, completion and the terminal timeout,
including a completion invoked outside its original asynchronous context. Real
and mock procedures use the same frame builders. Refused mock requests leave
credentials and mode unchanged.

RPC replies and config/mode/toggle terminal frames accept an optional `reason`
alongside the typed refusal. RPC error envelopes gain no field. Replies identify
their dispatch through the request/response pair. Start also correlates
deferred refusals as described above. Internal boot reconciliation uses the
shared mode producer. Regulatory reconfiguration has no additional keyed
hotspot settlement frame and skips the restart if its original radio has no
verified lifetime.

The existing transport envelope distinguishes mode publications. Broadcasts
carry `seq`; private mode refusals do not. The RPC client consumes an
unsequenced mode-error frame as call-only feedback instead of passing it to
subscription settlement. The correlated RPC reply then settles only its
original attempt. A sequenced terminal belongs to the accepted transaction and
settles every observing client, regardless of its error reason. No new wire,
status or attachment field is added. Other legacy unsequenced message types
keep their existing handling.

Configure still ignores entry-only `binding-required` frames. Its
`radio-changed` remains a terminal possibility after its dispatch acknowledgement
but before lock entry, so its existing handling is retained.

Attempt ownership is the unique identity created by begin, never inferred from
an equal target. Every pending mode echo creates a new attempt, including an
equal-target echo; the original RPC cannot fail, confirm or hand off that
replacement. The local-marker machinery and DEVICE_BUSY locality filter are
removed. Observers consume real busy terminals normally. If reconnect cleared
the pending latch, a terminal recreates an idle entry before settling it;
already terminal entries retain the existing state-machine rules.

Admitted operations retain the original member ordering and serialized frame
bytes after removing incarnation. Refused guarded requests intentionally have
new results and terminal errors. No enumerable `undefined` is added. Separate schema, replacement
schedule, mock and remote tests inspect the raw new field as well as legacy
bytes. Same-interface replacement tests dispatch against A, establish B before
pending or terminal publication, and require A's captured token, never B's.

## Producer and lifetime

The real status builder requires evidence for the exact current registry row
and its observation generation, with a coherent lifetime witness. It does not
accept an interface-name match alone. It does not await sysfs, mint a fallback, or
infer identity from an interface name. Discovery awaits the coherent sample
before classifying keys as verified MAC, `limited:<ifindex>:<wiphy>`, or
incoherent `degraded:<ifname>`. Before that observation completes,
or when no current coherent observation exists, the field is absent. Discovery
invalidates prior evidence before publishing or mutating rows, including reused
row objects. Detached samples carry their captured row and generation; a late,
failed, timed-out or incoherent observation cannot authorize an older token.
An observation older than the latest committed sample cannot publish. A rowless
sample can carry the previous exact row and its original stamp for an unchanged
identity at the same ifname. This preserves ownership for an already-bound
operation only while its registry row and live proof still match. It does not
make that stamp current: after invalidation, status stays tokenless and new
requests cannot use the carried association until coherent evidence matches
the current row marker. Request admission also requires its own live recheck.
After a detached publication, the producer compares each current row's projected
wire token with its value before publication. A changed token sends exactly one
Wi-Fi status frame to authenticated local clients through `broadcastMsgLocal`;
unchanged projected tokens send none. The cloud relay receives no additional
frame and its projection is unchanged. Existing pulls and initial snapshots
also carry proven tokens. A local token frame never acknowledges hotspot roster
delivery: only `broadcastWifiState` records membership sent to all subscribers,
so a pending roster poll still sends its normal global/control-channel update.
Discovery awaits sampling within its existing bounded run.

Each sample has a 1000 ms budget. A lost sample (superseded, incomplete, timed out
or rejected) resamples the current registry rows with a fresh generation after
250 ms, then 1 s, then 4 s, for at most three consecutive retries. Each retry
invalidates those rows before sampling. An incomplete or inconsistent bracket
still publishes uncertainty. If a current sampled registry row has no declared
degraded reason but lacks a coherent projectable token, that publication is a
lost sample with reason `incomplete`; it does not reset the budget.
Rows declared degraded or limited by their existing contract do not retry
solely for absent proof. A coherent publication or a new discovery resets
the retry budget. Discovery cancels pending observation work before awaiting
the device listing; an absent listing still queues the retained registry rows.
An `unavailable` event for an interface that has no identity row does not advance
the publication sequence. The monitor publication fence is released in `finally`,
including when the identity update throws.

There is at most one logical sample in flight and one latest queued batch.
A timed-out physical read may settle later; its aborted generation cannot issue
further reads or publish. A fresh sample can proceed without waiting for it.
All text and symlink identity reads share a module-level bound of four
outstanding physical operations across producers, discoveries and retries.
The counter decreases only when the operation settles, not on logical abort.
At capacity, sampling defers without calling another reader or starting a new
sampling timeout, logs one string warning per saturation episode
(`Wi-Fi identity reads still held (4); deferring sampling`), and resumes the
latest queued sample when a held read settles.
Settlement wakes only a queued capacity-deferred sample; it does not restart an
exhausted retry cycle. After retry exhaustion, another discovery is required.
Capacity deferral has no finite recovery bound if held reads never settle.

All observation-owned start, deadline, retry and queued-continuation timers are
unreferenced, so those timers alone cannot keep an otherwise finished process
alive. Explicit cancellation still clears them.

Explicit `stop()` or `terminate()` cancels without a lost-sample warning or
retry. `stop()` is reusable discovery cancellation; `terminate()` is terminal.
Production SIGTERM/SIGINT injects `terminate()` from the `main.ts` composition,
so a device listing already in flight cannot enqueue or restart observation
during cleanup. The generic shutdown helper imports no Wi-Fi/application graph.
Wi-Fi-owned test setup reopens the singleton for another isolated test.
Each lost sample logs only a string identifying its reason and interface names:
`Wi-Fi identity sample lost (<reason>) for <ifnames>; retry <n>/3` for retries
1, 2 and 3; the final loss ends with `; no retries left`. Thus an initial
sample and three retries that all time out produce four warnings and no
remaining timer. These warnings contain no status payload or credentials.

The producer's existing coherent ifindex/wiphy/path evidence rotates the random
token on a replacement, replug, classification change, or either degraded edge.
A true same-object rename and ordinary connection, scan, mode or capability
updates retain it. Uncertainty cannot establish continuity. Tokens are ephemeral
and equality-only, with no MAC, path, credential, or stable derived identifier.
They are non-secret observations that bind an already-authenticated action;
they never authenticate a caller.

The mock producer emits one random token per radio on station and hotspot
status. Mode and connection changes retain it. The authenticated development
procedure `dev.rebindWifi({device})` rotates only that radio's token and emits
the existing status shape; credentials, mode and connections remain unchanged.
It accepts the mock numeric id or device name, is registered only outside
production, and additionally refuses production or non-mock execution.
Mock initialization and reset clear the token map. Mock protocol fixtures use
fake clocks for all service timers and retain reset/stop cleanup.

Mock RPC admission and request-bound transaction admission use this same mock
producer. Internal calls do not create an admission context. They do not compare
mock tokens with a physical sysfs producer. Immediate mock RPC effects read
admission synchronously, so a queued rebind cannot overtake that check. A
limited mock row still refuses guarded requests. This is simulation behavior,
not physical-radio qualification.

## Exact wire delta and egress

With no token, the status builder adds no property, including no enumerable
`undefined`; serialized legacy Wi-Fi rows stay byte-identical. With the current
36-character UUID, each row grows by exactly 53 UTF-8 bytes:
`,\"incarnation\":\"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\"`.
Property ordering of all pre-existing members is retained. Other valid opaque
ASCII strings have their stated length; 53 is a producer measurement, not the
128-character schema limit.

Authorized local clients receive the field through initial `sendStatus`,
`broadcastWifiState`, `wifi.getStatus`, and aggregate `status.getStatus`.
Both RPC output schemas retain it. The current frontend's existing shared types,
JSON receive path and status hydration tolerate both shapes. The frontend uses
the token for hotspot draft ownership and guarded requests, with read-only
display and Stop retained when it is absent.

Remote-bound status strips it using the projection introduced for local hotspot
passwords. This includes initial and subsequent legacy remote serialization
and the optional v2 status relay when a channel is injected. The production
relay remains unwired by this change. A cloud mirror receiving those projected
frames therefore gains zero token bytes. Keeping the token local preserves remote
status bytes. It does not classify the token as a credential.

The legacy remote sender also strips the two settlement-frame tokens, preserving
unrelated members, send options and callbacks. Tokenless non-status frames keep
their original serialized bytes. Local frames are untouched. The v2 status
allowlist does not include `wifi`, and its command dispatcher does not invoke
hotspot procedures; this change adds neither route. The installed v2 decoder
probe therefore does not apply to these unsupported frame types. No new cloud
schema, package publication or relay wiring is required.

### Future remote hotspot callers (D13)

No current remote command route invokes these hotspot procedures. The legacy
remote dispatch is a no-op, and the control-channel command router has no
hotspot command. A future authenticated remote hotspot route must carry the
device's current binding and follow exactly the local admission table, including
safe Stop/station actions and the bounded observation wait. A credential-free
or token-less bypass is not a remote-control contract. Until that route and
dialog exist, incarnation remains local and `remote-status.ts` is unchanged.

## Compatibility and package boundary

The installed platform decoder is separately probed against
`@ceralive/control-protocol` 2026.7.0: strict status/frame decoding constrains the
envelope while retaining unknown nested Wi-Fi fields. The probe establishes
installed-package compatibility, not deployed-cloud or hardware qualification.
Remote stripping remains the policy even though that decoder accepts the field.

The workspace rule to publish producer bindings before new-field consumers
merge still governs registry packages such as `@ceralive/control-protocol`.
Here the producer contract is `@ceraui/rpc`, compiled from this repository's
`workspace:*` dependency by backend and frontend in the same build. There is no
external binding publication for this field or external new-field consumer.
P does not alter the published control-protocol schema.

Schema tests reject malformed/empty tokens and preserve both shapes. Real
producer tests use the prior injected discovery/sysfs fakes. The recorded
legacy equivalence oracle removes only the new row field before comparing its
existing status, registry, id-map, credential, result and broadcast assertions;
the frozen fixtures remain unchanged. The one authorized exception to A's
internal-only premise replaces
`expect(JSON.stringify(wifi.wifiBuildMsg())).toBe(before)` with
`expect(legacyBytes(recovered)).toBe(before)`, where both byte strings remove
only each row's incarnation. Additional emitted-value assertions require
unavailable/recovery rotation and stability across ordinary saved-network status
changes. Every other pre-existing assertion remains unchanged. Separate tests
inspect raw emitted tokens and serialized local/remote frames. The frontend
binding rollout adds operator copy and the coordinated EN/es-419 documentation
handoff; limited-mode and port-scope markers and their copy belong to B.
