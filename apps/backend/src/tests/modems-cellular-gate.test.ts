import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { call, ORPCError } from "@orpc/server";

import {
	CELLULAR_STACK_INITIALIZING,
	type CellularStartResult,
	initCellularStack,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import { getAllModemsProcedure } from "../rpc/procedures/modems.procedure.ts";
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

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function callGetAll(): Promise<unknown> {
	return call(getAllModemsProcedure, undefined, { context: makeContext() });
}

describe("modem procedures — cellular stack init gate", () => {
	beforeEach(() => {
		resetCellularStack();
		resetBootReadiness();
		getConfig().modem_backend = undefined;
	});

	afterEach(() => {
		resetCellularStack();
		resetBootReadiness();
		getConfig().modem_backend = undefined;
	});

	test("default (mmcli ready) — getAll resolves without the gate firing", async () => {
		// Given the default mmcli-ready stack (no init run)
		// When a modem procedure is called
		const result = await callGetAll();
		// Then it resolves normally (byte-identical to the pre-seam path)
		expect(result).toBeDefined();
	});

	test("during the dbus init window — getAll returns CELLULAR_STACK_INITIALIZING", async () => {
		// Given a dbus backend whose first snapshot has not resolved yet
		const gate = deferred<CellularStartResult>();
		const initPromise = initCellularStack({
			backend: "dbus",
			createDbusBackend: () => ({
				start: () => gate.promise,
				stop: async () => {},
			}),
		});

		// When a modem procedure is called during the init window
		let err: unknown;
		try {
			await callGetAll();
		} catch (e) {
			err = e;
		}

		// Then it returns the typed error — never a crash, never a hang
		expect(err).toBeInstanceOf(ORPCError);
		expect((err as ORPCError<string, unknown>).code).toBe(
			CELLULAR_STACK_INITIALIZING,
		);

		gate.resolve({ ok: true });
		await initPromise;
	});

	test("after the dbus backend commits — getAll resolves again", async () => {
		// Given a dbus backend that committed its first snapshot
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () => ({
				start: () => Promise.resolve({ ok: true }),
				stop: async () => {},
			}),
		});

		// When a modem procedure is called
		const result = await callGetAll();

		// Then it resolves normally
		expect(result).toBeDefined();
	});

	test("after a dbus init failure — the mmcli fallback keeps procedures working", async () => {
		// Given a dbus backend that failed to initialize (fell back to mmcli)
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () => ({
				start: () => Promise.reject(new Error("no system bus")),
				stop: async () => {},
			}),
		});

		// When a modem procedure is called after fallback
		const result = await callGetAll();

		// Then it resolves normally on the mmcli fallback path
		expect(result).toBeDefined();
	});
});
