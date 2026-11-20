import { afterEach, beforeEach, expect, test } from "bun:test";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import { bootId, queryFixture, socket } from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
beforeEach(() => {
	fixture = queryFixture();
});
afterEach(() => fixture.restore());
test.each([
	["a", "f"],
	["f", "a"],
] as const)(
	"available boot %s cannot locate an event in boot %s",
	async (available, requested) => {
		const rows = await fixture.list();
		fixture.list.mockResolvedValue(
			rows.map((row) => ({ ...row, bootId: available.repeat(32) })),
		);
		expect(
			await locateAround(socket(), { bootId: requested.repeat(32), at: 1 }),
		).toEqual({ ok: false, error: "BOOT_UNAVAILABLE" });
		expect(fixture.scan).not.toHaveBeenCalled();
	},
);
test("unexpected location faults propagate instead of being reported as cursor or journal errors", async () => {
	fixture.scan.mockRejectedValue(new TypeError("location fault"));
	expect(
		locateAround(socket(), { bootId, at: 1, eventId: "event-id" }),
	).rejects.toThrow("location fault");
});
test("same-socket replacement aborts and joins an event seek before reading its replacement", async () => {
	const started = Promise.withResolvers<void>();
	fixture.scan.mockImplementationOnce(async (input) => {
		started.resolve();
		if (!input.signal)
			throw new Error("seek must carry its cancellation signal");
		await new Promise<void>((resolve) =>
			input.signal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { status: "stopped", exitCode: 143, skippedRecords: 0 };
	});
	fixture.scan.mockResolvedValue({
		status: "eof",
		exitCode: 0,
		skippedRecords: 0,
	});
	const conn = socket();
	const pending = locateAround(conn, { bootId, at: 1, eventId: "event-id" });
	await started.promise;
	const replacement = queryLogs(conn, { boot: bootId });
	expect(await pending).toEqual({ ok: false, error: "READ_FAILED" });
	expect((await replacement).ok).toBe(true);
});
