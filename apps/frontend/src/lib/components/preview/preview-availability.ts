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
 * Preview availability — a single band set the surface renders one calm message
 * for. Some bands are PRE-dial (derived from the capability snapshot by
 * {@link derivePreviewAvailability}); the rest are POST-dial, set by
 * `PreviewCanvas` from the proxy close code, the mint outcome, or the media
 * watchdog. Every real failure mode maps to a DISTINCT band, so preview never
 * hangs on a silent "Connecting…".
 *
 *  • `available`          — dial the preview socket (PRE-dial).
 *  • `engineStarting`     — engine still booting; preview appears once ready
 *                           (PRE-dial).
 *  • `engineOffline`      — the proxy could not reach the engine's preview
 *                           endpoint (close 4502 UPSTREAM_DOWN), or the snapshot
 *                           reports the engine unreachable.
 *  • `previewUnavailable` — engine up, but its preview endpoint is
 *                           unbound/disabled on this device (snapshot, or close
 *                           4503 UPSTREAM_UNAVAILABLE).
 *  • `tokenRejected`      — the single-use preview token was rejected (close 4401
 *                           UNAUTHORIZED) even after one silent re-mint: the
 *                           token expired, was already consumed, or the proxy
 *                           denied it. Distinct from `engineOffline` — the engine
 *                           is reachable; the authorization failed.
 *  • `mintFailed`         — minting a preview token failed outright (the RPC
 *                           threw): the control session is unauthenticated or the
 *                           backend is unreachable. Nothing was dialed.
 *  • `interrupted`        — preview WAS live (or awaiting the first frame) and the
 *                           stream then dropped and could not be re-established
 *                           within the reconnect budget: the engine crashed, or
 *                           the network dropped mid-preview. Distinct from the
 *                           first-connect failures above.
 *  • `noVideo`            — the preview socket opened and `start` was sent, but
 *                           the engine delivered no media before the watchdog
 *                           deadline. With on-demand idle preview the engine
 *                           produces frames while idle, so this now means a real
 *                           gap — no capture source, or a source that is not
 *                           delivering — rather than "idle by design". Set
 *                           POST-dial by the media watchdog, never derived.
 */
export type PreviewAvailability =
	| "available"
	| "engineStarting"
	| "engineOffline"
	| "previewUnavailable"
	| "tokenRejected"
	| "mintFailed"
	| "interrupted"
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
