/*
 * T1 — power gate: poweroff / reboot / update-auto-reboot must be a no-op on a
 * dev host so a developer's own machine is NEVER powered off or rebooted by the
 * UI. The gate is isDevelopment() (NODE_ENV==="development" || MOCK_MODE), NOT
 * isRealDevice(): isRealDevice() returns false for an UNRECOGNISED board, so
 * gating on it would make a real-but-unrecognised device silently skip
 * poweroff — a production safety regression. Case (c) below pins that the real
 * spawn path is unconditional on board detection.
 *
 * The OS command is injected through the module's runner seam (mirrors the
 * setKioskDeps DI pattern), so the suite asserts on whether the runner FIRED —
 * never shelling out to a real `poweroff`/`reboot`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";

import {
	rebootAfterUpdate,
	resetRebootRunner,
	setRebootRunner,
} from "../modules/system/software-updates.ts";
import {
	poweroffProcedure,
	rebootProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

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

// Snapshot + restore the three env vars the gate (and isRealDevice) read, so no
// test leaks dev/prod state into the next.
let savedNodeEnv: string | undefined;
let savedMockMode: string | undefined;
let savedDeviceType: string | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedMockMode = process.env.MOCK_MODE;
	savedDeviceType = process.env.CERALIVE_DEVICE_TYPE;
});

afterEach(() => {
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	restore("NODE_ENV", savedNodeEnv);
	restore("MOCK_MODE", savedMockMode);
	restore("CERALIVE_DEVICE_TYPE", savedDeviceType);
	resetPowerCommandRunner();
	resetRebootRunner();
});

describe("(a) dev host — poweroff/reboot are a no-op", () => {
	test("NODE_ENV=development: poweroff returns success WITHOUT firing the runner", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));

		const result = await call(poweroffProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(commands).toHaveLength(0);
	});

	test("NODE_ENV=development: reboot returns success WITHOUT firing the runner", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));

		const result = await call(rebootProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(commands).toHaveLength(0);
	});

	test("MOCK_MODE=true alone also gates the spawn", async () => {
		delete process.env.NODE_ENV;
		process.env.MOCK_MODE = "true";
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));

		await call(poweroffProcedure, undefined, { context: makeContext() });

		expect(commands).toHaveLength(0);
	});
});

describe("(b) production + recognised real device — runner fires once", () => {
	test("poweroff spawns exactly once with the poweroff command", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "real";
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));

		const result = await call(poweroffProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(commands).toEqual(["poweroff"]);
	});

	test("reboot spawns exactly once with the reboot command", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "real";
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));

		const result = await call(rebootProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(commands).toEqual(["reboot"]);
	});
});

describe("(c) regression guard — unrecognised board still powers off", () => {
	// isRealDevice() returns false for an unrecognised board (no override, not
	// dev). The power path MUST NOT depend on board detection: a real device the
	// detector cannot fingerprint must still power off. Gating on isDevelopment()
	// (false in production) keeps the spawn unconditional here.
	test("production, no device-type override: poweroff runner STILL fires once", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE; // unrecognised board → isRealDevice() false
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));

		const result = await call(poweroffProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(commands).toEqual(["poweroff"]);
	});

	test("production, no device-type override: reboot runner STILL fires once", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		const commands: string[] = [];
		setPowerCommandRunner((command) => commands.push(command));

		const result = await call(rebootProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(commands).toEqual(["reboot"]);
	});
});

describe("(d) software-update auto-reboot gate", () => {
	test("NODE_ENV=development: auto-reboot does NOT invoke the runner", () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;
		const calls: Array<[string, string[]]> = [];
		setRebootRunner((bin, args) => calls.push([bin, args]));

		rebootAfterUpdate();

		expect(calls).toHaveLength(0);
	});

	test("MOCK_MODE=true: auto-reboot does NOT invoke the runner", () => {
		delete process.env.NODE_ENV;
		process.env.MOCK_MODE = "true";
		const calls: Array<[string, string[]]> = [];
		setRebootRunner((bin, args) => calls.push([bin, args]));

		rebootAfterUpdate();

		expect(calls).toHaveLength(0);
	});

	test("NODE_ENV=production: auto-reboot invokes run('reboot', []) once", () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		const calls: Array<[string, string[]]> = [];
		setRebootRunner((bin, args) => calls.push([bin, args]));

		rebootAfterUpdate();

		expect(calls).toEqual([["reboot", []]]);
	});
});
