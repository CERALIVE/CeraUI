// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
	buildTierList,
	canFallback,
	createTierLadder,
	currentTier,
	DEFAULT_WEBRTC_NO_FRAME_DEADLINE_MS,
	DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS,
	descend,
	evaluateWebrtcDeadline,
	isAtFloor,
	type PreviewDeliveryTier,
} from "./preview-tier-ladder";

describe("buildTierList", () => {
	it("orders WebRTC first, then WebCodecs, then MSE (the ladder order)", () => {
		expect(buildTierList({ webrtc: true, webcodecs: true, mse: true })).toEqual<
			PreviewDeliveryTier[]
		>(["webrtc", "webcodecs", "mse"]);
	});

	it("drops unavailable tiers but preserves order", () => {
		expect(
			buildTierList({ webrtc: true, webcodecs: false, mse: true }),
		).toEqual(["webrtc", "mse"]);
		expect(
			buildTierList({ webrtc: false, webcodecs: false, mse: true }),
		).toEqual(["mse"]);
		expect(
			buildTierList({ webrtc: false, webcodecs: false, mse: false }),
		).toEqual([]);
	});

	it("puts WebRTC on top of the pre-WebRTC compat tier (no-webcodecs browser)", () => {
		// A browser with RTCPeerConnection + MSE but no WebCodecs: ladder is the
		// canonical WebRTC → MSE two-rung ladder from the task.
		expect(
			buildTierList({ webrtc: true, webcodecs: false, mse: true }),
		).toEqual(["webrtc", "mse"]);
	});
});

describe("tier ladder FSM", () => {
	it("starts on the primary tier (index 0)", () => {
		const ladder = createTierLadder(["webrtc", "mse"]);
		expect(currentTier(ladder)).toBe("webrtc");
		expect(isAtFloor(ladder)).toBe(false);
		expect(canFallback(ladder)).toBe(true);
	});

	it("descends WebRTC → MSE on a fallback trigger", () => {
		const ladder = createTierLadder(["webrtc", "mse"]);
		const next = descend(ladder, "signaling-timeout");
		expect(next.fellBack).toBe(true);
		expect(next.tier).toBe("mse");
		expect(next.trigger).toBe("signaling-timeout");
		expect(currentTier(next.state)).toBe("mse");
		expect(isAtFloor(next.state)).toBe(true);
		expect(canFallback(next.state)).toBe(false);
	});

	it("descends through WebCodecs when it sits between WebRTC and MSE", () => {
		const ladder = createTierLadder(["webrtc", "webcodecs", "mse"]);
		const first = descend(ladder, "ice-failure");
		expect(first.tier).toBe("webcodecs");
		const second = descend(first.state, "no-frame-deadline");
		expect(second.tier).toBe("mse");
		expect(isAtFloor(second.state)).toBe(true);
	});

	it("is a no-op at the floor — MSE never falls back further", () => {
		const ladder = createTierLadder(["webrtc", "mse"]);
		const atFloor = descend(ladder, "ice-failure").state;
		const again = descend(atFloor, "no-frame-deadline");
		expect(again.fellBack).toBe(false);
		expect(again.tier).toBe("mse");
		expect(again.trigger).toBe(null);
		expect(currentTier(again.state)).toBe("mse");
	});

	it("does not mutate the input state (immutable transition)", () => {
		const ladder = createTierLadder(["webrtc", "mse"]);
		descend(ladder, "webrtc-failed");
		expect(ladder.index).toBe(0);
		expect(currentTier(ladder)).toBe("webrtc");
	});

	it("treats an empty ladder as terminally at-floor with no current tier", () => {
		const ladder = createTierLadder([]);
		expect(currentTier(ladder)).toBeUndefined();
		expect(isAtFloor(ladder)).toBe(true);
		expect(canFallback(ladder)).toBe(false);
	});
});

describe("evaluateWebrtcDeadline", () => {
	it("returns no trigger while the WebRTC session is playing", () => {
		expect(
			evaluateWebrtcDeadline({ phase: "playing", elapsedMs: 999_999 }),
		).toBeNull();
	});

	it("triggers signaling-timeout when ICE never connects within the budget", () => {
		expect(
			evaluateWebrtcDeadline({
				phase: "offer-wait",
				elapsedMs: DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS,
			}),
		).toBe("signaling-timeout");
		// The answered-but-not-connected phase is still a signaling stall.
		expect(
			evaluateWebrtcDeadline({
				phase: "answered",
				elapsedMs: DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS + 1,
			}),
		).toBe("signaling-timeout");
	});

	it("does not fire before the signaling budget elapses", () => {
		expect(
			evaluateWebrtcDeadline({
				phase: "offer-wait",
				elapsedMs: DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS - 1,
			}),
		).toBeNull();
	});

	it("triggers no-frame-deadline when ICE connected but no frame renders", () => {
		expect(
			evaluateWebrtcDeadline({
				phase: "connected",
				elapsedMs: DEFAULT_WEBRTC_NO_FRAME_DEADLINE_MS,
			}),
		).toBe("no-frame-deadline");
		// Connected but still inside the frame budget → wait.
		expect(
			evaluateWebrtcDeadline({
				phase: "connected",
				elapsedMs: DEFAULT_WEBRTC_NO_FRAME_DEADLINE_MS - 1,
			}),
		).toBeNull();
	});

	it("maps a failed phase straight to ice-failure regardless of elapsed", () => {
		expect(evaluateWebrtcDeadline({ phase: "failed", elapsedMs: 0 })).toBe(
			"ice-failure",
		);
	});

	it("honors caller-supplied deadline overrides", () => {
		expect(
			evaluateWebrtcDeadline({
				phase: "offer-wait",
				elapsedMs: 200,
				signalingTimeoutMs: 100,
			}),
		).toBe("signaling-timeout");
		expect(
			evaluateWebrtcDeadline({
				phase: "connected",
				elapsedMs: 200,
				noFrameDeadlineMs: 300,
			}),
		).toBeNull();
	});
});
