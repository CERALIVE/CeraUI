// @vitest-environment jsdom
/**
 * Device-pairing controller + countdown helpers (Task 25).
 *
 * Covers the device-side claim-code flow at the unit level: code generation,
 * the validity-window countdown derivation, mock-platform completion (paired and
 * rejected), and error surfacing. The live remote-channel reconnect is exercised
 * by the backend integration test and the e2e spec, not here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";

import {
	claimCodeRemainingMs,
	formatClaimCodeRemaining,
	isClaimCodeExpired,
} from "./claim-code-format";
import { PairingController } from "./pairing.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { pairing: { generateClaimCode: vi.fn(), completePairing: vi.fn() } },
}));

const generateClaimCode = vi.mocked(rpc.pairing.generateClaimCode);
const completePairing = vi.mocked(rpc.pairing.completePairing);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("claim-code countdown helpers", () => {
	it("clamps remaining time at zero and detects expiry", () => {
		expect(claimCodeRemainingMs(1_000, 600)).toBe(400);
		expect(claimCodeRemainingMs(1_000, 1_500)).toBe(0);
		expect(isClaimCodeExpired(1_000, 999)).toBe(false);
		expect(isClaimCodeExpired(1_000, 1_000)).toBe(true);
	});

	it("formats remaining ms as m:ss", () => {
		expect(formatClaimCodeRemaining(125_000)).toBe("2:05");
		expect(formatClaimCodeRemaining(5_000)).toBe("0:05");
		expect(formatClaimCodeRemaining(0)).toBe("0:00");
		expect(formatClaimCodeRemaining(-5_000)).toBe("0:00");
	});
});

describe("PairingController.generate", () => {
	it("stores the issued code, window, and flips to active", async () => {
		generateClaimCode.mockResolvedValue({
			code: "ABCD2345",
			validUntil: 10_000,
			windowSeconds: 300,
		});
		const pairing = new PairingController();

		await pairing.generate();

		expect(pairing.code).toBe("ABCD2345");
		expect(pairing.validUntil).toBe(10_000);
		expect(pairing.windowSeconds).toBe(300);
		expect(pairing.status).toBe("active");
	});

	it("surfaces a generation failure as error state", async () => {
		generateClaimCode.mockRejectedValue(new Error("boom"));
		const pairing = new PairingController();

		await expect(pairing.generate()).rejects.toThrow("boom");
		expect(pairing.status).toBe("error");
		expect(pairing.error).toBe("boom");
	});
});

describe("PairingController countdown derivation", () => {
	it("derives remaining label and expiry from validUntil and now", async () => {
		generateClaimCode.mockResolvedValue({
			code: "ABCD2345",
			validUntil: 100_000,
			windowSeconds: 300,
		});
		const pairing = new PairingController();
		await pairing.generate();

		pairing.now = 40_000;
		expect(pairing.remainingMs).toBe(60_000);
		expect(pairing.remainingLabel).toBe("1:00");
		expect(pairing.expired).toBe(false);

		pairing.now = 100_001;
		expect(pairing.remainingMs).toBe(0);
		expect(pairing.expired).toBe(true);
	});
});

describe("PairingController.complete", () => {
	it("marks paired and records device identity on success", async () => {
		generateClaimCode.mockResolvedValue({
			code: "ABCD2345",
			validUntil: 100_000,
			windowSeconds: 300,
		});
		completePairing.mockResolvedValue({
			paired: true,
			device_id: "CERA-DEV-1",
			sub_status: "ACTIVE",
			validUntil: 200_000,
		});
		const pairing = new PairingController();
		await pairing.generate();

		const result = await pairing.complete();

		expect(result?.paired).toBe(true);
		expect(pairing.status).toBe("paired");
		expect(pairing.deviceId).toBe("CERA-DEV-1");
		expect(pairing.subStatus).toBe("ACTIVE");
	});

	it("surfaces a rejected claim as error state", async () => {
		generateClaimCode.mockResolvedValue({
			code: "ABCD2345",
			validUntil: 100_000,
			windowSeconds: 300,
		});
		completePairing.mockResolvedValue({
			paired: false,
			error: "invalid-claim-code",
		});
		const pairing = new PairingController();
		await pairing.generate();

		await pairing.complete();

		expect(pairing.status).toBe("error");
		expect(pairing.error).toBe("invalid-claim-code");
	});

	it("is a no-op before a code has been generated", async () => {
		const pairing = new PairingController();
		const result = await pairing.complete();
		expect(result).toBeUndefined();
		expect(completePairing).not.toHaveBeenCalled();
	});
});

describe("PairingController.reset", () => {
	it("clears all pairing state back to idle", async () => {
		generateClaimCode.mockResolvedValue({
			code: "ABCD2345",
			validUntil: 100_000,
			windowSeconds: 300,
		});
		const pairing = new PairingController();
		await pairing.generate();

		pairing.reset();

		expect(pairing.code).toBeNull();
		expect(pairing.status).toBe("idle");
		expect(pairing.validUntil).toBe(0);
	});
});
