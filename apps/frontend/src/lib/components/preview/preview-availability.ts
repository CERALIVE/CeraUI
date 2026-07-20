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
 *  • `backpressure`       — the backend preview proxy tore the socket down because
 *                           the browser could not drain frames fast enough (close
 *                           4502 with reason `backpressure_overflow`). Distinct
 *                           from `engineOffline`: the engine is fine; the local
 *                           link/CPU could not keep up.
 *  • `noSourceApplied`    — the engine's typed failure frame `no-source-applied`:
 *                           no capture source is selected for the idle preview.
 *  • `sourceUnavailable`  — the engine's typed failure frame `source-unavailable`:
 *                           the applied source id is unknown or the device is gone.
 *  • `deviceBusy`         — the engine's typed failure frame `device-busy`: the
 *                           capture device is held by another consumer.
 *  • `pipelineFailed`     — the engine's typed failure frame `pipeline-failed`:
 *                           the idle-preview pipeline could not reach PLAYING.
 *  • `pausedHidden`       — NOT an error. The client OWNS a 30s viewer-liveness
 *                           timer: once the preview has gone unwatched
 *                           (tab hidden, canvas scrolled off, or the host
 *                           `<details>` collapsed) for the full window, the client
 *                           cleanly closes the socket so the single-owner engine
 *                           tears the idle leg down. Carries a "resume" affordance;
 *                           re-viewing redials automatically.
 */
export type PreviewAvailability =
	| "available"
	| "engineStarting"
	| "engineOffline"
	| "previewUnavailable"
	| "tokenRejected"
	| "mintFailed"
	| "interrupted"
	| "noVideo"
	| "backpressure"
	| "noSourceApplied"
	| "sourceUnavailable"
	| "deviceBusy"
	| "pipelineFailed"
	| "pausedHidden";

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

/**
 * The wire close-reason the backend preview proxy sends on a downstream
 * backpressure teardown (`preview-proxy.ts`: `closeDown(..., "backpressure_overflow")`).
 * The proxy reuses close code 4502 for this, so `PreviewCanvas` disambiguates on
 * the reason string to render the distinct `backpressure` band instead of
 * `engineOffline`.
 */
export const PREVIEW_CLOSE_REASON_BACKPRESSURE = "backpressure_overflow";

/**
 * The engine's typed idle-preview failure reasons (cerastream Todo 10), carried on
 * the preview WS text channel. WIRE CONTRACT (pinned here because CeraUI Todo 11 and
 * cerastream Todo 10 ship in parallel): a failure frame is JSON text carrying one of
 * these reasons, accepted in EITHER tolerant shape so CeraUI consumes whichever
 * cerastream lands — `{ type:"error", reason:"<reason>" }` or `{ type:"<reason>" }`.
 */
export const PREVIEW_ENGINE_FAILURE_REASONS = [
	"no-source-applied",
	"source-unavailable",
	"device-busy",
	"pipeline-failed",
] as const;

export type PreviewEngineFailureReason =
	(typeof PREVIEW_ENGINE_FAILURE_REASONS)[number];

const ENGINE_FAILURE_BAND: Record<
	PreviewEngineFailureReason,
	Extract<
		PreviewAvailability,
		"noSourceApplied" | "sourceUnavailable" | "deviceBusy" | "pipelineFailed"
	>
> = {
	"no-source-applied": "noSourceApplied",
	"source-unavailable": "sourceUnavailable",
	"device-busy": "deviceBusy",
	"pipeline-failed": "pipelineFailed",
};

/**
 * Map an engine typed-failure `reason` string to its {@link PreviewAvailability}
 * band, or `null` when the reason is not a recognised engine failure. Pure so the
 * band mapping is unit-testable without the component.
 */
export function engineFailureBand(
	reason: string | undefined | null,
): PreviewAvailability | null {
	if (reason == null) return null;
	return (
		(ENGINE_FAILURE_BAND as Record<string, PreviewAvailability>)[reason] ?? null
	);
}

/**
 * Bands that represent a TERMINAL preview state: the socket is (or should be)
 * closed and there is nothing left to dial until the operator re-toggles or
 * resumes. `PreviewCanvas` never schedules a reconnect out of these. `pausedHidden`
 * is terminal-until-resume; `noVideo` is terminal-until-retoggle. The connecting
 * bound-exit invariant (every non-live path leaves `connecting` within ≤10s) is
 * proven against this set.
 */
export const TERMINAL_PREVIEW_BANDS: ReadonlySet<PreviewAvailability> =
	new Set<PreviewAvailability>([
		"engineOffline",
		"previewUnavailable",
		"tokenRejected",
		"mintFailed",
		"interrupted",
		"noVideo",
		"backpressure",
		"noSourceApplied",
		"sourceUnavailable",
		"deviceBusy",
		"pipelineFailed",
		"pausedHidden",
	]);
