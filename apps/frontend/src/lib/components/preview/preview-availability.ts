/**
 * Pure, rune-free preview-availability derivation for `PreviewCanvas.svelte`.
 *
 * The preview socket is PROXIED through the CeraUI backend origin (`/preview`,
 * Task 20): the frontend dials ONLY the backend — never the cerastream engine
 * directly — and the backend forwards frames from the engine's loopback preview
 * socket. Dev and prod therefore dial the identical URL/token flow (dev's backend
 * proxies to the mock preview server under `shouldUseMocks()`), so there is no
 * mock-dev dial-target exception here.
 *
 * This is the PRE-dial gate: it consults the engine-capability snapshot so a
 * starting/offline engine, or one that reports its preview endpoint as
 * unbound/disabled, renders a calm band instead of dialing. The POST-dial states
 * come from the proxy close codes (`PreviewCanvas` maps 4502/4503/4401 onto the
 * same {@link PreviewAvailability} band set).
 */
import type { CapabilitiesMessage } from "@ceraui/rpc/schemas";

/**
 * Preview availability, derived from the capability snapshot:
 *  • `available`          — dial the preview socket.
 *  • `engineStarting`     — engine still booting; preview appears once ready.
 *  • `engineOffline`      — engine unreachable; preview unavailable until back.
 *  • `previewUnavailable` — engine up, but its preview endpoint is
 *                           unbound/disabled on this device.
 *  • `noVideo`            — the preview socket opened and `start` was sent, but
 *                           the engine delivered no media before the watchdog
 *                           deadline. The engine's preview leg taps the *active
 *                           program pipeline* (ADR-0002 preview-ws addendum), so
 *                           it emits nothing while the device is idle — the
 *                           socket simply stays open and silent. This band is
 *                           set POST-dial by `PreviewCanvas`'s media watchdog
 *                           (never derived from the snapshot), so an idle preview
 *                           surfaces a calm reason instead of an endless
 *                           "Connecting…".
 */
export type PreviewAvailability =
	| "available"
	| "engineStarting"
	| "engineOffline"
	| "previewUnavailable"
	| "noVideo";

/**
 * Resolve preview availability from the live capability snapshot.
 *
 * `engineStarting` wins over `engineOffline` (a booting engine is the more
 * specific, more actionable state), which wins over the preview-endpoint
 * checks. An absent snapshot (`undefined`, not yet arrived) and an absent
 * `preview` field (legacy engine) both resolve to `available` — the component
 * attempts the dial rather than pre-emptively blocking on missing data.
 */
export function derivePreviewAvailability(
	caps: CapabilitiesMessage | undefined,
): PreviewAvailability {
	if (!caps) return "available";
	if (caps.engineStarting) return "engineStarting";
	if (caps.engineUnavailable) return "engineOffline";
	if (
		caps.preview &&
		(caps.preview.bound === false || caps.preview.enabled === false)
	) {
		return "previewUnavailable";
	}
	return "available";
}

/** Visible reconnect-attempt counter is capped so it never grows unbounded. */
export const RECONNECT_ATTEMPT_DISPLAY_CAP = 5;

/**
 * Format the reconnect attempt for display, capped at
 * `RECONNECT_ATTEMPT_DISPLAY_CAP` so an engine that never comes back does not
 * scroll an ever-growing number. Returns an empty string before the first
 * reconnect (attempt 0), and `"5+"` once the cap is reached.
 */
export function cappedAttemptText(
	attempt: number,
	cap: number = RECONNECT_ATTEMPT_DISPLAY_CAP,
): string {
	if (attempt <= 0) return "";
	return attempt >= cap ? `${cap}+` : String(attempt);
}
