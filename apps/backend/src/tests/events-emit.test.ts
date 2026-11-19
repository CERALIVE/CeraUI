import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as timers from "node:timers";
import {
	EVENT_REGISTRY,
	type EventCode,
	type EventParams,
} from "@ceraui/rpc/events";
import { type DeviceEvent, deviceEventSchema } from "@ceraui/rpc/schemas";
import {
	formatProdEntry,
	logger,
	logRedact,
	redact,
} from "../helpers/logger.ts";
import { currentBootId } from "../modules/device-logs/boot-id.ts";
import {
	type EventEmitterDeps,
	emitEvent,
	resetEventEmitterForTest,
	setEventSink,
} from "../modules/events/emit.ts";
import { appendEvent, readEvents, tailSeq } from "../modules/events/store.ts";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const NEXT_BOOT = "123456788694489b8c3a3fb4795cab24";
const link = { iface: "eth0", kind: "ethernet" } as const;

function harness(overrides: Partial<EventEmitterDeps> = {}) {
	let now = 10_000;
	let boot: string | undefined = BOOT;
	const stored: { event: DeviceEvent; sync: boolean }[] = [];
	const journal: unknown[][] = [];
	const pushed: DeviceEvent[] = [];
	const warnings: unknown[][] = [];
	const timers: {
		fn: () => void;
		due: number;
		active: boolean;
		unrefs: number;
		cancels: number;
	}[] = [];
	let seeds = 0;
	resetEventEmitterForTest({
		now: () => now,
		bootId: () => boot,
		tailSeq: () => {
			seeds++;
			return 40;
		},
		appendEvent: (event, { sync }) => stored.push({ event, sync }),
		log: (...args) => journal.push(args),
		warn: (...args) => warnings.push(args),
		schedule: (fn, ms) => {
			const timer = { fn, due: now + ms, active: true, unrefs: 0, cancels: 0 };
			timers.push(timer);
			return {
				unref: () => timer.unrefs++,
				cancel: () => {
					timer.active = false;
					timer.cancels++;
				},
			};
		},
		...overrides,
	});
	setEventSink((event) => pushed.push(event));
	return {
		stored,
		journal,
		pushed,
		warnings,
		timers,
		get seeds() {
			return seeds;
		},
		setNow(value: number) {
			now = value;
		},
		setBoot(value: string | undefined) {
			boot = value;
		},
		advance(value: number) {
			now = value;
			for (const timer of timers) {
				if (timer.active && timer.due <= now) {
					timer.active = false;
					timer.fn();
				}
			}
		},
	};
}

// Include every declared key, including optional keys, without copying the registry.
function sample<C extends EventCode>(code: C): EventParams<C> {
	const candidates: unknown[] = [
		"x",
		1,
		true,
		["x"],
		BOOT,
		"52fd5e45-627d-4a10-a263-9129880c4330",
		"ethernet",
		"probe_failed",
		"operator",
		"engine_unavailable",
		"connect",
		"no_signal",
		"streaming",
		"start_failed",
		90,
		"download",
		"clean",
		"reboot",
		"SIGTERM",
		null,
	];
	const fields = Object.entries(EVENT_REGISTRY[code].params.shape).map(
		([key, schema]) => {
			const value = candidates.find((value) => schema.safeParse(value).success);
			expect(value, `${code}.${key} has a sample`).not.toBeUndefined();
			return [key, value];
		},
	);
	return EVENT_REGISTRY[code].params.parse(
		Object.fromEntries(fields),
	) as EventParams<C>;
}

afterEach(() => resetEventEmitterForTest());

test("one typed emit synchronously appends, journals and pushes one stamped record", () => {
	const h = harness();
	expect(h.seeds).toBe(0);
	expect(emitEvent("link_down", link)).toBeUndefined();
	expect(h.stored).toEqual([
		{
			event: {
				id: "66d8d180-41",
				seq: 41,
				bootId: BOOT,
				at: 10_000,
				code: "link_down",
				family: "network",
				severity: "warning",
				params: link,
			},
			sync: true,
		},
	]);
	expect(h.journal).toEqual([
		[
			"warn",
			"event",
			{
				module: "events",
				event_id: "66d8d180-41",
				code: "link_down",
				params: link,
			},
		],
	]);
	expect<unknown>(h.pushed).toEqual([h.stored[0]?.event]);
	h.setNow(10_001);
	emitEvent("engine_recovered", { streaming: false });
	expect(h.stored[1]?.event.seq).toBe(42);
	expect(h.stored[1]?.event.at).toBe(10_001);
	expect(h.seeds).toBe(1);
});

