import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { eventsEpoch } from "../modules/events/epoch.ts";
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

test("three events round-trip oldest first with supplied timestamps", () => {
	using deps = fixture();
	const records = [event(1), event(3), event(2)];
	for (const record of records) appendEvent(record, { ...deps, sync: false });
	expect(readEvents(deps)).toEqual(records);
	expect(tailSeq(deps)).toBe(3);
	expect(fs.readFileSync(path.join(deps.baseDir, "events.jsonl"), "utf8")).toBe(
		records.map(line).join(""),
	);
	expect(eventsBytes(deps)).toBe(Buffer.byteLength(records.map(line).join("")));
	expect(deps.warnings).toEqual([]);
});

test.each([
	["events", 512 * 1024, 8],
	["boots", 128 * 1024, 2],
] as const)(
	"%s retain exactly the newest generations at the byte bound",
	(name, cap, count) => {
		using deps = fixture();
		const records = Array.from({ length: count + 2 }, (_, i) =>
			name === "events" ? event(i + 1) : { ...boot(), startedAt: i + 1 },
		);
		for (const record of records) {
			const padded = line(record)
				.trimEnd()
				.padEnd(cap - 1, " ");
			fs.writeFileSync(path.join(deps.baseDir, `${name}.jsonl`), `${padded}\n`);
			if (name === "events") appendEvent(event(99), { ...deps, sync: false });
			else appendBoot(boot("next"), deps);
		}
		const files = fs.readdirSync(deps.baseDir).sort();
		expect(files).toEqual(
			[
				`${name}.jsonl`,
				...Array.from(
					{ length: count - 1 },
					(_, i) => `${name}.${i + 1}.jsonl`,
				),
			].sort(),
		);
		for (const file of files) {
			expect(
				fs.statSync(path.join(deps.baseDir, file)).size,
			).toBeLessThanOrEqual(cap);
			expect(fs.statSync(path.join(deps.baseDir, file)).mode & 0o777).toBe(
				0o600,
			);
		}
		const retained = name === "events" ? readEvents(deps) : readBoots(deps);
		expect<unknown>(retained).toEqual([
			...records.slice(-(count - 1)),
			name === "events" ? event(99) : boot("next"),
		]);
		if (name === "events")
			expect(eventsBytes(deps)).toBe(
				(count - 1) * cap + Buffer.byteLength(line(event(99))),
			);
	},
);

test.each(["events", "boots"] as const)(
	"%s rotate only when the next complete line exceeds the cap",
	(name) => {
		using deps = fixture();
		const cap = name === "events" ? 512 * 1024 : 128 * 1024;
		const record = name === "events" ? event() : boot();
		const file = path.join(deps.baseDir, `${name}.jsonl`);
		const append = () =>
			name === "events"
				? appendEvent(event(), { ...deps, sync: false })
				: appendBoot(boot(), deps);
		fs.writeFileSync(
			file,
			`${" ".repeat(cap - Buffer.byteLength(line(record)) - 1)}\n`,
		);
		append();
		expect(fs.statSync(file).size).toBe(cap);
		expect(fs.existsSync(path.join(deps.baseDir, `${name}.1.jsonl`))).toBe(
			false,
		);
		append();
		expect(fs.statSync(path.join(deps.baseDir, `${name}.1.jsonl`)).size).toBe(
			cap,
		);
		expect(fs.statSync(file).size).toBe(Buffer.byteLength(line(record)));
	},
);

test.each(["events", "boots"] as const)(
	"%s reject oversized UTF-8 records before rotation or writes",
	(name) => {
		using deps = fixture();
		const cap = name === "events" ? 512 * 1024 : 128 * 1024;
		const file = path.join(deps.baseDir, `${name}.jsonl`);
		fs.writeFileSync(file, "original\n");
		if (name === "events")
			appendEvent(event(1, "é".repeat(cap)), { ...deps, sync: false });
		else appendBoot(boot("é".repeat(cap)), deps);
		expect(fs.readFileSync(file, "utf8")).toBe("original\n");
		expect(fs.readdirSync(deps.baseDir)).toEqual([`${name}.jsonl`]);
		expect(deps.warnings).toHaveLength(1);
	},
);

test.each(["events", "boots"] as const)(
	"%s skip malformed, unknown-version and incomplete lines without losing neighbors",
	(name) => {
		using deps = fixture();
		const record = name === "events" ? event() : boot();
		const file = path.join(deps.baseDir, `${name}.jsonl`);
		fs.writeFileSync(
			file,
			[
				line(record).trimEnd(),
				"{broken",
				JSON.stringify({ ...record, v: 99 }),
				"null",
				"7",
				"[]",
				"{}",
				JSON.stringify({ v: 1 }),
				JSON.stringify({
					...record,
					v: 1,
					params: { nested: {} },
					startedAt: "bad",
				}),
				line(record).trimEnd(),
				line(record).trimEnd(),
			].join("\n"),
		);
		expect<unknown>(
			name === "events" ? readEvents(deps) : readBoots(deps),
		).toEqual([record, record]);
	},
);

