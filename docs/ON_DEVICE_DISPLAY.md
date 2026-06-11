# On-Device Display Architecture

**Status:** `[EXISTS]` (Phase 2 complete; Phase 3 hardware-blocked)
**Scope:** Cross-repo — CeraUI + image-building-pipeline
**Design contracts:** DC-1, DC-2, DC-3, DC-4

This document is the single architectural reference for the on-device display (kiosk) feature. It covers the repo boundary, the state machine, the token contract, the display-profile URL contract, and the Phase-3 deferral register. Read it before touching anything related to kiosk, cage, Chromium, wvkbd, or display profiles.

---

## 1. Overview

CeraLive devices ship a **single image** that supports both headless and kiosk operation. The kiosk stack (cage + Chromium + wvkbd) is installed in the image but **inert by default**: all units are masked at first boot. The operator enables kiosk mode through the CeraUI Settings surface, which drives the lifecycle via the backend RPC. No reflash is needed to switch between headless and kiosk operation.

```
┌─────────────────────────────────────────────────────────────────┐
│  image-building-pipeline                                        │
│  (chassis: cage, Chromium, wvkbd, systemd units, OOM config)   │
│  Ships installed + masked. Inert until CeraUI enables.         │
└────────────────────────┬────────────────────────────────────────┘
                         │ systemctl unmask/enable/start
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  CeraUI backend                                                 │
│  (content + control: kiosk RPC, token mint, state machine)     │
│  Owns the toggle, the token, and the lifecycle state.          │
└────────────────────────┬────────────────────────────────────────┘
                         │ loopback URL + kiosk_token
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Chromium --kiosk (Wayland, cage compositor)                    │
│  Renders CeraUI PWA at http://127.0.0.1:80/                    │
│  ?mode=touch&display=<profile>&kiosk_token=<token>             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Design Contracts

Four design contracts govern the cross-repo interface. Each is a hard boundary: changing one side without updating the other breaks the integration.

### DC-1: Repo Boundary

**The image owns the chassis. CeraUI owns the content and control.**

| Responsibility | Owner |
|---|---|
| cage systemd unit (`kiosk.service`) | image-building-pipeline |
| Chromium package + launch flags | image-building-pipeline |
| wvkbd package + OSK unit | image-building-pipeline |
| OOM score adjustments | image-building-pipeline |
| `OnFailure` handler + marker files | image-building-pipeline |
| Kiosk toggle RPC (`toggle-on`, `toggle-off`) | CeraUI backend |
| Token mint + tmpfs write | CeraUI backend |
| State machine + polling loop | CeraUI backend |
| Settings UI (kiosk dialog) | CeraUI frontend |
| Display-profile store + `?display=` parsing | CeraUI frontend |

The image-side units are **passive**: they wait for CeraUI to unmask and start them. CeraUI is **active**: it drives systemd and owns the persisted toggle state.

### DC-2: Kiosk Toggle State Machine

Five states. No others exist. Full spec: [`KIOSK_STATE_MACHINE.md`](KIOSK_STATE_MACHINE.md).

| State | Meaning |
|---|---|
| `disabled` | Kiosk off. `kiosk.service` masked. Default at first boot. |
| `enabled-stopped` | Toggle on, service not yet running. Transient. |
| `enabled-running` | cage + Chromium running normally. |
| `enabled-failed` | Crash-loop (3 failures / 60 s). Auto-disables the toggle. |
| `failed-no-display` | cage exited because no DRM/KMS output was found. |

```
disabled ──toggle-on──▶ enabled-stopped ──start OK──▶ enabled-running
                              │                              │
                              ├──no display──▶ failed-no-display
                              │                              │
                              └──crash-loop──▶ enabled-failed ──auto-disable──▶ disabled
                                                                                    ▲
                                                                         toggle-off─┘
