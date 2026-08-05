/**
 * Shared responsive pivot for the app shell.
 *
 * "Desktop chrome" = the rail-nav + top-HUD + centered-Dialog layout. The mobile
 * alternative is the bottom-dock nav + bottom Sheet (drawer) layout.
 *
 * Desktop chrome applies in two cases:
 *   1. The normal large breakpoint (Tailwind `lg`, 1024px wide) — phones/tablets
 *      in portrait stay below this and keep the mobile layout, unchanged.
 *   2. Short LANDSCAPE panels: at least 768px wide AND at most 600px tall. These
 *      are attached kiosk touchscreens (e.g. an 800×480 panel). They are too
 *      short for the bottom Sheet / bottom-dock layout to be usable — a bottom
 *      drawer on a 480px-tall screen with the on-screen keyboard raised buries
 *      the form behind the keyboard. The centered Dialog (which the
 *      `@media (max-height: 500px)` rule in app.css collapses to a full-height
 *      scrollable form) is the correct surface there.
 *
 * The standard desktop/mobile semantics for non-kiosk use are unchanged: only
 * the short-landscape band (≥768px wide ∧ ≤600px tall) — which previously fell
 * into the mobile layout — now resolves to desktop chrome.
 *
 * The comma is a media-query LIST (logical OR), honoured by `window.matchMedia`
 * and `svelte/reactivity`'s `MediaQuery`.
 *
 * KEEP IN SYNC with the short-viewport `@media` rules in `app.css`. Components
 * (`AppDialog`, `MainView`, `MainNav`) each instantiate their own `MediaQuery`
 * from this single string so the nav and the dialog pivot together.
 */
export const DESKTOP_CHROME_QUERY =
	"(min-width: 1024px), (min-width: 768px) and (max-height: 600px)";

/**
 * The wide-desktop breakpoint (Tailwind `lg`, 1024px) on its own.
 *
 * Used for chrome that needs the FULL desktop width, not just desktop chrome:
 * the header toolbar (locale + theme dropdowns). On a short landscape kiosk panel
 * (e.g. 800×480) the header is too narrow to hold the rail nav AND the toolbar
 * without horizontal overflow, so the toolbar is hidden there and those controls
 * surface in the Settings Appearance group instead, exactly as on mobile.
 * `SettingsView` already shows that group below 1024px, so the two agree without
 * extra coordination.
 */
export const WIDE_DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * The Device Health panel's dense band — narrow OR short.
 *
 * It drives three coordinated adaptations that must agree or the panel scrolls
 * on the 1024x600 kiosk touchscreen, which is a hard product requirement it must
 * not do: the recorder's shorter two-lane geometry, the now strip collapsing its
 * secondary lines into ` · ` fragments, and AppDialog's footer being dropped
 * (the panel is a reading instrument with zero actions, so the header's close
 * button — already lifted to the 44px touch target by app.css under
 * `data-layout-mode='touch'` — is the whole affordance).
 *
 * Measured on the real surface at 1024x600: 510px of dialog, 81px header, 77px
 * footer, leaving 352px of body for 451px of content. The footer alone is 77 of
 * the 99px overflow.
 */
export const HEALTH_COMPACT_QUERY = "(max-width: 1024px), (max-height: 700px)";
