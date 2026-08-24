/*
 * Task 4: modem-pin-locked scenario + working SIM unlock flow in dev.
 *
 * Proves the `unlockSim` / `unlockSimPuk` RPC procedures route through the mock
 * SIM state machine under `shouldMockModems()` (instead of the old
 * `no-locked-modem` short-circuit), so the full unlock/PUK flow works
 * end-to-end on an emulated host with no hardware and no `/run` writes:
 *
 *   - the `modem-pin-locked` scenario seeds modem 0 SIM-PIN locked, reported by
 *     the mmcli mock as `unlock-required: sim-pin` (the source of the broadcast
 *     `sim_lock.required` field — the rendered-DOM shape is covered by the e2e
 *     fixture self-test `backend-scenario-fixture.spec.ts`);
 *   - `unlockSim` with a wrong PIN burns exactly one attempt
 *     ({state:"wrong-pin", remainingAttempts:2}), a third wrong PIN trips the SIM
 *     to PUK-locked ({state:"puk-required"});
 *   - the fixture PIN "0000" unlocks ({state:"success"}), and the fixture PUK
 *     "12345678" recovers a PUK-locked SIM;
 *   - `remember:true` NEVER reaches `storeSimPin`/`clearSimPin` under mocks (no
 *     `/run/ceralive` writes on a dev host).
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

import { call } from "@orpc/server";

import { mockSimStateSchema } from "../mocks/mock-schemas.ts";
import {
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockSimState,
	handleMmcliCommand,
	MOCK_SIM_PIN_FIXTURE,
	MOCK_SIM_PIN2_FIXTURE,
	MOCK_SIM_PUK_FIXTURE,
	setMockSimLockState,
} from "../mocks/providers/modems.ts";
import {
	mmcliParseSep,
	parseModemUnlockInfo,
} from "../modules/modems/mmcli.ts";
import { discoverModems } from "../modules/modems/modem-update-loop.ts";
import { getModemIds, removeModem } from "../modules/modems/modems-state.ts";
import * as simSecrets from "../modules/modems/sim-secrets.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	unlockSimPin2Procedure,
	unlockSimProcedure,
	unlockSimPukProcedure,
} from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

beforeAll(async () => {
	// shouldUseMocks() gates the unlock procedures' mock branch on
	// isDevelopment(); MOCK_MODE flips that on without depending on NODE_ENV.
	process.env.MOCK_MODE = "true";
	initMockService("modem-pin-locked");
	await discoverModems();
});

afterEach(() => {
	resetMockState();
	mock.restore();
});

afterAll(() => {
	stopMockService();
	for (const id of getModemIds()) removeModem(id);
	setModemsState({});
	if (ORIGINAL_MOCK_MODE === undefined) {
		delete process.env.MOCK_MODE;
	} else {
		process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	}
});

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

// withDeviceType() scopes CERALIVE_DEVICE_TYPE for the duration of `fn` but
// resolves to void, so capture the call result inside the scope and hand it back.
async function callEmulated<T>(fn: () => Promise<T>): Promise<T> {
	let out: T | undefined;
	await withDeviceType("emulated", async () => {
		out = await fn();
	});
	return out as T;
}

function reportedUnlockRequired(modemId: number): string {
	const out = handleMmcliCommand(["-K", "-m", String(modemId)]);
	return parseModemUnlockInfo(mmcliParseSep(out ?? "")).required;
}

async function captureBroadcasts<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; frames: Array<Record<string, unknown>> }> {
	const sent: string[] = [];
	const client = {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sent.push(message),
	} as unknown as AppWebSocket;
	addClient(client);
	try {
		const result = await fn();
		return {
			result,
			frames: sent.map((message) => JSON.parse(message)) as Array<
				Record<string, unknown>
			>,
		};
	} finally {
		removeClient(client);
	}
}

function expectTargetedFullBroadcast(
	frames: Array<Record<string, unknown>>,
	modemId: string,
): void {
	const modemFrames = frames.filter((frame) => {
		const status = frame.status as Record<string, unknown> | undefined;
		return status?.modems !== undefined;
	});
	expect(modemFrames).toHaveLength(1);
	const status = modemFrames[0]?.status as Record<string, unknown> | undefined;
	const modems = status?.modems as
		| Record<string, Record<string, unknown>>
		| undefined;
	expect(modems?.[modemId]?.name).toBeDefined();
	expect(modems?.[modemId]?.sim_lock).toBeUndefined();
	for (const [id, modem] of Object.entries(modems ?? {})) {
		if (id !== modemId) expect(modem.name).toBeUndefined();
	}
}

describe("modem-pin-locked scenario seeding", () => {
	it("seeds modem 0 SIM-PIN locked with a schema-valid fixture", () => {
		const sim = getMockSimState(0);
		expect(mockSimStateSchema.safeParse(sim).success).toBe(true);
		expect(sim?.lock).toBe("pin-locked");
		expect(sim?.pinRetries).toBe(3);
	});

	it("reports modem 0 unlock-required 'sim-pin' (the sim_lock.required source)", () => {
		expect(reportedUnlockRequired(0)).toBe("sim-pin");
		// Only modem 0 is seeded locked — modem 1 stays unlocked.
		expect(reportedUnlockRequired(1)).toBe("none");
	});
});

describe("unlockSim RPC routes to the mock SIM state machine", () => {
	it("burns exactly one attempt on a wrong PIN", async () => {
		const result = await callEmulated(() =>
			call(
				unlockSimProcedure,
				{ modemPath: "0", pin: "9999" },
				{ context: makeContext() },
			),
		);
		expect(result).toEqual({ state: "wrong-pin", remainingAttempts: 2 });
		expect(getMockSimState(0)?.pinRetries).toBe(2);
		expect(getMockSimState(0)?.lock).toBe("pin-locked");
	});

	it("trips the SIM to PUK-locked once the PIN attempts are exhausted", async () => {
		const ctx = { context: makeContext() };
		expect(
			await callEmulated(() =>
				call(unlockSimProcedure, { modemPath: "0", pin: "9999" }, ctx),
			),
		).toEqual({ state: "wrong-pin", remainingAttempts: 2 });
		expect(
			await callEmulated(() =>
				call(unlockSimProcedure, { modemPath: "0", pin: "9999" }, ctx),
			),
		).toEqual({ state: "wrong-pin", remainingAttempts: 1 });
		expect(
			await callEmulated(() =>
				call(unlockSimProcedure, { modemPath: "0", pin: "9999" }, ctx),
			),
		).toEqual({ state: "puk-required" });
		expect(getMockSimState(0)?.lock).toBe("puk-locked");
		expect(getMockSimState(0)?.pinRetries).toBe(0);
	});

	it("unlocks modem 0 with the correct fixture PIN", async () => {
		const { result, frames } = await captureBroadcasts(() =>
			callEmulated(() =>
				call(
					unlockSimProcedure,
					{ modemPath: "0", pin: MOCK_SIM_PIN_FIXTURE },
					{ context: makeContext() },
				),
			),
		);
		expect(result).toEqual({ state: "success" });
		expect(getMockSimState(0)?.lock).toBe("unlocked");
		expectTargetedFullBroadcast(frames, "0");
	});

	it("does NOT persist the PIN (storeSimPin/clearSimPin) when remember=true under mocks", async () => {
		const storeSpy = spyOn(simSecrets, "storeSimPin");
		const clearSpy = spyOn(simSecrets, "clearSimPin");

		const result = await callEmulated(() =>
			call(
				unlockSimProcedure,
				{ modemPath: "0", pin: MOCK_SIM_PIN_FIXTURE, remember: true },
				{ context: makeContext() },
			),
		);

		expect(result).toEqual({ state: "success" });
		// The remember/storeSimPin branch is real-device only — a dev host never
		// writes the tmpfs secret, so neither setter is reached.
		expect(storeSpy).not.toHaveBeenCalled();
		expect(clearSpy).not.toHaveBeenCalled();
	});
});

describe("unlockSimPuk RPC routes to the mock SIM state machine", () => {
	it("recovers a PUK-locked SIM with the correct fixture PUK", async () => {
		const ctx = { context: makeContext() };
		for (let i = 0; i < 3; i++) {
			await callEmulated(() =>
				call(unlockSimProcedure, { modemPath: "0", pin: "9999" }, ctx),
			);
		}
		expect(getMockSimState(0)?.lock).toBe("puk-locked");

		const { result, frames } = await captureBroadcasts(() =>
			callEmulated(() =>
				call(
					unlockSimPukProcedure,
					{ modemPath: "0", puk: MOCK_SIM_PUK_FIXTURE, newPin: "4321" },
					ctx,
				),
			),
		);
		expect(result).toEqual({ success: true });
		expect(getMockSimState(0)?.lock).toBe("unlocked");
		expectTargetedFullBroadcast(frames, "0");
	});

	it("reports wrong-puk with the remaining attempt count on a bad PUK", async () => {
		const ctx = { context: makeContext() };
		for (let i = 0; i < 3; i++) {
			await callEmulated(() =>
				call(unlockSimProcedure, { modemPath: "0", pin: "9999" }, ctx),
			);
		}
		const result = await callEmulated(() =>
			call(
				unlockSimPukProcedure,
				{ modemPath: "0", puk: "00000000", newPin: "4321" },
				ctx,
			),
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe("wrong-puk");
		expect(getMockSimState(0)?.lock).toBe("puk-locked");
	});
});

describe("unlockSimPin2 RPC routes to the mock SIM state machine", () => {
	it("broadcasts modem 0 in full after the correct fixture PIN2 succeeds", async () => {
		setMockSimLockState(0, "pin2-locked");

		const { result, frames } = await captureBroadcasts(() =>
			callEmulated(() =>
				call(
					unlockSimPin2Procedure,
					{ modemPath: "0", pin2: MOCK_SIM_PIN2_FIXTURE },
					{ context: makeContext() },
				),
			),
		);

		expect(result).toEqual({ state: "success" });
		expect(getMockSimState(0)?.lock).toBe("unlocked");
		expectTargetedFullBroadcast(frames, "0");
	});
});
