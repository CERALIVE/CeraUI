/*
 * Mock SIM lock states (Task 15).
 *
 * Drives the dev-mode modem mock through the three SIM lock states
 * (unlocked / pin-locked / puk-locked) and pins the boot SIM-PIN auto-unlock
 * contract against them — with no hardware and no /run access:
 *
 *   1. PIN-locked + correct stored PIN → EXACTLY ONE submit → unlocked + one
 *      re-discovery; the mmcli mock flips `unlock-required` sim-pin → none.
 *   2. A wrong stored PIN is submitted ONCE, cleared, and never retried — even
 *      with several locked modems it never walks any SIM toward a PUK lockout.
 *   3. A PUK-locked SIM is surfaced for recovery and NEVER auto-submitted (it is
 *      not even enumerated as a PIN-unlock target; a direct attempt is rejected).
 *   4. On a dev/emulated host the boot action no-ops before reading the PIN.
 *
 * The auto-unlock contract is exercised by wiring the mock provider helpers into
 * the real `maybeAutoUnlockSimPins` via SimAutoUnlockDeps, so the once-then-stop
 * logic runs against the mock SIM state machine. The fixture PIN is never a real
 * credential and must never appear in any captured log line.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { logger } from "../helpers/logger.ts";
import {
	initMockService,
	resetMockState,
	setMockSimPinSecret,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockPinLockedModems,
	getMockSimState,
	handleMmcliCommand,
	MOCK_SIM_PIN_FIXTURE,
	mockAttemptSimUnlock,
	mockClearSimPinSecret,
	mockLoadSimPinSecret,
	setMockSimLockState,
} from "../mocks/providers/modems.ts";
import {
	mmcliParseSep,
	parseModemUnlockInfo,
} from "../modules/modems/mmcli.ts";
import {
	maybeAutoUnlockSimPins,
	type SimAutoUnlockDeps,
} from "../modules/modems/sim-autounlock.ts";

const SCENARIO = "multi-modem-wifi";
const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

beforeAll(() => {
	// shouldUseMocks() gates handleMmcliCommand on isDevelopment() — MOCK_MODE
	// flips that on without depending on NODE_ENV.
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

type Calls = {
	unlock: Array<[string, string]>;
	clear: number;
	onUnlocked: number;
	loadPin: number;
};

function makeMockDeps(opts: { isRealDevice?: boolean } = {}): {
	deps: SimAutoUnlockDeps;
	calls: Calls;
} {
	const calls: Calls = { unlock: [], clear: 0, onUnlocked: 0, loadPin: 0 };
	const deps: SimAutoUnlockDeps = {
		isRealDevice: async () => opts.isRealDevice ?? true,
		loadSimPin: async () => {
			calls.loadPin += 1;
			return mockLoadSimPinSecret();
		},
		clearSimPin: async () => {
			calls.clear += 1;
			mockClearSimPinSecret();
		},
		getLockedModems: () => getMockPinLockedModems(),
		unlock: async (modemPath, pin) => {
			calls.unlock.push([modemPath, pin]);
			return mockAttemptSimUnlock(modemPath, pin);
		},
		onUnlocked: async () => {
			calls.onUnlocked += 1;
		},
	};
	return { deps, calls };
}

/** Read the mock's reported lock for a modem straight from its mmcli `-K` output. */
function reportedUnlockRequired(modemId: number): string {
	const out = handleMmcliCommand(["-K", "-m", String(modemId)]);
	return parseModemUnlockInfo(mmcliParseSep(out ?? "")).required;
}

/** Run `fn` while recording every logger line, then restore the logger. */
async function withCapturedLogs(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const sink = logger as unknown as Record<
		string,
		(...args: unknown[]) => unknown
	>;
	const methods = ["info", "warn", "error", "debug"] as const;
	const originals: Record<string, (...args: unknown[]) => unknown> = {};
	for (const m of methods) {
		originals[m] = sink[m] as (...args: unknown[]) => unknown;
		sink[m] = (...args: unknown[]) => {
			lines.push(args.map((a) => String(a)).join(" "));
			// Winston's log methods rely on `this` — preserve the logger receiver.
			return originals[m]?.apply(logger, args);
		};
	}
	try {
		await fn();
	} finally {
		for (const m of methods) {
			const orig = originals[m];
			if (orig) sink[m] = orig;
		}
	}
	return lines;
}

describe("mock mmcli reports SIM lock status", () => {
	it("flips unlock-required across the three lock states", () => {
		expect(reportedUnlockRequired(0)).toBe("none");

		setMockSimLockState(0, "pin-locked");
		expect(reportedUnlockRequired(0)).toBe("sim-pin");

		setMockSimLockState(0, "puk-locked");
		expect(reportedUnlockRequired(0)).toBe("sim-puk");
	});

	it("reports the PIN attempt budget in unlock-retries", () => {
		setMockSimLockState(1, "pin-locked");
		const out = handleMmcliCommand(["-K", "-m", "1"]);
		const info = parseModemUnlockInfo(mmcliParseSep(out ?? ""));
		expect(info.required).toBe("sim-pin");
		expect(info.retries["sim-pin"]).toBe(3);
	});
});

describe("maybeAutoUnlockSimPins — PIN-locked → single unlock → unlocked", () => {
	it("submits the stored fixture PIN exactly once and unlocks", async () => {
		setMockSimLockState(0, "pin-locked");
		setMockSimPinSecret(MOCK_SIM_PIN_FIXTURE);

		expect(reportedUnlockRequired(0)).toBe("sim-pin");

		const { deps, calls } = makeMockDeps({ isRealDevice: true });
		await maybeAutoUnlockSimPins(deps);

		// EXACTLY ONE submit, with the fixture PIN.
		expect(calls.unlock).toEqual([["0", MOCK_SIM_PIN_FIXTURE]]);
		expect(getMockSimState(0)?.lock).toBe("unlocked");
		expect(reportedUnlockRequired(0)).toBe("none");
		// A freshly unlocked SIM triggers one re-discovery; the PIN is not cleared.
		expect(calls.onUnlocked).toBe(1);
		expect(calls.clear).toBe(0);
	});
});

