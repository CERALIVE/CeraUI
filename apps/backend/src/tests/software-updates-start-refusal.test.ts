/*
 * Software-update start: every refusal must name itself, and the shipped
 * setup.json must not silently disable the install path.
 *
 * Found live on a Rock 5B+ running the shipped image: clicking Update in
 * Settings → Software Updates showed "Applying…" for ~15 s, then reverted to the
 * Update button with no message, and no apt process ever ran. `/opt/ceralive/
 * debug.log` recorded `System: software update started` — so the RPC DID land —
 * and then nothing at all.
 *
 * The cause was a pair of asymmetries around `setup.apt_update_enabled`:
 *
 *   1. The shipped `setup.json` carries no `apt_update_enabled` key, and the
 *      field is `z.boolean().optional()` with no default, so it read `undefined`
 *      — falsy — on every device in the field.
 *   2. DISCOVERY (`checkForUpdates` → `triggerManualUpdateCheck` →
 *      `getSoftwareUpdateSize`) was never gated on that flag, so the device
 *      happily advertised an available update, while INSTALL
 *      (`startSoftwareUpdate` / `doSoftwareUpdate`) was gated and returned
 *      VOID — no reason, no log, no state change. The RPC still answered
 *      `{success:true}`, so the UI parked on "Applying…" until its 15 s TTL
 *      swept it away without a word.
 *
 * These tests pin the two properties that make that impossible to recur: the
 * shipped (key-absent) setup actually installs, and every refusal is a typed,
 * operator-visible reason rather than a silent return.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";

import { initMockService, shouldUseMocks } from "../mocks/mock-service.ts";
import { setup } from "../modules/setup.ts";
import {
	isUpdating,
	periodicCheckForSoftwareUpdates,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateRunner,
	resetSoftwareUpdateState,
	setSoftwareUpdateCheckRunner,
	setSoftwareUpdateRunner,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { startUpdateProcedure } from "../rpc/procedures/system.procedure.ts";
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

let savedNodeEnv: string | undefined;
let savedMockMode: string | undefined;
let savedAptEnabled: boolean | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedMockMode = process.env.MOCK_MODE;
	savedAptEnabled = setup.apt_update_enabled;
	// Production posture: the mock seam must never stand in for the apt spawn.
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
});

afterEach(() => {
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	restore("NODE_ENV", savedNodeEnv);
	restore("MOCK_MODE", savedMockMode);
	setup.apt_update_enabled = savedAptEnabled;
	resetSoftwareUpdateRunner();
	resetSoftwareUpdateCheckRunner();
	resetSoftwareUpdateState();
});

describe("a setup.json with no apt_update_enabled key still installs", () => {
	test("startSoftwareUpdate dispatches the real apt runner", () => {
		// EXACTLY what /opt/ceralive/setup.json ships: the key is absent.
		setup.apt_update_enabled = undefined;

		let runnerCalls = 0;
		setSoftwareUpdateRunner(() => {
			runnerCalls++;
			return { started: true };
		});

		const outcome = startSoftwareUpdate();

		expect(outcome).toEqual({ started: true });
		expect(runnerCalls).toBe(1);
	});

	test("the startUpdate RPC reports the dispatch it actually made", async () => {
		setup.apt_update_enabled = undefined;

		let runnerCalls = 0;
		setSoftwareUpdateRunner(() => {
			runnerCalls++;
			return { started: true };
		});

		const result = await call(startUpdateProcedure, undefined, {
			context: makeContext(),
		});

		expect(result).toEqual({ success: true });
		expect(runnerCalls).toBe(1);
	});
});

describe("every refusal names itself", () => {
	test("an explicit apt_update_enabled:false refuses with updates_disabled", async () => {
		setup.apt_update_enabled = false;

		let runnerCalls = 0;
		setSoftwareUpdateRunner(() => {
			runnerCalls++;
			return { started: true };
		});

		expect(startSoftwareUpdate()).toEqual({
			started: false,
			reason: "updates_disabled",
		});
		expect(runnerCalls).toBe(0);

		// The operator must be told, not left on a phantom "Applying…".
		const result = await call(startUpdateProcedure, undefined, {
			context: makeContext(),
		});
		expect(result).toEqual({ success: false, error: "updates_disabled" });
	});

	test("a second start while one is running refuses with already_updating", async () => {
		setup.apt_update_enabled = true;

		// A pre-check that starts but never calls back leaves the update in
		// flight, exactly like a real apt-get update still running.
		setSoftwareUpdateCheckRunner(() => true);
		resetSoftwareUpdateRunner();

		expect(startSoftwareUpdate()).toEqual({ started: true });
		expect(isUpdating()).toBe(true);

		expect(startSoftwareUpdate()).toEqual({
			started: false,
			reason: "already_updating",
		});

		const result = await call(startUpdateProcedure, undefined, {
			context: makeContext(),
		});
		expect(result).toEqual({ success: false, error: "already_updating" });
	});
});

describe("the periodic check never hands a dev host to apt", () => {
	test("no discovery runs under shouldUseMocks(), even with updates enabled", () => {
		setup.apt_update_enabled = true;
		process.env.NODE_ENV = "development";
		initMockService("multi-modem-wifi");
		expect(shouldUseMocks()).toBe(true);

		let checks = 0;
		setSoftwareUpdateCheckRunner(() => {
			checks++;
			return true;
		});

		periodicCheckForSoftwareUpdates();

		expect(checks).toBe(0);
	});
});

describe("a skipped apt pre-check never wedges the update latch", () => {
	test("isUpdating() falls back to false and the refusal is reported", () => {
		setup.apt_update_enabled = true;

		// The pre-check declines to run (apt busy / a stream started underneath
		// us). Its callback therefore NEVER fires — and the callback is the only
		// thing that clears softUpdateStatus, so an unconditional latch here left
		// isUpdating() true for the lifetime of the process, permanently refusing
		// every later update AND silently killing the periodic check loop.
		setSoftwareUpdateCheckRunner(() => false);
		resetSoftwareUpdateRunner();

		const outcome = startSoftwareUpdate();

		expect(outcome).toEqual({ started: false, reason: "check_unavailable" });
		expect(isUpdating()).toBe(false);
	});
});
