# Kiosk Toggle State Machine

**Design Contract: DC-2**
**Single source of truth for Tasks 23 and 25.**

The kiosk feature runs `cage` (a Wayland compositor) with Chromium in `--kiosk` mode, pointed at the CeraUI loopback URL. The CeraUI backend owns the lifecycle: it persists the toggle, drives systemd, and surfaces the live state to the settings UI. The UI shows the actual state, not just an on/off switch.

---

## States

Five states. No others exist.

| State | Meaning |
|---|---|
| `disabled` | Kiosk is off. `kiosk_enabled = false` persisted. `kiosk.service` is stopped and masked. |
| `enabled-stopped` | Toggle is on but the service is not running. Transient: occurs briefly after `toggle-on` before cage starts, or after a clean `toggle-off` before the config write completes. |
| `enabled-running` | `kiosk.service` is active and cage + Chromium are running normally. |
| `enabled-failed` | The service has entered systemd `failed` state due to a crash-loop (3 failures within 60 s). The persisted toggle is auto-disabled. |
| `failed-no-display` | The service failed because no display was detected at startup (HDMI/DSI unplugged). Distinct from a crash-loop failure. |

---

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> disabled : initial install (kiosk_enabled = false)

    disabled --> enabled-stopped : toggle-on\n(unmask + enable kiosk.service)
    enabled-stopped --> enabled-running : start kiosk.service\n(cage + Chromium launch OK)
    enabled-stopped --> enabled-failed : start kiosk.service\n(immediate failure / crash-loop)
    enabled-stopped --> failed-no-display : start kiosk.service\n(no display detected)

    enabled-running --> enabled-failed : crash-loop\n(3 failures / 60 s)
    enabled-running --> enabled-stopped : toggle-off\n(stop kiosk.service)

    enabled-failed --> disabled : auto-disable\n(kiosk_enabled = false persisted)
    failed-no-display --> disabled : toggle-off\n(stop + mask + kiosk_enabled = false)

    disabled --> enabled-stopped : toggle-on (retry)
```

---

## Transitions

Six transitions. Each entry lists the trigger, the systemd actions the backend takes, and the resulting state.

### T1: `toggle-on`

**From:** `disabled`
**To:** `enabled-stopped` (immediately), then `enabled-running` or a failure state once the service resolves

**Backend actions:**
1. Write `kiosk_enabled = true` to persisted config.
2. `systemctl unmask kiosk.service`
3. `systemctl enable kiosk.service`
4. `systemctl start kiosk.service`

The backend transitions to `enabled-stopped` synchronously after issuing the start command, then polls (see Failure-Observation Channel) to confirm the service reached `active (running)`.

---

### T2: `start resolves OK`

**From:** `enabled-stopped`
**To:** `enabled-running`

**Backend actions:** None. The backend observes `systemctl is-active kiosk.service` returning `active` and updates the broadcast state.

---

### T3: `toggle-off`

**From:** `enabled-running` or `failed-no-display`
**To:** `enabled-stopped` (transient) then `disabled`

**Backend actions:**
1. `systemctl stop kiosk.service`
2. `systemctl disable kiosk.service`
3. `systemctl mask kiosk.service`
4. Write `kiosk_enabled = false` to persisted config.
5. Delete the display-failure marker file if present (`/run/kiosk-no-display`).

---

### T4: `crash-loop`

**From:** `enabled-running`
**To:** `enabled-failed`

**Trigger:** systemd's `StartLimitIntervalSec=60` / `StartLimitBurst=3` fires. The unit enters `failed` state after 3 restarts within 60 seconds.

**Backend actions:** None triggered by the backend. The `OnFailure=kiosk-onfailure.service` handler (part of the unit, Task 26) writes a crash-loop marker. The backend detects the failure via the polling channel and transitions state.

---

### T5: `auto-disable after crash-loop`

**From:** `enabled-failed`
**To:** `disabled`

**Trigger:** Backend detects `enabled-failed` state.

**Backend actions:**
1. Write `kiosk_enabled = false` to persisted config.
2. `systemctl mask kiosk.service` (prevents accidental restart).
3. Broadcast `kiosk` state event to all connected clients.

**Rationale:** A crash-looping kiosk must not lock the operator out of the LAN browser UI. Auto-disabling the persisted toggle ensures the device is reachable from any browser on the LAN after a reboot, without requiring physical access.

---

### T6: `display unplugged`

**From:** `enabled-stopped` (during start) or `enabled-running` (display removed while running)
**To:** `failed-no-display`

**Trigger:** cage exits immediately because no DRM/KMS output is available. The `OnFailure` handler writes `/run/kiosk-no-display` to distinguish this from a crash-loop.

**Backend actions:** None triggered by the backend. The backend detects the marker file and sets state to `failed-no-display` rather than `enabled-failed`.

---

## Crash-Loop Auto-Disable Rule

**This rule is non-negotiable.**

When the backend observes `enabled-failed` (crash-loop, not display-unplug), it MUST:

1. Immediately write `kiosk_enabled = false` to the persisted config file.
2. Mask `kiosk.service` so it cannot be started by accident.
3. Broadcast the updated state to all connected clients.

The settings UI must reflect `disabled` after this transition, not `enabled-failed`. The user sees a failure banner explaining what happened, with a "Re-enable kiosk" action that goes through the normal `toggle-on` path (which will unmask the service).

The purpose: if cage or Chromium is crash-looping, the device must remain reachable from a LAN browser. Leaving `kiosk_enabled = true` in persisted config would re-trigger the crash-loop on every reboot.

---

## Persisted Config Fields

Both fields live in the backend's config file (same store as streaming config, managed via `helpers/config-loader.ts`).

| Field | Type | Description |
|---|---|---|
| `kiosk_enabled` | `boolean` | Whether the user has toggled kiosk on. Written on every `toggle-on`, `toggle-off`, and auto-disable. |
| `kiosk_last_state` | `string` (state enum) | Last-known state at shutdown. Written on every state transition. Used to restore the correct UI state on backend restart without waiting for the first poll cycle. |

On backend startup, if `kiosk_enabled = true` and `kiosk_last_state` is `enabled-running`, the backend immediately polls systemd to confirm the service is still running before broadcasting state. It does not assume the persisted state is current.

---

## Failure-Observation Channel

The backend detects `enabled-failed` and `failed-no-display` through three complementary signals. Tasks 23 and 26 implement both ends of this channel.

### Signal 1: `systemctl is-failed kiosk.service`

The backend polls `systemctl is-failed kiosk.service` on a 2-second interval whenever `kiosk_enabled = true`. The command exits `0` when the unit is in `failed` state.

```
systemctl is-failed kiosk.service
# exit 0 → unit is failed
# exit 1 → unit is not failed (active, inactive, etc.)
```

### Signal 2: `NRestarts` from `systemctl show`

To distinguish a crash-loop from a one-shot failure, the backend reads `NRestarts` from the unit properties:

```
systemctl show kiosk.service --property=NRestarts
# NRestarts=3
```

If `NRestarts >= 3` and the unit is in `failed` state, the backend classifies the failure as a crash-loop and applies the auto-disable rule (T5). If `NRestarts < 3`, the failure is treated as a single-shot failure and the state is held at `enabled-failed` pending user action.

### Signal 3: Display-failure marker file

The kiosk unit's `OnFailure=kiosk-onfailure.service` handler (Task 26) writes a marker file to distinguish display-unplug from a crash-loop:

```
/run/kiosk-no-display
```

This file is written by the `OnFailure` handler only when cage exits with the specific exit code that indicates no DRM output was found. The backend checks for this file's existence before classifying a `failed` unit as `enabled-failed` vs `failed-no-display`:

```
# Pseudo-logic in the backend poll loop:
if systemctl is-failed kiosk.service:
    if /run/kiosk-no-display exists:
        state = "failed-no-display"
    elif NRestarts >= 3:
        state = "enabled-failed"
        auto_disable()  # T5
    else:
        state = "enabled-failed"
