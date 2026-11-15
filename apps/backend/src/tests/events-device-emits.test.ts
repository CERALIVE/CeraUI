import { afterEach, expect, spyOn, test } from "bun:test";
import type { EventCode, EventParams } from "@ceraui/rpc/events";
import {
	type DeviceEvent,
	deviceEventSchema,
	LOW_DISK_THRESHOLD_BYTES,
	type LogBootInfo,
	type VersionContext,
	versionContextSchema,
} from "@ceraui/rpc/schemas";
import * as classified from "../modules/device-logs/classified-boots.ts";
import * as emitter from "../modules/events/emit.ts";
import * as store from "../modules/events/store.ts";
import * as context from "../modules/system/version-context.ts";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const PREVIOUS = "123456788694489b8c3a3fb4795cab24";
const versions: VersionContext = {
	bootId: BOOT,
	osImage: "2026.11.3-beta",
	slot: "rootfs.1",
	board: "ceralive,rk3588",
	boardModel: "Radxa ROCK 5B+",
	ceraui: "2026.11.3",
	engine: "2026.11.1",
	senderVersion: "1.4.0",
	kernel: "6.1",
	bun: "1.4.4",
};
const previous: LogBootInfo = {
	bootId: PREVIOUS,
	index: -1,
	firstTs: 1,
	lastTs: 2,
	current: false,
	shutdown: "unclean",
	evidence: ["no_shutdown_markers", "shutdown_requested_event"],
	logsAvailable: true,
	versions: null,
};
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	emitter.resetEventEmitterForTest();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
	restores.push(() => spy.mockRestore());
	return spy;
}
function recording() {
	const calls: Array<{ code: EventCode; params: EventParams<EventCode> }> = [];
	const emit = keep(spyOn(emitter, "emitEvent")).mockImplementation(
		(code, params) => {
			calls.push({ code, params });
		},
	);
	return { calls, emit };
}
function startup(rows: LogBootInfo[] = []) {
	keep(spyOn(context, "collectVersionContext")).mockResolvedValue(versions);
	keep(spyOn(classified, "listBoots")).mockResolvedValue(rows);
	const append = keep(spyOn(store, "appendBoot")).mockImplementation(() => {});
	keep(spyOn(Date, "now")).mockReturnValue(1234);
	return { ...recording(), append };
}

test("startup stores object versions and emits only flat, wire-preserved params", async () => {
	const h = startup();
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await recordDeviceStart();
	const { bootId: _bootId, ...flat } = versions;
	expect(h.append.mock.calls).toEqual([
		[{ bootId: BOOT, startedAt: 1234, versions }],
	]);
	expect(h.calls).toEqual([
		{
			code: "device_started",
			params: { ...flat, previousBootId: null, previousShutdown: null },
		},
	]);
	const event: DeviceEvent = {
		id: "start",
		seq: 1,
		bootId: BOOT,
		at: 1234,
		family: "device",
		severity: "info",
		code: "device_started",
		params: { ...flat, previousBootId: null, previousShutdown: null },
	};
	expect(deviceEventSchema.parse(event)).toEqual(event);
});

for (const shutdown of ["clean", "unclean", "unknown"] as const) {
	test(`startup selects journal index -1 and reports ${shutdown}`, async () => {
		const h = startup([
			{
				...previous,
				index: 0,
				bootId: BOOT,
				shutdown: "current",
				current: true,
			},
			{ ...previous, shutdown },
			{ ...previous, index: -2, bootId: "a".repeat(32), shutdown: "unclean" },
		]);
		const { recordDeviceStart } = await import(
			"../modules/events/device-start.ts"
		);
		await recordDeviceStart();
		const { bootId: _bootId, ...flat } = versions;
		expect(h.calls).toEqual([
			{
				code: "device_started",
				params: {
					...flat,
					previousBootId: PREVIOUS,
					previousShutdown: shutdown,
				},
			},
			...(shutdown === "unclean"
				? [
						{
							code: "previous_boot_unclean" as const,
							params: { bootId: PREVIOUS, evidence: previous.evidence },
						},
					]
				: []),
		]);
	});
}

