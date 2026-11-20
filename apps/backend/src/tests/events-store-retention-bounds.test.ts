import { expect, test } from "bun:test";
import fs from "node:fs";
import {
	append,
	readRing,
	record,
	ringPath,
	rings,
	sequence,
	sizedRecord,
	type TestRecord,
} from "./events-store.bounds-fixtures.ts";
import { fixture, line } from "./events-store.fixtures.ts";

test.each(
	rings.flatMap((ring) => [-1, 0, 1].map((offset) => ({ ring, offset }))),
)(
	"$ring.name generation count offset $offset keeps exactly the newest bounded files in order",
	({ ring, offset }) => {
		using deps = fixture();
		const count = ring.files + offset;
		for (let seq = 1; seq <= count; seq++) {
			append(sizedRecord(ring, { bytes: ring.bytes, seq }), deps);
		}

		const first = Math.max(1, count - ring.files + 1);
		expect(readRing(ring, deps).map(sequence)).toEqual(
			Array.from({ length: count - first + 1 }, (_, index) => first + index),
		);
		const kept = Math.min(count, ring.files);
		expect(fs.readdirSync(deps.baseDir).sort()).toEqual(
			Array.from({ length: kept }, (_, generation) =>
				generation ? `${ring.name}.${generation}.jsonl` : `${ring.name}.jsonl`,
			).sort(),
		);
		for (let generation = 0; generation < kept; generation++) {
			expect(fs.statSync(ringPath(deps.baseDir, ring, generation)).size).toBe(
				ring.bytes,
			);
		}
		expect(deps.warnings).toEqual([]);
	},
);

test.each(rings)(
	"$name retention preserves within-file append order and evicts the whole oldest generation",
	(ring) => {
		using deps = fixture();
		const seeded: TestRecord[] = [];
		for (let generation = ring.files - 1; generation >= 0; generation--) {
			const values = [
				record(ring, 40 - generation * 2),
				record(ring, -40 + generation * 2),
			];
			const encoded = values.map(line).join("");
			const text = `${encoded.slice(0, -1)}${" ".repeat(ring.bytes - Buffer.byteLength(encoded))}\n`;
			fs.writeFileSync(ringPath(deps.baseDir, ring, generation), text);
			seeded.push(...values);
		}
		const next = record(ring, 99);

		append(next, deps);

		expect(readRing(ring, deps).map(sequence)).toEqual([
			...seeded.slice(2).map(sequence),
			99,
		]);
		expect(fs.readdirSync(deps.baseDir)).toHaveLength(ring.files);
		expect(deps.warnings).toEqual([]);
	},
);
