import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../helpers/logger.ts";
import { isDevelopment } from "../mocks/mock-config.ts";
import {
	appendBoot,
	appendEvent,
	clearEvents,
	eventsBytes,
	readBoots,
	readEvents,
	resolveEventsDir,
	tailSeq,
} from "../modules/events/store.ts";
import { boot, event, fixture, line } from "./events-store.fixtures.ts";

test("directory overrides take precedence and ignore blank overrides", () => {
	expect(
		resolveEventsDir({
			CERALIVE_EVENTS_DIR: " /explicit ",
			CERALIVE_DATA_DIR: "/data-override",
		}),
	).toBe("/explicit");
	expect(
		resolveEventsDir({
			CERALIVE_EVENTS_DIR: " ",
			CERALIVE_DATA_DIR: " /data-override ",
		}),
	).toBe("/data-override/ceralive/events");
	expect(resolveEventsDir({ CERALIVE_DATA_DIR: "" }, () => false)).toBe(
		"/data/ceralive/events",
	);
	expect(resolveEventsDir({}, () => true)).toBe(
		path.join(tmpdir(), "ceralive-dev", "events"),
	);
	expect(resolveEventsDir({}, () => false)).toBe("/data/ceralive/events");
	expect(resolveEventsDir({})).toBe(
		isDevelopment()
			? path.join(tmpdir(), "ceralive-dev", "events")
			: "/data/ceralive/events",
	);
});

test("default dependencies resolve the environment path and use the designated logger", () => {
	using deps = fixture();
	const previous = process.env.CERALIVE_EVENTS_DIR;
	const warning = spyOn(logger, "warn").mockImplementation(() => logger);
	try {
		process.env.CERALIVE_EVENTS_DIR = deps.baseDir;
		appendEvent(event(), { sync: false });
		appendBoot(boot());
		expect(readEvents()).toEqual([event()]);
		expect(readBoots()).toEqual([boot()]);
		expect(tailSeq()).toBe(1);
		expect(eventsBytes()).toBe(Buffer.byteLength(line(event())));
		clearEvents();
		const blocked = path.join(deps.baseDir, "blocked");
		fs.writeFileSync(blocked, "file");
		process.env.CERALIVE_EVENTS_DIR = path.join(blocked, "child");
		appendEvent(event(), { sync: false });
		expect(warning).toHaveBeenCalledTimes(1);
	} finally {
		warning.mockRestore();
		if (previous === undefined) delete process.env.CERALIVE_EVENTS_DIR;
		else process.env.CERALIVE_EVENTS_DIR = previous;
	}
});

test.each([false, true])(
	"sync=%s controls fdatasync after append and closes the descriptor",
	(sync) => {
		using deps = fixture();
		const calls: string[] = [];
		appendEvent(event(), {
			...deps,
			sync,
			fs: {
				...fs,
				appendFileSync: (...args) => {
					fs.appendFileSync(...args);
					calls.push("append");
				},
				fdatasyncSync: (fd) => {
					expect(fs.fstatSync(fd).size).toBe(Buffer.byteLength(line(event())));
					calls.push("sync");
					fs.fdatasyncSync(fd);
				},
				closeSync: (fd) => {
					fs.closeSync(fd);
					calls.push("close");
				},
			},
		});
		expect(calls).toEqual(
			sync ? ["append", "sync", "close"] : ["append", "close"],
		);
		expect(deps.warnings).toEqual([]);
	},
);

test.each([
	"mkdirSync",
	"statSync",
	"readFileSync",
	"chmodSync",
	"openSync",
	"fchmodSync",
	"appendFileSync",
	"fdatasyncSync",
	"closeSync",
	"renameSync",
	"rmSync",
] as const)(
	"append contains %s failure and reports exactly one warning",
	(operation) => {
		using deps = fixture();
		fs.writeFileSync(
			path.join(deps.baseDir, "events.jsonl"),
			`${" ".repeat(512 * 1024 - 1)}\n`,
		);
		const failure = new Error(`injected ${operation}`);
		let closed = 0;
		const injected = {
			...fs,
			closeSync: (fd: number) => {
				fs.closeSync(fd);
				closed++;
			},
			[operation]: (...args: unknown[]) => {
				if (operation === "closeSync") {
					const [fd] = args;
					if (typeof fd === "number") fs.closeSync(fd);
				}
				throw failure;
			},
		};
		expect(() =>
			appendEvent(event(), { ...deps, fs: injected, sync: true }),
		).not.toThrow();
		expect(deps.warnings).toHaveLength(1);
		if (["fchmodSync", "appendFileSync", "fdatasyncSync"].includes(operation))
			expect(closed).toBe(1);
	},
);

test("a failed partial append preserves older records and permits a later append", () => {
	using deps = fixture();
	appendEvent(event(1), { ...deps, sync: false });
	let closed = false;
	appendEvent(event(2), {
		...deps,
		sync: true,
		fs: {
			...fs,
			appendFileSync: (fd) => {
				fs.appendFileSync(fd, '{"v":1,"id":"partial');
				throw new Error("power cut");
			},
			closeSync: (fd) => {
				fs.closeSync(fd);
				closed = true;
			},
		},
	});
	expect(closed).toBe(true);
	expect(deps.warnings).toHaveLength(1);
	expect(readEvents(deps)).toEqual([event(1)]);
	appendEvent(event(3), { ...deps, sync: false });
	expect(readEvents(deps)).toEqual([event(1), event(3)]);
});

test.each([
	"readEvents",
	"readBoots",
	"tailSeq",
	"eventsBytes",
	"clearEvents",
] as const)("%s contains filesystem errors with one warning", (operation) => {
	using deps = fixture();
	appendEvent(event(), { ...deps, sync: false });
	appendBoot(boot(), deps);
	const injected = {
		...deps,
		fs: {
			...fs,
			statSync: () => {
				throw new Error("unreadable");
			},
			rmSync: () => {
				throw new Error("read-only");
			},
		},
	};
	const result = { readEvents, readBoots, tailSeq, eventsBytes, clearEvents }[
		operation
	](injected);
	expect(result).toEqual(
		{
			readEvents: [],
			readBoots: [],
			tailSeq: 0,
			eventsBytes: 0,
			clearEvents: false,
		}[operation],
	);
	expect(deps.warnings).toHaveLength(1);
});

test("boot append failures are contained", () => {
	using deps = fixture();
	const blocked = path.join(deps.baseDir, "file");
	fs.writeFileSync(blocked, "file");
	expect(() =>
		appendBoot(boot(), { ...deps, baseDir: path.join(blocked, "child") }),
	).not.toThrow();
	expect(deps.warnings).toHaveLength(1);
});
