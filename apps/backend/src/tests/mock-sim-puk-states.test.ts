/*
 * Mock SIM PUK recovery states (T13 — ceraui-os-interaction-ux).
 *
 * Drives the dev-mode SIM PUK mock knob (`mockAttemptSimPukUnlock`) through every
 * terminal the SIM PUK recovery UI must distinguish — with no PUK-locked hardware:
 *
 *   1. A SIM that is NOT puk-locked rejects a PUK submit as `no-locked-modem`.
 *   2. The correct fixture PUK clears the lock to `unlocked` (success).
 *   3. A wrong PUK burns exactly one PUK attempt (`wrong-puk` + decremented count).
 *   4. Exhausting the PUK budget bricks the SIM permanently (`locked`, attempts 0).
 *
 * The single-attempt + decrement contract mirrors the PIN mock + the real
 * `unlockSimPuk`. Neither fixture is a real credential and must never reach a log.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { MOCK_SIM_PUK_RETRIES } from "../mocks/mock-constants.ts";
import {
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockSimState,
	MOCK_SIM_PUK_FIXTURE,
	mockAttemptSimPukUnlock,
	setMockSimLockState,
} from "../mocks/providers/modems.ts";

const SCENARIO = "multi-modem-wifi";
const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

beforeAll(() => {
	process.env.MOCK_MODE = "true";
	initMockService(SCENARIO);
});

afterEach(() => resetMockState());

afterAll(() => {
	stopMockService();
	if (ORIGINAL_MOCK_MODE === undefined) {
		delete process.env.MOCK_MODE;
	} else {
		process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	}
});

describe("mockAttemptSimPukUnlock — terminal classification", () => {
	it("rejects a PUK submit against a SIM that is not PUK-locked", () => {
		expect(getMockSimState(0)?.lock).toBe("unlocked");
		expect(mockAttemptSimPukUnlock("0", MOCK_SIM_PUK_FIXTURE)).toEqual({
			success: false,
			error: "no-locked-modem",
		});

		setMockSimLockState(0, "pin-locked");
		expect(mockAttemptSimPukUnlock("0", MOCK_SIM_PUK_FIXTURE)).toEqual({
			success: false,
			error: "no-locked-modem",
		});
	});

	it("unlocks a PUK-locked SIM with the correct fixture PUK", () => {
		setMockSimLockState(0, "puk-locked");

		expect(mockAttemptSimPukUnlock("0", MOCK_SIM_PUK_FIXTURE)).toEqual({
			success: true,
		});
		expect(getMockSimState(0)?.lock).toBe("unlocked");
	});

	it("burns exactly one PUK attempt on a wrong PUK", () => {
		setMockSimLockState(0, "puk-locked");
		expect(getMockSimState(0)?.pukRetries).toBe(MOCK_SIM_PUK_RETRIES);

		const result = mockAttemptSimPukUnlock("0", "00000000");

		expect(result).toEqual({
			success: false,
			error: "wrong-puk",
			remainingAttempts: MOCK_SIM_PUK_RETRIES - 1,
		});
		expect(getMockSimState(0)?.lock).toBe("puk-locked");
		expect(getMockSimState(0)?.pukRetries).toBe(MOCK_SIM_PUK_RETRIES - 1);
	});

	it("bricks the SIM once the PUK budget is exhausted", () => {
		setMockSimLockState(1, "puk-locked");
		let result = mockAttemptSimPukUnlock("1", "00000000");
		for (let i = 1; i < MOCK_SIM_PUK_RETRIES; i++) {
			result = mockAttemptSimPukUnlock("1", "00000000");
		}

		expect(result).toEqual({
			success: false,
			error: "locked",
			remainingAttempts: 0,
		});
		expect(getMockSimState(1)?.pukRetries).toBe(0);
		expect(getMockSimState(1)?.lock).toBe("puk-locked");
	});
});
