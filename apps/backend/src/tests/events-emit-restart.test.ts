import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_REGISTRY } from "@ceraui/rpc/events";
import type { DeviceEvent } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { currentBootId } from "../modules/device-logs/boot-id.ts";
import {
	emitEvent,
	resetEventEmitterForTest,
	setEventSink,
} from "../modules/events/emit.ts";
import { appendEvent, readEvents } from "../modules/events/store.ts";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const NEXT_BOOT = "123456788694489b8c3a3fb4795cab24";

function record(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
	return {
		id: "66d8d180-9",
		seq: 9,
		bootId: BOOT,
		at: 100,
		code: "update_slots_current",
		family: "update",
		severity: "success",
		params: { id: "installed" },
		...overrides,
	};
}

function harness(read: () => DeviceEvent[] = () => []) {
	const appended: DeviceEvent[] = [];
	const pushed: DeviceEvent[] = [];
	const journal: unknown[][] = [];
	const warnings: unknown[][] = [];
	let boot: string | undefined = BOOT;
	let reads = 0;
	resetEventEmitterForTest({
		bootId: () => boot,
		now: () => 100,
		tailSeq: () => 9,
		readEvents: () => {
			reads++;
			return read();
		},
		appendEvent: (event) => appended.push(event),
		log: (...args) => journal.push(args),
		warn: (...args) => warnings.push(args),
	});
	setEventSink((event) => pushed.push(event));
	return {
		appended,
		pushed,
		journal,
		warnings,
		get reads() {
			return reads;
		},
		setBoot(value: string | undefined) {
			boot = value;
		},
	};
}

afterEach(() => resetEventEmitterForTest());

