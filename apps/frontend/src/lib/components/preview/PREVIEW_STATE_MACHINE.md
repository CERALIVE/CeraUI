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
| `pausedHidden` | 30s unwatched (see below) | viewer-liveness effect | **resume / re-view** | until-resume |

`4401` is the one code that does NOT immediately band: it re-mints exactly ONCE
(silent), then a second `4401` surfaces `tokenRejected`.

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
id). A coarse/absent source omits the field so the engine falls back to its own
selection or replies with `no-source-applied` / `source-unavailable`. A confirmed
`config.source` change redials with the new `input_id` via the existing
applied-source follow effect.