```

The marker file lives on `tmpfs` (`/run/`) and is deleted on reboot and on `toggle-off` (T3). It is never written to persistent storage.

---

## UI Element Mapping

The settings UI surfaces the live state, not just the toggle value. Each state maps to a specific UI presentation in the kiosk settings dialog (Task 25).

| State | Toggle position | Status indicator | User action available |
|---|---|---|---|
| `disabled` | Off | None | Toggle on |
| `enabled-stopped` | On | Spinner / "Starting..." | Toggle off |
| `enabled-running` | On | Green dot / "Running" | Toggle off |
| `enabled-failed` | Off (auto-disabled) | Red / "Crashed, auto-disabled" | Re-enable (toggle on) |
| `failed-no-display` | On | Amber / "No display detected" | Toggle off, or plug in display and retry |

The toggle reflects `kiosk_enabled` from persisted config. The status indicator reflects the live polled state. After auto-disable (T5), the toggle snaps to Off even though the user last set it to On.

The backend broadcasts state changes via the existing `kiosk` event type on the WebSocket event bus (same pattern as `status` and `config` events in `rpc/events.ts`). The frontend subscribes and updates the store reactively.

---

## Implementation Notes for Tasks 23 and 25

**Task 23 (backend kiosk RPC + polling):**
- Implement the poll loop using `Bun.spawn(["systemctl", "is-failed", "kiosk.service"])` and `Bun.spawn(["systemctl", "show", "kiosk.service", "--property=NRestarts"])`.
- Check `/run/kiosk-no-display` with `Bun.file("/run/kiosk-no-display").exists()`.
- Persist config changes via `helpers/config-loader.ts` (same pattern as `setAutostart` in `modules/streaming/streamloop.ts`).
- Broadcast state via `rpc/events.ts` `kiosk` event type.
- The `toggle-on` and `toggle-off` RPC procedures follow the same shape as `sshStartProcedure` / `sshStopProcedure` in `rpc/procedures/system.procedure.ts`.

**Task 25 (frontend kiosk settings dialog):**
- The dialog composes `AppDialog.svelte`.
- The toggle binds to `kiosk_enabled` from the RPC response.
- The status indicator derives from the `kiosk` broadcast event state field.
- All user-facing strings go through `LL.*` (typesafe-i18n).
- No inline validation literals.
