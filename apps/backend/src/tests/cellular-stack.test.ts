import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ORPCError } from "@orpc/server";

import {
	assertCellularStackReady,
	CELLULAR_STACK_INITIALIZING,
	type CellularBackend,
	type CellularStartResult,
	getCellularStack,
	initCellularStack,
	resetCellularStack,
	stopCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fakeBackend(
	start: () => Promise<CellularStartResult>,
	onStop?: () => void,
): CellularBackend {
	return {
		start,
		stop: async () => {
			onStop?.();
		},
	};
}

function gateError(): unknown {
	try {
		assertCellularStackReady();
	} catch (err) {
		return err;
	}
	return undefined;
}

describe("cellular stack composition root", () => {
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

	test("default state is mmcli-ready with no init window", () => {
		// Given a fresh process where init has never run
		// When reading the stack and the readiness gate
		// Then mmcli is committed, ready, and the gate never fires
		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: false,
		});
		expect(gateError()).toBeUndefined();
	});

	test("initCellularStack with mmcli commits mmcli ready synchronously", async () => {
		// Given the default mmcli backend
		// When init runs
		await initCellularStack({ backend: "mmcli" });
		// Then the stack is ready with no init window
		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: false,
		});
		expect(gateError()).toBeUndefined();
	});

	test("dbus commits only after its first successful snapshot", async () => {
		// Given a dbus backend whose first snapshot has not resolved yet
		const gate = deferred<CellularStartResult>();
		const initPromise = initCellularStack({
			backend: "dbus",
			createDbusBackend: () => fakeBackend(() => gate.promise),
		});

		// Then the stack is still initializing and the gate throws the typed error
		expect(getCellularStack().ready).toBe(false);
		expect(getCellularStack().backend).toBe("dbus");
		const err = gateError();
		expect(err).toBeInstanceOf(ORPCError);
		expect((err as ORPCError<string, unknown>).code).toBe(
			CELLULAR_STACK_INITIALIZING,
		);

		// When the first authoritative snapshot resolves
		gate.resolve({ ok: true });
		await initPromise;

		// Then dbus is committed, ready, and undegraded
		expect(getCellularStack()).toEqual({
			backend: "dbus",
			ready: true,
			degraded: false,
		});
		expect(gateError()).toBeUndefined();
		expect(getBootReadiness().degraded).toBe(false);
	});

	test("dbus init failure falls back to mmcli with degraded readiness", async () => {
		// Given a dbus backend whose snapshot rejects (no reachable bus)
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () =>
				fakeBackend(() => Promise.reject(new Error("no system bus"))),
		});

		// Then the stack falls back to mmcli, stays ready, and reports degraded
		const stack = getCellularStack();
		expect(stack.backend).toBe("mmcli");
		expect(stack.ready).toBe(true);
		expect(stack.degraded).toBe(true);
		expect(stack.degradedReason).toBeDefined();
		expect(getBootReadiness().degradedSubsystems).toContain("cellular-stack");
		expect(gateError()).toBeUndefined();
	});

	test("a non-authoritative first snapshot (ok:false) is not committed", async () => {
		// Given a dbus backend that starts but yields no authoritative snapshot
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () =>
				fakeBackend(() => Promise.resolve({ ok: false })),
		});

		// Then the backend is NOT committed — it falls back + degrades
		const stack = getCellularStack();
		expect(stack.backend).toBe("mmcli");
		expect(stack.degraded).toBe(true);
		expect(getBootReadiness().degradedSubsystems).toContain("cellular-stack");
	});

	test("a hung dbus init falls back within the bounded init window", async () => {
		// Given a dbus backend whose snapshot never resolves
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () =>
				fakeBackend(() => new Promise<CellularStartResult>(() => {})),
			initTimeoutMs: 20,
		});

		// Then the bounded window elapses and the stack falls back rather than hang
		const stack = getCellularStack();
		expect(stack.backend).toBe("mmcli");
		expect(stack.degraded).toBe(true);
		expect(getBootReadiness().degradedSubsystems).toContain("cellular-stack");
	});

	test("selects the backend from config.modem_backend when unset in deps", async () => {
		// Given config opting into the dbus backend
		getConfig().modem_backend = "dbus";
		// When init runs without an explicit backend override
		await initCellularStack({
			createDbusBackend: () => fakeBackend(() => Promise.resolve({ ok: true })),
		});
		// Then the config-selected dbus backend is committed
		expect(getCellularStack().backend).toBe("dbus");
		expect(getCellularStack().ready).toBe(true);
	});

	test("stops the failed dbus backend on fallback", async () => {
		// Given a dbus backend that rejects init
		let stopped = false;
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () =>
				fakeBackend(
					() => Promise.reject(new Error("boom")),
					() => {
						stopped = true;
					},
				),
		});
		// Then its transport is released on fallback
		expect(stopped).toBe(true);
	});

	test("stopCellularStack releases the committed dbus backend and resets", async () => {
		// Given a committed dbus backend
		let stopped = false;
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () =>
				fakeBackend(
					() => Promise.resolve({ ok: true }),
					() => {
						stopped = true;
					},
				),
		});
		expect(getCellularStack().backend).toBe("dbus");

		// When the stack is torn down
		await stopCellularStack();

		// Then the backend is stopped and the stack resets to the mmcli default
		expect(stopped).toBe(true);
		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: false,
		});
	});
});