test("three link_down occurrences fold to the latest trailing record with suppressed two", () => {
	const h = harness();
	emitEvent("link_down", { ...link, downSec: 1 });
	h.setNow(10_001);
	emitEvent("link_down", { ...link, downSec: 2 });
	h.setNow(39_999);
	emitEvent("link_down", { ...link, downSec: 3 });
	expect(h.stored).toHaveLength(1);
	expect(h.journal).toHaveLength(1);
	expect(h.pushed).toHaveLength(1);
	expect(h.timers).toHaveLength(1);
	expect(h.timers[0]?.due).toBe(40_000);
	expect(h.timers[0]?.unrefs).toBe(1);
	h.advance(39_999);
	expect(h.stored).toHaveLength(1);
	h.advance(40_000);
	expect(h.stored[1]).toEqual({
		event: {
			id: "66d8d180-42",
			seq: 42,
			bootId: BOOT,
			at: 40_000,
			code: "link_down",
			family: "network",
			severity: "warning",
			params: { ...link, downSec: 3 },
			suppressed: 2,
		},
		sync: true,
	});
	expect(h.journal).toHaveLength(2);
	expect(h.pushed).toEqual(h.stored.map(({ event }) => event));
	expect(h.timers.filter((t) => t.active)).toHaveLength(0);
	h.advance(100_000);
	expect(h.stored).toHaveLength(2);
});

test("a fifty occurrence storm ends with exactly two records and forty nine suppressed", () => {
	const h = harness();
	for (let n = 0; n < 50; n++) emitEvent("link_down", { ...link, downSec: n });
	h.advance(40_000);
	expect(h.stored).toHaveLength(2);
	expect(h.stored[1]?.event.params.downSec).toBe(49);
	expect(h.stored[1]?.event.suppressed).toBe(49);
	expect(h.journal).toHaveLength(2);
	expect(h.pushed).toHaveLength(2);
});

test("registry subjects combine state codes but separate interfaces", () => {
	const h = harness();
	emitEvent("link_down", link);
	emitEvent("link_up", { ...link, downSec: 4 });
	emitEvent("link_down", { ...link, iface: "eth1" });
	h.advance(40_000);
	expect(
		h.stored.map(({ event }) => [
			event.code,
			event.params.iface,
			event.suppressed,
		]),
	).toEqual([
		["link_down", "eth0", undefined],
		["link_down", "eth1", undefined],
		["link_up", "eth0", 1],
	]);
	expect(h.stored[2]?.event.severity).toBe("success");
	expect(h.journal[2]?.[0]).toBe("info");
});

test.each([40_000, 40_001])(
	"an occurrence at %i expires a delayed timer before opening a fresh window",
	(at) => {
		const h = harness();
		emitEvent("link_down", link);
		emitEvent("link_up", link);
		const stale = h.timers[0];
		h.setNow(at);
		emitEvent("link_down", { ...link, downSec: 9 });
		expect(h.stored.map(({ event }) => event.code)).toEqual([
			"link_down",
			"link_up",
			"link_down",
		]);
		expect(stale?.cancels).toBe(1);
		stale?.fn();
		expect(h.stored).toHaveLength(3);
		h.advance(at + 30_000);
		expect(h.stored).toHaveLength(3);
		expect(h.timers.filter((t) => t.active)).toHaveLength(0);
	},
);

test("empty windows expire silently and allow a new first occurrence", () => {
	const h = harness();
	emitEvent("link_down", link);
	h.advance(40_000);
	expect(h.stored).toHaveLength(1);
	emitEvent("link_up", link);
	expect(h.stored).toHaveLength(2);
	expect(h.stored[1]?.event).not.toHaveProperty("suppressed");
});