test("a missing index -1 never substitutes an older stored boot", async () => {
	const h = startup([{ ...previous, index: -2 }]);
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await recordDeviceStart();
	expect(h.calls[0]?.params).toMatchObject({
		previousBootId: null,
		previousShutdown: null,
	});
	expect(h.calls).toHaveLength(1);
});

test("a current classification is never sent as a previous shutdown value", async () => {
	const h = startup([{ ...previous, shutdown: "current" }]);
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await recordDeviceStart();
	expect(h.calls[0]?.params).toMatchObject({
		previousBootId: PREVIOUS,
		previousShutdown: null,
	});
	expect(h.calls).toHaveLength(1);
});

test("a boot-list failure still stores and emits the current version context", async () => {
	const h = startup();
	keep(spyOn(classified, "listBoots")).mockRejectedValue(
		new Error("journal unavailable"),
	);
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await recordDeviceStart();
	expect(h.append).toHaveBeenCalledTimes(1);
	expect(h.calls[0]?.params).toMatchObject({
		previousBootId: null,
		previousShutdown: null,
	});
});

test("a failed version collection never appends or emits an invented boot", async () => {
	const h = startup();
	const { bootId: _bootId, ...withoutBoot } = versions;
	keep(spyOn(context, "collectVersionContext")).mockImplementation(async () =>
		versionContextSchema.parse(withoutBoot),
	);
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await expect(recordDeviceStart()).rejects.toThrow();
	expect(h.append).not.toHaveBeenCalled();
	expect(h.calls).toHaveLength(0);
});

test("a throwing boot store does not erase the start or previous-boot event", async () => {
	const h = startup([previous]);
	h.append.mockImplementation(() => {
		throw new Error("disk failure");
	});
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await recordDeviceStart();
	expect(h.calls.map(({ code }) => code)).toEqual([
		"device_started",
		"previous_boot_unclean",
	]);
});

test("throwing start emitters cannot prevent the next event or reject startup", async () => {
	const h = startup([previous]);
	h.emit.mockImplementation((code) => {
		h.calls.push({ code, params: {} });
		throw new Error("consumer failed");
	});
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await recordDeviceStart();
	expect(h.calls.map(({ code }) => code)).toEqual([
		"device_started",
		"previous_boot_unclean",
	]);
	expect(h.append).toHaveBeenCalledTimes(1);
});

test("disk edges preserve the strict threshold and survive unavailable samples", async () => {
	const h = recording();
	const { createDiskEventObserver } = await import(
		"../modules/events/device-disk.ts"
	);
	const observe = createDiskEventObserver();
	const disk = (free: number) => ({ total: 2 ** 32, used: 2 ** 32 - free });
	observe(disk(LOW_DISK_THRESHOLD_BYTES));
	observe(disk(LOW_DISK_THRESHOLD_BYTES - 1));
	observe(disk(LOW_DISK_THRESHOLD_BYTES - 2));
	observe(null);
	observe(disk(LOW_DISK_THRESHOLD_BYTES));
	observe(disk(LOW_DISK_THRESHOLD_BYTES + 1));
	expect(h.calls).toEqual([
		{ code: "disk_low", params: { freeBytes: LOW_DISK_THRESHOLD_BYTES - 1 } },
		{ code: "disk_ok", params: { freeBytes: LOW_DISK_THRESHOLD_BYTES } },
	]);
});

test.each([0, LOW_DISK_THRESHOLD_BYTES - 1])(
	"first low reading %s emits once per observer",
	async (freeBytes) => {
		const h = recording();
		const { createDiskEventObserver } = await import(
			"../modules/events/device-disk.ts"
		);
		const observe = createDiskEventObserver();
		observe({ total: freeBytes, used: 0 });
		observe({ total: freeBytes, used: 0 });
		expect(h.calls).toEqual([{ code: "disk_low", params: { freeBytes } }]);
		createDiskEventObserver()({ total: freeBytes, used: 0 });
		expect(h.calls).toHaveLength(2);
	},
);

