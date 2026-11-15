import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as timersApi from "node:timers";
import { logStorageSchema } from "@ceraui/rpc/schemas";
import * as logging from "../helpers/logger.ts";
import * as stateStore from "../modules/device-logs/settings.ts";
import {
	getLogSettings,
	getLogState,
	saveLogSettings,
} from "../modules/device-logs/settings.ts";
import * as eventStore from "../modules/events/store.ts";
import { record } from "./helpers/device-query.ts";
import { retentionFixture } from "./helpers/device-retention.ts";

let f: ReturnType<typeof retentionFixture>;
let ceiling:
	| ReturnType<
			typeof spyOn<
				typeof import("../modules/device-logs/ceiling.ts"),
				"readJournalCeiling"
			>
	  >
	| undefined;
let directory:
	| ReturnType<
			typeof spyOn<
				typeof import("../modules/device-logs/retention-files.ts"),
				"journalDirectoryBytes"
			>
	  >
	| undefined;
beforeEach(() => {
	f = retentionFixture();
});
afterEach(async () => {
	ceiling?.mockRestore();
	directory?.mockRestore();
	await f.restore();
});
async function service() {
	const values = await import("../modules/device-logs/ceiling.ts");
	ceiling = spyOn(values, "readJournalCeiling").mockReturnValue({
		maxSizeMb: 256,
		maxAgeDays: 30,
	});
	const files = await import("../modules/device-logs/retention-files.ts");
	directory = spyOn(files, "journalDirectoryBytes").mockResolvedValue(55);
	return import("../modules/device-logs/retention.ts");
}
const defaults = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "debug",
} as const;
function timerHasRef(): unknown {
	const timer = f.schedule.mock.results[0]?.value;
	return typeof timer === "object" &&
		timer !== null &&
		"hasRef" in timer &&
		typeof timer.hasRef === "function"
		? timer.hasRef()
		: undefined;
}
async function bounded<T>(event: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			event,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("event deadline")), 1000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

