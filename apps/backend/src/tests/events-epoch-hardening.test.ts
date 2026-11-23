import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { eventRingEpochSchema } from "@ceraui/rpc/schemas";
import * as epochModule from "../modules/events/epoch.ts";
import { clearEvents } from "../modules/events/store.ts";
import { fixture } from "./events-store.fixtures.ts";

const { eventsEpoch } = epochModule;
const NAME = "events.epoch";
const ORIGINAL = "0f4c2a51-8d3e-4b7a-9c1f-2e6d8a4b5c7e";
const WINNER = "5410cb19-864e-4992-8acf-74f15c351cf5";

function ioError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

test.each(["", "torn", "x".repeat(65)])(
	"replaces %j with a complete private epoch and warns once",
	(contents) => {
		using deps = fixture();
		const file = path.join(deps.baseDir, NAME);
		fs.writeFileSync(file, contents);

		const id = eventsEpoch({
			...deps,
			fs: {
				...fs,
				readFileSync: () => {
					throw new Error("epoch must not use whole-file reads");
				},
			},
		});

		expect(eventRingEpochSchema.parse(id)).toBe(fs.readFileSync(file, "utf8"));
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(deps.warnings).toHaveLength(1);
	},
);

test("replaces a symlink without accepting or writing its target", () => {
	using deps = fixture();
	const file = path.join(deps.baseDir, NAME);
	const target = path.join(deps.baseDir, "target");
	fs.writeFileSync(target, ORIGINAL);
	fs.symlinkSync(target, file);

	const id = eventsEpoch(deps);

	expect(id).not.toBe(ORIGINAL);
	expect(eventRingEpochSchema.parse(id)).toBe(fs.readFileSync(file, "utf8"));
	expect(fs.lstatSync(file).isFile()).toBe(true);
	expect(fs.readFileSync(target, "utf8")).toBe(ORIGINAL);
});

test("opens a FIFO without blocking and replaces it", () => {
	using deps = fixture();
	const file = path.join(deps.baseDir, NAME);
	const makeFifo = Bun.spawnSync(["mkfifo", file]);
	expect(makeFifo.exitCode).toBe(0);

	const id = eventsEpoch({
		...deps,
		fs: {
			...fs,
			readFileSync: () => {
				throw new Error("would block reading the FIFO");
			},
			openSync: (target, flags, mode) => {
				if (
					target === file &&
					(typeof flags !== "number" || (flags & fs.constants.O_NONBLOCK) === 0)
				)
					throw new Error("would block opening the FIFO");
				return fs.openSync(target, flags, mode);
			},
		},
	});

	expect(fs.lstatSync(file).isFile()).toBe(true);
	expect(eventRingEpochSchema.parse(id)).toBe(fs.readFileSync(file, "utf8"));
});

test("a directory stays intact, gives no epoch, and warns only once", () => {
	using deps = fixture();
	const directory = path.join(deps.baseDir, NAME);
	const keep = path.join(directory, "keep");
	fs.mkdirSync(directory);
	fs.writeFileSync(keep, "untouched");
	const attempts: fs.PathLike[] = [];
	const injected = {
		...deps,
		fs: {
			...fs,
			renameSync: (from: fs.PathLike, to: fs.PathLike) => {
				attempts.push(to);
				if (to === directory) throw ioError("EISDIR");
				fs.renameSync(from, to);
			},
		},
	};

	expect([eventsEpoch(injected), eventsEpoch(injected)]).toEqual([
		undefined,
		undefined,
	]);
	expect(fs.readFileSync(keep, "utf8")).toBe("untouched");
	expect(fs.readdirSync(deps.baseDir)).toEqual([NAME]);
	expect(attempts).toEqual([]);
	expect(deps.warnings).toHaveLength(1);
});

test("ENOSPC during staging leaves the old epoch byte-identical", () => {
	using deps = fixture();
	const file = path.join(deps.baseDir, NAME);
	const oldBytes = Buffer.from([0x00, 0x41, 0xff]);
	fs.writeFileSync(file, oldBytes);

	const id = eventsEpoch({
		...deps,
		fs: {
			...fs,
			appendFileSync: (fd) => {
				fs.appendFileSync(fd, "partial");
				throw ioError("ENOSPC");
			},
		},
	});

	expect(id).toBeUndefined();
	expect(fs.readFileSync(file)).toEqual(oldBytes);
	expect(fs.readdirSync(deps.baseDir)).toEqual([NAME]);
	expect(deps.warnings).toHaveLength(1);
});

test("a stop before the create link leaves no incomplete epoch", () => {
	using deps = fixture();
	const file = path.join(deps.baseDir, NAME);
	const synced: string[] = [];
	const io = {
		...fs,
		fsyncSync: (fd: number) => {
			const temp = fs.readdirSync(deps.baseDir)[0];
			if (temp === undefined) throw new Error("staging file missing");
			synced.push(fs.readFileSync(path.join(deps.baseDir, temp), "utf8"));
			fs.fsyncSync(fd);
		},
		linkSync: () => {
			throw ioError("EIO");
		},
	};

	const id = eventsEpoch({ ...deps, fs: io });

	expect(id).toBeUndefined();
	expect(fs.existsSync(file)).toBe(false);
	expect(synced).toEqual([expect.any(String)]);
	eventRingEpochSchema.parse(synced[0]);
});