test("update identities emit once per boot per subject without timers", () => {
	const h = harness();
	emitEvent("update_os_staged", { id: "a", version: "v1" });
	emitEvent("update_os_staged", { id: "a", version: "v2" });
	h.advance(1_000_000);
	emitEvent("update_os_staged", { id: "a", version: "v3" });
	emitEvent("update_os_staged", { id: "b", version: "v4" });
	emitEvent("update_os_activated", { id: "a", version: "v5" });
	expect(h.stored.map(({ event }) => event.params.version)).toEqual([
		"v1",
		"v4",
		"v5",
	]);
	expect(h.timers).toEqual([]);
	h.setBoot(NEXT_BOOT);
	emitEvent("update_os_staged", { id: "a", version: "v6" });
	expect(h.stored[3]?.event).toMatchObject({
		id: "12345678-44",
		bootId: NEXT_BOOT,
		seq: 44,
		params: { version: "v6" },
	});
	expect(h.seeds).toBe(1);
});

test.each([
	{},
	{ ...link, kind: "bogus" },
	{ ...link, severity: "success" },
	{ ...link, subject: "other" },
	{ ...link, password: "private" },
	null,
	{ ...link, iccid: "private" },
])(
	"invalid params are dropped with exactly one warning and no side effects: %j",
	(params) => {
		const h = harness();
		expect(() =>
			Reflect.apply(emitEvent, null, ["link_down", params]),
		).not.toThrow();
		expect(h.stored).toEqual([]);
		expect(h.journal).toEqual([]);
		expect(h.pushed).toEqual([]);
		expect(h.timers).toEqual([]);
		expect(h.seeds).toBe(0);
		expect(h.warnings).toEqual([
			["invalid event params", { module: "events", code: "link_down" }],
		]);
	},
);

test("invalid folded params cannot replace a valid latest state", () => {
	const h = harness();
	emitEvent("link_down", link);
	emitEvent("link_up", link);
	Reflect.apply(emitEvent, null, ["link_down", {}]);
	h.advance(40_000);
	expect(h.stored[1]?.event).toMatchObject({ code: "link_up", suppressed: 1 });
	expect(h.warnings).toHaveLength(1);
});

test.each([
	[
		"stream_stopped",
		{ cause: "operator", durationSec: 1 },
		"info",
		"info",
		false,
	],
	[
		"stream_stopped",
		{ cause: "engine_loss", durationSec: 1 },
		"warning",
		"warn",
		true,
	],
	["stream_stop_failed", {}, "error", "error", true],
	["stream_started", {}, "success", "info", false],
] as const)(
	"registry severity controls %s with %j",
	(code, params, severity, level, sync) => {
		const h = harness();
		emitEvent(code, params);
		expect(h.stored[0]?.event.severity).toBe(severity);
		expect(h.stored[0]?.sync).toBe(sync);
		expect(h.journal[0]?.[0]).toBe(level);
	},
);

test("device_started synchronizes its first append", () => {
	const h = harness();
	emitEvent("device_started", sample("device_started"));
	expect(h.stored).toHaveLength(1);
	expect(h.stored[0]?.sync).toBe(true);
});

test("sync is limited to one per second with shutdown and service stop always synced", () => {
	const h = harness();
	h.setNow(0);
	emitEvent("link_down", link);
	h.setNow(999);
	emitEvent("stream_stop_failed", {});
	h.setNow(1_000);
	emitEvent("engine_lost", { streaming: true });
	emitEvent("shutdown_requested", { action: "reboot", origin: "operator" });
	emitEvent("service_stopping", { signal: "SIGTERM" });
	emitEvent("device_started", sample("device_started"));
	emitEvent("disk_low", { freeBytes: 1 });
	expect(h.stored.map(({ sync }) => sync)).toEqual([
		true,
		false,
		true,
		true,
		true,
		false,
		false,
	]);
});

test("ordinary info appends do not consume the sync allowance", () => {
	const h = harness();
	emitEvent("interface_added", link);
	emitEvent("link_down", { ...link, iface: "eth1" });
	expect(h.stored.map(({ sync }) => sync)).toEqual([false, true]);
});

