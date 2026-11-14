import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { eventsBytes } from "../modules/events/store.ts";
import {
	diskSnapshot,
	paddedFile,
	readRing,
	record,
	ringPath,
	rings,
	seed,
	sequence,
} from "./events-store.bounds-fixtures.ts";
import { fixture, line } from "./events-store.fixtures.ts";

const cases = rings.flatMap((ring) =>
	[...new Set([0, Math.floor(ring.files / 2), ring.files - 1])].flatMap(
		(generation) =>
			[-1, 0, 1, ring.bytes * 3].flatMap((offset) =>
				[false, true].map((multiple) => ({
					ring,
					generation,
					offset,
					multiple,
				})),
			),
	),
);

test.each(cases)(
	"$ring.name read file cap offset $offset generation $generation multiple $multiple admits only bounded valid JSON",
	({ ring, generation, offset, multiple }) => {
		using deps = fixture();
		const seeded = seed(ring, deps.baseDir);
		const target = record(ring, ring.files - generation);
		const bytes = ring.bytes + offset;
		const values = multiple
			? [target, record(ring, -100 - generation)]
			: [target];
		const encoded = values.map(line).join("");
		const text = multiple
			? `${encoded.slice(0, -1)}${" ".repeat(bytes - Buffer.byteLength(encoded))}\n`
			: paddedFile(target, bytes);
		expect(Buffer.byteLength(text)).toBe(bytes);
		const lines = text.split("\n");
		for (const [index, value] of values.entries()) {
			expect(JSON.parse(lines[index] ?? "")).toEqual({ v: 1, ...value });
		}
		fs.writeFileSync(ringPath(deps.baseDir, ring, generation), text);
		fs.writeFileSync(path.join(deps.baseDir, "unrelated.keep"), "untouched");
		const before = diskSnapshot(deps.baseDir);

		const actual = readRing(ring, deps);

		expect(actual).toEqual(
			seeded.flatMap((value) =>
				sequence(value) === sequence(target)
					? bytes > ring.bytes
						? []
						: values
					: [value],
			),
		);
		expect(deps.warnings).toEqual([]);
		expect(diskSnapshot(deps.baseDir)).toEqual(before);
		expect(eventsBytes(deps)).toBe(
			ring.name === "events" ? (ring.files - 1) * ring.bytes + bytes : 0,
		);
	},
);
