import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents } from "../modules/events/store.ts";
import { event, fixture, line } from "./events-store.fixtures.ts";

test.each(["\n", '{"v":1,"id":"torn'] as const)(
	"append inspects one byte of the retained file tail %j",
	(tail) => {
		using deps = fixture();
		const file = join(deps.baseDir, "events.jsonl");
		const retained = `${line(event(1))}${" ".repeat(256 * 1024)}${tail}`;
		fs.writeFileSync(file, retained);
		const inspect = spyOn(fs, "readSync");
		try {
			appendEvent(event(2), {
				...deps,
				sync: false,
				fs: {
					...fs,
					readFileSync: () => {
						throw new Error("append must not read the entire ring");
					},
				},
			});
			expect(deps.warnings).toEqual([]);
			expect(inspect.mock.calls).toEqual([
				[
					expect.any(Number),
					expect.any(Uint8Array),
					{ length: 1, position: Buffer.byteLength(retained) - 1 },
				],
			]);
		} finally {
			inspect.mockRestore();
		}
		expect(readEvents(deps)).toEqual([event(1), event(2)]);
	},
);