test.each([
	"appendEvent",
	"log",
	"sink",
	"now",
	"tailSeq",
	"bootId",
	"schedule",
	"warn",
] as const)(
	"a throwing %s never escapes the synchronous caller",
	(dependency) => {
		const fail = () => {
			throw new Error("private failure");
		};
		const h = harness(dependency === "sink" ? {} : { [dependency]: fail });
		if (dependency === "sink") setEventSink(fail);
		expect(() => emitEvent("link_down", link)).not.toThrow();
		if (dependency === "appendEvent") {
			expect(h.journal).toHaveLength(1);
			expect(h.pushed).toHaveLength(1);
		}
		if (dependency === "log") {
			expect(h.stored).toHaveLength(1);
			expect(h.pushed).toHaveLength(1);
		}
		if (dependency === "sink") expect(h.stored).toHaveLength(1);
		if (dependency !== "warn") {
			expect(h.warnings).toStrictEqual([
				[
					dependency === "schedule"
						? "event scheduling failed"
						: "event emission failed",
					{ module: "events" },
				],
			]);
		}
		if (dependency === "warn") {
			expect(() =>
				Reflect.apply(emitEvent, null, ["link_down", {}]),
			).not.toThrow();
		}
	},
);

test("throwing trailing outputs are contained and release their timer", () => {
	const h = harness({
		appendEvent: () => {
			throw new Error("store");
		},
		log: () => {
			throw new Error("journal");
		},
		warn: () => {
			throw new Error("diagnostic");
		},
	});
	setEventSink(() => {
		throw new Error("sink");
	});
	emitEvent("link_down", link);
	emitEvent("link_up", link);
	expect(() => h.advance(40_000)).not.toThrow();
	expect(h.timers.filter((t) => t.active)).toHaveLength(0);
});

test("a throwing trailing clock is contained and releases the window", () => {
	let broken = false;
	const h = harness({
		now: () => {
			if (broken) throw new Error("clock");
			return 10_000;
		},
	});
	emitEvent("link_down", link);
	emitEvent("link_up", link);
	broken = true;
	expect(() => h.advance(40_000)).not.toThrow();
	expect(h.timers.filter((t) => t.active)).toHaveLength(0);
	expect(h.stored).toHaveLength(1);
	broken = false;
	emitEvent("link_up", link);
	expect(h.stored).toHaveLength(2);
});

test("unknown boot identity drops without inventing a boot id", () => {
	const h = harness();
	h.setBoot(undefined);
	emitEvent("link_down", link);
	expect(h.stored).toEqual([]);
	expect(h.timers).toEqual([]);
	h.setBoot(BOOT);
	emitEvent("link_down", link);
	expect(h.stored[0]?.event.bootId).toBe(BOOT);
});

test("reset cancels every timer clears the sink and reseeds sequence", () => {
	const h = harness();
	emitEvent("link_down", link);
	emitEvent("link_up", link);
	emitEvent("engine_lost", { streaming: false });
	resetEventEmitterForTest({
		tailSeq: () => 90,
		bootId: () => BOOT,
		now: () => 0,
		appendEvent: (event, { sync }) => h.stored.push({ event, sync }),
		log: () => {},
		warn: () => {},
	});
	expect(h.timers.map((t) => t.cancels)).toEqual([1, 1]);
	for (const timer of h.timers) timer.fn();
	expect(h.stored).toHaveLength(2);
	emitEvent("update_slots_current", { id: "after-reset" });
	expect(h.stored[2]?.event.seq).toBe(91);
	expect(h.pushed).toHaveLength(2);
});

test("changing boot retires old windows without flushing old states", () => {
	const h = harness();
	emitEvent("link_down", link);
	emitEvent("link_up", link);
	h.setBoot(NEXT_BOOT);
	emitEvent("link_down", link);
	h.advance(40_000);
	expect(h.stored.map(({ event }) => [event.bootId, event.code])).toEqual([
		[BOOT, "link_down"],
		[NEXT_BOOT, "link_down"],
	]);
	expect(h.timers[0]?.cancels).toBe(1);
});

test("clearing or replacing the sink takes effect for trailing records", () => {
	const h = harness();
	emitEvent("link_down", link);
	emitEvent("link_up", link);
	setEventSink(null);
	h.advance(40_000);
	expect(h.pushed).toHaveLength(1);
	const replacement: DeviceEvent[] = [];
	setEventSink((event) => replacement.push(event));
	emitEvent("link_down", link);
	expect<unknown>(replacement).toEqual([h.stored[2]?.event]);
});

