import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { eventsEpoch } from "../modules/events/epoch.ts";
import { clearEvents, readEvents } from "../modules/events/store.ts";
import { event, fixture, line } from "./events-store.fixtures.ts";

test.each(["epoch unlink", "directory sync"] as const)(
	"clear preserves every generation when %s fails",
	(fault) => {
		using deps = fixture();
		const records = Array.from({ length: 8 }, (_, i) => event(i + 1));
		for (const record of records) {
			const generation = records.length - record.seq;
			const file = generation ? `events.${generation}.jsonl` : "events.jsonl";
			fs.writeFileSync(path.join(deps.baseDir, file), line(record));
		}
		const epochFile = path.join(deps.baseDir, "events.epoch");
		const epoch = eventsEpoch(deps);
		const failure = new Error(`injected ${fault} failure`);
		const io: typeof fs = {
			...fs,
			rmSync: (target, options) => {
				if (fault === "epoch unlink" && target === epochFile) throw failure;
				fs.rmSync(target, options);
			},
			fsyncSync: (fd) => {
				if (fault === "directory sync") throw failure;
				fs.fsyncSync(fd);
			},
		};

		const cleared = clearEvents({ ...deps, fs: io });

		expect(readEvents(deps)).toEqual(records);
		expect(cleared).toBe(false);
		expect(deps.warnings).toHaveLength(1);
		if (fault === "epoch unlink") expect(eventsEpoch(deps)).toBe(epoch);
	},
);
