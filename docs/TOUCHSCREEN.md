# CeraUI Touchscreen / Kiosk Foundation

CeraUI ships a single responsive web UI. There is **no separate touch build**. A
lightweight "layout mode" flag scales hit targets and spacing so the same UI is
comfortable on an attached touchscreen (the kiosk scenario) without forking the
codebase. This document describes that foundation and what remains for a full
touch experience.

## Layout Mode Mechanism

The active mode is reflected as a `data-layout-mode` attribute on
`document.documentElement` (the `<html>` element). CSS reads that attribute to
swap a small set of design tokens; components consume the tokens, so no
component needs mode-specific branching.

Two modes exist:

| Mode | `data-layout-mode` | Intent |
|---|---|---|
| Default | `default` | Web-first sizing (mouse + keyboard) |
| Touch | `touch` | Larger hit targets + scaled spacing for kiosk touchscreens |

### Toggling

- **URL param** — `?mode=touch` or `?mode=default` overrides the persisted mode
  on load (handy for kiosk provisioning and QA).
- **Store** — `apps/frontend/src/lib/stores/layout-mode.svelte.ts` exposes
  `getLayoutMode()` / `setLayoutMode(mode)` backed by `$persist` (localStorage
  key `layout-mode`), so the choice survives reloads.
- **Reflection** — `App.svelte` runs two `$effect`s: one applies the URL param,
  the other mirrors the current store value onto
  `document.documentElement.dataset.layoutMode`.

## CSS Tokens

Defined in `apps/frontend/src/app.css`:

| Token | Default | Touch | Purpose |
|---|---|---|---|
| `--touch-target-min` | `0px` | `44px` | Minimum hit-target size (WCAG 2.5.5 target size) |
| `--spacing-touch-scale` | `1` | `1.25` | Multiplier for touch-aware spacing |

In default mode the tokens are inert (`0px` / `1`), so the web layout is
untouched. In touch mode the `[data-layout-mode='touch']` block raises them.

### Applied consequences

In touch mode, `--touch-target-min` is enforced as `min-height` on the major
interactive surfaces:

- Global buttons (`[data-slot='button']`, which covers the shared `Button`
  component and everything built on `buttonVariants`).
- Dialog action footer buttons (`[data-slot='alert-dialog-action']`,
  `[data-slot='alert-dialog-cancel']`).
- Navigation tabs (`#nav-tab-*` desktop rail, `#mobile-nav-tab-*` bottom bar).

`min-height` is used deliberately: the used box height is
`max(height, min-height)` regardless of selector specificity, so it lifts
compact `h-*`-sized controls to 44px without fighting Tailwind utilities and
without affecting default mode (where the token is `0px`).

The desktop nav tabs are already `h-11` (44px) and the mobile bar is
`min-h-[56px]`, so touch mode keeps them consistent rather than shrinking them.

`--spacing-touch-scale` is reserved for spacing-sensitive surfaces; consume it as
`calc(<base> * var(--spacing-touch-scale))` when a component needs touch-aware
padding/gaps.

## Kiosk Target

Primary target: **1024×600 landscape** (e.g. a Waveshare 10.1" capacitive
touchscreen attached to the device). All three destinations — **Live**,
**Network**, **Settings** — must fit at 1024×600 with **no horizontal
overflow**, in both default and touch modes. This is verified with Playwright
(see `test-results/task-36-default.png` and `task-36-touch.png`).

## Minimum Supported Resolution

| Orientation | Minimum | Verified |
|---|---|---|
| Landscape | **800×480** | `test-results/task-13-800x480.txt` |
| Portrait | **600×1024** | `test-results/task-13-portrait.txt` |

**800×480 landscape is the floor.** Below this the chrome and the larger config
dialogs (notably `ServerDialog`) can no longer be laid out without clipping. At
800×480 the panel renders the **desktop chrome** (see Breakpoints) and every
dialog renders as a centered, collapsible Dialog rather than a bottom Sheet, so
the form stays usable with the on-screen keyboard raised (verified against a
simulated 250px bottom inset — the `ServerDialog` Save action remains on-screen).

Portrait panels down to **600×1024** render the mobile layout (bottom-dock nav +
bottom HUD) with no clipped controls. Narrower or shorter viewports are not a
supported device target.

## Breakpoints

The shell pivots between two layouts. The single source of truth is
`DESKTOP_CHROME_QUERY` in `apps/frontend/src/lib/layout.ts`, consumed by
`MainView.svelte`, `MainNav.svelte`, and `AppDialog.svelte` (each instantiates
its own reactive `MediaQuery` from that string, so the nav and the dialog flip
together):

```
(min-width: 1024px), (min-width: 768px) and (max-height: 600px)
```

- **Desktop chrome** — rail nav (`MainNav.svelte`), HUD below the header,
  centered Dialog surfaces. Applies when the viewport is **≥1024px wide** (normal
  desktop / the 1024×600 kiosk) **OR** is a **short landscape panel** (≥768px
  wide ∧ ≤600px tall, e.g. **800×480**).
- **Mobile layout** — bottom-dock nav (`MobileNav.svelte`), HUD docked at the
  bottom, bottom Sheet (drawer) surfaces. Applies to everything else: narrow
  and/or tall viewports such as phones and **portrait panels (e.g. 600×1024)**.

The short-landscape branch is the fix for the old `lg=1024` pivot, where an
800×480 panel fell into the mobile layout and got a bottom Sheet — unusable with
the on-screen keyboard. Standard desktop/mobile semantics for non-kiosk use are
unchanged: only the ≥768px-wide ∧ ≤600px-tall band moved from mobile to desktop
chrome.

### Short-viewport dialog collapse

`app.css` adds an unlayered `@media (max-height: 500px)` rule: on very short
viewports the AppDialog surface collapses to a **minimal, full-height scrollable
form**. It overrides the default `max-h-[85svh]` to fill the (small) viewport
(`max-height: 100svh`), squares off the corners, and trims the header/footer
padding so more of the height goes to the scrollable body. The footer
(Save/Cancel) stays pinned on-screen. The `100svh` basis tracks the *small*
viewport, so when the browser reports a reduced viewport (e.g. an on-screen
keyboard that resizes the visual viewport) the dialog shrinks with it and Save
stays reachable.

> **OSK integration note.** The kiosk on-screen keyboard (`wvkbd`, see the image
> pipeline) is a Wayland compositor overlay and does **not** resize the Chromium
> viewport or set `env(keyboard-inset-height)`. The collapse rule keeps the
> dialog usable in the space the viewport reports; reserving space for an overlay
> keyboard that does not shrink the viewport is a device-integration concern
> tracked outside CeraUI.

Layout mode (touch/default) is **orthogonal** to these breakpoints: touch mode
only scales hit-target tokens; it does not change which nav renders or which
dialog surface is used. A 1024-wide kiosk gets the desktop chrome whether or not
touch mode is on.

## Remaining Work for a Full Touch UI

This task delivers the foundation only. A complete touch/kiosk experience would
additionally need:

1. **Larger slider thumbs** — bitrate / audio-delay sliders need bigger drag
   handles for finger control.
2. **Larger select / combobox targets** — dropdown rows and triggers should
   honor `--touch-target-min`.
3. **Swipe gestures for sheet dismiss** — bottom sheets / dialogs should support
   swipe-to-close.
4. **Pinch-to-zoom prevention** — a kiosk viewport should lock zoom
   (`user-scalable=no` / `touch-action`) so the UI stays pixel-stable.
5. **Dedicated kiosk type scale** — an optional larger base font scale, driven
   off the same `data-layout-mode` mechanism, for at-a-distance legibility.
