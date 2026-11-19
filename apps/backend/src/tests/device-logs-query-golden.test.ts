import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { type LogQueryInput, logQueryInputSchema } from "@ceraui/rpc/schemas";
import {
	bindQuery,
	encodePosition,
} from "../modules/device-logs/continuation.ts";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import {
	bootId,
	eventMessage,
	queryFixture,
	record,
	socket,
} from "./helpers/device-query.ts";

const fixture = queryFixture();
afterEach(() => fixture.restore());
test("service option and match combinations replay against the systemd fixture", async () => {
	const bootRows = await fixture.list();
	fixture.list.mockResolvedValue([
		...bootRows,
		...bootRows.map((row) => ({ ...row, bootId: "f".repeat(32) })),
	]);
	const cases: {
		name: string;
		input: LogQueryInput;
		ids: string;
		anchor?: boolean;
	}[] = [
		{ name: "newest", input: { boot: bootId }, ids: "m7 m6 m5 m4 m3 m2 m1" },
		{
			name: "oldest",
			input: { boot: bootId, direction: "newer" },
			ids: "m1 m2 m3 m4 m5 m6 m7",
		},
		{ name: "all boots", input: { boot: "all" }, ids: "m7 m6 m5 m4 m3 m2 m1" },
		{ name: "another boot", input: { boot: "f".repeat(32) }, ids: "" },
		{
			name: "older inclusive",
			input: { boot: bootId },
			anchor: true,
			ids: "m3 m2 m1",
		},
		{
			name: "newer inclusive",
			input: { boot: bootId, direction: "newer" },
			anchor: true,
			ids: "m3 m4 m5 m6 m7",
		},
		{
			name: "bounded membership",
			input: { boot: bootId, since: 1700000001000, until: 1700000004000 },
			ids: "m7 m6 m5 m4 m3 m2 m1",
		},
		{
			name: "app literal text",
			input: { boot: bootId, sources: ["app"], text: "m" },
			ids: "m6 m4 m1",
		},
		{
			name: "app or kernel warnings",
			input: {
				boot: bootId,
				sources: ["app", "kernel"],
				levels: ["error", "warning"],
			},
			ids: "m6 m3",
		},
	];
	const rows: {
		name: string;
		options: string[];
		matches: string[];
		ids: string;
	}[] = [];
	for (const item of cases) {
		fixture.scan.mockClear();
		fixture.scan.mockResolvedValue({
			status: "eof",
			exitCode: 0,
			skippedRecords: 0,
		});
		const query = logQueryInputSchema.parse(item.input);
		await queryLogs(socket(), {
			...query,
			...(item.anchor
				? {
						continuation: encodePosition(
							"s=3",
							bindQuery(query, query.boot === "all" ? null : bootId, 7),
						),
					}
				: {}),
		});
		const call = fixture.scan.mock.calls[0]?.[0];
		if (!call) throw new Error("query did not scan");
		rows.push({
			name: item.name,
			options: call.options.map((option) =>
				option.replace("--cursor=s=3", "--cursor=$m3"),
			),
			matches: call.matches,
			ids: item.ids,
		});
	}
	fixture.scan.mockClear();
	fixture.scan.mockImplementation(async (input) => {
		input.onRecord(
			record(3, {
				MESSAGE: eventMessage,
				__REALTIME_TIMESTAMP: "1700000002000000",
			}),
		);
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	await locateAround(socket(), {
		bootId,
		at: 1700000002000,
		eventId: "event-id",
	});
	const hint = fixture.scan.mock.calls[0]?.[0];
	if (!hint) throw new Error("around did not seek");
	rows.push({
		name: "event seek without realtime bounds",
		options: hint.options,
		matches: hint.matches,
		ids: "m6 m4 m1",
	});
	for (const at of [
		0,
		1,
		2,
		60,
		1000,
		4999,
		5001,
		5999,
		6001,
		10_000,
		100_000,
		Number.MAX_SAFE_INTEGER - 60_000,
		Number.MAX_SAFE_INTEGER - 5000,
		Number.MAX_SAFE_INTEGER - 1,
		Number.MAX_SAFE_INTEGER,
	]) {
		fixture.scan.mockClear();
		await locateAround(socket(), { bootId, at, eventId: "event-id" });
		const seek = fixture.scan.mock.calls[0]?.[0];
		if (!seek) throw new Error("around did not seek");
		rows.push({
			name: `event seek at ${at}`,
			options: seek.options,
			matches: seek.matches,
			ids: "m6 m4 m1",
		});
	}
	const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	const path = new URL(
		"../../test-harness/journal-conformance/query/golden-argv.txt",
		import.meta.url,
	);
	if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, text);
	expect(readFileSync(path, "utf8")).toBe(text);
});
