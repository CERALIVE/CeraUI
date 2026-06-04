# Product

## Register

product

## Users

Live streamers, broadcasters, and content creators — from professional broadcast engineers to passionate field operators — configuring a CeraLive streaming encoder device (Jetson Nano SBC). Primary context: field broadcasts under time pressure, event management on tablets, studio setup at desktop. They configure multi-link bonded network connections (cellular modems, Wi-Fi, Ethernet), streaming pipelines, video/audio encoding, and server targets. During a live broadcast they need at-a-glance telemetry and immediate control, not configuration menus.

## Product Purpose

CeraUI is the on-device control plane for CeraLive streaming hardware. It lets operators configure, monitor, and control an active stream from a browser PWA. Success: a user can arrive cold, configure their encoder and network connections, start a bonded multi-link stream, and monitor it live — all without consulting docs or making a support call. The persistent live HUD (bitrate, signal, SoC telemetry) keeps the operator informed throughout.

3-destination information architecture: **Live** (streaming + encoder config), **Network** (connectivity), **Settings** (system configuration). Heavy dialog usage for all secondary flows.

## Brand Personality

**Ground Control** — precision telemetry instrument. A satellite operations center, not a broadcast control room. Warm near-black graphite surfaces, phosphor-lime live indicators, amber/coral state signals. Confident, instrument-calibrated, field-ready.

Three words: **Calibrated. Live. Controlled.**

Emotional goal: the operator feels the stream is in good hands — every indicator reads at a glance, every action is unambiguous, the interface never surprises them at a critical moment.

## Anti-references

- The old CeraUI cyan/slate identity (electric cyan #11C4D4, blue-black #0b0f1a) — do not revive.
- Generic SaaS cream/sand/beige backgrounds — no warm neutral defaults.
- Glassmorphism as decoration — no backdrop-blur cards by default.
- Gradient text (background-clip: text) — never.
- Side-stripe accent borders on cards — never.
- The hero-metric template (big number, gradient accent line) — SaaS cliché, wrong register.
- Identical card grids — nested cards are always wrong here.
- Per-section uppercase eyebrow labels — overused, not this brand.
- Linear clone or Vercel developer aesthetic — too dev-tool, not instrument-tool.
- Purple gradients or glassmorphism-everything "AI-generated" aesthetic.

## Design Principles

1. **Instrument Clarity**: Every surface is a display, not a form. Status is primary; configuration is contextual (accessed via focused dialogs). The operator should know the stream state at a glance without opening anything.
2. **Dark-First Hero**: The base experience is dark graphite — the device lives in controlled environments, events, and broadcast settings where dark reduces eye strain and the phosphor-lime accents pop. Light mode is first-class but not the hero.
3. **Dialog-Driven Configuration**: Configuration complexity lives in focused, contextual dialogs/sheets — not inline mega-forms. Each dialog owns one concern. The 3 destinations are scannable, not scroll-heavy forms.
4. **Live-Data Discipline**: Real-time telemetry (bitrate, signals, sensors) is throttled, smoothed, and staleness-aware. Live values must degrade gracefully on disconnect — never show misleading fresh-looking data when the WS connection is down.
5. **Touch-Inclusive by Default**: Hit targets, spacing, and layout must remain functional when a touchscreen is attached. The foundation is web-first but kiosk-ready (1024×600 target).

## Accessibility & Inclusion

- WCAG AA minimum: body text ≥4.5:1 contrast, large text ≥3:1. Verified for both dark and light themes.
- RTL first-class: Arabic (`ar`) locale triggers `dir=rtl`; all layout uses logical CSS properties; dialog close buttons, navigation order, and HUD signal order mirror correctly.
- 10 locales: en, ar, de, es, fr, hi, ja, ko, pt-BR, zh. CJK and Arabic require system font fallbacks (Space Grotesk lacks those scripts — no tofu glyphs).
- `prefers-reduced-motion`: every animation has an alternative (typically crossfade or instant transition).
- 1024×600 kiosk viewport target: all surfaces fit without overflow for touchscreen attachment scenarios.
