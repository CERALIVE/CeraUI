import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { appendBoot, appendEvent } from "../modules/events/store.ts";
import { boot, event, fixture, line } from "./events-store.fixtures.ts";
import { invalidRecords } from "./events-store.validation-cases.ts";

test.each(invalidRecords)(
	"$name is rejected before any persistence operation",
	({ kind, value }) => {
		using deps = fixture();
		const file = path.join(deps.baseDir, `${kind}.jsonl`);
		const original = kind === "events" ? line(event()) : line(boot());
		fs.writeFileSync(file, original);
		let persistenceCalls = 0;
		const options = {
			...deps,
			sync: true,
			fs: {
				...fs,
				mkdirSync: () => {
					persistenceCalls++;
				},
			},
		};
		const append = kind === "events" ? appendEvent : appendBoot;

		let result: unknown;
		expect(() => {
			result = Reflect.apply(append, undefined, [value, options]);
		}).not.toThrow();

		expect(result).toBeUndefined();
		expect(persistenceCalls).toBe(0);
		expect(fs.readFileSync(file, "utf8")).toBe(original);
		expect(fs.readdirSync(deps.baseDir)).toEqual([`${kind}.jsonl`]);
		expect(deps.warnings).toEqual([
			"event store: operation failed: invalid record",
		]);
	},
);

test("invalid data neither creates its directory nor logs payload content", () => {
	using deps = fixture();
	const baseDir = path.join(deps.baseDir, "never-created");
	const secret = "private-payload-".repeat(20000);
	const invalid = { ...event(), params: { nested: { secret } } };

	expect(() =>
		Reflect.apply(appendEvent, undefined, [
			invalid,
			{ ...deps, baseDir, sync: true },
		]),
	).not.toThrow();

	expect(fs.existsSync(baseDir)).toBe(false);
	expect(deps.warnings).toEqual([
		"event store: operation failed: invalid record",
	]);
	expect(deps.warnings.join("")).not.toContain("private-payload");
});
