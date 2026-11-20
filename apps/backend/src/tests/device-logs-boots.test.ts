import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { logBootInfoSchema } from "@ceraui/rpc/schemas";
import * as run from "../helpers/run.ts";
import * as mocks from "../mocks/mock-service.ts";
import * as identity from "../modules/device-logs/boot-id.ts";
import { listBoots } from "../modules/device-logs/boots.ts";
import * as adapter from "../modules/device-logs/mock-journal.ts";
import * as store from "../modules/events/store.ts";
import { record } from "./helpers/device-query.ts";

afterEach(() => {
	setSystemTime();
	spyOn(run, "run").mockRestore();
	spyOn(mocks, "shouldUseMocks").mockRestore();
	spyOn(store, "readBoots").mockRestore();
	spyOn(identity, "currentBootId").mockRestore();
	spyOn(adapter, "scanMockJournal").mockRestore();
});
const a = "a".repeat(32),
	b = "b".repeat(32),
	c = "c".repeat(32);
test("boot rows merge stored versions without replacing journal bounds or inventing availability", async () => {
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	spyOn(identity, "currentBootId").mockReturnValue(b);
	spyOn(store, "readBoots").mockReturnValue([
		{ bootId: a, startedAt: 5, versions: null },
		{ bootId: c, startedAt: 3, versions: null },
	]);
	const command = spyOn(run, "run").mockResolvedValue(
		JSON.stringify([
			{ boot_id: a, index: -1, first_entry: 1000, last_entry: 2999 },
			{ boot_id: b, index: 0, first_entry: 3000, last_entry: 4000 },
		]),
	);
	const result = await listBoots();
	expect(command.mock.calls).toEqual([
		["journalctl", ["--list-boots", "-o", "json"], { timeout: 30_000 }],
	]);
	expect(result).toEqual([
		{
			bootId: b,
			index: 0,
			firstTs: 3,
			lastTs: 4,
			current: true,
			logsAvailable: true,
			shutdown: "current",
			evidence: [],
			versions: null,
		},
		{
			bootId: a,
			index: -1,
			firstTs: 1,
			lastTs: 2,
			current: false,
			logsAvailable: true,
			shutdown: "unknown",
			evidence: [],
			versions: null,
		},
		{
			bootId: c,
			index: -2,
			firstTs: 3,
			lastTs: 3,
			current: false,
			logsAvailable: false,
			shutdown: "unknown",
			evidence: [],
			versions: null,
		},
	]);
	for (const row of result)
		expect(logBootInfoSchema.safeParse(row).success).toBe(true);
});
test("mock boot discovery never runs journalctl and has exactly one current journal boot", async () => {
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	spyOn(identity, "currentBootId").mockReturnValue(a);
	spyOn(store, "readBoots").mockReturnValue([]);
	const command = spyOn(run, "run");
	const result = await listBoots();
	expect(result).toHaveLength(1);
	expect(result[0]).toMatchObject({
		bootId: a,
		current: true,
		logsAvailable: true,
		shutdown: "current",
		index: 0,
	});
	expect(command).not.toHaveBeenCalled();
});
test.each([
	"{}",
	'[{"boot_id":"bad","index":0,"first_entry":0,"last_entry":1}]',
	"bad JSON",
])(
	"invalid boot-list payload %s fails instead of masquerading as empty history",
	async (stdout) => {
		spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
		spyOn(run, "run").mockResolvedValue(stdout);
		expect(listBoots()).rejects.toMatchObject({ code: "READ_FAILED" });
	},
);
test.each([
	["01".repeat(16), [], 0],
	["02".repeat(16), [3, 9], 9],
	["03".repeat(16), [0, 3], 3],
	["04".repeat(16), [1000, 2000], 2000],
] as const)(
	"mock boot %s starts at discovery and reads its last timestamp from %j",
	async (bootId, timestamps, last) => {
		const startedAt = 3000;
		setSystemTime(new Date(startedAt));
		spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
		spyOn(identity, "currentBootId").mockReturnValue(bootId);
		spyOn(store, "readBoots").mockReturnValue([]);
		spyOn(adapter, "scanMockJournal").mockImplementation(async (input) => {
			expect(input.options).toEqual([]);
			expect(input.matches).toEqual([]);
			for (const ts of timestamps)
				expect(input.onRecord(record(ts))).toBe("continue");
			return { status: "eof", exitCode: 0, skippedRecords: 0 };
		});
		expect(await listBoots()).toEqual([
			{
				bootId,
				index: 0,
				firstTs: startedAt,
				lastTs: last,
				current: true,
				logsAvailable: true,
				shutdown: "current",
				evidence: [],
				versions: null,
			},
		]);
	},
);
test("missing mock identity and native command faults remain explicit failures", async () => {
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	spyOn(identity, "currentBootId").mockReturnValue(undefined);
	expect(listBoots()).rejects.toMatchObject({ code: "READ_FAILED" });
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	for (const [error, code] of [
		[
			Object.assign(new Error("missing"), { code: "ENOENT" }),
			"JOURNAL_UNAVAILABLE",
		],
		[Object.assign(new Error("denied"), { code: "EACCES" }), "READ_FAILED"],
		[Object.assign(new Error("pipe"), { code: "EPIPE" }), "READ_FAILED"],
		[{ code: "ENOENT" }, "READ_FAILED"],
		["fault", "READ_FAILED"],
		[new TypeError("command fault"), "READ_FAILED"],
	] as const) {
		spyOn(run, "run").mockRejectedValue(error);
		expect(listBoots()).rejects.toMatchObject({ code });
	}
});
test("the largest reader-admitted microsecond timestamp round-trips as the mock boot's last entry", async () => {
	const startedAt = 3000;
	setSystemTime(new Date(startedAt));
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	spyOn(identity, "currentBootId").mockReturnValue("05".repeat(16));
	spyOn(store, "readBoots").mockReturnValue([]);
	const largest = record(1, {
		__REALTIME_TIMESTAMP: String(Number.MAX_SAFE_INTEGER),
	});
	spyOn(adapter, "scanMockJournal").mockImplementation(async (input) => {
		input.onRecord(largest);
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const result = await listBoots();
	expect(result[0]).toMatchObject({
		firstTs: startedAt,
		lastTs: Number(BigInt(Number.MAX_SAFE_INTEGER) / 1000n),
	});
	expect(logBootInfoSchema.safeParse(result[0]).success).toBe(true);
});
