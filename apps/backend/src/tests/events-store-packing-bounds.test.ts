import { expect, test } from "bun:test";
import fs from "node:fs";
import { eventsBytes } from "../modules/events/store.ts";
import {
	append,
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

const cases = rings.flatMap((ring) =>
	(["file", "ring"] as const).flatMap((scope) =>
		[-1, 0, 1].flatMap((offset) =>
			[512, 1024].map((unit) => ({ ring, scope, offset, unit })),
		),
	),
);

test.each(
	rings.flatMap((ring) => [-1, 0, 1].map((offset) => ({ ring, offset }))),
)(
	"$ring.name aggregate ring bytes offset $offset enforces the total byte ceiling by whole-file eviction",
	({ ring, offset }) => {
		using deps = fixture();
		const previous = seed(ring, deps.baseDir);
		const next = record(ring, ring.files + 1);
		const currentBytes = ring.bytes - Buffer.byteLength(line(next)) + offset;
		fs.writeFileSync(
			ringPath(deps.baseDir, ring),
			paddedFile(record(ring, ring.files), currentBytes),
		);

		append(next, deps);

		expect(readRing(ring, deps)).toEqual([
			...previous.slice(offset > 0 ? 1 : 0),
			next,
		]);
		const total = Array.from(
			{ length: ring.files },
			(_, generation) =>
				fs.statSync(ringPath(deps.baseDir, ring, generation)).size,
		).reduce((sum, bytes) => sum + bytes, 0);
		expect(total).toBe(
			ring.bytes * (offset > 0 ? ring.files - 1 : ring.files) + offset,
		);
		expect(total).toBeLessThanOrEqual(ring.bytes * ring.files);
		expect(eventsBytes(deps)).toBe(ring.name === "events" ? total : 0);
		expect(deps.warnings).toEqual([]);
	},
);

test.each(cases)(
	"$ring.name $scope record capacity offset $offset width $unit obeys bytes rather than an independent count cap",
	({ ring, scope, offset, unit }) => {
		using deps = fixture();
		const referenceCapacity =
			(ring.bytes * (scope === "file" ? 1 : ring.files)) / 1024;
		const count = referenceCapacity + offset;
		const perFile = ring.bytes / unit;
		const previous = Array.from({ length: count - 1 }, (_, index) =>
			sizedRecord(ring, { bytes: unit, seq: index + 1 }),
		);
		const groups = Math.ceil(previous.length / perFile);
		for (let generation = 0; generation < groups; generation++) {
			const start = (groups - generation - 1) * perFile;
			fs.writeFileSync(
				ringPath(deps.baseDir, ring, generation),
				previous
					.slice(start, start + perFile)
					.map(line)
					.join(""),
			);
		}
		const next = sizedRecord(ring, { bytes: unit, seq: count });

		append(next, deps);

		const dropped = count > perFile * ring.files ? perFile : 0;
		expect(readRing(ring, deps).map(sequence)).toEqual(
			Array.from(
				{ length: count - dropped },
				(_, index) => dropped + index + 1,
			),
		);
		const keptFiles = Math.min(Math.ceil(count / perFile), ring.files);
		expect(fs.readdirSync(deps.baseDir)).toHaveLength(keptFiles);
		let total = 0;
		for (let generation = 0; generation < keptFiles; generation++) {
			const bytes = fs.statSync(ringPath(deps.baseDir, ring, generation)).size;
			expect(bytes).toBeLessThanOrEqual(ring.bytes);
			total += bytes;
		}
		expect(total).toBe((count - dropped) * unit);
		expect(total).toBeLessThanOrEqual(ring.bytes * ring.files);
		expect(eventsBytes(deps)).toBe(ring.name === "events" ? total : 0);
		expect(deps.warnings).toEqual([]);
	},
);
