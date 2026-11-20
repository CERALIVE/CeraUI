import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	type LogQueryOutput,
	logQueryInputSchema,
	logQueryOutputSchema,
} from "@ceraui/rpc/schemas";
import * as identity from "../modules/device-logs/boot-id.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import { JournalReadError } from "../modules/device-logs/reader.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
	socket,
} from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
beforeEach(() => {
	fixture = queryFixture();
});
afterEach(() => fixture.restore());
function page(result: LogQueryOutput) {
	expect(logQueryOutputSchema.safeParse(result).success).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result;
}
const query = { boot: bootId, direction: "newer", limit: 3 } as const;
test("a two-page walk returns three then two without duplicates or gaps", async () => {
	fixture.scan.mockImplementation(
		journal([1, 2, 3, 4, 5].map((n) => record(n))),
	);
	const first = page(await queryLogs(socket(), query));
	expect(first.entries.map((r) => r.cursor)).toEqual(["s=1", "s=2", "s=3"]);
	expect(first).toMatchObject({
		hasMore: true,
		termination: "lookahead",
		historyEpoch: 7,
		bootId,
	});
	expect(
		JSON.parse(Buffer.from(first.continuation ?? "", "base64url").toString()).c,
	).toBe("s=3");
	const second = page(
		await queryLogs(socket(), {
			...query,
			continuation: first.continuation ?? undefined,
		}),
	);
	expect(second.entries.map((r) => r.cursor)).toEqual(["s=4", "s=5"]);
	expect(second).toMatchObject({
		hasMore: false,
		termination: "end",
		continuation: null,
	});
});
test.each([0, 3])(
	"exactly %i records then EOF proves end, regardless of page size",
	async (count) => {
		fixture.scan.mockImplementation(
			journal(Array.from({ length: count }, (_, n) => record(n))),
		);
		expect(page(await queryLogs(socket(), query))).toMatchObject({
			hasMore: false,
			termination: "end",
			continuation: null,
		});
	},
);
test("older traversal reverses the journal and passes only internal options", async () => {
	fixture.scan.mockImplementation(journal([record(1), record(2), record(3)]));
	const result = page(
		await queryLogs(socket(), { boot: "all", limit: 2, since: 0, until: 9 }),
	);
	expect(result.entries.map((r) => r.cursor)).toEqual(["s=3", "s=2"]);
	expect(result.bootId).toBeNull();
	expect(fixture.scan.mock.calls[0]?.[0].options).toEqual(["-r"]);
});
test.each(["eof", "mismatch"] as const)(
	"a lost continuation anchor (%s) expires the cursor",
	async (kind) => {
		fixture.scan.mockImplementation(journal([record(1), record(2)]));
		const first = page(await queryLogs(socket(), { ...query, limit: 1 }));
		fixture.scan.mockImplementation(async (input) => {
			if (kind === "mismatch") input.onRecord(record(99));
			return { status: "eof", exitCode: 0, skippedRecords: 0 };
		});
		expect(
			await queryLogs(socket(), {
				...query,
				continuation: first.continuation ?? undefined,
			}),
		).toEqual({ ok: false, error: "CURSOR_UNAVAILABLE" });
	},
);
test("filter, scope and direction changes refuse a token; epoch loss expires it", async () => {
	fixture.scan.mockImplementation(journal([record(1), record(2)]));
	const first = page(await queryLogs(socket(), { ...query, limit: 1 }));
	for (const patch of [
		{ text: "other" },
		{ since: 1 },
		{ until: 9 },
		{ sources: ["app"] as const },
		{ levels: ["error"] as const },
		{ direction: "older" as const },
		{ boot: "all" as const },
	]) {
		expect(
			await queryLogs(socket(), {
				...query,
				...patch,
				sources: patch.sources ? [...patch.sources] : [],
				levels: patch.levels ? [...patch.levels] : undefined,
				continuation: first.continuation ?? undefined,
			}),
		).toEqual({ ok: false, error: "FILTER_CHANGED" });
	}
	fixture.epoch.mockReturnValue({
		historyEpoch: 8,
		lastClearedAt: null,
		lastMaintenance: null,
	});
	expect(
		await queryLogs(socket(), {
			...query,
			continuation: first.continuation ?? undefined,
		}),
	).toEqual({ ok: false, error: "CURSOR_UNAVAILABLE" });
});
test("budget advances through zero matches and long clock steps to physical EOF", async () => {
	const rows = [1, 2, 3, ...Array.from({ length: 60 }, () => 0), 4].map(
		(ts, i) => record(i + 1, { __REALTIME_TIMESTAMP: String(ts * 1000) }),
	);
	fixture.scan.mockImplementation(journal(rows, 12));
	let continuation: string | undefined;
	const seen: number[] = [];
	for (let i = 0; i < 10; i++) {
		const result = page(
			await queryLogs(socket(), { ...query, limit: 2, since: 1, continuation }),
		);
		seen.push(...result.entries.map((r) => r.ts));
		if (result.termination === "end") break;
		expect(result.continuation).not.toBeNull();
		continuation = result.continuation ?? undefined;
	}
	expect(seen).toEqual([1, 2, 3, 4]);
	for (const [input] of fixture.scan.mock.calls) {
		expect(
			input.options.some(
				(o) => o.startsWith("--since") || o.startsWith("--until"),
			),
		).toBe(false);
	}
});
test("a zero-record budget preserves the incoming position and null on the first page", async () => {
	fixture.scan.mockImplementation(journal([record(1), record(2)]));
	const first = page(await queryLogs(socket(), { ...query, limit: 1 }));
	fixture.scan.mockImplementation(journal([], 0));
	fixture.scan.mockResolvedValue({
		status: "budget",
		exitCode: 143,
		skippedRecords: 0,
	});
	expect(
		page(
			await queryLogs(socket(), {
				...query,
				continuation: first.continuation ?? undefined,
			}),
		),
	).toMatchObject({
		entries: [],
		hasMore: null,
		termination: "budget",
		continuation: first.continuation,
	});
	expect(page(await queryLogs(socket(), query))).toMatchObject({
		continuation: null,
		hasMore: null,
	});
});
test.each(["JOURNAL_UNAVAILABLE", "RECORD_TOO_LARGE", "READ_FAILED"] as const)(
	"reader error %s remains an error",
	async (code) => {
		fixture.scan.mockRejectedValue(new JournalReadError(code));
		expect(await queryLogs(socket(), query)).toEqual({
			ok: false,
			error: code,
		});
	},
);
test("unexpected programming errors propagate rather than becoming end", async () => {
	fixture.scan.mockRejectedValue(new TypeError("broken callback"));
	expect(queryLogs(socket(), query)).rejects.toThrow("broken callback");
});
test("unknown explicit boot and missing current boot cannot broaden to all", async () => {
	fixture.list.mockResolvedValue([]);
	expect(await queryLogs(socket(), query)).toEqual({
		ok: false,
		error: "BOOT_UNAVAILABLE",
	});
	expect(fixture.scan).not.toHaveBeenCalled();
});
test("the parsed query boundary rejects an option-shaped continuation", () => {
	expect(
		logQueryInputSchema.safeParse({ continuation: "--file=secret" }).success,
	).toBe(false);
});
test("a first record before the requested anchor is also expired", async () => {
	fixture.scan.mockImplementation(journal([record(1), record(2)]));
	const first = page(await queryLogs(socket(), { ...query, limit: 1 }));
	fixture.scan.mockImplementation(async (input) => {
		input.onRecord(record(0));
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	expect(
		await queryLogs(socket(), {
			...query,
			continuation: first.continuation ?? undefined,
		}),
	).toEqual({ ok: false, error: "CURSOR_UNAVAILABLE" });
});
test("missing current identity fails instead of scanning all boots", async () => {
	const id = spyOn(identity, "currentBootId").mockReturnValue(undefined);
	try {
		expect(await queryLogs(socket(), {})).toEqual({
			ok: false,
			error: "BOOT_UNAVAILABLE",
		});
		expect(fixture.scan).not.toHaveBeenCalled();
	} finally {
		id.mockRestore();
	}
});