test("a create collision returns the winner and removes only its staging file", () => {
	using deps = fixture();
	const file = path.join(deps.baseDir, NAME);
	const io: typeof fs = {
		...fs,
		linkSync: (from, to) => {
			fs.writeFileSync(file, WINNER);
			fs.linkSync(from, to);
		},
	};

	const id = eventsEpoch({ ...deps, fs: io });

	expect(id).toBe(WINNER);
	expect(fs.readFileSync(file, "utf8")).toBe(WINNER);
	expect(fs.readdirSync(deps.baseDir)).toEqual([NAME]);
});

test.each(["before", "after"] as const)(
	"a stop %s the repair rename never leaves the epoch path absent",
	(point) => {
		using deps = fixture();
		const file = path.join(deps.baseDir, NAME);
		fs.writeFileSync(file, "torn");
		const synced: string[] = [];

		const id = eventsEpoch({
			...deps,
			fs: {
				...fs,
				fsyncSync: (fd) => {
					if (fs.fstatSync(fd).isDirectory()) throw ioError("EIO");
					const temp = fs
						.readdirSync(deps.baseDir)
						.find((name) => name.endsWith(".tmp"));
					if (temp === undefined) throw new Error("staging file missing");
					synced.push(fs.readFileSync(path.join(deps.baseDir, temp), "utf8"));
					fs.fsyncSync(fd);
				},
				renameSync: (from, to) => {
					if (point === "before") throw ioError("EIO");
					fs.renameSync(from, to);
				},
			},
		});

		expect(id).toBeUndefined();
		expect(synced).toHaveLength(1);
		const replacement = eventRingEpochSchema.parse(synced[0]);
		expect(fs.readFileSync(file, "utf8")).toBe(
			point === "before" ? "torn" : replacement,
		);
	},
);

test("only the dead writer's staging file is removed on startup", () => {
	using deps = fixture();
	const dead = `${NAME}.2147483647.${ORIGINAL}.tmp`;
	const live = `${NAME}.${process.pid}.${WINNER}.tmp`;
	for (const name of [dead, live, "unrelated.tmp"])
		fs.writeFileSync(path.join(deps.baseDir, name), "keep");

	eventRingEpochSchema.parse(eventsEpoch(deps));

	expect(fs.readdirSync(deps.baseDir).sort()).toEqual(
		[NAME, live, "unrelated.tmp"].sort(),
	);
	expect(fs.readFileSync(path.join(deps.baseDir, live), "utf8")).toBe("keep");
});

test("a cached epoch survives EIO, disk changes, and distinct store paths", () => {
	using left = fixture();
	using right = fixture();
	fs.writeFileSync(path.join(left.baseDir, NAME), ORIGINAL);
	fs.writeFileSync(path.join(right.baseDir, NAME), WINNER);
	expect(eventsEpoch(left)).toBe(ORIGINAL);
	expect(eventsEpoch(right)).toBe(WINNER);
	fs.writeFileSync(path.join(left.baseDir, NAME), WINNER);
	const unreadable = () => {
		throw ioError("EIO");
	};

	const id = eventsEpoch({
		...left,
		baseDir: `${left.baseDir}/.`,
		fs: { ...fs, openSync: unreadable, readFileSync: unreadable },
	});

	expect(id).toBe(ORIGINAL);
	expect(eventsEpoch(left)).toBe(ORIGINAL);
	expect(eventsEpoch(right)).toBe(WINNER);
});

test("a failed clear directory sync does not invalidate the cached epoch", () => {
	using deps = fixture();
	const first = eventRingEpochSchema.parse(eventsEpoch(deps));
	const cleared = clearEvents({
		...deps,
		fs: {
			...fs,
			fsyncSync: () => {
				throw ioError("EIO");
			},
		},
	});

	expect(cleared).toBe(false);
	expect(eventsEpoch(deps)).toBe(first);
	expect(clearEvents(deps)).toBe(true);
	expect(eventRingEpochSchema.parse(eventsEpoch(deps))).not.toBe(first);
});

test("creation is synchronous, a valid ID persists across restart, and a clear yields a new ID", () => {
	using deps = fixture();
	const first = eventsEpoch(deps);
	expect(first).not.toBeInstanceOf(Promise);
	eventRingEpochSchema.parse(first);
	// The base revision has no in-memory epoch state to reset.
	epochModule.resetEventsEpochForTest?.();
	expect(eventsEpoch(deps)).toBe(first);
	expect(clearEvents({ ...deps, baseDir: `${deps.baseDir}/.` })).toBe(true);
	expect(eventRingEpochSchema.parse(eventsEpoch(deps))).not.toBe(first);
});