test("default limits cause no vacuum and no daily interval", async () => {
	const r = await service();
	await r.initLogRetention();
	expect(f.run.mock.calls).toEqual([]);
	expect(f.schedule.mock.calls).toEqual([]);
});
test("tightened retention records observed success without rotating", async () => {
	const r = await service();
	const reply = await r.setRetention({
		maxAgeDays: 7,
		maxSizeMb: 64,
		detail: "info",
	});
	expect(reply.ok).toBe(true);
	expect(f.run.mock.calls.map((c) => c.slice(0, 2))).toEqual([
		["journalctl", ["--vacuum-time=7d", "--vacuum-size=64M"]],
		["journalctl", ["--disk-usage"]],
		["journalctl", ["--disk-usage"]],
	]);
	expect(getLogState().lastMaintenance).toMatchObject({
		ok: true,
		targetMet: true,
	});
	expect(f.detail).toHaveBeenLastCalledWith("info");
	expect(f.schedule.mock.calls.map((t) => t[1])).toEqual([86_400_000]);
	expect(timerHasRef()).toBe(false);
	await r.setRetention(defaults);
	expect(timerHasRef()).toBe(false);
});
test.each([
	{ maxAgeDays: 31, maxSizeMb: null, detail: "debug" },
	{ maxAgeDays: 0, maxSizeMb: null, detail: "debug" },
	{ maxAgeDays: -1, maxSizeMb: null, detail: "debug" },
	{ maxAgeDays: 1.1, maxSizeMb: null, detail: "debug" },
	{ maxAgeDays: Number.MAX_SAFE_INTEGER, maxSizeMb: null, detail: "debug" },
	{ maxAgeDays: null, maxSizeMb: 257, detail: "debug" },
	{ maxAgeDays: null, maxSizeMb: 15, detail: "debug" },
	{ maxAgeDays: null, maxSizeMb: Number.MAX_VALUE, detail: "debug" },
	{ maxAgeDays: null, maxSizeMb: 16.1, detail: "debug" },
	{},
	null,
	"",
	{ ...defaults, detail: "bad" },
])(
	"refuses invalid admission without saving or spawning: %j",
	async (value) => {
		const r = await service();
		expect(await r.setRetention(value)).toEqual({
			ok: false,
			error: "INVALID_RETENTION",
		});
		expect(getLogSettings()).toEqual(defaults);
		expect(f.run.mock.calls).toEqual([]);
	},
);
test("unknown ceiling allows detail only and leaves maintenance inert", async () => {
	const r = await service();
	ceiling?.mockReturnValue(null);
	expect(await r.setRetention({ ...defaults, maxSizeMb: 64 })).toEqual({
		ok: false,
		error: "INVALID_RETENTION",
	});
	expect(await r.setRetention({ ...defaults, maxAgeDays: 7 })).toEqual({
		ok: false,
		error: "INVALID_RETENTION",
	});
	expect((await r.setRetention({ ...defaults, detail: "info" })).ok).toBe(true);
	expect(f.run.mock.calls.map((c) => c[1])).toEqual([["--disk-usage"]]);
	saveLogSettings({ ...defaults, maxAgeDays: 1 });
	f.run.mockClear();
	await r.initLogRetention();
	expect(f.run.mock.calls).toEqual([]);
	expect(f.schedule.mock.calls).toEqual([]);
});
test("storage includes recursive disk accounting and a bounded source sample", async () => {
	const r = await service();
	writeFileSync(join(f.dir, "debug.log"), "legacy");
	const storage = await r.getStorage();
	expect(logStorageSchema.parse(storage)).toEqual(storage);
	expect(storage).toMatchObject({
		journalBytes: 33554432,
		journalDirBytes: 55,
		legacyDebugBytes: 6,
		ceiling: { maxSizeMb: 256, maxAgeDays: 30 },
		retention: defaults,
		recentVolume: [
			{ source: "engine", entries: 1, bytes: 2 },
			{ source: "app", entries: 1, bytes: 3 },
		],
		recentSample: 2,
		eventsBytes: 0,
		lastMaintenance: null,
		lastClearedAt: null,
	});
	expect(
		f.scan.mock.calls.map(([i]) => ({
			options: i.options,
			matches: i.matches,
		})),
	).toEqual([
		{ options: [], matches: [] },
		{ options: ["-r"], matches: [] },
	]);
	expect(f.scan.mock.calls[1]?.[0].limits?.records).toBe(4096);
	expect(f.scan.mock.calls.map(([input]) => input.spawn)).toEqual([
		undefined,
		undefined,
	]);
});
test("vacuum failure is recorded and storage still returns", async () => {
	const r = await service();
	f.run.mockRejectedValueOnce(new Error("exit 1"));
	const result = await r.setRetention({ ...defaults, maxSizeMb: 64 });
	expect(result.ok).toBe(true);
	expect(getLogState().lastMaintenance).toMatchObject({
		ok: false,
		targetMet: false,
	});
});
test.each(["size", "age", "unknown"] as const)(
	"maintenance reports unmet %s target",
	async (kind) => {
		const r = await service();
		if (kind === "size")
			f.run.mockImplementation(async (_cmd, args) =>
				args.includes("--disk-usage") ? "take up 65M" : "",
			);
		if (kind === "unknown") f.run.mockImplementation(async () => "unreadable");
		if (kind === "age")
			f.scan.mockImplementation(async (i) => {
				i.onRecord({ ...record(1), ts: Date.now() - 7 * 86_400_000 - 1 });
				return { status: "stopped", exitCode: 0, skippedRecords: 0 };
			});
		await r.setRetention({ ...defaults, maxAgeDays: 7, maxSizeMb: 64 });
		expect(getLogState().lastMaintenance).toMatchObject({
			ok: true,
			targetMet: false,
		});
	},
);
test("delete older files rotates then uses rounded uptime plus safety minute", async () => {
	const r = await service();
	f.read.mockResolvedValue("1234.5 0");
	f.run.mockImplementation(async (_cmd, args) => {
		if (args.includes("--list-boots"))
			return JSON.stringify([
				{ boot_id: record(1).bootId, index: 0, first_entry: 0, last_entry: 0 },
			]);
		return "take up 1M";
	});
	const reply = await r.deleteOlderFiles();
	expect(reply).toMatchObject({ ok: true, bootsBefore: 1, bootsAfter: 1 });
	expect(f.run.mock.calls.map((c) => c[1])).toEqual([
		["--list-boots", "-o", "json"],
		["--rotate"],
		["--vacuum-time=1295s"],
		["--list-boots", "-o", "json"],
		["--disk-usage"],
	]);
});
test("clear joins readers, preserves events and records the new epoch", async () => {
	const r = await service();
	writeFileSync(join(f.dir, "debug.log"), "old");
	const before = getLogState().historyEpoch;
	const reply = await r.clearAll();
	expect(reply.ok).toBe(true);
	expect(getLogState().historyEpoch).toBe(before + 1);
	expect(f.stop).toHaveBeenCalledWith("cleared");
	expect(f.abort).toHaveBeenCalledTimes(1);
	expect(f.run.mock.calls.map((c) => c[1])).toEqual([
		["--rotate"],
		["--vacuum-time=1s"],
		["--disk-usage"],
	]);
	expect(existsSync(join(f.dir, "debug.log"))).toBe(false);
	expect(getLogState().lastClearedAt).toBeNumber();
});
test("clear refuses during updates before changing history", async () => {
	const r = await service();
	f.phase.mockReturnValue({ ...f.phase(), phase: "committing" });
	expect(await r.clearAll()).toEqual({
		ok: false,
		error: "UPDATE_IN_PROGRESS",
	});
	expect(getLogState().historyEpoch).toBe(0);
	expect(f.run.mock.calls).toEqual([]);
	expect(f.stop).not.toHaveBeenCalled();
});

