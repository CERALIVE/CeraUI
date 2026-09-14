# Live session switching

Status: [PARTIAL] — consumer implementation against published bindings;
U6 hardware acceptance remains **0/10**. No board commands are part of this work.

## Session truth, not discovery

`active_encode.switch_targets` is the engine-owned live roster. Each target carries
only an opaque `input_id` and `kind` (`capture`, `synthetic`, `network`). The shared
RPC package imports the producer's browser-safe schema and re-exports its type.
There is no local wire declaration, fake capture origin, or synthetic discovery row.

Membership means the engine has a built leg, a linked switch-owned pad and an
admissible switch state. It is not an idle capability, a health measurement, or a
reservation. Passthrough and composition publish `[]`: neither has the program
switch this control needs.

Two distinct roster members form a switchable pair, including one HDMI capture
plus one synthetic leg. The current leg renders the ordinary Active affirmation,
not a button. Synthetic labels use the translated Test Pattern name plus the
session identifier, in both the selector and live summary. Discovery can supply
capture display names, but cannot add or remove a session target.

The roster has three distinct readings:

| Reading | Operator surface |
|---|---|
| Absent | Legacy two-capture gate, with an explicit “targets not reported” notice |
| `[]` | No switch actions; an explicit “no source switches in this session” notice |
| Populated | Only reported legs, subject to the existing two-source threshold |

Not being in the switch roster does not itself prove a capture device disappeared.
The existing device-loss and frame-liveness signals retain their separate jobs.
A reported active synthetic leg is not mislabeled as a lost capture device.

## Admission and effects

The existing authenticated `streaming.switchInput` procedure takes a fresh
`list-switch-targets` snapshot before a live switch. A non-member is refused
before any engine switch or capture-config write, with the neutral `SWITCH_FAILED`
result. In particular, a stale synthetic target cannot establish a physical unplug
and must never produce `SOURCE_LOST`. The existing localized switch-failure toast
reports the refusal without inventing a hardware cause. Only JSON-RPC method-not-found
permits the legacy device-registry path; connection, query and final switch errors
never retry via discovery. The engine performs final admission against its current
session, so a target retiring after the snapshot is a normal possible refusal.
The registry gate in `devices.ts` remains unchanged.

Successful capture switches retain durable source selection and deferred Auto-audio
follow. Synthetic/network switches are session-only: they do not overwrite the
next-start capture configuration or retarget program audio. No new start phase,
boot-readiness behavior, or `change-config` transaction is introduced.

## Published dependency boundary

Both `apps/backend` and `packages/rpc` pin **`@ceralive/cerastream@2026.9.6`**
exactly, from npm, with schema **0.18.0** and registry `gitHead`
`100e84e672d21a2d38ffc7234bec2f78ad24fe4a`. The generated Bun lockfile carries
the registry artifact integrity. No producer link or local tarball is used.

The inherited work was blocked correctly: its installed local producer claimed
2026.9.5 while exposing unpublished schema 0.18.0. Those earlier green results
are not registry evidence. The real 2026.9.6 contract also differs from that
candidate: the query field is `switch_targets`, not `targets`, and targets have
no `label` or `available`. Consumer tests now exercise the actual published shape.

Coverage includes JSON plus producer-Zod plus backend extraction plus consumer-Zod
round-trips for absent, empty and populated rosters; a real local NDJSON/UDS exchange
through the registry client; installed-path/version checks for both consumers;
procedure-level empty-roster and query/switch-failure negatives; and rendered
synthetic switching, legacy behavior and distinct absent/empty notices.

`session-switch-adapter.test.ts` additionally drives the real backend adapter and
authenticated procedure through the published client over a local Unix socket.
Numeric `-32601` alone takes the legacy path. Other standard, server and unknown
RPC codes refuse even with “method not found” in their message; socket loss, a
closed/missing client, timeout, malformed JSON, malformed target data and malformed
error envelopes never consult discovery. Every negative case checks the request
list, capture-follow entry, config writes and disk bytes, resolved audio and an
already-pending audio selection. Stale synthetic requests cover both empty and
populated fresh rosters. The browser regression exercises LiveView's actual
localized error mapping and keeps the current source selected after refusal.

## U6 hardware boundary

This implements the operator path, not the ten-cycle drill. **U6 remains 0/10.**
The producer tags synthetic A/ball `bt709` (`2:3:5:1`) and B/SMPTE `2:4:7:1`
(limited/BT.601/sRGB/BT.709). Neither leg is untagged. UI labels do not prove
capture colorimetry, negotiated caps or muxed VUI.

The separate encoder `fix/srgb-transfer-vui` change (`7e2e5f5`) is independently
reviewed; this consumer work neither changes that plugin nor establishes muxed-output
acceptance. The later hardware drill must verify the prescribed distinct color
vectors and fail on stale or missing VUI, drive the live selector for ten cycles,
and establish receiver continuity plus unchanged encoder-restarts and pipeline
identity. A host browser test or a successful switch RPC is not that evidence.

## Consumer validation — 2026-09-14

The post-registry gate completed with terminal exit **0** at 12:08:01Z:

| Gate | Result |
|---|---|
| Frozen registry install | exit 0 |
| `bun run lint` (includes all package typechecks) | exit 0; 29 pre-existing Biome warnings, 3 infos; Svelte 0 errors/warnings |
| RPC unit suite | 512 passed |
| i18n unit suite | 709 passed |
| Backend `bun test --parallel` | 6,102 passed; 2 unchanged prerequisite skips; 0 failed |
| Frontend Vitest | 6,299 passed across 381 files |
| Frontend hardware-prerequisite guard (host-only) | 4 passed; no hardware contacted |
| Tech-debt gate | exit 0 |
| `BUILD_ARCH=amd64 bun run build` | exit 0 |
| `live-source-switch.spec.ts`, desktop, one worker | 5 passed; exit 0 |

Runtime: Bun 1.4.2; Node 26.7.0 for Node-based tools. The first background-launch
attempt was terminated during lint by the harness and is not counted. The
replacement used a detached process session and recorded every step's exit.

Failing-first receipts: the published-shape frontend fixtures failed four cases
on inherited code (missing synthetic action/affirmation, false loss and lost
summary label). The backend fixtures failed nine cases on the inherited query
shape. The new absent/empty notice tests failed three cases before the notices
were added. No existing test was skipped or weakened to obtain the passing gate.

Manual component-browser evidence covers capture-active, synthetic-active, empty
and unknown states at 375/768/1280 px. Pointer switch to B and keyboard return to
HDMI each reached the existing callback; no page errors or horizontal overflow.
This uses the real component with injected props, not a media engine. The e2e
spec separately exercises the mounted cockpit and authenticated socket path.
The QA run produced local, ephemeral artifacts (logs and screenshots) that are
not retained in the repository.