```

**Crash-loop auto-disable rule (non-negotiable):** when the backend observes `enabled-failed`, it immediately writes `kiosk_enabled = false`, masks `kiosk.service`, and broadcasts the updated state. This ensures the device stays reachable from a LAN browser after a reboot. See `KIOSK_STATE_MACHINE.md §Crash-Loop Auto-Disable Rule`.

**Failure-observation channel:** the backend polls on a 2-second interval using three complementary signals:
1. `systemctl is-failed kiosk.service` (exit 0 = failed)
2. `NRestarts` from `systemctl show` (>= 3 = crash-loop)
3. `/run/kiosk-no-display` marker file (written by `OnFailure` handler, distinguishes display-unplug from crash-loop)

### DC-3: Loopback Kiosk Token

Full spec: [`KIOSK_TOKEN_CONTRACT.md`](KIOSK_TOKEN_CONTRACT.md).

The kiosk service needs to open CeraUI already authenticated, without a password prompt. The mechanism is a short-lived, single-use token:

- 32 bytes of cryptographic randomness, hex-encoded (64 hex characters)
- Written to tmpfs only: `/run/ceralive/kiosk-token` (permissions `0600`)
- Consumed over loopback only (`127.0.0.1`) — LAN requests return `401`
- Single-use: the file is deleted before the response is sent
- Not PASETO, not a session cookie — it is exchanged for one

**Exchange flow:**

```
kiosk.service                    CeraUI backend
     |                                |
     |  (backend startup)             |
     |                                | mint token → /run/ceralive/kiosk-token
     |                                |
     |  ExecStart: chromium           |
     |    http://127.0.0.1:80/        |
     |    ?mode=touch                 |
     |    &display=lcd                |
     |    &kiosk_token=<hex>          |
     |                                |
     |  GET /?...&kiosk_token=<hex>   |
     |------------------------------->|
     |                                | 1. Check source IP == 127.0.0.1
     |                                | 2. Read /run/ceralive/kiosk-token
     |                                | 3. Constant-time compare
     |                                | 4. Delete token file (before response)
     |                                | 5. Issue session cookie
     |  200 + Set-Cookie: session=... |
     |<-------------------------------|
```

**Invariants both repos must uphold:**
- Source IP must be `127.0.0.1`
- tmpfs path is exactly `/run/ceralive/kiosk-token`
- Query parameter name is exactly `kiosk_token`
- Token is invalidated before the response is returned
- Token is never written to durable disk
- Loopback port is `80`

### DC-4: Display-Profile URL Contract

The `?display=` query parameter selects the display profile. CeraUI parses it on load, persists it in the display-profile store, and reflects it as `data-display` on `<html>`.

| Value | Meaning |
|---|---|
| `lcd` | Default. Full-color LCD. Standard OKLCH tokens. |
| `eink` | E-paper display. Monochrome OKLCH tokens, animations disabled. |
| `mono` | Monochrome LCD/OLED. Same monochrome treatment as `eink`. |

The `eink` and `mono` profiles both set `data-theme="eink"` (via `prefersEinkTheme()` in `App.svelte`), which triggers the monochrome CSS token set and the `animation: none !important` freeze. `data-display` carries the raw profile value for profile-specific rules.

**Source of truth:** `apps/frontend/src/lib/stores/display-profile.svelte.ts` — `DISPLAY_PROFILES` const-asserted array.

---

## 3. Launch URL Contract

The full kiosk launch URL is:

```
http://127.0.0.1:80/?mode=touch&display=<profile>&kiosk_token=<token>
```

| Parameter | Source | Notes |
|---|---|---|
| `mode=touch` | hardcoded in `kiosk.service` | Scales touch targets to 44px minimum |
| `display=<profile>` | `${DISPLAY_PROFILE:-lcd}` in unit | One of `lcd`, `eink`, `mono` |
| `kiosk_token=<token>` | read from `/run/ceralive/kiosk-token` | 64-char hex; single-use |

The port `80` is fixed. Neither repo may derive it independently. If it ever changes, `KIOSK_TOKEN_CONTRACT.md` and `apps/backend/src/rpc/server.ts` are updated together, and the image unit is updated in the same change.

---

## 4. Display Engine

**Engine: cage + Chromium `--kiosk --ozone-platform=wayland`**

This combination is non-negotiable. It was chosen for engine parity: Chromium is the same Blink engine used by Playwright in the CeraUI test suite. Any rendering or layout regression caught in e2e tests will reproduce on the device.

| Component | Role | Package source |
|---|---|---|
| `cage` | Wayland compositor (single-app kiosk) | Debian bookworm (`cage`) |
| `chromium` | Kiosk browser | Debian bookworm (`chromium`); must be >= 111 for OKLCH + TailwindCSS v4 |
| `wvkbd` | On-screen keyboard (OSK) | NOT in bookworm; requires build-from-source or vetted .deb |

**Chromium launch flags (minimum required):**

```bash
chromium \
  --kiosk \
  --ozone-platform=wayland \
  --no-sandbox \
  "${KIOSK_URL}"