test("an unreadable update phase refuses clear without letting the getter escape", async () => {
	const r = await service();
	f.phase.mockImplementationOnce(() => {
		throw new Error("state unavailable");
	});
	expect(await r.clearAll()).toEqual({ ok: false, error: "READ_FAILED" });
	expect(getLogState().historyEpoch).toBe(0);
	expect(f.run.mock.calls).toEqual([]);
});
test("legacy cleanup reports a failed unlink instead of success", async () => {
	const r = await service();
	const files = await import("../modules/device-logs/retention-files.ts");
	const remove = spyOn(files, "deleteLegacyDebugFiles").mockRejectedValue(
		new Error("EACCES"),
	);
	try {
		expect(await r.deleteLegacyDebug()).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
	} finally {
		remove.mockRestore();
	}
});
test("mock operations use only ring data and clear before emitting to a throwing subscriber", async () => {
	const r = await service();
	f.mock.mockReturnValue(true);
	logging.logger.info("before clear");
	const listener = logging.onLogLine(() => {
		throw new Error("consumer");
	});
	try {
		const storage = await r.getStorage();
		expect(storage.oldestEntryTs).toBe(
			Date.parse(JSON.parse(logging.getRecentLogLines()[0] ?? "{}").ts),
		);
		expect(storage.journalBytes).toBe(
			logging.getRecentLogLines().reduce((n, s) => n + Buffer.byteLength(s), 0),
		);
		expect(storage.journalDirBytes).toBe(storage.journalBytes);
		expect(storage.ceiling).toEqual({ maxSizeMb: 256, maxAgeDays: 30 });
		expect((await r.setRetention({ ...defaults, maxAgeDays: 7 })).ok).toBe(
			true,
		);
		expect(await r.deleteOlderFiles()).toMatchObject({
			ok: true,
			bootsBefore: 1,
			bootsAfter: 1,
		});
		expect((await r.clearAll()).ok).toBe(true);
		expect(JSON.parse(logging.getRecentLogLines()[0] ?? "{}").msg).toBe(
			"device logs cleared",
		);
		expect(JSON.parse(logging.getRecentLogLines()[0] ?? "{}").module).toBe(
			"device-logs",
		);
		expect(f.run.mock.calls).toEqual([]);
		expect(
			f.scan.mock.calls.every(([input]) => input.spawn !== undefined),
		).toBe(true);
		expect(ceiling).not.toHaveBeenCalled();
		expect(directory).not.toHaveBeenCalled();
	} finally {
		listener();
	}
});

