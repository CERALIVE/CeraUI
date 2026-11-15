import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logQueryInputSchema } from "@ceraui/rpc/schemas";
import * as identity from "../modules/device-logs/boot-id.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import { scanPage } from "../modules/device-logs/scan-page.ts";
import {
	bootId,
	queryFixture,
	record,
	socket,
} from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
beforeEach(() => {
	fixture = queryFixture();
});
afterEach(() => fixture.restore());
test("the reader receives exact continue then stop decisions at look-ahead", async () => {
	fixture.scan.mockImplementation(async (input) => {
		expect(input.onRecord(record(1))).toBe("continue");
		expect(input.onRecord(record(2))).toBe("stop");
		return { status: "stopped", exitCode: 143, skippedRecords: 0 };
	});
	expect(
		await queryLogs(socket(), { boot: bootId, direction: "newer", limit: 1 }),
	).toMatchObject({
		ok: true,
		entries: [{ cursor: "s=1" }],
		termination: "lookahead",
	});
});
test("a rejected anchor stops the reader before any further record", async () => {
	let calls = 0;
	fixture.scan.mockImplementation(async (input) => {
		if (calls++ === 0) {
			input.onRecord(record(1));
			input.onRecord(record(2));
		} else expect(input.onRecord(record(0))).toBe("stop");
		return { status: "stopped", exitCode: 143, skippedRecords: 0 };
	});
	const first = await queryLogs(socket(), { boot: bootId, limit: 1 });
	if (!first.ok) throw new Error(first.error);
	expect(
		await queryLogs(socket(), {
			boot: bootId,
			continuation: first.continuation ?? undefined,
		}),
	).toEqual({ ok: false, error: "CURSOR_UNAVAILABLE" });
});
test("the page primitive refuses cancellation even when a scan returns a normal exit", async () => {
	const controller = new AbortController();
	controller.abort();
	fixture.scan.mockResolvedValue({
		status: "stopped",
		exitCode: 0,
		skippedRecords: 0,
	});
	expect(
		scanPage(logQueryInputSchema.parse({}), {
			bootId,
			epoch: 7,
			signal: controller.signal,
		}),
	).rejects.toMatchObject({ code: "READ_FAILED" });
});
test("a stored-only boot cannot start a raw query", async () => {
	const rows = await fixture.list();
	fixture.list.mockResolvedValue(
		rows.map((row) => ({ ...row, logsAvailable: false })),
	);
	expect(await queryLogs(socket(), { boot: bootId })).toEqual({
		ok: false,
		error: "BOOT_UNAVAILABLE",
	});
	expect(fixture.scan).not.toHaveBeenCalled();
});
test("native current queries use the current identity without enumerating archived boots", async () => {
	const id = spyOn(identity, "currentBootId").mockReturnValue(bootId);
	fixture.list.mockRejectedValue(
		new TypeError("must not enumerate current boot"),
	);
	fixture.scan.mockResolvedValue({
		status: "eof",
		exitCode: 0,
		skippedRecords: 0,
	});
	try {
		expect(await queryLogs(socket(), {})).toMatchObject({ ok: true, bootId });
		expect(fixture.list).not.toHaveBeenCalled();
	} finally {
		id.mockRestore();
	}
});
test.each([
	["a", "f"],
	["f", "a"],
] as const)(
	"available boot %s cannot authorize unknown boot %s",
	async (available, requested) => {
		const rows = await fixture.list();
		fixture.list.mockResolvedValue(
			rows.map((row) => ({ ...row, bootId: available.repeat(32) })),
		);
		expect(await queryLogs(socket(), { boot: requested.repeat(32) })).toEqual({
			ok: false,
			error: "BOOT_UNAVAILABLE",
		});
		expect(fixture.scan).not.toHaveBeenCalled();
	},
);
test("an explicit high-valued boot identity remains distinct from current", async () => {
	const selected = "f".repeat(32);
	const rows = await fixture.list();
	fixture.list.mockResolvedValue(
		rows.map((row) => ({ ...row, bootId: selected })),
	);
	fixture.scan.mockResolvedValue({
		status: "eof",
		exitCode: 0,
		skippedRecords: 0,
	});
	expect(await queryLogs(socket(), { boot: selected })).toMatchObject({
		ok: true,
		bootId: selected,
	});
});