```

**OSK (wvkbd):** shipped `--hidden` by default. Toggled via `SIGUSR1` (show) / `SIGUSR2` (hide). The compositor overlay does NOT resize the Chromium viewport or set `env(keyboard-inset-height)` — the CeraUI responsive layout handles the OSK inset via viewport-height CSS (`svh`). See `docs/TOUCHSCREEN.md` for the OSK inset design.

**GPU userspace (RK3588):** the device image pins `armbian_branch: vendor` (D3), which means the GPU userspace is `libmali-valhall-g610` (proprietary Mali-G610), NOT mainline panthor/Mesa-panfrost. The expected `lsmod` module is `mali` (not `panthor`). If `libmali` fails to provide EGL/GBM for Chromium ozone-wayland, the contingency (mainline kernel + Mesa) collides with D3 (HDMI hdmirx + MPP) and requires a re-plan. This is a hardware-validation item in Task 30.

---

## 5. Settings Surface

The kiosk settings dialog is part of the CeraUI Settings destination (Task 25). It exposes:

- A toggle binding to `kiosk_enabled` from the backend config
- A live status indicator reflecting the polled kiosk state (not just the toggle)
- A display-profile selector (`lcd` / `eink` / `mono`)
- A failure banner with a "Re-enable kiosk" action after auto-disable

The toggle and status indicator can diverge: after a crash-loop auto-disable (T5), the toggle snaps to Off while the status shows the last failure reason. This is intentional — the user sees what happened, not just the current toggle position.

**Location:** `apps/frontend/src/main/dialogs/` (kiosk dialog, composes `AppDialog.svelte`)

---

## 6. Phase-3 Deferral Register

The following items are explicitly deferred to Phase 3. They are NOT shipped in the current image and must NOT be documented as implemented.

All Phase-3 items are hardware-blocked: no RK3588 board is reachable from the development environment (Task 1 spike verdict: NO-GO). They require physical hardware validation before implementation can proceed.

### P3-1: E-ink Kernel DRM Driver + Device Tree

**What:** A kernel DRM driver and device-tree overlay for an e-paper display panel (e.g. Waveshare SPI e-ink) connected to the RK3588 GPIO/SPI bus.

**Why deferred:** The RK3588 vendor kernel (`armbian_branch: vendor`) does not include a mainline e-ink DRM driver. Adding one requires a custom kernel module, a device-tree overlay for the specific panel, and validation that the panel's refresh rate and partial-update mode work correctly with cage's KMS output. This cannot be validated without physical hardware.

**Current state:** The CeraUI frontend is e-ink-ready (monochrome OKLCH tokens, `animation: none` freeze, `data-display=eink` CSS hooks). The image-side driver and DT overlay are not present.

**Unblocked by:** Physical RK3588 board + target e-ink panel + lab access.

### P3-2: Dual-Display Hybrid (LCD + E-ink Simultaneously)

**What:** Running cage with two simultaneous outputs: an LCD touchscreen (primary, interactive) and an e-ink panel (secondary, status-only, slow refresh).

**Why deferred:** Requires confirming the `card0`/`card1` display-vs-render DRM node mapping on RK3588 (Task 28), validating that cage can drive two KMS outputs, and implementing a display-routing layer that sends the correct framebuffer to each panel. The e-ink panel also requires P3-1 first.

**Current state:** Not designed. The display-profile store supports `lcd`, `eink`, and `mono` as single-profile selections; dual-output routing is out of scope for Phase 2.

**Unblocked by:** P3-1 + Task 28 (RK3588 dual-GPU udev + touch calibration) + hardware access.

### P3-3: On-Device Live-Video Preview

**What:** A live video preview of the encoded stream rendered inside the CeraUI kiosk UI, so the operator can see what is being broadcast without a separate monitor.

**Why deferred:** Requires either a WebRTC or HLS re-mux path from cerastream's output into the browser, or a GStreamer pipeline feeding a `<video>` element via a local HTTP endpoint. Both approaches need hardware-accelerated decode on the RK3588 (libmali + V4L2 stateless decoder or Rockchip MPP decode path) to avoid CPU contention with the encoder. None of this has been validated on hardware.

**Current state:** Not designed. The HUD bar shows bitrate and link telemetry; no video preview surface exists.

**Unblocked by:** Hardware access + encoder/decoder pipeline design.

### P3-4: Battery / Power Telemetry (#61)

**What:** Displaying battery state-of-charge, charging status, and power draw in the CeraUI HUD or a dedicated power dialog.

**Why deferred (document-only):** Current CeraLive target boards (Orange Pi 5+, Radxa Rock 5B+) are **mains-powered appliances**. They have no battery, no fuel-gauge IC, and no power management controller that exposes SoC/charge data. There is no hardware to read. Issue #61 is tracked for future board variants that include a battery (e.g. a portable streaming backpack form factor), but no such board is in the current hardware roadmap.

**Current state:** The HUD bar shows SoC telemetry (CPU/GPU/memory). No battery/power surface exists and none is planned for Phase 2 or Phase 3 on current hardware.

**Unblocked by:** A board variant with a fuel-gauge IC (e.g. MAX17055, BQ27xxx) and a corresponding kernel driver + sysfs path.

---

## 7. Cross-Repo Change Rules

Any change that touches the DC-1/DC-2/DC-3/DC-4 interface boundary must update both repos in the same change (Rule A):

| Change | Files to update |
|---|---|
| Loopback port changes | `KIOSK_TOKEN_CONTRACT.md` + `apps/backend/src/rpc/server.ts` + image `kiosk.service` |
| Token path changes | `KIOSK_TOKEN_CONTRACT.md` + backend token handler + image `kiosk.service` |
| Display profile values change | `display-profile.svelte.ts` (`DISPLAY_PROFILES`) + `KIOSK_TOKEN_CONTRACT.md` + image unit `DISPLAY_PROFILE` env |
| State machine transitions change | `KIOSK_STATE_MACHINE.md` + backend kiosk RPC + frontend kiosk dialog |
| Chromium flags change | `image-building-pipeline/v2/docs/kiosk-display.md` + this doc |

---

## 8. Related Documents

| Document | Scope |
|---|---|
| [`KIOSK_STATE_MACHINE.md`](KIOSK_STATE_MACHINE.md) | DC-2: full 5-state machine spec (Tasks 23 + 25) |
| [`KIOSK_TOKEN_CONTRACT.md`](KIOSK_TOKEN_CONTRACT.md) | DC-3: loopback token spec (Tasks 24 + 26) |
| [`TOUCHSCREEN.md`](TOUCHSCREEN.md) | Touch/kiosk CSS layout, OSK inset, `?mode=touch` |
| [`image-building-pipeline/v2/docs/kiosk-display.md`](../../image-building-pipeline/v2/docs/kiosk-display.md) | Image-side chassis: units, packages, OOM, wvkbd build |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Full CeraUI system data flow |
