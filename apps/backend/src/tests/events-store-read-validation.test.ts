import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readBoots, readEvents } from "../modules/events/store.ts";
import { boot, event, fixture, line } from "./events-store.fixtures.ts";
import { invalidRecords } from "./events-store.validation-cases.ts";

test.each(invalidRecords)(
	"$name on disk is corrupt and cannot hide valid neighbors",
	({ kind, value, diskLine }) => {
		using deps = fixture();
		const file = path.join(deps.baseDir, `${kind}.jsonl`);
		const before = kind === "events" ? event(1) : boot("before");
		const after = kind === "events" ? event(2) : boot("after");
		const envelope =
			typeof value === "object" && value !== null && !Array.isArray(value)
				? { v: 1, ...value }
				: value;
		fs.writeFileSync(
			file,
			`${line(before)}${diskLine ?? JSON.stringify(envelope)}\n${line(after)}`,
		);

		const records = kind === "events" ? readEvents(deps) : readBoots(deps);

		expect<unknown>(records).toEqual([before, after]);
		expect(deps.warnings).toEqual([]);
	},
);
