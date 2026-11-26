# Hotspot draft binding [EXISTS; host and browser scope]

The confirmation gate and live hotspot editor capture device, opaque
incarnation, link epoch and owner session when they load. Same-binding status
patches, including renames, signal/scan updates and replacement JSON objects,
preserve typed details and the acknowledgement. A changed binding reloads the
current stored values, clears consent and displays an inline notice. Every
load advances a local attempt counter, so returning from A to B to A cannot
revive A's old response.

Prepare/load/save, start, live configure and AP mode switches send the captured
expected incarnation. Stop and station mode send it when present and remain
available without it. A tokenless row cannot authorize guarded actions. Missing
proof can mean identification is still pending or the device software predates
the protocol; the UI does not infer a version from a token's absence. An
explicit degraded reason also withholds guarded actions. Live credentials
remain readable and copyable, and Stop remains available.

The live editor uses `wifiHotspotConfigOpKey(device, incarnation)` for dispatch,
pending display and settlement. The shared mode and hotspot keys also include
the token. Config/mode frames use the producer's dispatched token, never the
latest token substituted onto an old outcome. Old config frames still drain
local receipt ownership; mismatched frames cannot settle the displayed operation.
Tokenless frames retain the legacy key for tokenless rows. The operation
helper checks each owner's captured lifetime before applying a delayed RPC
result, toast or callback; callers outside this flow retain their prior behavior.

The backend enforces `radio-changed` and `binding-required` at request and
request-bound transaction-lock entry. A current start refusal reopens
the gate with fresh consent; a retired owner's response cannot reopen it.
Configure distinguishes refusal from an interrupted restart and does not claim
the hotspot is running after interruption.

Each Start send has its own optional UUID. The subscription routes its delayed
terminal to the initiating dialog only when the UUID, device and link match.
The receipt is reserved before sending, so it can catch a refusal before the
acknowledgement as well as afterward. A replacement during the accepted Start
can show the changed-radio notice after the row token rotates. A failed reply
whose correlated refusal arrived first is applied the same way, so a rotation
before that reply cannot hide the notice. A failed or unverified Down shows
the existing unknown-mode notice without reopening the credential gate. Success still requires authoritative status. A backend that
does not echo UUIDs continues to confirm from status.

## Admission and transient observation recovery

| Operation | Required binding |
| --- | --- |
| Prepare load/save, Start, Configure, mode to hotspot/hybrid | The current row token; missing is `binding-required`, stale is `radio-changed` |
| A guarded operation on a limited row | `radio-unverified`, with no radio or credential effect |
| Stop and mode to station | Neither a missing nor a stale token refuses the action |

The backend samples fresh physical identity under the adapter lock rather
than trusting the last broadcast. If no current token is projectable, it waits
for a running observation for up to two seconds and then returns
`radio-changed`, `reason: "current-unobserved"`, without effects.

One shared RPC middleware creates the request-admission context. Frame metadata
uses a separate context and never supplies request authority. Direct internal
calls, including boot restore and regulatory reconfigure, have no request
context and do not synthesize a client token. A regulatory restart requires
an original verified radio binding.
That context is one-shot: the transaction lock-entry check consumes it on admit
and refuse alike, and middleware retires it in `finally` even when no consumer
runs. It belongs only to its recorded adapter. Mock effects consume it
synchronously. Configure retains it until its dispatched lock attempt enters
or exits, while keeping the writer asynchronous. The transaction, the caller's
later publications and everything they schedule run without it, and restore
edges are delivered without it.

That transient refusal does not close the Prepare gate or fail a pending
config/mode operation. The frontend waits at most three seconds for the next
status frame for the row and retries the same call once only if its original
token still matches the frame and the current view. If the token changes,
the original operation ends; the editor reloads, and an activation or AP
mode switch needs fresh acknowledgement. A setup gate loads the replacement's
details without the old draft and without inheriting its retry. A token-less
frame or an expired wait selects `hotspotConfirm.bindingUnsupported` and
sends no request. A second refusal uses the existing reloaded-details
handling. A mode change that was sent without the credential gate is not retried
once the label or the row says the access point would start from a station; its
refusal opens the first credential prompt without a changed-binding notice.
The prompt takes over from the refused attempt, so cancelling it leaves no
mode-switch error on the row.
An acknowledged change keeps its one retry.
Closing the owner or changing device/link retires the wait. There
is no automatic retry loop. The retry stays on its original key, and is not
sent if another transition has taken over that key.
An open Start or mode confirmation, including the inline warning before dropping
an uplink, keeps the dialog's consent slot; the other action cannot open a
second confirmation while it is occupied.
If the access point ends after the inline warning opened, confirming the warning
opens the credential gate and sends nothing.

