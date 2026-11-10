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
latest token substituted onto an old outcome. Mismatched frames are ignored.
Tokenless frames retain the legacy key for tokenless rows. The operation
helper checks each owner's captured lifetime before applying a delayed RPC
result, toast or callback; callers outside this flow retain their prior behavior.

The frontend handles a future `radio-changed` or `binding-required` refusal
without requiring either during this rollout. A current start refusal reopens
the gate with fresh consent; a retired owner's response cannot reopen it.
Configure distinguishes refusal from an interrupted restart and does not claim
the hotspot is running after interruption.

## Compatibility and remaining rollout

This fixes the frontend draft/acknowledgement overwrite. P/P2 accept and echo
tokens but do not enforce them at backend effect boundaries. That backend race,
limited-mode behavior, `identity_limited`, composite/port-scope markers and
their conditional copy ship in B. C adds none of those states or fields.
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

es-419 (native review pending): Cuando abras la configuración del punto de
acceso, guarda el nombre de la red y la contraseña que aparecen antes de
encenderlo. Las actualizaciones habituales de Wi-Fi conservan tus cambios.
Si cambia el adaptador o la conexión, CeraLive vuelve a cargar los datos y te
pide que confirmes otra vez. Si la identificación está pendiente, espera a
que aparezcan los datos; actualiza el software del equipo si sigue sin
identificarse. Puedes leer y copiar los datos de un punto de acceso activo
y apagarlo de todos modos.

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