test.each([
	{ maxAgeDays: 1, maxSizeMb: 16, detail: "debug" },
	{ maxAgeDays: 30, maxSizeMb: 256, detail: "info" },
	{ maxAgeDays: 1, maxSizeMb: null, detail: "info" },
	{ maxAgeDays: null, maxSizeMb: 16, detail: "debug" },
] as const)("accepts inclusive retention bounds %j", async (next) => {
	const r = await service();
	expect((await r.setRetention(next)).ok).toBe(true);
	expect(getLogSettings()).toEqual(next);
	expect(f.run.mock.calls[0]?.[1]).toEqual([
		...(next.maxAgeDays === null ? [] : [`--vacuum-time=${next.maxAgeDays}d`]),
		...(next.maxSizeMb === null ? [] : [`--vacuum-size=${next.maxSizeMb}M`]),
	]);
});

test("storage preserves unknown measurements and nonzero event bytes", async () => {
	const r = await service();
	ceiling?.mockReturnValue(null);
	directory?.mockResolvedValue(null);
	f.run.mockRejectedValue(new Error("journal missing"));
	f.scan.mockRejectedValue(new Error("scan missing"));
	const events = spyOn(eventStore, "eventsBytes").mockReturnValue(123);
	try {
		expect(await r.getStorage()).toMatchObject({
			journalBytes: null,
			journalDirBytes: null,
			oldestEntryTs: null,
			recentVolume: [],
			recentSample: 0,
			ceiling: null,
			eventsBytes: 123,
		});
	} finally {
		events.mockRestore();
	}
});