Configure keeps this same recovery owner alive after the RPC dispatch
acknowledgement until its captured config terminal arrives. A deferred
`radio-changed/current-unobserved` receipt starts the existing future-status
wait at receipt time, before an acknowledgement continuation can miss that
status; it consumes the same single retry. A plain deferred `radio-changed`
uses the same draft reload callback. Other writer terminals keep their existing
subscription settlement, and a deferred `radio-unverified` has localized inline
feedback. Closing the owner, a link reset or the existing operation timeout
retires the config receipt; there is no additional timeout or retry loop.

Each Configure call reserves its own terminal position before invoking RPC,
even when another Save uses the same device and radio token. The receipt helper
owns both the RPC and the captured terminal. `NotSentError` and a Configure
RPC error release the reservation completely: the former proves no send, and
the latter precedes writer admission on this procedure's fixed-ack path.
A normal entry refusal also releases it; its frame precedes its RPC reply.
An uncertain timeout or reset cannot prove no dispatch and keeps possible debt.
Retiring an owner releases its callback but retains any possible terminal debt.
Its delayed terminal is consumed without settling, reloading or recovering a
replacement Save. A new socket epoch discards old-socket reservations. The
valid Configure path owes one captured terminal per dispatch; no new wire
identifier is introduced. Configure's result, toast and reload also require
the same still-current admission controller, so an old acknowledgement cannot
revive a cancelled Save. Every delivered captured terminal drains its local
reservation before filtering by the displayed token. Repeated token rotations
therefore retain no records for terminals already delivered.

A terminal outcome received before the retry prevents a resend; the existing
confirmed or failed state remains visible.
The abandoned retry does not replace that feedback with its earlier refusal.
Attempt ownership belongs to one begin identity. A pending mode echo replaces
that identity even when its key and target match, so a losing RPC cannot settle
the winner displayed on its requesting client. The local-marker machinery is
removed. All mode refusals before pending, including station contention and
the transaction's own preflight checks, are private to their requester.

Broadcast mode terminals carry the existing `seq` envelope. Private mode-error
frames have no sequence and are consumed by the RPC client without entering
subscription settlement; their correlated RPC result owns the local outcome.
Broadcast terminals settle every observer regardless of reason, including busy
outcomes and a reconnecting requester whose idle latch must be recreated. There
is no foreign-DEVICE_BUSY filter. Configure keeps its separate asynchronous
terminal contract. The [protocol contract](WIFI-INCARNATION-PROTOCOL.md) records
the routing and attempt rules.

Future remote callers must use this same admission and recovery contract.
There is no remote hotspot route today; the token remains local and the remote
status projection is unchanged. The full backend table and D13 rule are in
[the protocol contract](WIFI-INCARNATION-PROTOCOL.md).

## Compatibility and remaining rollout

Limited mode retains its existing degraded reason. Backend entry admission
and in-operation checks use the radio lifetime. Composite and port-scoped
identity remain separate changes.
Old backends keep read-only hotspot display, Copy, Stop and station switching;
the new frontend withholds guarded actions until a token is available.
This is an intentional compatibility limit, not full action parity.
Token-aware asynchronous config/mode settlement requires P2's echoed outcome
fields. A pre-release producer that emits row tokens but lacks those echoes
cannot settle the new pending keys; it also needs the device software update.
No parity across arbitrary intermediate pre-release versions is claimed.

No G1-G5, physical hotplug, NetworkManager or hardware qualification is claimed.
Native es-419 review of the final copy and rendered states remains required.
All ten catalogs contain the new keys; EN and es-419 have authored copy, and
the other eight currently use the English values. No existing catalog value
or immutable rendered oracle is changed.