test("coalescing retains at most 1024 subjects and releases capacity at expiry", () => {
	const h = harness();
	for (let n = 0; n < 2048; n++)
		emitEvent("link_down", { ...link, iface: `eth${n}` });
	expect(h.stored).toHaveLength(1024);
	expect(h.timers.filter((t) => t.active)).toHaveLength(1024);
	emitEvent("link_up", link);
	h.advance(40_000);
	expect(h.stored).toHaveLength(1025);
	expect(h.stored[1024]?.event).toMatchObject({
		code: "link_up",
		suppressed: 1,
	});
	expect(h.timers.filter((t) => t.active)).toHaveLength(0);
	emitEvent("link_down", { ...link, iface: "fresh" });
	expect(h.stored).toHaveLength(1026);
});

test("update dedupe stays bounded without admitting forgotten identities in the same boot", () => {
	const h = harness();
	for (let n = 0; n < 2048; n++)
		emitEvent("update_updates_available", { id: `${n}` });
	emitEvent("update_updates_available", { id: "0" });
	expect(h.stored).toHaveLength(1024);
	expect(h.timers).toEqual([]);
	h.setBoot(NEXT_BOOT);
	emitEvent("update_updates_available", { id: "0" });
	expect(h.stored).toHaveLength(1025);
});

test("native scheduled timers are unreferenced and cancelled by reset", () => {
	const h = harness();
	const realSetTimeout = timers.setTimeout;
	const native: ReturnType<typeof setTimeout>[] = [];
	const spy = spyOn(timers, "setTimeout").mockImplementation(
		Object.assign((...args: Parameters<typeof setTimeout>) => {
			const timer = realSetTimeout(...args);
			native.push(timer);
			return timer;
		}, realSetTimeout),
	);
	const cancel = spyOn(timers, "clearTimeout");
	try {
		resetEventEmitterForTest({
			bootId: () => BOOT,
			tailSeq: () => 0,
			appendEvent: (event, { sync }) => h.stored.push({ event, sync }),
			log: () => {},
			warn: () => {},
		});
		emitEvent("link_down", link);
		expect(spy).toHaveBeenCalledWith(expect.any(Function), 30_000);
		expect(native).toHaveLength(1);
		expect(native[0]?.hasRef()).toBe(false);
		resetEventEmitterForTest();
		expect(cancel).toHaveBeenCalledWith(native[0]);
		expect(cancel.mock.calls[0]?.[0]).toBe(native[0]);
	} finally {
		spy.mockRestore();
		cancel.mockRestore();
		for (const timer of native) clearTimeout(timer);
	}
});

test("the redaction seam scrubs a password key before storage journal and sink", () => {
	const schema = EVENT_REGISTRY.link_down.params;
	const parse = spyOn(schema, "safeParse").mockReturnValue({
		success: true,
		data: { ...link, password: "private" } as EventParams<"link_down">,
	});
	try {
		const h = harness();
		emitEvent("link_down", link);
		expect(h.stored[0]?.event.params).toEqual({
			...link,
			password: "[REDACTED]",
		});
		expect(h.pushed[0]?.params).toEqual({ ...link, password: "[REDACTED]" });
		expect(h.journal[0]?.[2]).toEqual({
			module: "events",
			event_id: "66d8d180-41",
			code: "link_down",
			params: { ...link, password: "[REDACTED]" },
		});
	} finally {
		parse.mockRestore();
	}
});

