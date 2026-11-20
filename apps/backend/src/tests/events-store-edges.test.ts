import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	appendBoot,
	appendEvent,
	clearEvents,
	eventsBytes,
	readBoots,
	readEvents,
	tailSeq,
} from "../modules/events/store.ts";
import { boot, event, fixture, line } from "./events-store.fixtures.ts";

test.each(["events", "boots"] as const)(
	"%s accept a single record exactly at the byte cap and reject one byte more",
	(name) => {
		using deps = fixture();
		const cap = name === "events" ? 512 * 1024 : 128 * 1024;
		if (name === "events") {
			const record = event(
				1,
				"x".repeat(cap - Buffer.byteLength(line(event()))),
			);
			appendEvent(record, { ...deps, sync: false });
			expect(readEvents(deps)).toEqual([record]);
			appendEvent(
				{
					...record,
					params: { ...record.params, text: `${record.params.text}x` },
				},
				{ ...deps, sync: false },
			);
		} else {
			const record = boot("x".repeat(cap - Buffer.byteLength(line(boot()))));
			appendBoot(record, deps);
			expect(readBoots(deps)).toEqual([record]);
			appendBoot(
				boot("x".repeat(cap - Buffer.byteLength(line(boot())) + 1)),
				deps,
			);
		}
		expect(fs.statSync(path.join(deps.baseDir, `${name}.jsonl`)).size).toBe(
			cap,
		);
		expect(fs.readdirSync(deps.baseDir)).toEqual([`${name}.jsonl`]);
		expect(deps.warnings).toHaveLength(1);
	},
);

test.each(["events", "boots"] as const)(
	"%s skip an oversized file while reading healthy neighboring generations",
	(name) => {
		using deps = fixture();
		const cap = name === "events" ? 512 * 1024 : 128 * 1024;
		const record = name === "events" ? event() : boot();
		fs.writeFileSync(
			path.join(deps.baseDir, `${name}.jsonl`),
			"x".repeat(cap + 1),
		);
		fs.writeFileSync(path.join(deps.baseDir, `${name}.1.jsonl`), line(record));
		if (name === "events") expect(readEvents(deps)).toEqual([event()]);
		else expect(readBoots(deps)).toEqual([boot()]);
		if (name === "events") appendEvent(event(2), { ...deps, sync: false });
		else appendBoot(boot("new"), deps);
		expect(fs.statSync(path.join(deps.baseDir, `${name}.jsonl`)).size).toBe(
			cap + 1,
		);
		expect(deps.warnings).toHaveLength(1);
	},
);

test("a torn tail's separator counts against rotation and is omitted from the new file", () => {
	using deps = fixture();
	const file = path.join(deps.baseDir, "events.jsonl");
	const size = 512 * 1024 - Buffer.byteLength(line(event()));
	fs.writeFileSync(file, "x".repeat(size));
	appendEvent(event(), { ...deps, sync: false });
	expect(fs.statSync(path.join(deps.baseDir, "events.1.jsonl")).size).toBe(
		size,
	);
	expect(fs.readFileSync(file, "utf8")).toBe(line(event()));
	expect(readEvents(deps)).toEqual([event()]);
});

test("boot appends sync their descriptor after the complete line", () => {
	using deps = fixture();
	let synced = false;
	appendBoot(boot(), {
		...deps,
		fs: {
			...fs,
			fdatasyncSync: (fd) => {
				expect(fs.fstatSync(fd).size).toBe(Buffer.byteLength(line(boot())));
				synced = true;
			},
		},
	});
	expect(synced).toBe(true);
});

test("an empty directory has no records, sequence or bytes", () => {
	using deps = fixture();
	expect(readEvents(deps)).toEqual([]);
	expect(readBoots(deps)).toEqual([]);
	expect(tailSeq(deps)).toBe(0);
	expect(eventsBytes(deps)).toBe(0);
});

