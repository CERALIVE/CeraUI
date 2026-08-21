import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CellularBackend } from "../modules/cellular/cellular-stack.ts";
import {
	DEFAULT_MODEM_BACKEND,
	getCellularStack,
	initCellularStack,
	resetCellularStack,
	resolveModemBackend,
	stopCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { createDbusCellularBackend } from "../modules/cellular/dbus-backend.ts";
import {
	DbusModemCache,
	EPOCH_SETTLE_MS,
	REASON_MM_RESTARTING,
} from "../modules/cellular/dbus-modem-cache.ts";
import { getConfig } from "../modules/config.ts";

import { FakeBus } from "./support/fake-dbus-bus.ts";
import { managedObjectsTree } from "./support/mm-tree-fixture.ts";

const ROSTER = [
	{
		path: "/org/freedesktop/ModemManager1/Modem/11",
		ifname: "wwan0",
		physdev: "/sys/devices/platform/usb/1-1.1",
		model: "FM350-GL",
	},
	{
		path: "/org/freedesktop/ModemManager1/Modem/12",
		ifname: "wwan1",
		physdev: "/sys/devices/platform/usb/1-1.2",
		model: "SIM7600G-H",
	},
	{
		path: "/org/freedesktop/ModemManager1/Modem/13",
		ifname: "wwan2",
		physdev: "/sys/devices/platform/usb/1-1.3",
		model: "RM530N-GL",
	},
	{
		path: "/org/freedesktop/ModemManager1/Modem/14",
		ifname: "wwan3",
		physdev: "/sys/devices/platform/usb/1-1.4",
		model: "MF79U",
	},
] as const;

/** Post-restart the daemon renumbers the WHOLE roster (todo 16: 11..14 -> 0..3). */
const RENUMBERED = ROSTER.map((modem, index) => ({
	...modem,
	path: `/org/freedesktop/ModemManager1/Modem/${index}`,
}));

const settle = async (): Promise<void> => {
	for (let i = 0; i < 12; i += 1) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
};

let cache: DbusModemCache;
let clock: number;

beforeEach(() => {
	cache = new DbusModemCache();
	clock = 5_000_000;
	cache.setClock(() => clock);
	resetCellularStack();
});

afterEach(async () => {
	cache.reset();
	await stopCellularStack();
	delete getConfig().modem_backend;
});

describe("the shipped cutover", () => {
	test("Given an UNMODIFIED production config, When the backend is resolved, Then it is the D-Bus one", () => {
		expect(getConfig().modem_backend).toBeUndefined();
		expect(DEFAULT_MODEM_BACKEND).toBe("dbus");
		expect(resolveModemBackend()).toBe("dbus");
	});

	test("Given the operator rollback value, When the backend is resolved, Then mmcli is selected", () => {
		getConfig().modem_backend = "mmcli";

		expect(resolveModemBackend()).toBe("mmcli");
	});

	test("Given the rollback value, When the stack initializes, Then it commits mmcli with no D-Bus init window", async () => {
		getConfig().modem_backend = "mmcli";
		let dbusFactoryCalls = 0;

		await initCellularStack({
			createDbusBackend: () => {
				dbusFactoryCalls += 1;
				return {
					start: async () => ({ ok: true }),
					stop: async () => undefined,
				};
			},
		});

		expect(dbusFactoryCalls).toBe(0);
		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: false,
		});
	});

	test("Given an UNMODIFIED config, When the stack initializes over a live bus, Then dbus COMMITS", async () => {
		const bus = new FakeBus({ tree: managedObjectsTree([...ROSTER]) });

		await initCellularStack({
			createDbusBackend: () =>
				createDbusCellularBackend({ cache, transport: bus.transport() }),
		});

		expect(getCellularStack().backend).toBe("dbus");
		expect(getCellularStack().ready).toBe(true);
		expect(getCellularStack().degraded).toBe(false);
		expect(cache.readViews().map((v) => v.ifname)).toEqual([
			"wwan0",
			"wwan1",
			"wwan2",
			"wwan3",
		]);
	});
});