test("source sample combines repeated and unknown sources and drops failed partial reads", async () => {
	const r = await service();
	f.scan.mockImplementation(async (i) => {
		for (const row of [record(1), record(2), { ...record(3), source: null }])
			if (i.onRecord(row) === "stop") break;
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const storage = await r.getStorage();
	expect(storage.oldestEntryTs).toBe(1);
	expect(storage.recentVolume).toEqual([
		{ source: "app", entries: 2, bytes: 14 },
		{ source: null, entries: 1, bytes: 7 },
	]);
	f.scan.mockImplementation(async (i) => {
		i.onRecord(record(1));
		throw new Error("partial failure");
	});
	expect(await r.getStorage()).toMatchObject({
		oldestEntryTs: null,
		recentSample: 0,
		recentVolume: [],
	});
});

test.each(["budget", "eof"] as const)(
	"empty oldest scan records %s honestly",
	async (status) => {
		const r = await service();
		f.scan.mockResolvedValue({ status, exitCode: 0, skippedRecords: 0 });
		await r.setRetention({ ...defaults, maxAgeDays: 1 });
		expect(getLogState().lastMaintenance).toMatchObject({
			ok: true,
			targetMet: status === "eof",
		});
	},
);

test("skipped oldest candidates cannot establish an age target", async () => {
	const r = await service();
	f.scan.mockImplementation(async (i) => {
		i.onRecord({ ...record(1), ts: Date.now() });
		return { status: "stopped", exitCode: 143, skippedRecords: 1 };
	});
	await r.setRetention({ ...defaults, maxAgeDays: 1 });
	expect(getLogState().lastMaintenance).toMatchObject({
		ok: true,
		targetMet: false,
	});
	expect((await r.getStorage()).oldestEntryTs).toBeNull();
});

test("storage counts unreadable candidates as examined without assigning them a source", async () => {
	const r = await service();
	f.scan.mockImplementation(async (i) => {
		i.onRecord(record(1));
		return { status: "budget", exitCode: 143, skippedRecords: 3 };
	});
	expect((await r.getStorage()).recentSample).toBe(4);
});

test("unknown oldest entry cannot satisfy an age target even when usage reports zero", async () => {
	const r = await service();
	f.scan.mockRejectedValue(new Error("unreadable"));
	f.run.mockImplementation(async (_cmd, args) =>
		args.includes("--disk-usage") ? "take up 0B" : "",
	);
	await r.setRetention({ ...defaults, maxAgeDays: 1 });
	expect(getLogState().lastMaintenance).toMatchObject({
		ok: true,
		targetMet: false,
	});
});

test("daily maintenance serializes with clear and does not survive disabled limits", async () => {
	const r = await service();
	await r.setRetention({ ...defaults, maxAgeDays: 1 });
	const callback = f.schedule.mock.calls[0]?.[0];
	if (typeof callback !== "function") throw new Error("missing daily callback");
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	f.run.mockImplementationOnce(async () => {
		started.resolve();
		return release.promise;
	});
	callback();
	await bounded(started.promise);
	const clearing = r.clearAll();
	await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
	expect(f.stop).not.toHaveBeenCalled();
	release.resolve("");
	expect((await clearing).ok).toBe(true);
	expect(
		f.run.mock.calls.map((c) => c[1]).filter((a) => a?.[0] === "--rotate"),
	).toEqual([["--rotate"]]);
	await r.setRetention(defaults);
	const schedules = f.schedule.mock.calls.length;
	await r.initLogRetention();
	expect(f.schedule.mock.calls.length).toBe(schedules);
});

test("initializing saved retention immediately maintains and owns one daily timer", async () => {
	const r = await service();
	saveLogSettings({ ...defaults, maxAgeDays: 7 });
	await r.initLogRetention();
	expect(f.run.mock.calls[0]?.slice(0, 2)).toEqual([
		"journalctl",
		["--vacuum-time=7d"],
	]);
	expect(f.schedule.mock.calls.map((call) => call[1])).toEqual([86_400_000]);
});

test("a failed initial maintenance receipt still owns the required daily timer", async () => {
	const r = await service();
	saveLogSettings({ ...defaults, maxAgeDays: 7 });
	const state = spyOn(stateStore, "updateLogState").mockImplementationOnce(
		() => {
			throw new Error("disk");
		},
	);
	try {
		await expect(r.initLogRetention()).rejects.toThrow("disk");
		expect(f.schedule.mock.calls.map((call) => call[1])).toEqual([86_400_000]);
	} finally {
		state.mockRestore();
	}
});

test("saved tightened limits keep their timer when a detail consumer throws", async () => {
	const r = await service();
	f.detail.mockImplementationOnce(() => {
		throw new Error("consumer");
	});
	expect(await r.setRetention({ ...defaults, maxAgeDays: 7 })).toEqual({
		ok: false,
		error: "READ_FAILED",
	});
	expect(getLogSettings().maxAgeDays).toBe(7);
	expect(f.schedule.mock.calls.map((call) => call[1])).toEqual([86_400_000]);
});

test("disabling limits cancels the daily timer once without stale cancellations", async () => {
	const r = await service();
	const clear = spyOn(timersApi, "clearInterval");
	try {
		await r.setRetention({ ...defaults, maxSizeMb: 16 });
		const timer = f.schedule.mock.results[0]?.value;
		clear.mockClear();
		await r.setRetention(defaults);
		expect(clear.mock.calls.length).toBe(1);
		expect(timer).toBe(clear.mock.calls[0]?.[0]);
		await r.initLogRetention();
		expect(clear.mock.calls.length).toBe(1);
	} finally {
		clear.mockRestore();
	}
});

test("daily callback contains a failed state consumer and logs its exact maintenance failure", async () => {
	const r = await service();
	await r.setRetention({ ...defaults, maxSizeMb: 16 });
	const error = new Error("disk");
	const state = spyOn(stateStore, "updateLogState").mockImplementationOnce(
		() => {
			throw error;
		},
	);
	const recorded = Promise.withResolvers<unknown[]>();
	const warn = spyOn(logging.logger, "warn").mockImplementation(
		(...args: unknown[]) => {
			recorded.resolve(args);
			return logging.logger;
		},
	);
	try {
		const callback = f.schedule.mock.calls[0]?.[0];
		if (typeof callback !== "function")
			throw new Error("daily callback missing");
		callback();
		expect(await bounded(recorded.promise)).toEqual([
			"Log maintenance state could not be saved",
			{ module: "device-logs", error },
		]);
		expect((await r.setRetention(defaults)).ok).toBe(true);
	} finally {
		state.mockRestore();
		warn.mockRestore();
	}
});

test.each([0, 1])(
	"size target uses exact MiB at the boundary plus %i byte",
	async (extra) => {
		const r = await service();
		f.run.mockImplementation(async (_cmd, args) =>
			args.includes("--disk-usage") ? `take up ${64 * 1048576 + extra}B` : "",
		);
		await r.setRetention({ ...defaults, maxSizeMb: 64 });
		expect(getLogState().lastMaintenance?.targetMet).toBe(extra === 0);
	},
);

test.each([0, 1])(
	"age target is inclusive at the exact day boundary plus %i millisecond",
	async (extra) => {
		const r = await service();
		const now = spyOn(Date, "now").mockReturnValue(1700000000000);
		f.scan.mockImplementation(async (input) => {
			input.onRecord({
				...record(1),
				ts: 1700000000000 - 7 * 86400000 - extra,
			});
			return { status: "stopped", exitCode: 143, skippedRecords: 0 };
		});
		try {
			await r.setRetention({ ...defaults, maxAgeDays: 7 });
			expect(getLogState().lastMaintenance?.targetMet).toBe(extra === 0);
		} finally {
			now.mockRestore();
		}
	},
);

test("a null age limit ignores old entries when enforcing size only", async () => {
	const r = await service();
	f.scan.mockImplementation(async (input) => {
		input.onRecord(record(1));
		return { status: "stopped", exitCode: 143, skippedRecords: 0 };
	});
	await r.setRetention({ ...defaults, maxSizeMb: 64 });
	expect(getLogState().lastMaintenance?.targetMet).toBe(true);
});

test("a null size limit ignores large usage when enforcing age only", async () => {
	const r = await service();
	f.run.mockResolvedValue("take up 1G");
	await r.setRetention({ ...defaults, maxAgeDays: 7 });
	expect(getLogState().lastMaintenance?.targetMet).toBe(true);
});

test("mock ceiling enforces the scenario's age and size ceiling independently", async () => {
	const r = await service();
	f.mock.mockReturnValue(true);
	expect(
		(await r.setRetention({ ...defaults, maxAgeDays: 30, maxSizeMb: 256 })).ok,
	).toBe(true);
	expect(await r.setRetention({ ...defaults, maxAgeDays: 31 })).toEqual({
		ok: false,
		error: "INVALID_RETENTION",
	});
	expect(await r.setRetention({ ...defaults, maxSizeMb: 257 })).toEqual({
		ok: false,
		error: "INVALID_RETENTION",
	});
});

test("zero uptime vacuums with the safety minute and the fixed read and command contracts", async () => {
	const r = await service();
	f.read.mockResolvedValue("0 0");
	f.run.mockImplementation(async (cmd, args) => {
		expect(cmd).toBe("journalctl");
		return args.includes("--list-boots") ? "[]" : "take up 0B";
	});
	expect(await r.deleteOlderFiles()).toMatchObject({
		ok: true,
		bootsBefore: 0,
		bootsAfter: 0,
	});
	expect(f.read.mock.calls).toEqual([["/proc/uptime", "utf8"]]);
	expect(f.run.mock.calls.map((c) => c.slice(0, 2))).toEqual([
		["journalctl", ["--list-boots", "-o", "json"]],
		["journalctl", ["--rotate"]],
		["journalctl", ["--vacuum-time=60s"]],
		["journalctl", ["--list-boots", "-o", "json"]],
		["journalctl", ["--disk-usage"]],
	]);
});

test.each(["save", "state", "detail"] as const)(
	"setting I/O failure (%s) refuses and releases mutex",
	async (kind) => {
		const r = await service();
		const fail =
			kind === "save"
				? spyOn(stateStore, "saveLogSettings").mockImplementationOnce(() => {
						throw new Error("disk");
					})
				: kind === "state"
					? spyOn(stateStore, "updateLogState").mockImplementationOnce(() => {
							throw new Error("disk");
						})
					: f.detail.mockImplementationOnce(() => {
							throw new Error("consumer");
						});
		try {
			expect(await r.setRetention({ ...defaults, maxSizeMb: 16 })).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect((await r.setRetention(defaults)).ok).toBe(true);
		} finally {
			fail.mockRestore();
		}
	},
);

test.each(["", "-1 0", "1.2.3 0", "Infinity 0", "9007199254740991 0", "1e9 0"])(
	"older-file cleanup refuses malformed or overflowing uptime %j",
	async (uptime) => {
		const r = await service();
		f.read.mockResolvedValue(uptime);
		f.run.mockResolvedValue("[]");
		expect(await r.deleteOlderFiles()).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect(f.run.mock.calls.map((c) => c[1])).toEqual([
			["--list-boots", "-o", "json"],
			["--rotate"],
		]);
	},
);

test.each([0, 1, 2, 3])(
	"older-file cleanup refuses failed journal operation %i",
	async (index) => {
		const r = await service();
		f.read.mockResolvedValue("0 0");
		let call = 0;
		f.run.mockImplementation(async (_cmd, args) => {
			if (call++ === index) throw new Error("journal failure");
			return args.includes("--list-boots") ? "[]" : "take up 0B";
		});
		expect(await r.deleteOlderFiles()).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
	},
);

test("legacy cleanup succeeds and returns observed remaining storage", async () => {
	const r = await service();
	writeFileSync(join(f.dir, "debug5.log"), "five");
	const result = await r.deleteLegacyDebug();
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.storage.legacyDebugBytes).toBe(0);
});

test.each([
	"persist",
	"follow",
	"query",
	"rotate",
	"vacuum",
	"unlink",
] as const)(
	"clear failure (%s) refuses, releases its mutex and does not report a cleared time",
	async (kind) => {
		const r = await service();
		const files = await import("../modules/device-logs/retention-files.ts");
		const undo =
			kind === "persist"
				? spyOn(stateStore, "updateLogState").mockImplementationOnce(() => {
						throw new Error("disk");
					})
				: kind === "follow"
					? f.stop.mockRejectedValueOnce(new Error("consumer"))
					: kind === "query"
						? f.abort.mockRejectedValueOnce(new Error("consumer"))
						: kind === "unlink"
							? spyOn(files, "deleteLegacyDebugFiles").mockRejectedValueOnce(
									new Error("disk"),
								)
							: f.run.mockImplementationOnce(async () => {
									if (kind === "rotate") throw new Error("rotate");
									f.run.mockRejectedValueOnce(new Error("vacuum"));
									return "";
								});
		try {
			expect(await r.clearAll()).toEqual({ ok: false, error: "READ_FAILED" });
			expect(getLogState().lastClearedAt).toBeNull();
			expect((await r.clearAll()).ok).toBe(true);
		} finally {
			undo.mockRestore();
		}
	},
);
