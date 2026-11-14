import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	type DeviceEvent,
	EVENT_FAMILIES,
	EVENT_SEVERITIES,
} from "@ceraui/rpc/schemas";
import {
	appendBoot,
	appendEvent,
	readBoots,
	readEvents,
} from "../modules/events/store.ts";
import { boot, event, fixture, line } from "./events-store.fixtures.ts";
import { versionStringFields } from "./events-store.validation-cases.ts";

const validEvents = [
	...["", "future_code", "é"].flatMap((value) => [
		{ ...event(), id: value },
		{ ...event(), code: value },
	]),
	...[Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER].flatMap(
		(value) => [
			{ ...event(), seq: value },
			{ ...event(), suppressed: value },
		],
	),
	...[-Number.MAX_VALUE, -0.5, 0, Number.MIN_VALUE, 0.5, Number.MAX_VALUE].map(
		(at) => ({ ...event(), at }),
	),
	...EVENT_FAMILIES.map((family) => ({ ...event(), family })),
	...EVENT_SEVERITIES.map((severity) => ({ ...event(), severity })),
	...["0".repeat(32), "f".repeat(32)].map((bootId) => ({ ...event(), bootId })),
	...[
		"",
		"é",
		-1.5,
		0,
		Number.MAX_VALUE,
		true,
		false,
		null,
		[],
		["x", "é"],
	].map((value) => ({ ...event(), params: { value } })),
];

test.each(validEvents.map((record, index) => ({ record, index })))(
	"valid event boundary $index persists identically to its read representation",
	({ record }) => {
		using deps = fixture();
		Reflect.apply(appendEvent, undefined, [record, { ...deps, sync: false }]);
		expect(readEvents(deps)).toEqual([record]);
		expect(
			fs.readFileSync(path.join(deps.baseDir, "events.jsonl"), "utf8"),
		).toBe(line(record));
		expect(deps.warnings).toEqual([]);
	},
);

test.each(
	[undefined, null, "future", 1, true, [], { future: true }].map(
		(value, index) => ({ value, index }),
	),
)(
	"wire family and severity fallback $index is canonicalized on write and read",
	({ value }) => {
		using deps = fixture();
		const record = {
			...event(),
			code: "future_code",
			family: value,
			severity: value,
		};
		const expected: DeviceEvent = {
			...event(),
			code: "future_code",
			family: "device",
			severity: "info",
		};
		Reflect.apply(appendEvent, undefined, [record, { ...deps, sync: false }]);
		expect(
			fs.readFileSync(path.join(deps.baseDir, "events.jsonl"), "utf8"),
		).toBe(`${JSON.stringify({ v: 1, ...expected })}\n`);
		expect(readEvents(deps)).toEqual([expected]);
		fs.writeFileSync(
			path.join(deps.baseDir, "events.jsonl"),
			`${JSON.stringify({ v: 1, ...record })}\n`,
		);
		expect(readEvents(deps)).toEqual([expected]);
		expect(deps.warnings).toEqual([]);
	},
);

const validBoots = [
	{ ...boot(), versions: null },
	...[-Number.MAX_VALUE, -0.5, 0, Number.MIN_VALUE, 0.5, Number.MAX_VALUE].map(
		(startedAt) => ({ ...boot(), startedAt }),
	),
	...["0".repeat(32), "f".repeat(32)].map((bootId) => ({ ...boot(), bootId })),
	...["0".repeat(32), "f".repeat(32)].map((bootId) => ({
		...boot(),
		versions: { ...boot().versions, bootId },
	})),
	...["", "é"].map((ceraui) => ({
		...boot(),
		versions: { ...boot().versions, ceraui },
	})),
	...versionStringFields.flatMap((field) =>
		[null, "", "future-version"].map((value) => ({
			...boot(),
			versions: { ...boot().versions, [field]: value },
		})),
	),
];

test.each(validBoots.map((record, index) => ({ record, index })))(
	"valid boot boundary $index persists identically to its read representation",
	({ record }) => {
		using deps = fixture();
		Reflect.apply(appendBoot, undefined, [record, deps]);
		expect<unknown>(readBoots(deps)).toEqual([record]);
		expect(
			fs.readFileSync(path.join(deps.baseDir, "boots.jsonl"), "utf8"),
		).toBe(`${JSON.stringify({ v: 1, ...record })}\n`);
		expect(deps.warnings).toEqual([]);
	},
);

test("unknown event fields cannot override the version envelope on write", () => {
	using deps = fixture();
	Reflect.apply(appendEvent, undefined, [
		{ ...event(), v: 99, extra: "discarded" },
		{ ...deps, sync: false },
	]);
	expect(fs.readFileSync(path.join(deps.baseDir, "events.jsonl"), "utf8")).toBe(
		line(event()),
	);
	expect(readEvents(deps)).toEqual([event()]);
});
