# PreviewCanvas state machine

The on-demand preview surface (`PreviewCanvas.svelte`) is a two-dimensional
state machine:

- **`status`** — the connection/decode lifecycle (`PreviewStatus`):
  `idle → connecting → reconnecting → waiting → live`, plus the two dead-ends
  `unsupported` (no WebCodecs/MSE) and `error` (decoder fault).
- **`availability`** — the single rendered **band** the operator sees when the
  media surface is replaced. It is derived:

  ```
  availability = paused ? "pausedHidden"
               : closeReason ?? derivePreviewAvailability(capabilitiesSnapshot)
  ```

  When `availability !== "available"` the calm band renders and the dial effect
  tears the socket down (`stop()` → `status = "idle"`). So **every band is a
  torn-down socket**: a band and a live media surface are mutually exclusive.

`PreviewAvailability` bands and their setter, retry policy, and terminality are in
`preview-availability.ts` (`TERMINAL_PREVIEW_BANDS`). `pausedHidden` is a distinct
client-owned latch (NOT an error) carrying a resume affordance.

## The connecting-exit invariant (tested)

> **Every non-live input path leaves the `connecting` presentation within a
> bounded time (≤10s = the 8s media watchdog + margin) into a DISTINCT band or a
> terminal state. No input sequence may leave `connecting` rendered
> indefinitely.**

`PreviewCanvas.test.ts` sweeps the full trigger matrix under fake timers and
asserts that after each trigger the status is no longer `connecting` and a
distinct `data-reason` band (or `live`) is rendered.

## Lifecycle (`status`) transitions

| From | Trigger | Next status | Notes |
|------|---------|-------------|-------|
| `idle` | toggle on, tier ok | `connecting` | mints token, dials `/preview` |
| `idle` | toggle on, no codec tier | `unsupported` | terminal; no dial |
| `connecting` | `codec-config` / init | `waiting` | media watchdog cleared; `everProgressed = true` |
| `waiting` | first frame painted / appended | `live` | media flowing |
| `connecting`/`waiting`/`live` | socket drop (default close) | `reconnecting` | bounded backoff, see below |
| `reconnecting` | backoff timer fires | `connecting` | re-mint + re-dial |
| any active | toggle off / unmount / source change | `idle` | single-owner `teardown()` |
| any | decoder error | `error` | terminal band-adjacent overlay |

## Band (`availability`) triggers

| Band | Trigger | Set by | Retry policy | Terminal? |
|------|---------|--------|-------------|-----------|
| `available` | caps ok, nothing dialed-down | pre-dial derive | dials | no |
| `engineStarting` | `caps.engineStarting` | pre-dial derive | none (re-derives on caps) | no (self-heals) |
| `engineOffline` | `caps.engineUnavailable` **or** close `4502` (non-backpressure) **or** reconnect cap exhausted with never-progressed | pre-dial derive / `handleSocketClose` / `scheduleReconnect` | re-toggle | yes |
| `previewUnavailable` | `caps.preview.{bound,enabled}===false` **or** close `4503` | pre-dial derive / `handleSocketClose` | re-toggle | yes |
| `tokenRejected` | second close `4401` (after one silent re-mint) | `handleSocketClose` | re-toggle | yes |
| `mintFailed` | `mintPreviewToken()` RPC threw | `connect()` catch | re-toggle | yes |
| `interrupted` | reconnect cap exhausted **after** the session had reached waiting/live | `scheduleReconnect` (`everProgressed`) | re-toggle | yes |
| `noVideo` | socket open + `start` sent, no media before the 8s watchdog | media watchdog | re-toggle | yes |
| `backpressure` | close `4502` with reason `backpressure_overflow` | `handleSocketClose` | re-toggle | yes |
| `noSourceApplied` | engine failure frame `no-source-applied` | `handleText` | re-toggle | yes |
| `sourceUnavailable` | engine failure frame `source-unavailable` | `handleText` | re-toggle | yes |
| `deviceBusy` | engine failure frame `device-busy` | `handleText` | re-toggle | yes |
| `pipelineFailed` | engine failure frame `pipeline-failed` | `handleText` | re-toggle | yes |
| `passthroughActive` | engine failure frame `passthrough-active` | `handleText` | re-toggle | yes |
| `pausedHidden` | 30s unwatched (see below) | viewer-liveness effect | **resume / re-view** | until-resume |

`4401` is the one code that does NOT immediately band: it re-mints exactly ONCE
(silent), then a second `4401` surfaces `tokenRejected`.

### Engine typed-failure frames — accepted shapes

The five engine failure reasons above arrive on the WS text channel in any of
three shapes, all accepted by `handleText`:

| Shape | Emitted by |
|-------|-----------|
| `{ type:"preview-error", reason:"<reason>" }` | **what cerastream actually ships** (`preview/leg_control.rs`) |
| `{ type:"error", reason:"<reason>" }` | tolerated legacy shape |
| `{ type:"<reason>" }` | tolerated legacy shape |

The `preview-error` shape was previously consumed by the WebRTC session-cap branch
and dropped for every reason other than `rejected-limit`, so a real engine failure
never reached its band — the operator sat on "Connecting…" and then the misleading
`noVideo` band. `rejected-limit` remains the ONE `preview-error` reason that is a
ladder event rather than a band (it degrades WebRTC to the next rung, §ADR-0006 §4);
every other reason is terminal and additionally tears the WebRTC session down so the
armed signaling deadline cannot overwrite the band with a bogus fallback.

## Reconnect budget

A default socket drop schedules a jittered exponential backoff
(`RECONNECT_BASE_MS`…`RECONNECT_CAP_MS`), capped at
`PREVIEW_MAX_RECONNECT_ATTEMPTS` (5). On exhaustion the loop STOPS (no infinite
spin): a session that had reached `waiting`/`live` (`everProgressed`) surfaces
`interrupted`; one that never connected surfaces `engineOffline`.

## Viewer-liveness auto-stop (the client OWNS the 30s)

"Viewed" = **tab visible** (`document.visibilityState`) **AND** the preview card
is on-screen (`IntersectionObserver`) **AND** the host `<details>` is open
(`hostActive` prop from `IdleCockpit`). Losing any one starts a 30s window
(`VIEWER_IDLE_TIMEOUT_MS`).

| Condition | Effect |
|-----------|--------|
| active session goes unwatched | arm 30s timer |
| re-viewed before 30s (blip) | cancel timer — **no teardown** |
| 30s elapsed still unwatched | `paused = true` → `pausedHidden` band → dial effect cleanly closes the socket (single-owner engine then reaps the idle leg) |
| re-viewed while paused | auto-resume (`resume()`) → redial |
| resume affordance clicked | `resume()` → redial |

The client cleanly CLOSING the socket is the teardown signal — the engine's
single-owner rule tears the idle leg down immediately; server-side eviction only
reaps stragglers that never close. Auto-stop never fires while a session is being
viewed (`status === "live"` AND viewed).

## Applied-source `input_id`

The WS `start` frame carries the resolved applied source:
`{ action:"start", tier, input_id }` where `input_id = config.source` (the
broadcast-confirmed pick; for a capture device this IS the engine `list-devices`
id). An absent source omits the field so the engine falls back to its own selection
or replies with `no-source-applied`. A confirmed `config.source` change redials with
the new `input_id` via the existing applied-source follow effect.

`config.source` may legitimately hold a COARSE pipeline id rather than a device id
— e.g. `"hdmi"` when the operator picks a source row that no enumerated device is
currently bound to. CeraUI sends it verbatim and the engine answers
`source-unavailable`, which is the honest result: the selected source really has no
device behind it. The band above is what makes that visible; do NOT silently drop
the field to paper over it.

## Preview ENCODER identity is outside this machine

The preview encoder — which element encodes the feed, and whether the operator may
ask for the board's hardware one — is **not** a `PreviewCanvas` concern and is not
part of either dimension above. It never affects `status`, never sets a band, and
never changes the dial. It lives in a sibling control mounted by the same host:

| Surface | Where |
|---|---|
| The control | `src/main/live/PreviewEncodeControl.svelte`, mounted by `PreviewDisclosure.svelte` beside `PreviewCanvas` |
| The derivation | `src/main/live/preview-encode-state.ts` (`derivePreviewEncodeView`) |
| Capability gate | `capabilities.preview.preview_hw_capability` via `isPreviewHardwareEncodeCapable()` (`@ceraui/rpc`) — the control renders only on `=== true` |
| Persisted request | `config.previewEncode` (`"software"` / `"hardware"`), written with `streaming.setConfig` |
| Live realization | `status.preview_encoder_realized` — `{selected_element?, realized_element, mode, fallback_reason?}` |

Two facts a reader of this document will otherwise get wrong:

1. **A hardware-preview fallback is NOT a preview failure.** The engine falls back
   to `x264enc` and the preview keeps working, so there is no band, no close code
   and no `preview-error` frame — the tier ladder is entirely unaffected. The only
   report is the control's own warning, keyed on `fallback_reason.code`
   (`factory-missing` / `property-failure`, the latter naming the refused
   property). Do not add an availability band for it.
2. **Capability and realization are different channels and never substitute.**
   Capability rides the idle-safe `get-capabilities` snapshot and is a PLATFORM
   fact; realization rides session-scoped `status` and is absent whenever no
   session is running. An absent realization is not "software", and a live
   software realization is not "no capability".
