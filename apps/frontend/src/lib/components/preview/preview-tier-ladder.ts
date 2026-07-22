/**
 * Pure, rune-free preview delivery-tier LADDER for `PreviewCanvas.svelte`.
 *
 * The preview has an ordered set of delivery tiers. WebRTC (ADR-0006) is the
 * low-latency PRIMARY tier; MSE is the guaranteed FLOOR that every browser can
 * play. The ladder descends one rung on a fallback trigger and never climbs back
 * within a session — the operator re-toggles to retry from the top.
 *
 *   WebRTC ──(signaling-timeout │ ice-failure │ no-frame-deadline │
 *             webrtc-failed │ rejected-limit)──▶ [WebCodecs] ──▶ MSE (floor)
 *
 * WebCodecs (the pre-WebRTC compat decoder) is kept as an intermediate rung when
 * the browser supports it, so a WebRTC failure on a WebCodecs-capable browser
 * still lands on the lower-latency canvas path before the MSE floor. On a browser
 * without WebCodecs the ladder is the canonical two-rung WebRTC → MSE.
 *
 * Everything here is pure so the ladder FSM and the WebRTC establishment-deadline
 * reasoning are unit-testable in isolation from the Svelte component
 * (`preview-tier-ladder.test.ts`), following the `preview-live-edge.ts` pattern.
 */

/** A concrete delivery tier the preview can run on. */
export type PreviewDeliveryTier = "webrtc" | "webcodecs" | "mse";

/**
 * Why the ladder fell back off the WebRTC rung. The first three are the task's
 * mandated automatic-fallback triggers; `webrtc-failed` is the engine's typed
 * mid-session failure frame (`ice_failed`/`ice_timeout`), and `rejected-limit`
 * is the session-cap rejection (ADR-0006 §4).
 */
export type LadderFallbackTrigger =
	| "signaling-timeout"
	| "ice-failure"
	| "no-frame-deadline"
	| "webrtc-failed"
	| "rejected-limit";

/**
 * Budget from sending the WebRTC `start` frame to ICE reaching `connected`.
 * Exceeding it with no connection is a `signaling-timeout` fallback.
 */
export const DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS = 5000;

/**
 * Budget from sending the WebRTC `start` frame to the FIRST rendered video frame.
 * Reaching it while ICE is connected but no frame has painted is a
 * `no-frame-deadline` fallback. Also the overall WebRTC establishment deadline —
 * the ladder is guaranteed to have descended off WebRTC by this point, so the QA
 * "lands on MSE within its deadline" gate is bounded by it.
 */
export const DEFAULT_WEBRTC_NO_FRAME_DEADLINE_MS = 6000;

/** Which decoders/transports the running browser advertises. */
export interface TierAvailability {
	webrtc: boolean;
	webcodecs: boolean;
	mse: boolean;
}

/**
 * Build the ordered tier list from the browser's advertised capabilities.
 * Order is fixed (WebRTC → WebCodecs → MSE); unavailable tiers are omitted.
 * An all-false input yields `[]` (nothing to play → the component surfaces the
 * `unsupported` state).
 */
export function buildTierList(a: TierAvailability): PreviewDeliveryTier[] {
	const tiers: PreviewDeliveryTier[] = [];
	if (a.webrtc) tiers.push("webrtc");
	if (a.webcodecs) tiers.push("webcodecs");
	if (a.mse) tiers.push("mse");
	return tiers;
}

/** Immutable ladder position: the ordered tiers + the current rung index. */
export interface TierLadderState {
	readonly tiers: readonly PreviewDeliveryTier[];
	readonly index: number;
}

/** Start a ladder on its primary (index 0) tier. */
export function createTierLadder(
	tiers: readonly PreviewDeliveryTier[],
): TierLadderState {
	return { tiers, index: 0 };
}

/** The tier currently selected, or `undefined` for an empty ladder. */
export function currentTier(
	state: TierLadderState,
): PreviewDeliveryTier | undefined {
	return state.tiers[state.index];
}

/** True when there is no lower rung to fall back to (MSE floor, or empty). */
export function isAtFloor(state: TierLadderState): boolean {
	return state.tiers.length === 0 || state.index >= state.tiers.length - 1;
}

/** True when a fallback would land on a real lower rung. */
export function canFallback(state: TierLadderState): boolean {
	return state.index < state.tiers.length - 1;
}

/** The outcome of a {@link descend} attempt. */
export interface LadderDescent {
	/** The next ladder state (unchanged when already at the floor). */
	state: TierLadderState;
	/** The tier now selected. */
	tier: PreviewDeliveryTier | undefined;
	/** Whether the ladder actually moved down a rung. */
	fellBack: boolean;
	/** The trigger that caused the descent, or `null` when it was a floor no-op. */
	trigger: LadderFallbackTrigger | null;
}

/**
 * Descend one rung on a fallback trigger. At the floor this is a no-op (the
 * returned `state` is the same, `fellBack` is `false`) — MSE never degrades
 * further, it is the guaranteed floor. Pure: the input state is never mutated.
 */
export function descend(
	state: TierLadderState,
	trigger: LadderFallbackTrigger,
): LadderDescent {
	if (!canFallback(state)) {
		return { state, tier: currentTier(state), fellBack: false, trigger: null };
	}
	const next: TierLadderState = { tiers: state.tiers, index: state.index + 1 };
	return { state: next, tier: currentTier(next), fellBack: true, trigger };
}

/** WebRTC establishment phases, in order. */
export type WebrtcPhase =
	| "offer-wait"
	| "answered"
	| "connected"
	| "playing"
	| "failed";

/** Inputs to {@link evaluateWebrtcDeadline}. */
export interface WebrtcDeadlineInput {
	phase: WebrtcPhase;
	/** Milliseconds since the WebRTC `start` frame was sent. */
	elapsedMs: number;
	signalingTimeoutMs?: number;
	noFrameDeadlineMs?: number;
}

/**
 * Decide, from the current WebRTC phase and elapsed time, whether the ladder must
 * fall back — and with which trigger. Returns `null` while the session is still
 * within budget (or already playing).
 *
 * - `playing`   → `null` (media is flowing; no fallback).
 * - `failed`    → `ice-failure` (terminal ICE state, regardless of elapsed).
 * - `connected` → `no-frame-deadline` once `elapsedMs >= noFrameDeadlineMs`
 *                 (ICE up but no video painted), else `null`.
 * - otherwise (`offer-wait` / `answered`, i.e. not yet ICE-connected) →
 *   `signaling-timeout` once `elapsedMs >= signalingTimeoutMs`, else `null`.
 */
export function evaluateWebrtcDeadline({
	phase,
	elapsedMs,
	signalingTimeoutMs = DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS,
	noFrameDeadlineMs = DEFAULT_WEBRTC_NO_FRAME_DEADLINE_MS,
}: WebrtcDeadlineInput): LadderFallbackTrigger | null {
	if (phase === "playing") return null;
	if (phase === "failed") return "ice-failure";
	if (phase === "connected") {
		return elapsedMs >= noFrameDeadlineMs ? "no-frame-deadline" : null;
	}
	return elapsedMs >= signalingTimeoutMs ? "signaling-timeout" : null;
}
