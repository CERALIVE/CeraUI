/**
 * Pure, rune-free preview-availability derivation for `PreviewCanvas.svelte`.
 *
 * The preview socket is served DIRECTLY by the cerastream engine (ADR-0002
 * preview-ws addendum). Before dialing it forever, the component consults the
 * engine-capability snapshot: a starting/offline engine, or an engine that
 * reports its preview endpoint as unbound/disabled, means there is nothing to
 * dial — the component renders a calm, honest band instead.
 *
 * DEV EXCEPTION: in a mock-backed dev build the preview WS is served by the
 * `startMockPreviewServer()` mock (port 9997) regardless of what the mock
 * capability snapshot advertises for `preview`, so dev must NEVER block the
 * dial on the snapshot — it always dials the mock. `isMockBackedDev` is the
 * frontend equivalent of the backend `shouldUseMocks()` gate (it is
 * `import.meta.env.DEV` / `BUILD_INFO.IS_DEV` at the call site).
 */
import type { CapabilitiesMessage } from "@ceraui/rpc/schemas";

/**
 * Preview availability, derived from the capability snapshot:
 *  • `available`          — dial the preview socket.
 *  • `engineStarting`     — engine still booting; preview appears once ready.
 *  • `engineOffline`      — engine unreachable; preview unavailable until back.
 *  • `previewUnavailable` — engine up, but its preview endpoint is
 *                           unbound/disabled on this device.
 */
export type PreviewAvailability =
	| "available"
	| "engineStarting"
	| "engineOffline"
	| "previewUnavailable";

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
	isMockBackedDev: boolean,
): PreviewAvailability {
	// Dev is always backed by the mock preview WS server (port 9997) — the mock
	// capability snapshot's `preview` field must never suppress the dev dial.
	if (isMockBackedDev) return "available";
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
