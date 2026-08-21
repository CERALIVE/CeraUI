import { beforeEach, describe, expect, test } from "bun:test";

import {
	COALESCE_MS,
	DbusModemCache,
	EPOCH_SETTLE_MS,
	REASON_MM_RESTARTING,
	REASON_MM_UNAVAILABLE,
} from "../modules/cellular/dbus-modem-cache.ts";
import type { DbusModemView } from "../modules/modems/modem-wire-adapters.ts";

function view(
	runtimeId: number,
	overrides: Partial<DbusModemView> = {},
): DbusModemView {
	return {
		runtimeId,
		idPath: `/sys/devices/platform/usb/1-1.${runtimeId}`,
		ifname: `wwan${runtimeId}`,
		mmState: "connected",
		registration: { status: "home", activeRats: new Set(["lte"]) },
		signal: 60,
		supportedNetworkTypes: ["4g"],
		activeNetworkType: "4g",
		...overrides,
	};
}

const EPOCH_A = ":1.9";
const EPOCH_B = ":1.21509";

let cache: DbusModemCache;
let clock: number;
let notifications: number;

beforeEach(() => {
	cache = new DbusModemCache();
	clock = 1_000_000;
	notifications = 0;
	cache.setClock(() => clock);
	cache.subscribe(() => {
		notifications += 1;
	});
});

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("authority", () => {
	test("Given nothing observed, When the wire producer reads, Then it gets nothing and mmcli stays authoritative", () => {
		expect(cache.authority()).toBe("initializing");
		expect(cache.readViews()).toEqual([]);
	});

	test("Given the first snapshot, When applied, Then it becomes authoritative immediately", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);

		expect(cache.authority()).toBe("authoritative");
		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([1, 2]);
		expect(notifications).toBe(1);
	});

	test("Given an authoritative roster, When a snapshot OMITS a modem, Then it is removed", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);
		cache.applySnapshot(EPOCH_A, [view(1)]);

		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([1]);
	});

	test("Given an unchanged snapshot, When re-applied, Then nothing is published", () => {
		cache.applySnapshot(EPOCH_A, [view(1)]);
		const before = notifications;

		cache.applySnapshot(EPOCH_A, [view(1)]);

		expect(notifications).toBe(before);
	});
});

describe("the two failure classes are separated", () => {
	test("Given a client failure while MM is alive, When reported, Then the cache demotes below mmcli", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);

		cache.applyFailure("bus-error");

		expect(cache.authority()).toBe("demoted");
		expect(cache.readViews()).toEqual([]);
	});

	test("Given MM's bus name lost, When reported, Then rows are RETAINED and marked, never dropped", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);

		cache.applyFailure("source-unavailable");

		expect(cache.authority()).toBe("retained-stale");
		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([1, 2]);
		expect(
			cache
				.readViews()
				.every((v) => v.availabilityReason === REASON_MM_UNAVAILABLE),
		).toBe(true);
	});

	test("Given an owner loss with nothing observed yet, When reported, Then there is nothing to retain", () => {
		cache.applyFailure("source-unavailable");

		expect(cache.authority()).toBe("demoted");
		expect(cache.readViews()).toEqual([]);
	});
});

describe("the MM-restart empty-snapshot landmine (todo 16 gate 4)", () => {
	test("Given a live roster, When a new epoch resnapshots EMPTY, Then the operator's list is NOT blanked", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2), view(3), view(4)]);

		cache.applyFailure("source-unavailable");
		cache.applySnapshot(EPOCH_B, []);

		expect(cache.authority()).toBe("settling");
		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([1, 2, 3, 4]);
		expect(
			cache
				.readViews()
				.every((v) => v.availabilityReason === REASON_MM_RESTARTING),
		).toBe(true);
	});

	test("Given a settling epoch, When the roster refills gradually, Then re-probed rows go live and the rest stay marked", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2), view(3), view(4)]);
		cache.applyFailure("source-unavailable");
		cache.applySnapshot(EPOCH_B, []);

		// The new owner renumbers the whole roster (todo 16: 11,13,14,15 -> 0,1,2,3),
		// so the carried rows are matched on ID_PATH, never on the MM index.
		cache.applySnapshot(EPOCH_B, [
			{ ...view(1), runtimeId: 0 },
			{ ...view(2), runtimeId: 1 },
		]);

		expect(cache.authority()).toBe("settling");
		const rows = cache.readViews();
		expect(rows.filter((v) => v.availabilityReason === undefined).length).toBe(
			2,
		);
		expect(
			rows.filter((v) => v.availabilityReason === REASON_MM_RESTARTING).length,
		).toBe(2);
	});

	test("Given a settling epoch, When the roster is fully back, Then authority returns and no ghost row survives", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);
		cache.applyFailure("source-unavailable");
		cache.applySnapshot(EPOCH_B, []);

		cache.applySnapshot(EPOCH_B, [
			{ ...view(1), runtimeId: 0 },
			{ ...view(2), runtimeId: 1 },
		]);

		expect(cache.authority()).toBe("authoritative");
		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([0, 1]);
		expect(
			cache.readViews().every((v) => v.availabilityReason === undefined),
		).toBe(true);
	});

	test("Given a modem genuinely unplugged DURING the restart, When the settle deadline passes, Then it is finally dropped", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);
		cache.applyFailure("source-unavailable");
		cache.applySnapshot(EPOCH_B, []);
		expect(cache.readViews().length).toBe(2);

		clock += EPOCH_SETTLE_MS + 1;
		cache.applySnapshot(EPOCH_B, [{ ...view(1), runtimeId: 0 }]);

		expect(cache.authority()).toBe("authoritative");
		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([0]);
	});

	test("Given a row retired at settle end, When a LATER epoch settles, Then it is not re-injected (no tombstone needed)", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);
		cache.applyFailure("source-unavailable");
		cache.applySnapshot(EPOCH_B, []);
		clock += EPOCH_SETTLE_MS + 1;
		cache.applySnapshot(EPOCH_B, [view(1)]);
		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([1]);

		cache.applyFailure("source-unavailable");
		cache.applySnapshot(":1.30000", []);

		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([1]);
	});

	test("Given a row with no ID_PATH, When an epoch changes, Then it is NOT carried on the MM index alone", () => {
		const anchorless = { ...view(7), idPath: undefined };
		cache.applySnapshot(EPOCH_A, [anchorless]);

		cache.applyFailure("source-unavailable");
		cache.applySnapshot(EPOCH_B, []);

		expect(cache.readViews()).toEqual([]);
	});
});