describe("maybeAutoUnlockSimPins — failed attempt stops (no second try)", () => {
	it("submits a wrong PIN once, clears it, and never retries another modem", async () => {
		setMockSimLockState(0, "pin-locked");
		setMockSimLockState(1, "pin-locked");
		setMockSimPinSecret("9999"); // wrong: not the fixture PIN

		const { deps, calls } = makeMockDeps({ isRealDevice: true });
		await maybeAutoUnlockSimPins(deps);

		// One submit total — the shared wrong PIN is not walked across every SIM.
		expect(calls.unlock.length).toBe(1);
		expect(calls.clear).toBe(1);
		expect(calls.onUnlocked).toBe(0);
		// The cleared secret cannot be resubmitted on a later boot.
		expect(mockLoadSimPinSecret()).toBeNull();
		// First modem burned exactly one attempt; the second was never touched.
		expect(getMockSimState(0)?.pinRetries).toBe(2);
		expect(getMockSimState(0)?.lock).toBe("pin-locked");
		expect(getMockSimState(1)?.pinRetries).toBe(3);
		expect(getMockSimState(1)?.lock).toBe("pin-locked");
	});
});

describe("maybeAutoUnlockSimPins — PUK-locked surfaces recovery, never auto-submits", () => {
	it("does not enumerate or submit a PUK-locked SIM", async () => {
		setMockSimLockState(0, "puk-locked");
		setMockSimPinSecret(MOCK_SIM_PIN_FIXTURE);

		// The recovery UI sees the PUK state via the mmcli mock…
		expect(reportedUnlockRequired(0)).toBe("sim-puk");
		// …but the boot hook never treats it as a PIN-unlock target.
		expect(getMockPinLockedModems()).toEqual([]);

		const { deps, calls } = makeMockDeps({ isRealDevice: true });
		await maybeAutoUnlockSimPins(deps);

		expect(calls.unlock.length).toBe(0);
		expect(calls.clear).toBe(0);
		expect(getMockSimState(0)?.lock).toBe("puk-locked");
	});

	it("rejects a direct PIN submit against a PUK-locked SIM without changing state", () => {
		setMockSimLockState(0, "puk-locked");

		const result = mockAttemptSimUnlock("0", MOCK_SIM_PIN_FIXTURE);

		expect(result).toEqual({ state: "puk-required" });
		expect(getMockSimState(0)?.lock).toBe("puk-locked");
	});
});

describe("maybeAutoUnlockSimPins — emulated host no-op", () => {
	it("never reads the PIN or touches the SIM on a dev/emulated host", async () => {
		setMockSimLockState(0, "pin-locked");
		setMockSimPinSecret(MOCK_SIM_PIN_FIXTURE);

		const { deps, calls } = makeMockDeps({ isRealDevice: false });
		await maybeAutoUnlockSimPins(deps);

		// Gate is first — the stored PIN is not even read.
		expect(calls.loadPin).toBe(0);
		expect(calls.unlock.length).toBe(0);
		expect(calls.clear).toBe(0);
		expect(getMockSimState(0)?.lock).toBe("pin-locked");
	});
});

describe("the fixture PIN never reaches a log line + failure-path evidence", () => {
	it("captures the wrong-PIN-stops flow with no PIN in any log", async () => {
		setMockSimLockState(0, "pin-locked");
		setMockSimLockState(1, "pin-locked");
		// Drive the wrong-PIN failure path with a distinctive value we can grep for.
		const WRONG_PIN = "8675309";
		setMockSimPinSecret(WRONG_PIN);

		const beforeLock = reportedUnlockRequired(0);
		const { deps, calls } = makeMockDeps({ isRealDevice: true });
		const logs = await withCapturedLogs(() => maybeAutoUnlockSimPins(deps));
		const afterRetries = getMockSimState(0)?.pinRetries ?? -1;

		const joined = logs.join("\n");
		expect(joined).not.toContain(WRONG_PIN);
		expect(joined).not.toContain(MOCK_SIM_PIN_FIXTURE);

		const evidence = [
			"Task 15 — SIM mock failure-path evidence (wrong-PIN stops, no PIN in logs)",
			"",
			`scenario: ${SCENARIO}`,
			"modems seeded pin-locked: 0, 1",
			`stored PIN (wrong, redacted): ${"*".repeat(WRONG_PIN.length)}`,
			`fixture PIN (redacted): ${"*".repeat(MOCK_SIM_PIN_FIXTURE.length)}`,
			"",
			`modem 0 unlock-required before: ${beforeLock}`,
			`unlock submits (must be 1): ${calls.unlock.length}`,
			`stored PIN cleared (must be 1): ${calls.clear}`,
			`re-discoveries (must be 0): ${calls.onUnlocked}`,
			`modem 0 pinRetries after (3 -> 2): ${afterRetries}`,
			`modem 1 pinRetries (untouched, 3): ${getMockSimState(1)?.pinRetries}`,
			`stored secret after clear (null): ${mockLoadSimPinSecret()}`,
			"",
			"captured logger lines (none contain a PIN):",
			...logs.map((l) => `  | ${l}`),
		].join("\n");
		await Bun.write("test-results/task-15-simfail.txt", `${evidence}\n`);

		expect(calls.unlock.length).toBe(1);
		expect(calls.clear).toBe(1);
		expect(afterRetries).toBe(2);
	});
});
