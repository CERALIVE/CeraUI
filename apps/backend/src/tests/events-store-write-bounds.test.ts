import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	append,
	diskSnapshot,
	paddedFile,
	readRing,
	record,
	ringPath,
	rings,
	seed,
	sequence,
	sizedRecord,
} from "./events-store.bounds-fixtures.ts";
import { fixture, line } from "./events-store.fixtures.ts";

test.each(
	rings.flatMap((ring) =>
		[-1, 0, 1].flatMap((offset) =>
			[false, true].map((unicode) => ({ ring, offset, unicode })),
		),
	),
)(
	"$ring.name record bytes cap offset $offset unicode $unicode enforces the shared payload and line budget",
	({ ring, offset, unicode }) => {
		using deps = fixture();
		const seeded = seed(ring, deps.baseDir);
		fs.writeFileSync(path.join(deps.baseDir, "unrelated.keep"), "untouched");
		const before = diskSnapshot(deps.baseDir);
		const value = sizedRecord(ring, {
			bytes: ring.bytes + offset,
			seq: ring.files + 1,
			unicode,
		});
		expect(Buffer.byteLength(line(value))).toBe(ring.bytes + offset);

		append(value, deps);

		if (offset > 0) {
			expect(readRing(ring, deps)).toEqual(seeded);
			expect(diskSnapshot(deps.baseDir)).toEqual(before);
			expect(deps.warnings).toEqual([
				"event store: operation failed: record exceeds event store file limit",
			]);
		} else {
			expect(readRing(ring, deps).map(sequence)).toEqual([
				...seeded.slice(1).map(sequence),
				sequence(value),
			]);
			expect(fs.readFileSync(ringPath(deps.baseDir, ring), "utf8")).toBe(
				line(value),
			);
			expect(fs.readdirSync(deps.baseDir)).toHaveLength(ring.files + 1);
			expect(deps.warnings).toEqual([]);
		}
	},
);

test.each(
	rings.flatMap((ring) =>
		[-1, 0, 1, ring.bytes * 3].map((offset) => ({ ring, offset })),
	),
)(
	"$ring.name existing file cap offset $offset preserves valid history or refuses once",
	({ ring, offset }) => {
		using deps = fixture();
		const seeded = seed(ring, deps.baseDir);
		const current = record(ring, ring.files);
		fs.writeFileSync(
			ringPath(deps.baseDir, ring),
			paddedFile(current, ring.bytes + offset),
		);
		fs.writeFileSync(path.join(deps.baseDir, "unrelated.keep"), "untouched");
		const before = diskSnapshot(deps.baseDir);
		const next = record(ring, ring.files + 1);

		append(next, deps);

		if (offset > 0) {
			expect(diskSnapshot(deps.baseDir)).toEqual(before);
			expect(readRing(ring, deps)).toEqual(seeded.slice(0, -1));
			expect(deps.warnings).toEqual([
				"event store: operation failed: existing event store file exceeds limit",
			]);
		} else {
			expect(readRing(ring, deps)).toEqual([...seeded.slice(1), next]);
			expect(fs.statSync(ringPath(deps.baseDir, ring, 1)).size).toBe(
				ring.bytes + offset,
			);
			expect(fs.readFileSync(ringPath(deps.baseDir, ring), "utf8")).toBe(
				line(next),
			);
			expect(
				fs.readFileSync(path.join(deps.baseDir, "unrelated.keep"), "utf8"),
			).toBe("untouched");
			expect(deps.warnings).toEqual([]);
		}
	},
);

test.each(
	rings.flatMap((ring) =>
		[-1, 0, 1].flatMap((offset) =>
			[false, true].map((unicode) => ({ ring, offset, unicode })),
		),
	),
)(
	"$ring.name accumulated bytes cap offset $offset unicode $unicode rotates only after crossing",
	({ ring, offset, unicode }) => {
		using deps = fixture();
		const first = record(ring, 1);
		const next = sizedRecord(ring, { bytes: ring.bytes / 4, seq: 2, unicode });
		const bytes = ring.bytes - Buffer.byteLength(line(next)) + offset;
		fs.writeFileSync(ringPath(deps.baseDir, ring), paddedFile(first, bytes));

		append(next, deps);

		expect(readRing(ring, deps)).toEqual([first, next]);
		expect(fs.existsSync(ringPath(deps.baseDir, ring, 1))).toBe(offset > 0);
		expect(fs.statSync(ringPath(deps.baseDir, ring)).size).toBe(
			offset > 0 ? Buffer.byteLength(line(next)) : ring.bytes + offset,
		);
		expect(deps.warnings).toEqual([]);
	},
);