test("future event codes and wire defaults survive disk parsing", () => {
	using deps = fixture();
	fs.writeFileSync(
		path.join(deps.baseDir, "events.jsonl"),
		`${JSON.stringify({
			v: 1,
			...event(),
			code: "future",
			family: "future",
			severity: "future",
		})}\n`,
	);
	expect(readEvents(deps)).toEqual([
		{ ...event(), code: "future", family: "device", severity: "info" },
	]);
});

test("a fresh append isolates a torn last line left by a crash", () => {
	using deps = fixture();
	fs.writeFileSync(
		path.join(deps.baseDir, "events.jsonl"),
		`${line(event(1))}{"v":1,"id":"torn`,
	);
	appendEvent(event(2), { ...deps, sync: false });
	expect(readEvents(deps)).toEqual([event(1), event(2)]);
});

test("clear removes only eight event generations and preserves both boot generations", () => {
	using deps = fixture();
	for (let i = 0; i < 8; i++)
		fs.writeFileSync(
			path.join(deps.baseDir, i ? `events.${i}.jsonl` : "events.jsonl"),
			line(event(i)),
		);
	fs.writeFileSync(path.join(deps.baseDir, "boots.1.jsonl"), line(boot("old")));
	appendBoot(boot("new"), deps);
	fs.writeFileSync(path.join(deps.baseDir, "unrelated"), "keep");
	clearEvents(deps);
	expect(fs.readdirSync(deps.baseDir).sort()).toEqual([
		"boots.1.jsonl",
		"boots.jsonl",
		"unrelated",
	]);
	expect(readBoots(deps)).toEqual([boot("old"), boot("new")]);
	expect(eventsBytes(deps)).toBe(0);
	expect(tailSeq(deps)).toBe(0);
	clearEvents(deps);
	expect(deps.warnings).toEqual([]);
});

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("the ring epoch lives on disk until a clear or a damaged file replaces it", () => {
	using deps = fixture();
	const file = path.join(deps.baseDir, "events.epoch");
	expect(eventsEpoch(deps)).toMatch(UUID);
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	const stored = "0f4c2a51-8d3e-4b7a-9c1f-2e6d8a4b5c7e";
	fs.writeFileSync(file, stored);
	appendEvent(event(1), { ...deps, sync: false });
	expect(eventsEpoch(deps)).toBe(stored);

	expect(clearEvents(deps)).toBe(true);
	const cleared = eventsEpoch(deps);
	expect(cleared).toMatch(UUID);
	expect(cleared).not.toBe(stored);
	fs.writeFileSync(file, stored.slice(0, 12));
	const repaired = eventsEpoch(deps);
	expect(repaired).toMatch(UUID);
	expect(repaired).not.toBe(cleared);
	expect(eventsEpoch(deps)).toBe(repaired);
	expect(deps.warnings).toEqual([]);
});

test("a failed clear still replaces the ring epoch, and an unwritable store names none", () => {
	using deps = fixture();
	const before = eventsEpoch(deps);
	const retained = path.join(deps.baseDir, "events.1.jsonl");
	fs.writeFileSync(retained, line(event(1)));
	const remove = fs.rmSync;
	const unlink = spyOn(fs, "rmSync").mockImplementation((target, options) => {
		if (target === retained) throw new Error("injected unlink failure");
		remove(target, options);
	});
	try {
		expect(clearEvents(deps)).toBe(false);
	} finally {
		unlink.mockRestore();
	}
	expect(readEvents(deps)).toEqual([event(1)]);
	expect(eventsEpoch(deps)).not.toBe(before);

	const blocked = path.join(deps.baseDir, "blocked");
	fs.writeFileSync(blocked, "");
	const warned = deps.warnings.length;
	expect(eventsEpoch({ ...deps, baseDir: blocked })).toBeUndefined();
	expect(deps.warnings).toHaveLength(warned + 1);
});

test("tailSeq takes the maximum across disk generations and rereads stale state", () => {
	using deps = fixture();
	fs.writeFileSync(path.join(deps.baseDir, "events.7.jsonl"), line(event(91)));
	appendEvent(event(2), { ...deps, sync: false });
	expect(tailSeq(deps)).toBe(91);
	fs.writeFileSync(path.join(deps.baseDir, "events.7.jsonl"), line(event(12)));
	expect(tailSeq(deps)).toBe(12);
	expect(readEvents(deps)).toEqual([event(12), event(2)]);
});

test.each(["events", "boots"] as const)(
	"%s repair existing file permissions before append",
	(name) => {
		using deps = fixture();
		const file = path.join(deps.baseDir, `${name}.jsonl`);
		fs.writeFileSync(file, "", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		if (name === "events") appendEvent(event(), { ...deps, sync: false });
		else appendBoot(boot(), deps);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	},
);

test("new nested directories are private", () => {
	using deps = fixture();
	const baseDir = path.join(deps.baseDir, "nested", "events");
	appendEvent(event(), { ...deps, baseDir, sync: false });
	expect(fs.statSync(baseDir).mode & 0o777).toBe(0o700);
});