test("default read dependency seeds on first use and after emitter reset", () => {
	const bootId = currentBootId();
	if (bootId === undefined) throw new Error("real boot id unavailable");
	const baseDir = mkdtempSync(join(tmpdir(), "event-default-restart-"));
	const previousDir = process.env.CERALIVE_EVENTS_DIR;
	const log = spyOn(logger, "log").mockImplementation(() => logger);
	process.env.CERALIVE_EVENTS_DIR = baseDir;
	try {
		appendEvent(record({ bootId }), { baseDir, sync: false });
		emitEvent("update_slots_current", { id: "installed" });
		expect(readEvents({ baseDir })).toHaveLength(1);
		resetEventEmitterForTest();
		emitEvent("update_slots_current", { id: "installed" });
		expect(readEvents({ baseDir })).toHaveLength(1);
		expect(log).not.toHaveBeenCalled();
	} finally {
		log.mockRestore();
		if (previousDir === undefined) delete process.env.CERALIVE_EVENTS_DIR;
		else process.env.CERALIVE_EVENTS_DIR = previousDir;
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("two backend processes in one real boot persist an update subject only once", async () => {
	const bootId = currentBootId();
	if (bootId === undefined) throw new Error("real boot id unavailable");
	const baseDir = mkdtempSync(join(tmpdir(), "event-restart-"));
	const script = `
		import { emitEvent } from ${JSON.stringify(import.meta.resolve("../modules/events/emit.ts"))};
		emitEvent("update_installed", { id: "service-restart", packages: ["ceraui"] });
		emitEvent("update_installed", { id: "service-restart", packages: ["ceraui"] });
	`;
	try {
		for (let processNumber = 1; processNumber <= 2; processNumber++) {
			const child = Bun.spawn([process.execPath, "-e", script], {
				env: { ...process.env, CERALIVE_EVENTS_DIR: baseDir },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			});
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited, stderr).toBe(0);
			expect(readEvents({ baseDir }), `after process ${processNumber}`).toEqual(
				[
					{
						id: `${bootId.slice(0, 8)}-1`,
						seq: 1,
						bootId,
						at: expect.any(Number),
						code: "update_installed",
						family: "update",
						severity: "success",
						params: { id: "service-restart", packages: ["ceraui"] },
					},
				],
			);
		}
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("a persisted current boot subject suppresses every output synchronously", () => {
	const h = harness(() => [record()]);
	expect(
		emitEvent("update_slots_current", { id: "installed" }),
	).toBeUndefined();
	expect(h.appended).toEqual([]);
	expect(h.journal).toEqual([]);
	expect(h.pushed).toEqual([]);
	expect(h.warnings).toEqual([]);
	expect(h.reads).toBe(1);
});

test.each([
	["different subject", record({ params: { id: "other" } })],
	["different code", record({ code: "update_updates_available" })],
	["different boot", record({ bootId: NEXT_BOOT })],
	[
		"non-update code with an update wire family",
		record({ code: "service_stopping", params: { signal: "SIGTERM" } }),
	],
	["unknown future code", record({ code: "update_future" })],
	["inherited property name", record({ code: "toString" })],
] as const)("seed permits an update with a %s", (_name, stored) => {
	const h = harness(() => [stored, record({ params: { id: "unrelated" } })]);
	emitEvent("update_slots_current", { id: "installed" });
	expect(h.appended).toEqual([record({ id: "66d8d180-10", seq: 10 })]);
	expect(h.pushed).toEqual(h.appended);
	expect(h.journal).toHaveLength(1);
	expect(h.warnings).toEqual([]);
});

test("seed uses the registry code family even when the stored family differs", () => {
	const h = harness(() => [record({ family: "device" })]);
	emitEvent("update_slots_current", { id: "installed" });
	expect(h.appended).toEqual([]);
	expect(h.warnings).toEqual([]);
});

test("same code uses all registry subject params rather than a presumed id", () => {
	const h = harness(() => [
		record({
			code: "update_failed",
			params: { stage: "download", reason: "network" },
		}),
	]);
	emitEvent("update_failed", { stage: "download", reason: "network" });
	emitEvent("update_failed", { stage: "download", reason: "disk" });
	emitEvent("update_failed", { stage: "commit", reason: "network" });
	expect(h.appended.map((event) => event.params)).toEqual([
		{ stage: "download", reason: "disk" },
		{ stage: "commit", reason: "network" },
	]);
});

test("seed ignores non-subject params just like live update dedupe", () => {
	const h = harness(() => [
		record({
			code: "update_installed",
			params: { id: "installed", packages: ["old"] },
		}),
	]);
	emitEvent("update_installed", { id: "installed", packages: ["new"] });
	emitEvent("update_installed", { id: "other", packages: ["new"] });
	expect(h.appended.map((event) => event.params)).toEqual([
		{ id: "other", packages: ["new"] },
	]);
});

test("seed is lazy once per boot and resets after a boot change", () => {
	const h = harness(() => [record(), record({ bootId: NEXT_BOOT })]);
	expect(h.reads).toBe(0);
	emitEvent("link_down", { iface: "eth0", kind: "ethernet" });
	Reflect.apply(emitEvent, null, ["update_slots_current", {}]);
	h.setBoot(undefined);
	emitEvent("update_slots_current", { id: "installed" });
	expect(h.reads).toBe(0);
	h.setBoot(BOOT);
	emitEvent("update_slots_current", { id: "installed" });
	emitEvent("update_slots_current", { id: "new" });
	emitEvent("update_slots_current", { id: "new" });
	expect(h.reads).toBe(1);
	h.setBoot(NEXT_BOOT);
	emitEvent("link_down", { iface: "eth0", kind: "ethernet" });
	expect(h.reads).toBe(1);
	emitEvent("update_slots_current", { id: "installed" });
	emitEvent("update_slots_current", { id: "new" });
	expect(h.reads).toBe(2);
	expect(
		h.appended.map(({ bootId, code, params }) => [bootId, code, params]),
	).toEqual([
		[BOOT, "link_down", { iface: "eth0", kind: "ethernet" }],
		[BOOT, "update_slots_current", { id: "new" }],
		[NEXT_BOOT, "link_down", { iface: "eth0", kind: "ethernet" }],
		[NEXT_BOOT, "update_slots_current", { id: "new" }],
	]);
});

test("a throwing seed warns once falls back empty and never retries in the boot", () => {
	const h = harness(() => {
		throw new Error("private read failure");
	});
	expect(() =>
		emitEvent("update_slots_current", { id: "installed" }),
	).not.toThrow();
	emitEvent("update_slots_current", { id: "installed" });
	emitEvent("update_slots_current", { id: "other" });
	expect(h.reads).toBe(1);
	expect(h.warnings).toEqual([
		["event update seed failed", { module: "events" }],
	]);
	expect(h.appended.map((event) => event.params)).toEqual([
		{ id: "installed" },
		{ id: "other" },
	]);
	expect(h.journal).toHaveLength(2);
	expect(h.pushed).toEqual(h.appended);
});

test("a throwing seed warning still permits synchronous emission", () => {
	const appended: DeviceEvent[] = [];
	resetEventEmitterForTest({
		bootId: () => BOOT,
		readEvents: () => {
			throw new Error("read");
		},
		warn: () => {
			throw new Error("warning");
		},
		tailSeq: () => 0,
		appendEvent: (event) => appended.push(event),
		log: () => {},
	});
	expect(() =>
		emitEvent("update_slots_current", { id: "installed" }),
	).not.toThrow();
	expect(appended).toHaveLength(1);
});

test("non-update families never seed and retain their thirty second window", () => {
	const h = harness(() => {
		throw new Error("must not read");
	});
	emitEvent("link_down", { iface: "eth0", kind: "ethernet" });
	emitEvent("link_up", { iface: "eth0", kind: "ethernet" });
	expect(h.reads).toBe(0);
	expect(h.warnings).toEqual([]);
	expect(h.appended.map((event) => event.code)).toEqual(["link_down"]);
});

test("seed counts unique subjects and stops at the existing 1024 identity bound", () => {
	const records = [
		record(),
		record(),
		...Array.from({ length: 1024 }, (_, n) =>
			record({ params: { id: `${n}` } }),
		),
	];
	const subject = spyOn(EVENT_REGISTRY.update_slots_current, "subject");
	try {
		const h = harness(() => records);
		emitEvent("update_slots_current", { id: "fresh" });
		expect(h.appended).toEqual([]);
		// One live subject, two duplicate stored rows and 1023 other stored subjects.
		expect(subject).toHaveBeenCalledTimes(1026);
	} finally {
		subject.mockRestore();
	}
});

test("other boots and non-update codes consume no seed capacity", () => {
	const h = harness(() => [
		record({ bootId: NEXT_BOOT }),
		record({ code: "service_stopping", params: { signal: "SIGTERM" } }),
		record({ code: "update_future" }),
		...Array.from({ length: 1023 }, (_, n) =>
			record({ params: { id: `${n}` } }),
		),
	]);
	emitEvent("update_slots_current", { id: "fresh" });
	expect(h.appended.map((event) => event.params)).toEqual([{ id: "fresh" }]);
	expect(h.warnings).toEqual([]);
});

test("a seed iteration failure discards partially seeded subjects", () => {
	const records = [record()];
	records[Symbol.iterator] = function* () {
		yield record();
		throw new Error("interrupted read");
	};
	const h = harness(() => records);
	expect(() =>
		emitEvent("update_slots_current", { id: "installed" }),
	).not.toThrow();
	expect(h.appended.map((event) => event.params)).toEqual([
		{ id: "installed" },
	]);
	expect(h.warnings).toEqual([
		["event update seed failed", { module: "events" }],
	]);
});
