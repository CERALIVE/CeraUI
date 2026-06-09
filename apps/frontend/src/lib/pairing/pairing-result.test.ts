/**
 * Pure pairing result/expiry reducers (device-pairing dialog, Task 20).
 *
 * These rune-free reducers are the testable core of the pairing dialog:
 *   - `reducePairingResult` maps a `completePairing` RPC response onto a
 *     discriminated outcome (paired vs. rejected) the UI can render directly.
 *   - `subscriptionTone` maps a subscription standing onto a semantic tone so
 *     the post-pairing badge styling stays out of the markup.
 *   - `shouldAutoRegenerate` is the regenerate-on-expiry decision: true only
 *     when a live (displayed, active) code's validity window has elapsed.
 *
 * Driving the dialog through these means the countdown/expiry/result logic is
 * proven here without a DOM or a runes runtime.
 */
import { describe, expect, it } from "vitest";

import {
	reducePairingResult,
	shouldAutoRegenerate,
	subscriptionTone,
} from "./pairing-result";

describe("reducePairingResult", () => {
	it("maps a successful claim onto a paired outcome with identity + standing", () => {
		const outcome = reducePairingResult({
			paired: true,
			device_id: "CERA-DEV-1",
			sub_status: "ACTIVE",
			validUntil: 200_000,
		});

		expect(outcome).toEqual({
			kind: "paired",
			deviceId: "CERA-DEV-1",
			subStatus: "ACTIVE",
			validUntil: 200_000,
		});
	});

	it("normalises absent optional fields to null on a paired outcome", () => {
		const outcome = reducePairingResult({ paired: true });

		expect(outcome).toEqual({
			kind: "paired",
			deviceId: null,
			subStatus: null,
			validUntil: null,
		});
	});

	it("maps a rejected claim onto an error outcome carrying the machine code", () => {
		const outcome = reducePairingResult({
			paired: false,
			error: "invalid-claim-code",
		});

		expect(outcome).toEqual({ kind: "rejected", error: "invalid-claim-code" });
	});

	it("falls back to a stable error code when the rejection omits one", () => {
		const outcome = reducePairingResult({ paired: false });

		expect(outcome).toEqual({ kind: "rejected", error: "pair-failed" });
	});
});

describe("subscriptionTone", () => {
	it("maps each subscription standing onto a semantic tone", () => {
		expect(subscriptionTone("ACTIVE")).toBe("positive");
		expect(subscriptionTone("FREE")).toBe("neutral");
		expect(subscriptionTone("EXPIRED")).toBe("warning");
		expect(subscriptionTone("CANCELLED")).toBe("critical");
	});
});

describe("shouldAutoRegenerate", () => {
	it("regenerates only when a live (active) code has expired", () => {
		expect(shouldAutoRegenerate("active", true)).toBe(true);
	});

	it("does not regenerate while the active code is still valid", () => {
		expect(shouldAutoRegenerate("active", false)).toBe(false);
	});

	it("never regenerates from a non-active state, even when expired", () => {
		expect(shouldAutoRegenerate("idle", true)).toBe(false);
		expect(shouldAutoRegenerate("generating", true)).toBe(false);
		expect(shouldAutoRegenerate("pairing", true)).toBe(false);
		expect(shouldAutoRegenerate("paired", true)).toBe(false);
		expect(shouldAutoRegenerate("error", true)).toBe(false);
	});
});