describe("event-driven adoption", () => {
	let bus: FakeBus;
	let backend: CellularBackend;

	beforeEach(async () => {
		bus = new FakeBus({ tree: managedObjectsTree([...ROSTER]) });
		backend = createDbusCellularBackend({ cache, transport: bus.transport() });
		const result = await backend.start();
		expect(result.ok).toBe(true);
	});

	afterEach(async () => {
		await backend.stop();
	});

	test("Given a live subscription, When a modem is unplugged, Then the row disappears without any poll", async () => {
		bus.setTree(managedObjectsTree(ROSTER.slice(0, 3)));
		bus.interfacesRemoved("/org/freedesktop/ModemManager1/Modem/14");
		await settle();

		expect(cache.readViews().map((v) => v.ifname)).toEqual([
			"wwan0",
			"wwan1",
			"wwan2",
		]);
	});

	test("Given a live subscription, When a modem is plugged in, Then the row appears without any poll", async () => {
		const extra = {
			path: "/org/freedesktop/ModemManager1/Modem/20",
			ifname: "wwan9",
			physdev: "/sys/devices/platform/usb/1-1.9",
		};
		bus.setTree(managedObjectsTree([...ROSTER, extra]));
		bus.interfacesAdded(extra.path);
		await settle();

		expect(cache.readViews().map((v) => v.ifname)).toContain("wwan9");
	});

	test("Given a burst of signals, When they arrive together, Then they collapse into a BOUNDED refresh count", async () => {
		const before = bus.snapshotCalls;

		for (let i = 0; i < 20; i += 1) {
			bus.propertiesChanged("/org/freedesktop/ModemManager1/Modem/11");
		}
		await settle();

		expect(bus.snapshotCalls - before).toBeLessThanOrEqual(2);
	});

	test("Given an old-epoch straggler, When it arrives, Then it drives no refresh at all", async () => {
		const before = bus.snapshotCalls;

		bus.propertiesChanged("/org/freedesktop/ModemManager1/Modem/11", ":1.OLD");
		await settle();

		expect(bus.snapshotCalls).toBe(before);
		expect(cache.readViews().length).toBe(4);
	});

	test("Given a client failure while MM is alive, When it happens, Then mmcli takes over as the backstop", async () => {
		bus.failNextSnapshot = true;
		bus.propertiesChanged("/org/freedesktop/ModemManager1/Modem/11");
		await settle();

		expect(cache.authority()).toBe("demoted");
		expect(cache.readViews()).toEqual([]);
	});
});

