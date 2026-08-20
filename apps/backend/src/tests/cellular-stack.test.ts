/**
 * Cellular composition-root contract.
 *
 * Three properties are load-bearing and each is driven through the REAL
 * `initCellularStack` rather than asserted of its shape: the backend SELECTION
 * (absent config must resolve mmcli, so a device nobody configured never opens
 * the bus), the COMMIT POINT (a dbus backend is not ready until its first
 * authoritative snapshot, and the gate answers a typed error until then), and
 * the FALLBACK (every failure mode ends ready-on-mmcli, degraded, and flagged on
 * the boot-readiness surface — boot is never blocked).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ORPCError } from "@orpc/server";

import {
	assertCellularStackReady,
	CELLULAR_STACK_INITIALIZING,
	CELLULAR_SUBSYSTEM,
	type CellularBackend,
	type CellularStartResult,
	DBUS_FALLBACK_REASON,
	getCellularStack,
	initCellularStack,
	resetCellularStack,
	resolveModemBackend,
	stopCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface SpyBackend extends CellularBackend {
	readonly stopCount: () => number;
}

function spyBackend(start: () => Promise<CellularStartResult>): SpyBackend {
	let stops = 0;
	return {
		start,
		stop: async () => {
			stops += 1;
		},
		stopCount: () => stops,
	};
}

function gateError(): unknown {
	try {
		assertCellularStackReady();
		return undefined;
	} catch (err) {
		return err;
	}
}

function setBackendConfig(value: "mmcli" | "dbus" | undefined): void {
	if (value === undefined) {
		delete getConfig().modem_backend;
		return;
	}
	getConfig().modem_backend = value;
}

beforeEach(() => {
	resetCellularStack();
	resetBootReadiness();
	setBackendConfig(undefined);
});

afterEach(() => {
	resetCellularStack();
	resetBootReadiness();
	setBackendConfig(undefined);
});

describe("backend selection", () => {
	test("an absent config key resolves DBUS — the shipped cutover reaches the fleet", () => {
		// Given a device that has never been configured — i.e. every board in the
		// field, since nothing has ever written this key
		expect(getConfig().modem_backend).toBeUndefined();
		// Then the resolved backend is the D-Bus observer, not the legacy CLI path
		expect(resolveModemBackend()).toBe("dbus");
	});

	test("an explicit mmcli config resolves mmcli", () => {
		setBackendConfig("mmcli");
		expect(resolveModemBackend()).toBe("mmcli");
	});

	test("an explicit dbus config resolves dbus", () => {
		setBackendConfig("dbus");
		expect(resolveModemBackend()).toBe("dbus");
	});

	test("an injected backend outranks the config (test seam)", () => {
		setBackendConfig("dbus");
		expect(resolveModemBackend({ backend: "mmcli" })).toBe("mmcli");
	});

	test("the default stack is mmcli-ready before init has ever run", () => {
		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: false,
		});
		expect(gateError()).toBeUndefined();
	});
});

describe("selection matrix — backend x start outcome", () => {
	test("absent config CONSTRUCTS the dbus backend — an unmodified board takes the cutover", async () => {
		// Given no configured backend
		let built = 0;
		// When init runs with a dbus factory available
		await initCellularStack({
			createDbusBackend: () => {
				built += 1;
				return spyBackend(async () => ({ ok: true }));
			},
		});
		// Then the factory WAS called and dbus is committed ready
		expect(built).toBe(1);
		expect(getCellularStack()).toEqual({
			backend: "dbus",
			ready: true,
			degraded: false,
		});
	});

	test("explicit mmcli never constructs a dbus backend either", async () => {
		let built = 0;
		setBackendConfig("mmcli");
		await initCellularStack({
			createDbusBackend: () => {
				built += 1;
				return spyBackend(async () => ({ ok: true }));
			},
		});
		expect(built).toBe(0);
		expect(getCellularStack().backend).toBe("mmcli");
		expect(getCellularStack().degraded).toBe(false);
	});

	test("dbus + start-ok commits dbus, ready and undegraded", async () => {
		setBackendConfig("dbus");
		await initCellularStack({
			createDbusBackend: () => spyBackend(async () => ({ ok: true })),
		});
		expect(getCellularStack()).toEqual({
			backend: "dbus",
			ready: true,
			degraded: false,
		});
		expect(gateError()).toBeUndefined();
		expect(getBootReadiness().degraded).toBe(false);
	});

	test("dbus + start-fail (rejection) falls back to degraded mmcli", async () => {
		setBackendConfig("dbus");
		const backend = spyBackend(async () => {
			throw new Error("no system bus");
		});
		await initCellularStack({ createDbusBackend: () => backend });

		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: true,
			degradedReason: DBUS_FALLBACK_REASON,
		});
		expect(backend.stopCount()).toBe(1);
		expect(gateError()).toBeUndefined();
	});

	test("dbus + a NON-authoritative snapshot is a failure, not a commit", async () => {
		// Given a backend that starts but cannot vouch for its snapshot
		setBackendConfig("dbus");
		const backend = spyBackend(async () => ({ ok: false }));
		// When init runs
		await initCellularStack({ createDbusBackend: () => backend });
		// Then it falls back rather than committing an unverified source
		expect(getCellularStack().backend).toBe("mmcli");
		expect(getCellularStack().degraded).toBe(true);
		expect(backend.stopCount()).toBe(1);
	});

	test("dbus + start-timeout falls back within the bounded window", async () => {
		// Given a start that never resolves
		setBackendConfig("dbus");
		const hang = deferred<CellularStartResult>();
		const backend = spyBackend(() => hang.promise);

		// When the bounded init window elapses
		await initCellularStack({
			createDbusBackend: () => backend,
			initTimeoutMs: 20,
		});

		// Then the stack fell back, stopped the hung backend, and flagged degraded
		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: true,
			degradedReason: DBUS_FALLBACK_REASON,
		});
		expect(backend.stopCount()).toBe(1);
		hang.resolve({ ok: true });
	});

	test("a factory that throws is a fallback, never a boot crash", async () => {
		setBackendConfig("dbus");
		await initCellularStack({
			createDbusBackend: () => {
				throw new Error("dbus module unavailable");
			},
		});
		expect(getCellularStack().backend).toBe("mmcli");
		expect(getCellularStack().degraded).toBe(true);
	});
});

describe("the init window is observable, not a hang", () => {
	test("dbus is NOT ready until the first authoritative snapshot resolves", async () => {
		// Given a dbus start that has not answered yet
		setBackendConfig("dbus");
		const gate = deferred<CellularStartResult>();
		const init = initCellularStack({
			createDbusBackend: () => spyBackend(() => gate.promise),
		});

		// Then the stack is dbus-but-not-ready and the gate throws the typed error
		expect(getCellularStack().backend).toBe("dbus");
		expect(getCellularStack().ready).toBe(false);
		const err = gateError();
		expect(err).toBeInstanceOf(ORPCError);
		expect((err as ORPCError<string, unknown>).code).toBe(
			CELLULAR_STACK_INITIALIZING,
		);

		// When the snapshot lands
		gate.resolve({ ok: true });
		await init;

		// Then the gate stops firing
		expect(getCellularStack().ready).toBe(true);
		expect(gateError()).toBeUndefined();
	});
});

describe("degraded fallback is recorded on the boot-readiness surface", () => {
	test("a fallback flags the cellular-stack subsystem", async () => {
		setBackendConfig("dbus");
		expect(getBootReadiness().degraded).toBe(false);

		await initCellularStack({
			createDbusBackend: () =>
				spyBackend(async () => {
					throw new Error("bus refused");
				}),
		});

		const readiness = getBootReadiness();
		expect(readiness.degraded).toBe(true);
		expect(readiness.degradedSubsystems).toContain(CELLULAR_SUBSYSTEM);
	});

	test("a successful dbus init flags nothing", async () => {
		setBackendConfig("dbus");
		await initCellularStack({
			createDbusBackend: () => spyBackend(async () => ({ ok: true })),
		});
		expect(getBootReadiness().degradedSubsystems).not.toContain(
			CELLULAR_SUBSYSTEM,
		);
	});
});

describe("stopCellularStack", () => {
	test("stops the committed dbus backend and returns to the mmcli default", async () => {
		setBackendConfig("dbus");
		const backend = spyBackend(async () => ({ ok: true }));
		await initCellularStack({ createDbusBackend: () => backend });

		await stopCellularStack();

		expect(backend.stopCount()).toBe(1);
		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: false,
		});
	});

	test("is idempotent, and never double-stops a backend already released", async () => {
		setBackendConfig("dbus");
		const backend = spyBackend(async () => ({ ok: true }));
		await initCellularStack({ createDbusBackend: () => backend });

		await stopCellularStack();
		await stopCellularStack();

		expect(backend.stopCount()).toBe(1);
	});

	test("on the mmcli path there is nothing to stop", async () => {
		await initCellularStack({ backend: "mmcli" });
		await stopCellularStack();
		expect(getCellularStack().backend).toBe("mmcli");
	});

	test("a backend whose stop() throws still releases the stack", async () => {
		setBackendConfig("dbus");
		await initCellularStack({
			createDbusBackend: () => ({
				start: async () => ({ ok: true }),
				stop: async () => {
					throw new Error("already gone");
				},
			}),
		});

		await stopCellularStack();

		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: false,
		});
	});
});