for (const code of Object.keys(EVENT_REGISTRY) as EventCode[]) {
	test(`${code}: every declared key survives redaction and producer to stored wire round-trip`, () => {
		const baseDir = mkdtempSync(join(tmpdir(), "event-emit-"));
		try {
			const h = harness({
				appendEvent: (event, options) =>
					appendEvent(event, { ...options, baseDir }),
				tailSeq: () => tailSeq({ baseDir }),
			});
			const params = sample(code);
			for (const key of Object.keys(EVENT_REGISTRY[code].params.shape)) {
				expect(logRedact({ [key]: "x" })).toEqual({ [key]: "x" });
			}
			emitEvent(code, params);
			const records = readEvents({ baseDir });
			expect(records).toHaveLength(1);
			expect<unknown>(deviceEventSchema.parse(records[0]).params).toEqual(
				params,
			);
			expect(records[0]).toMatchObject({
				code,
				family: EVENT_REGISTRY[code].family,
				severity: EVENT_REGISTRY[code].severity(params),
			});
			expect(h.pushed).toEqual(records);
			const severity = EVENT_REGISTRY[code].severity(params);
			expect(h.journal).toEqual([
				[
					severity === "error"
						? "error"
						: severity === "warning"
							? "warn"
							: "info",
					"event",
					{ module: "events", event_id: "66d8d180-1", code, params },
				],
			]);
			const info = redact().transform({
				level: "info",
				message: "event",
				module: "events",
				params,
			});
			if (typeof info !== "object") throw new Error("redaction dropped event");
			expect(JSON.parse(formatProdEntry(info)).meta.params).toEqual(params);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
}

test("secret shaped values are redacted in the latest folded payload", () => {
	const h = harness();
	emitEvent("link_down", link);
	emitEvent("link_up", { ...link, displayName: "Bearer private" });
	h.advance(40_000);
	expect(h.stored[1]?.event.params.displayName).toBe("[REDACTED]");
	expect(h.pushed[1]?.params.displayName).toBe("[REDACTED]");
});

test("default logger and store dependencies are used by the public emitter", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "event-default-"));
	const old = process.env.CERALIVE_EVENTS_DIR;
	process.env.CERALIVE_EVENTS_DIR = baseDir;
	const log = spyOn(logger, "log").mockImplementation(() => logger);
	const clock = spyOn(Date, "now").mockReturnValue(12345);
	try {
		resetEventEmitterForTest();
		emitEvent("update_slots_current", { id: "default" });
		const records = readEvents({ baseDir });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			bootId: currentBootId(),
			at: 12345,
			seq: 1,
		});
		expect(log).toHaveBeenCalledWith("info", "event", {
			module: "events",
			event_id: `${currentBootId()?.slice(0, 8)}-1`,
			code: "update_slots_current",
			params: { id: "default" },
		});
	} finally {
		log.mockRestore();
		clock.mockRestore();
		if (old === undefined) delete process.env.CERALIVE_EVENTS_DIR;
		else process.env.CERALIVE_EVENTS_DIR = old;
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("default warning output reports invalid params once without their contents", () => {
	const warning = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		resetEventEmitterForTest();
		Reflect.apply(emitEvent, null, ["link_down", { password: "private" }]);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledWith("invalid event params", {
			module: "events",
			code: "link_down",
		});
	} finally {
		warning.mockRestore();
	}
});

test("explicit undefined optional params are omitted before storage", () => {
	const h = harness();
	emitEvent("link_down", { ...link, displayName: undefined });
	expect(h.stored[0]?.event.params).toEqual(link);
	expect(deviceEventSchema.safeParse(h.stored[0]?.event).success).toBe(true);
});

test("unref failure cancels the allocated timer and allows the subject to retry", () => {
	let broken = true;
	let cancels = 0;
	const h = harness({
		schedule: () => ({
			unref: () => {
				if (broken) throw new Error("unref");
			},
			cancel: () => {
				cancels++;
			},
		}),
	});
	expect(() => emitEvent("link_down", link)).not.toThrow();
	expect(cancels).toBe(1);
	expect(h.stored).toHaveLength(0);
	expect(h.warnings).toEqual([
		["event scheduling failed", { module: "events" }],
	]);
	broken = false;
	emitEvent("link_down", link);
	expect(h.stored).toHaveLength(1);
});

test("reset contains a throwing timer cancellation and invalidates stale callbacks", () => {
	let callback = () => {};
	const h = harness({
		schedule: (fn) => {
			callback = fn;
			return {
				unref: () => {},
				cancel: () => {
					throw new Error("cancel");
				},
			};
		},
		warn: () => {
			throw new Error("warning");
		},
	});
	emitEvent("link_down", link);
	emitEvent("link_up", link);
	expect(() => resetEventEmitterForTest()).not.toThrow();
	expect(() => callback()).not.toThrow();
	expect(h.stored).toHaveLength(1);
});

test("shutdown sync consumes the following second allowance and a new boot resets it", () => {
	const h = harness();
	h.setNow(500);
	emitEvent("shutdown_requested", { action: "poweroff", origin: "operator" });
	h.setNow(1000);
	emitEvent("link_down", link);
	h.setBoot(NEXT_BOOT);
	emitEvent("link_down", link);
	expect(h.stored.map(({ sync }) => sync)).toEqual([true, false, true]);
});