describe("the MM restart storm converges with no ghost rows", () => {
	test("Given a restart, When the empty resnapshot lands, Then the operator's list is NEVER blanked", async () => {
		const bus = new FakeBus({ tree: managedObjectsTree([...ROSTER]) });
		const backend = createDbusCellularBackend({
			cache,
			transport: bus.transport(),
		});
		await backend.start();

		bus.setTree([]);
		bus.restartModemManager(":1.21509");
		await settle();

		expect(cache.readViews().length).toBe(4);
		expect(
			cache
				.readViews()
				.every((v) => v.availabilityReason === REASON_MM_RESTARTING),
		).toBe(true);

		// The roster refills over ~20 s of `InterfacesAdded` from the NEW owner,
		// under wholly different MM indices.
		for (let i = 0; i < RENUMBERED.length; i += 1) {
			bus.setTree(managedObjectsTree(RENUMBERED.slice(0, i + 1)));
			bus.interfacesAdded(RENUMBERED[i]?.path ?? "");
			await settle();
			expect(cache.readViews().length).toBe(4);
		}

		expect(cache.authority()).toBe("authoritative");
		expect(
			cache
				.readViews()
				.map((v) => v.ifname)
				.sort(),
		).toEqual(["wwan0", "wwan1", "wwan2", "wwan3"]);
		expect(
			cache.readViews().every((v) => v.availabilityReason === undefined),
		).toBe(true);
		expect(new Set(cache.readViews().map((v) => v.idPath)).size).toBe(4);

		await backend.stop();
	});

	test("Given repeated restarts, When the storm ends, Then the roster is exactly four rows", async () => {
		const bus = new FakeBus({ tree: managedObjectsTree([...ROSTER]) });
		const backend = createDbusCellularBackend({
			cache,
			transport: bus.transport(),
		});
		await backend.start();

		for (let round = 0; round < 3; round += 1) {
			bus.setTree([]);
			bus.restartModemManager(`:1.${30000 + round}`);
			await settle();
			bus.setTree(managedObjectsTree([...RENUMBERED]));
			bus.interfacesAdded(RENUMBERED[0]?.path ?? "");
			await settle();
		}

		expect(cache.authority()).toBe("authoritative");
		expect(cache.readViews().length).toBe(4);
		expect(new Set(cache.readViews().map((v) => v.idPath)).size).toBe(4);

		await backend.stop();
	});

	test("Given a restart the roster never survives, When the settle deadline passes, Then the empty truth finally lands", async () => {
		const bus = new FakeBus({ tree: managedObjectsTree([...ROSTER]) });
		const backend = createDbusCellularBackend({
			cache,
			transport: bus.transport(),
		});
		await backend.start();

		bus.setTree([]);
		bus.restartModemManager(":1.40000");
		await settle();
		expect(cache.readViews().length).toBe(4);

		clock += EPOCH_SETTLE_MS + 1;
		bus.propertiesChanged("/org/freedesktop/ModemManager1/Modem/0");
		await settle();

		expect(cache.readViews()).toEqual([]);

		await backend.stop();
	});
});

describe("the startup cancellation contract", () => {
	test("Given a start that times out, When it LATER resolves, Then it performs zero cache writes", async () => {
		let releaseConnect: (() => void) | undefined;
		const connectGate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const bus = new FakeBus({
			tree: managedObjectsTree([...ROSTER]),
			connectGate,
		});
		const backend = createDbusCellularBackend({
			cache,
			transport: bus.transport(),
		});

		await initCellularStack({
			createDbusBackend: () => backend,
			initTimeoutMs: 5,
		});

		expect(getCellularStack()).toEqual({
			backend: "mmcli",
			ready: true,
			degraded: true,
			degradedReason: "cellular_dbus_init_failed",
		});
		expect(cache.authority()).toBe("initializing");

		// Release the delayed connect AFTER the fallback has been taken. The
		// observer has no stopped-generation checks between connect / subscribe /
		// owner-lookup, so it WILL re-issue all four match rules here — the
		// backend's own generation is what must retire them again.
		releaseConnect?.();
		await settle();
		await settle();

		expect(cache.authority()).toBe("initializing");
		expect(cache.readViews()).toEqual([]);
		expect(bus.transport().subscriptionCount()).toBe(0);
		expect(bus.connected).toBe(false);
		expect(bus.disconnectCount).toBeGreaterThanOrEqual(2);
	});

	test("Given a start that times out on the SNAPSHOT, When it later resolves, Then no authority change happens", async () => {
		let releaseSnapshot: (() => void) | undefined;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const bus = new FakeBus({
			tree: managedObjectsTree([...ROSTER]),
			snapshotGate,
		});
		const backend = createDbusCellularBackend({
			cache,
			transport: bus.transport(),
		});

		await initCellularStack({
			createDbusBackend: () => backend,
			initTimeoutMs: 5,
		});
		expect(getCellularStack().degraded).toBe(true);

		releaseSnapshot?.();
		await settle();
		await settle();

		expect(cache.authority()).toBe("initializing");
		expect(cache.readViews()).toEqual([]);
	});

	test("Given an already-stopped backend, When start is called, Then it never touches the bus", async () => {
		const bus = new FakeBus({ tree: managedObjectsTree([...ROSTER]) });
		const backend = createDbusCellularBackend({
			cache,
			transport: bus.transport(),
		});

		await backend.stop();
		const result = await backend.start();

		expect(result.ok).toBe(false);
		expect(bus.snapshotCalls).toBe(0);
	});
});
