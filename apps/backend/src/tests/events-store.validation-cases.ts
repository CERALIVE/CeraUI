import { boot, event } from "./events-store.fixtures.ts";

export interface InvalidRecordCase {
	readonly name: string;
	readonly kind: "events" | "boots";
	readonly value: unknown;
	readonly diskLine?: string;
}

const wrongString = [undefined, null, 1, true, [], { secret: "private" }];
const wrongNumber = [
	undefined,
	null,
	"1",
	true,
	[],
	{},
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
];
const wrongInteger = [
	...wrongNumber,
	0.5,
	-0.5,
	Number.MAX_SAFE_INTEGER + 1,
	Number.MIN_SAFE_INTEGER - 1,
];
export const invalidBootIds: readonly unknown[] = [
	...wrongString,
	"",
	"a".repeat(31),
	"a".repeat(33),
	"A".repeat(32),
	"g".repeat(32),
	`${"0".repeat(31)}G`,
	"01234567-89ab-cdef-0123-456789abcdef",
	` ${"a".repeat(32)}`,
	`${"a".repeat(32)} `,
	`${"a".repeat(32)}\n`,
	`${"a".repeat(32)}\r`,
];

function fields(
	kind: InvalidRecordCase["kind"],
	cases: Readonly<Record<string, readonly unknown[]>>,
): InvalidRecordCase[] {
	const record = kind === "events" ? event() : boot();
	return Object.entries(cases).flatMap(([field, values]) =>
		values.map((value, index) => ({
			name: `${kind}.${field} invalid variant ${index}`,
			kind,
			value: { ...record, [field]: value },
		})),
	);
}

export const versionStringFields = [
	"osImage",
	"slot",
	"board",
	"boardModel",
	"engine",
	"senderVersion",
	"kernel",
	"bun",
] as const;

const versionCases = Object.entries({
	bootId: invalidBootIds,
	ceraui: wrongString,
	...Object.fromEntries(
		versionStringFields.map((field) => [
			field,
			[undefined, 1, true, [], { secret: "private" }],
		]),
	),
}).flatMap(([field, values]) =>
	values.map(
		(value, index): InvalidRecordCase => ({
			name: `boots.versions.${field} invalid variant ${index}`,
			kind: "boots",
			value: { ...boot(), versions: { ...boot().versions, [field]: value } },
		}),
	),
);

export const invalidRecords: readonly InvalidRecordCase[] = [
	...(["events", "boots"] as const).flatMap((kind) =>
		[undefined, null, false, 0, "private", [], {}].map((value, index) => ({
			name: `${kind} root invalid variant ${index}`,
			kind,
			value,
		})),
	),
	...fields("events", {
		id: wrongString,
		seq: wrongInteger,
		bootId: invalidBootIds,
		at: wrongNumber,
		code: wrongString,
		params: [undefined, null, false, 1, "private", []],
		suppressed: wrongInteger.filter((value) => value !== undefined),
	}),
	...[
		undefined,
		{},
		[1],
		["ok", false],
		Number.NaN,
		Number.POSITIVE_INFINITY,
	].map(
		(value, index): InvalidRecordCase => ({
			name: `events.params.value invalid variant ${index}`,
			kind: "events",
			value: { ...event(), params: { field: value } },
			...(value === undefined ||
			(typeof value === "number" && !Number.isFinite(value))
				? {
						diskLine: JSON.stringify({
							v: 1,
							...event(),
							params: { field: "raw-invalid-value" },
						}).replace('"raw-invalid-value"', String(value)),
					}
				: {}),
		}),
	),
	...fields("boots", {
		bootId: invalidBootIds,
		startedAt: wrongNumber,
		versions: [undefined, false, 1, "private", [], {}],
	}),
	...versionCases,
	{
		name: "boots unknown top-level field",
		kind: "boots",
		value: { ...boot(), unexpected: "private" },
	},
	{
		name: "boots unknown version field",
		kind: "boots",
		value: {
			...boot(),
			versions: { ...boot().versions, unexpected: "private" },
		},
	},
];