describe("publication bounds", () => {
	test("Given a signal-only change, When applied, Then publication is COALESCED", async () => {
		cache.applySnapshot(EPOCH_A, [view(1)]);
		const before = notifications;

		cache.applySnapshot(EPOCH_A, [view(1, { signal: 61 })]);
		cache.applySnapshot(EPOCH_A, [view(1, { signal: 62 })]);
		cache.applySnapshot(EPOCH_A, [view(1, { signal: 63 })]);

		expect(notifications).toBe(before);
		expect(cache.readViews()[0]?.signal).toBe(63);

		await sleep(COALESCE_MS + 40);
		expect(notifications).toBe(before + 1);
	});

	test("Given a state change, When applied, Then it propagates IMMEDIATELY", () => {
		cache.applySnapshot(EPOCH_A, [view(1)]);
		const before = notifications;

		cache.applySnapshot(EPOCH_A, [view(1, { mmState: "searching" })]);

		expect(notifications).toBe(before + 1);
	});

	test("Given a plug event, When applied, Then it propagates IMMEDIATELY", () => {
		cache.applySnapshot(EPOCH_A, [view(1)]);
		const before = notifications;

		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);

		expect(notifications).toBe(before + 1);
	});

	test("Given a pending signal coalesce, When a plug event lands, Then one frame carries both", async () => {
		cache.applySnapshot(EPOCH_A, [view(1)]);
		const before = notifications;

		cache.applySnapshot(EPOCH_A, [view(1, { signal: 65 })]);
		cache.applySnapshot(EPOCH_A, [view(1, { signal: 65 }), view(2)]);

		expect(notifications).toBe(before + 1);
		await sleep(COALESCE_MS + 40);
		expect(notifications).toBe(before + 1);
	});

	test("Given an event storm of identical snapshots, When applied, Then nothing is published at all", () => {
		cache.applySnapshot(EPOCH_A, [view(1)]);
		const before = notifications;

		for (let i = 0; i < 50; i += 1) {
			cache.applySnapshot(EPOCH_A, [view(1)]);
		}

		expect(notifications).toBe(before);
	});
});

describe("event-order failures", () => {
	test("Given duplicate adds in one snapshot, When applied, Then the roster is what the snapshot said", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(1)]);
		cache.applySnapshot(EPOCH_A, [view(1)]);

		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([1]);
	});

	test("Given rows arriving in a different ORDER, When applied, Then the snapshot's order is served verbatim", () => {
		cache.applySnapshot(EPOCH_A, [view(1), view(2)]);
		cache.applySnapshot(EPOCH_A, [view(2), view(1)]);

		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([2, 1]);
	});

	test("Given a rapid replug, When the modem returns under a new index, Then exactly one row survives", () => {
		cache.applySnapshot(EPOCH_A, [view(12)]);
		cache.applySnapshot(EPOCH_A, []);
		cache.applySnapshot(EPOCH_A, [{ ...view(12), runtimeId: 15 }]);

		expect(cache.readViews().map((v) => v.runtimeId)).toEqual([15]);
	});

	test("Given a reset, When the wire producer reads, Then every cache, timer and tombstone is gone", () => {
		cache.applySnapshot(EPOCH_A, [view(1)]);

		cache.reset();

		expect(cache.authority()).toBe("initializing");
		expect(cache.readViews()).toEqual([]);
	});
});