test("the default sequence seed resumes from records already on disk", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "event-seed-"));
	const old = process.env.CERALIVE_EVENTS_DIR;
	process.env.CERALIVE_EVENTS_DIR = baseDir;
	try {
		const h = harness({
			tailSeq: () => 87,
			appendEvent: (event, options) =>
				appendEvent(event, { ...options, baseDir }),
		});
		emitEvent("update_slots_current", { id: "before" });
		resetEventEmitterForTest({
			bootId: () => BOOT,
			now: () => 0,
			log: () => {},
			warn: () => {},
		});
		emitEvent("update_slots_current", { id: "after" });
		expect(readEvents({ baseDir }).map((event) => event.seq)).toEqual([88, 89]);
		expect(h.pushed).toHaveLength(1);
	} finally {
		if (old === undefined) delete process.env.CERALIVE_EVENTS_DIR;
		else process.env.CERALIVE_EVENTS_DIR = old;
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("sequence zero remains initialized instead of consulting the tail again", () => {
	let reads = 0;
	const h = harness({
		tailSeq: () => {
			reads++;
			return -1;
		},
	});
	emitEvent("update_slots_current", { id: "first" });
	emitEvent("update_slots_current", { id: "second" });
	expect(h.stored.map(({ event }) => event.seq)).toEqual([0, 1]);
	expect(reads).toBe(1);
});

for (const expiry of ["occurrence", "scheduler"] as const) {
	test.each(["same subject", "different subject", "update family"] as const)(
		`boundary sink reentry via ${expiry} retains window ownership for %s`,
		(target) => {
			const h = harness();
			emitEvent("link_down", link);
			emitEvent("link_up", link);
			let reentered = false;
			setEventSink((event) => {
				h.pushed.push(event);
				if (event.suppressed === undefined || reentered) return;
				reentered = true;
				if (target === "update family") {
					emitEvent("update_slots_current", { id: "nested" });
					emitEvent("update_slots_current", { id: "nested" });
				} else {
					emitEvent("link_up", {
						...link,
						iface: target === "same subject" ? "eth0" : "eth1",
						displayName: "nested",
					});
				}
			});
			if (expiry === "scheduler") h.advance(40_000);
			else h.setNow(40_000);

			emitEvent("link_down", { ...link, displayName: "outer" });
			const records = h.stored.length;
			const activeBefore = h.timers.filter((timer) => timer.active).length;
			resetEventEmitterForTest();
			const activeAfter = h.timers.filter((timer) => timer.active).length;

			expect({ records, activeBefore, activeAfter }).toEqual({
				records: target === "same subject" ? 3 : 4,
				activeBefore: target === "different subject" ? 2 : 1,
				activeAfter: 0,
			});
			expect(h.stored.map(({ event }) => event.code)).toEqual(
				target === "same subject"
					? ["link_down", "link_up", "link_up"]
					: [
							"link_down",
							"link_up",
							target === "update family" ? "update_slots_current" : "link_up",
							"link_down",
						],
			);
			expect(h.pushed).toEqual(h.stored.map(({ event }) => event));
			expect(h.journal).toHaveLength(target === "same subject" ? 3 : 4);
			expect(h.timers).toHaveLength(target === "different subject" ? 3 : 2);
			expect(h.warnings).toEqual([]);
		},
	);

	test(`boundary sink reentry via ${expiry} keeps the outer occurrence as the latest trailing state`, () => {
		const h = harness();
		emitEvent("link_down", link);
		emitEvent("link_up", link);
		let reentered = false;
		setEventSink((event) => {
			h.pushed.push(event);
			if (event.suppressed === undefined || reentered) return;
			reentered = true;
			emitEvent("link_up", { ...link, displayName: "nested" });
		});
		if (expiry === "scheduler") h.advance(40_000);
		else h.setNow(40_000);
		emitEvent("link_down", { ...link, displayName: "outer" });

		h.advance(70_000);

		expect(
			h.stored.map(({ event }) => [
				event.code,
				event.params.displayName,
				event.suppressed,
				event.seq,
			]),
		).toEqual([
			["link_down", undefined, undefined, 41],
			["link_up", undefined, 1, 42],
			["link_up", "nested", undefined, 43],
			["link_down", "outer", 1, 44],
		]);
		expect(h.pushed).toEqual(h.stored.map(({ event }) => event));
		expect(h.journal).toHaveLength(4);
		expect(h.timers).toHaveLength(2);
		expect(h.timers.filter((timer) => timer.active)).toHaveLength(0);
		expect(h.warnings).toEqual([]);
	});
}