## Operator documentation handoff for the same release

The release owner must coordinate these paragraphs into docs.ceralive.tv in
both languages before release. This repository does not claim the site is
already updated or remove the release hold.

EN: When you open hotspot setup, keep the displayed network name and password
before turning it on. Ordinary Wi-Fi updates keep your edits. If the adapter
or connection changes, CeraLive reloads the details and asks you to confirm
again. If identification is pending, wait for the details; update the device
software if it remains unidentified. You can still read and copy an active
hotspot's details and turn it off.
If the adapter changes after you select Enable Hotspot, the dialog can report
that the hotspot did not start. If it cannot confirm that the hotspot stopped,
check the adapter's current status before trying again.

es-419 (native review pending): Cuando abras la configuración del punto de
acceso, guarda el nombre de la red y la contraseña que aparecen antes de
encenderlo. Las actualizaciones habituales de Wi-Fi conservan tus cambios.
Si cambia el adaptador o la conexión, CeraLive vuelve a cargar los datos y te
pide que confirmes otra vez. Si la identificación está pendiente, espera a
que aparezcan los datos; actualiza el software del equipo si sigue sin
identificarse. Puedes leer y copiar los datos de un punto de acceso activo
y apagarlo de todos modos.
Si el adaptador cambia después de seleccionar Activar punto de acceso, el
cuadro puede indicar que el punto de acceso no se activó. Si no puede confirmar
que se apagó, revisa el estado actual del adaptador antes de volver a intentarlo.

## Tests and authorized existing-assertion updates

`HotspotDialog.binding.test.ts` drives the real dialog, selector, subscription
consumer, session epoch and async-operation store, with deferred RPC promises.
It covers same-binding patches, binding loss/change, owner/link/ABA invalidation,
late outcomes, tokenless/degraded behavior and safe Stop.
`hotspot-draft-binding.spec.ts` drives the real Network destination and mock
protocol hooks. A same-token status patch must preserve the pair and consent,
and actual activation must use that pair; a rotation must reload and uncheck.

The two protected clipboard/credential E2E files stay byte-identical. The owner
authorized fixture tokens and exact request-expectation additions, keeping
every other predicate and call-count/order check unchanged:

| Original location | Before | After |
| --- | --- | --- |
| `HotspotDialog.activation.test.ts:147` | prepare `{device: "0"}` | prepare `{device: "0", incarnation: "radio-A"}` |
| `HotspotDialog.activation.test.ts:168` | start `{device: "0"}` | start `{device: "0", incarnation: "radio-A"}` |
| `HotspotDialog.activation.test.ts:194-198` | prepare `{device: "0", name: "CERALIVE_791c", password: "my own pass"}` | same exact fields plus `incarnation: "radio-A"` |
| `WifiSection.hotspot-switch.test.ts:244-247` | mode `{device: "wifi0", mode: "hybrid"}` | same exact fields plus `incarnation: "radio-A"` |
| `WifiSection.hotspot-switch.test.ts:292-295` | mode `{device: "wifi0", mode: "hotspot"}` | same exact fields plus `incarnation: "radio-A"` |
| `truthfulness.spec.ts:2488` | mode `{device: "0", mode: "hotspot"}` | same exact fields plus `incarnation: "truth-radio-A"` |

The STATION and `wifiIface` fixtures receive `incarnation: "radio-A"`.
No matcher is relaxed and no token is hidden from a spy. Final test and
attempt-level browser receipts belong to the pull request evidence.

The truthfulness transition's synthetic radio receives
`incarnation: "truth-radio-A"` and its terminal mode fixture echoes that value.
The two deferred config fixtures in `hotspot-toggle.spec.ts:412,443` now echo
the incarnation captured from the actual dispatched request. Their success,
error, form-retention, call-count and timing predicates remain unchanged.
The two-security-choice row at `truthfulness.spec.ts:2649` also receives
`incarnation: "truth-live-A"` so its existing selector interaction has lifetime
proof. Its assertions and the neighboring tokenless legacy fixture are unchanged.
