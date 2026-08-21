/**
 * Every modem procedure is gated on cellular-stack readiness.
 *
 * The matrix below runs each REAL procedure through all three lifecycle states,
 * because the failure this prevents is not "the gate is wrong" but "one
 * procedure was never wired to it" — and a single ungated procedure reads a
 * half-initialised dbus backend during the init window. Driving the procedures
 * rather than the middleware is what makes an unwired one fail here.
 *
 * The ready and degraded states are BOTH pass-through: a fallback to mmcli is a
 * working modem stack, so degrading must never take the modem UI away.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { call, ORPCError } from "@orpc/server";

import {
	CELLULAR_STACK_INITIALIZING,
	type CellularStartResult,
	getCellularStack,
	initCellularStack,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import {
	configureModemProcedure,
	getAllModemsProcedure,
	scanModemProcedure,
	setUsbModeProcedure,
	unlockSimProcedure,
	unlockSimPukProcedure,
} from "../rpc/procedures/modems.procedure.ts";
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

// Every input names modem id 0 / an unknown modem path, so a procedure that DOES
// run past the gate no-ops against absent hardware instead of driving mmcli.
const MODEM_PROCEDURES = [
	{
		name: "modems.getAll",
		invoke: () =>
			call(getAllModemsProcedure, undefined, { context: makeContext() }),
	},
	{
		name: "modems.configure",
		invoke: () =>
			call(
				configureModemProcedure,
				{
					device: 0,
					network_type: "5g",
					apn: "",
					username: "",
					password: "",
				},
				{ context: makeContext() },
			),
	},
	{
		name: "modems.scan",
		invoke: () =>
			call(scanModemProcedure, { device: 0 }, { context: makeContext() }),
	},
	{
		name: "modems.unlockSim",
		invoke: () =>
			call(
				unlockSimProcedure,
				{ modemPath: "/org/freedesktop/ModemManager1/Modem/999", pin: "0000" },
				{ context: makeContext() },
			),
	},
	{
		name: "modems.unlockSimPuk",
		invoke: () =>
			call(
				unlockSimPukProcedure,
				{
					modemPath: "/org/freedesktop/ModemManager1/Modem/999",
					puk: "12345678",
					newPin: "0000",
				},
				{ context: makeContext() },
			),
	},
	{
		name: "modems.setUsbMode",
		invoke: () =>
			call(
				setUsbModeProcedure,
				{ device: "0", mode: "qmi", confirm: true } as const,
				{ context: makeContext() },
			),
	},
] as const;

function gateCodeOf(err: unknown): string | undefined {
	return err instanceof ORPCError ? err.code : undefined;
}

async function refusalCode(
	invoke: () => Promise<unknown>,
): Promise<string | undefined> {
	try {
		await invoke();
		return undefined;
	} catch (err) {
		return gateCodeOf(err);
	}
}

let releaseInit: ((value: CellularStartResult) => void) | undefined;

beforeEach(() => {
	resetCellularStack();
	resetBootReadiness();
	delete getConfig().modem_backend;
	delete getConfig().modem_provisioning;
});

afterEach(() => {
	releaseInit?.({ ok: true });
	releaseInit = undefined;
	resetCellularStack();
	resetBootReadiness();
	delete getConfig().modem_backend;
	delete getConfig().modem_provisioning;
});

function enterInitializing(): void {
	const gate = new Promise<CellularStartResult>((resolve) => {
		releaseInit = resolve;
	});
	void initCellularStack({
		backend: "dbus",
		createDbusBackend: () => ({
			start: () => gate,
			stop: async () => {},
		}),
	});
}

describe("lifecycle state: dbus initializing", () => {
	for (const procedure of MODEM_PROCEDURES) {
		test(`${procedure.name} refuses with the typed init error`, async () => {
			// Given a dbus backend whose first snapshot has not landed
			enterInitializing();
			expect(getCellularStack().ready).toBe(false);

			// Then the procedure never runs its handler
			expect(await refusalCode(procedure.invoke)).toBe(
				CELLULAR_STACK_INITIALIZING,
			);
		});
	}
});

describe("lifecycle state: mmcli ready", () => {
	for (const procedure of MODEM_PROCEDURES) {
		test(`${procedure.name} passes the gate`, async () => {
			await initCellularStack({ backend: "mmcli" });
			expect(getCellularStack().ready).toBe(true);

			expect(await refusalCode(procedure.invoke)).not.toBe(
				CELLULAR_STACK_INITIALIZING,
			);
		});
	}
});

describe("lifecycle state: degraded mmcli fallback", () => {
	for (const procedure of MODEM_PROCEDURES) {
		test(`${procedure.name} still passes the gate after a dbus fallback`, async () => {
			// Given a dbus init that failed and fell back
			await initCellularStack({
				backend: "dbus",
				createDbusBackend: () => ({
					start: async () => {
						throw new Error("no bus");
					},
					stop: async () => {},
				}),
			});
			expect(getCellularStack().degraded).toBe(true);
			expect(getCellularStack().ready).toBe(true);

			// Then a degraded stack is still a WORKING stack
			expect(await refusalCode(procedure.invoke)).not.toBe(
				CELLULAR_STACK_INITIALIZING,
			);
		});
	}
});