for (const invalid of [
	undefined,
	"",
	{},
	[],
	{ total: 1 },
	{ used: 1 },
	{ total: "1", used: 0 },
	{ total: -1, used: 0 },
	{ total: 1, used: -1 },
	{ total: LOW_DISK_THRESHOLD_BYTES - 1, used: -1 },
	{ total: 1, used: 2 },
	{ total: 0.5, used: 0 },
	{ total: 2, used: 0.5 },
	{ total: Number.MAX_SAFE_INTEGER + 1, used: 0 },
	{ total: Number.MAX_SAFE_INTEGER, used: Number.MAX_SAFE_INTEGER + 1 },
	{ total: Infinity, used: 0 },
	{ total: NaN, used: 0 },
	{ total: 1, used: NaN },
]) {
	test(`invalid disk reading ${JSON.stringify(invalid)} does not move the edge latch`, async () => {
		const h = recording();
		const { createDiskEventObserver } = await import(
			"../modules/events/device-disk.ts"
		);
		const observe = createDiskEventObserver();
		observe(invalid);
		expect(h.calls).toEqual([]);
		observe({ total: 1, used: 1 });
		observe(invalid);
		observe({ total: 1, used: 1 });
		expect(h.calls).toEqual([{ code: "disk_low", params: { freeBytes: 0 } }]);
	});
}

test("safe integer disk extremes retain exact bytes", async () => {
	const h = recording();
	const { createDiskEventObserver } = await import(
		"../modules/events/device-disk.ts"
	);
	const observe = createDiskEventObserver();
	observe({ total: Number.MAX_SAFE_INTEGER, used: Number.MAX_SAFE_INTEGER });
	observe({ total: Number.MAX_SAFE_INTEGER, used: 0 });
	expect(h.calls).toEqual([
		{ code: "disk_low", params: { freeBytes: 0 } },
		{ code: "disk_ok", params: { freeBytes: Number.MAX_SAFE_INTEGER } },
	]);
});

test("throwing disk consumers do not escape or replay an edge", async () => {
	const h = recording();
	h.emit.mockImplementation((code, params) => {
		h.calls.push({ code, params });
		throw new Error("consumer failed");
	});
	const { createDiskEventObserver } = await import(
		"../modules/events/device-disk.ts"
	);
	const observe = createDiskEventObserver();
	observe({ total: 1, used: 1 });
	observe({ total: 1, used: 1 });
	observe({ total: 2 ** 32, used: 0 });
	expect(h.calls.map(({ code }) => code)).toEqual(["disk_low", "disk_ok"]);
});

test("startup reaches the real typed registry, durable rings, journal and throwing subscriber", async () => {
	keep(spyOn(context, "collectVersionContext")).mockResolvedValue(versions);
	keep(spyOn(classified, "listBoots")).mockResolvedValue([previous]);
	keep(spyOn(Date, "now")).mockReturnValue(2345);
	const journal: unknown[][] = [];
	const pushed: DeviceEvent[] = [];
	emitter.resetEventEmitterForTest({
		bootId: () => BOOT,
		now: () => 2345,
		log: (...args) => {
			journal.push(args);
		},
	});
	emitter.setEventSink((event) => {
		pushed.push(event);
		throw new Error("broken subscriber");
	});
	const { recordDeviceStart } = await import(
		"../modules/events/device-start.ts"
	);
	await recordDeviceStart();
	expect(store.readBoots()).toEqual([
		{ bootId: BOOT, startedAt: 2345, versions },
	]);
	const events = store.readEvents();
	expect(events.map(({ code }) => code)).toEqual([
		"device_started",
		"previous_boot_unclean",
	]);
	expect(events.map((event) => deviceEventSchema.parse(event))).toEqual(pushed);
	expect(journal.map(([level, message]) => [level, message])).toEqual([
		["info", "event"],
		["warn", "event"],
	]);
});

test("disk reentrancy observes the new latch before a consumer calls back", async () => {
	const h = recording();
	const { createDiskEventObserver } = await import(
		"../modules/events/device-disk.ts"
	);
	const observe = createDiskEventObserver();
	h.emit.mockImplementation((code, params) => {
		h.calls.push({ code, params });
		observe({ total: 1, used: 1 });
	});
	observe({ total: 1, used: 1 });
	expect(h.calls).toEqual([{ code: "disk_low", params: { freeBytes: 0 } }]);
});
