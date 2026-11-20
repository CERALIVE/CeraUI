import { afterEach, beforeEach, expect, test } from "bun:test";
import { logFollowStartOutputSchema } from "@ceraui/rpc/schemas";
import {
	startFollow,
	stopAllFollows,
	stopFollow,
} from "../modules/device-logs/follow.ts";
import { JournalReadError } from "../modules/device-logs/reader.ts";
import { followFixture, record } from "./helpers/device-follow.ts";

let f: ReturnType<typeof followFixture>;
beforeEach(() => {
	f = followFixture();
});
afterEach(async () => {
	await stopAllFollows("cleared");
	f.restore();
});
async function start(input = {}) {
	const result = await startFollow(f.conn, input, f.options);
	expect(logFollowStartOutputSchema.safeParse(result).success).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result;
}
function child() {
	const result = f.children.at(-1);
	if (!result) throw new Error("follower not spawned");
	return result;
}
test.each(["JOURNAL_UNAVAILABLE", "RECORD_TOO_LARGE", "READ_FAILED"] as const)(
	"position scan failure %s releases admission without a child",
	async (code) => {
		f.scan.mockRejectedValueOnce(new JournalReadError(code));
		expect(await startFollow(f.conn, {}, f.options)).toEqual({
			ok: false,
			error: code,
		});
		expect(f.argv).toEqual([]);
		expect(await stopFollow(f.conn)).toEqual({
			success: false,
			checkpointCursor: null,
		});
	},
);

test("an indeterminate empty head scan cannot start an unanchored follower", async () => {
	f.scan.mockResolvedValue({
		status: "budget",
		exitCode: 143,
		skippedRecords: 0,
	});
	expect(await startFollow(f.conn, {}, f.options)).toEqual({
		ok: false,
		error: "READ_FAILED",
	});
	expect(f.argv).toEqual([]);
});
test("a boot containing only unreadable records cannot start a cursorless watcher", async () => {
	f.scan.mockResolvedValue({ status: "eof", exitCode: 0, skippedRecords: 1 });
	expect(await startFollow(f.conn, {}, f.options)).toEqual({
		ok: false,
		error: "READ_FAILED",
	});
	expect(f.argv).toEqual([]);
	expect(f.time.timers.size).toBe(0);
});

test("unknown boot identity refuses follow without scanning", async () => {
	f.boot.mockReturnValue(undefined);
	expect(await startFollow(f.conn, {}, f.options)).toEqual({
		ok: false,
		error: "BOOT_UNAVAILABLE",
	});
	expect(f.scan).not.toHaveBeenCalled();
});
test("an unexpected watcher launch failure returns READ_FAILED and releases its slot", async () => {
	expect(
		await startFollow(
			f.conn,
			{},
			{
				clock: f.time.clock,
				spawn: () => {
					throw new Error("launch failed");
				},
			},
		),
	).toEqual({ ok: false, error: "READ_FAILED" });
	expect(await stopFollow(f.conn)).toEqual({
		success: false,
		checkpointCursor: null,
	});
	expect(f.time.timers.size).toBe(0);
});

test("a failed socket send stops its follower and preserves its resumable checkpoint", async () => {
	let writes = 0;
	const conn = {
		send() {
			writes++;
			throw new Error("socket closed");
		},
	};
	expect((await startFollow(conn, {}, f.options)).ok).toBe(true);
	await child().emit([record(2)]);
	expect(() => f.time.advance(250)).not.toThrow();
	expect(child().signals).toEqual(["SIGTERM"]);
	expect(await stopFollow(conn)).toEqual({
		success: true,
		checkpointCursor: "s=1",
	});
	expect(writes).toBe(1);
	expect(f.time.timers.size).toBe(0);
});

test("malformed follower output ends once and retires queued work without retry", async () => {
	await start();
	await child().emit([record(2)]);
	await child().emitRaw("{malformed}\n");
	await f.sent;
	expect(f.messages[0]).toMatchObject({
		entries: [],
		dropped: 0,
		checkpointCursor: "s=1",
		ended: "follower_exit",
	});
	expect(f.messages.length).toBe(1);
	expect(child().signals).toEqual(["SIGTERM"]);
	expect(f.time.timers.size).toBe(0);
	expect(await stopFollow(f.conn)).toEqual({
		success: false,
		checkpointCursor: null,
	});
});

test("a stream failure during our stop does not announce an unexpected exit", async () => {
	await start();
	child().failOnAbort();
	expect(await stopFollow(f.conn)).toEqual({
		success: true,
		checkpointCursor: "s=1",
	});
	expect(f.messages).toEqual([]);
	expect(f.time.timers.size).toBe(0);
});

test("a relevant suppressed notice pending at exit keeps the terminal gap", async () => {
	await start({ sources: ["app"] });
	await child().emit([
		record(2, {
			MESSAGE: "Suppressed ceralive.service",
			MESSAGE_ID: "a596d6fe7bfa4994828e72309e95d61e",
		}),
	]);
	child().finish(0);
	await f.sent;
	expect(f.messages[0]).toMatchObject({
		gap: "suppressed",
		ended: "follower_exit",
		checkpointCursor: "s=2",
	});
	expect(f.messages[0]?.entries.map((r) => r.cursor)).toEqual(["s=2"]);
});