test.each([
	[-2, undefined, -2],
	[-5, -2, -2],
] as const)(
	"tailSeq returns the negative disk maximum for current %i and previous %s",
	(current, previous, expected) => {
		using deps = fixture();
		if (previous !== undefined)
			fs.writeFileSync(
				path.join(deps.baseDir, "events.1.jsonl"),
				line(event(previous)),
			);
		fs.writeFileSync(
			path.join(deps.baseDir, "events.jsonl"),
			line(event(current)),
		);
		expect(tailSeq(deps)).toBe(expected);
	},
);

test("non-Error filesystem failures still produce one useful warning", () => {
	using deps = fixture();
	appendEvent(event(), {
		...deps,
		sync: false,
		fs: {
			...fs,
			mkdirSync: () => {
				throw "disk unavailable";
			},
		},
	});
	expect(deps.warnings).toEqual([
		"event store: operation failed: disk unavailable",
	]);
});

test("a read failure is contained and reported", () => {
	using deps = fixture();
	fs.writeFileSync(path.join(deps.baseDir, "events.jsonl"), line(event()));
	expect(
		readEvents({
			...deps,
			fs: {
				...fs,
				readFileSync: () => {
					throw new TypeError("read failed");
				},
			},
		}),
	).toEqual([]);
	expect(deps.warnings).toEqual(["event store: operation failed: read failed"]);
});

test.each(["", "x"])(
	"appending to a short existing tail %j preserves exact byte accounting",
	(tail) => {
		using deps = fixture();
		const file = path.join(deps.baseDir, "events.jsonl");
		fs.writeFileSync(file, tail);
		appendEvent(event(), { ...deps, sync: false });
		const expected = tail === "" ? line(event()) : `${tail}\n${line(event())}`;
		expect(fs.readFileSync(file, "utf8")).toBe(expected);
		expect(eventsBytes(deps)).toBe(Buffer.byteLength(expected));
		expect(readEvents(deps)).toEqual([event()]);
	},
);

test("a new file is private before descriptor mode repair", () => {
	using deps = fixture();
	let createdMode = 0;
	appendEvent(event(), {
		...deps,
		sync: false,
		fs: {
			...fs,
			openSync: (...args) => {
				const fd = fs.openSync(...args);
				createdMode = fs.fstatSync(fd).mode & 0o777;
				return fd;
			},
		},
	});
	expect(createdMode).toBe(0o600);
});

test("rotation discards the oldest generation even when intervening generations are absent", () => {
	using deps = fixture();
	fs.writeFileSync(path.join(deps.baseDir, "events.7.jsonl"), line(event(1)));
	fs.writeFileSync(
		path.join(deps.baseDir, "events.jsonl"),
		`${" ".repeat(512 * 1024 - 1)}\n`,
	);
	appendEvent(event(2), { ...deps, sync: false });
	expect(fs.readdirSync(deps.baseDir).sort()).toEqual([
		"events.1.jsonl",
		"events.jsonl",
	]);
	expect(readEvents(deps)).toEqual([event(2)]);
});

test("out-of-ring filenames are untouched by reads, accounting, rotation and clear", () => {
	using deps = fixture();
	for (const name of [
		"events.-1.jsonl",
		"events.8.jsonl",
		"boots.-1.jsonl",
		"boots.2.jsonl",
	]) {
		fs.writeFileSync(
			path.join(deps.baseDir, name),
			name.startsWith("events") ? line(event(999)) : line(boot("ignored")),
		);
	}
	appendEvent(event(1), { ...deps, sync: false });
	appendBoot(boot("retained"), deps);
	expect(readEvents(deps)).toEqual([event(1)]);
	expect(readBoots(deps)).toEqual([boot("retained")]);
	expect(eventsBytes(deps)).toBe(Buffer.byteLength(line(event(1))));
	fs.writeFileSync(
		path.join(deps.baseDir, "events.jsonl"),
		`${" ".repeat(512 * 1024 - 1)}\n`,
	);
	appendEvent(event(2), { ...deps, sync: false });
	clearEvents(deps);
	expect(fs.readdirSync(deps.baseDir).sort()).toEqual([
		"boots.-1.jsonl",
		"boots.2.jsonl",
		"boots.jsonl",
		"events.-1.jsonl",
		"events.8.jsonl",
	]);
});
