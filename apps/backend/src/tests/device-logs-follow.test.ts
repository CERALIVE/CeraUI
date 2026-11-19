import { afterEach, beforeEach, expect, test } from "bun:test";
import { logFollowStartOutputSchema } from "@ceraui/rpc/schemas";
import {
	startFollow,
	stopAllFollows,
	stopFollow,
} from "../modules/device-logs/follow.ts";
import { JOURNAL_OUTPUT_FIELDS } from "../modules/device-logs/reader.ts";
import { getLogState } from "../modules/device-logs/settings.ts";
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
test("head checkpoint precedes two entries in one delayed batch", async () => {
	expect((await start()).checkpointCursor).toBe("s=1");
	await child().emit([record(1), record(2), record(3)]);
	expect(f.messages).toEqual([]);
	expect(f.time.timers.size).toBe(1);
	f.time.advance(249);
	expect(f.messages).toEqual([]);
	f.time.advance(1);
	expect(f.messages.map((m) => m.entries.map((e) => e.cursor))).toEqual([
		["s=2", "s=3"],
	]);
	expect(f.messages[0]).toMatchObject({ checkpointCursor: "s=3", dropped: 0 });
	expect(f.argv[0]).toContain("--cursor=s=1");
	expect(f.argv[0]).toContain("--lines=all");
	expect(f.argv[0]).not.toContain("-n");
	expect(f.argv[0]).toEqual([
		"journalctl",
		"-f",
		"-o",
		"json",
		"--all",
		`--output-fields=${JOURNAL_OUTPUT_FIELDS}`,
		"--cursor=s=1",
		"--lines=all",
		"--",
		`_BOOT_ID=${record(1).bootId}`,
	]);
});

test("205 pending records deliver 200 and count five dropped records", async () => {
	await start();
	await child().emit(Array.from({ length: 205 }, (_, i) => record(i + 2)));
	f.time.advance(0);
	expect(f.messages.map((m) => m.entries.length)).toEqual([200]);
	expect(f.messages[0]).toMatchObject({
		checkpointCursor: "s=206",
		dropped: 5,
	});
});

test.each(["absent", "mismatch", "unreadable"] as const)(
	"lost resume position (%s) announces gap and resolves fresh head",
	async (kind) => {
		f.scan.mockImplementationOnce(async (input) => {
			if (kind === "mismatch") input.onRecord(record(98));
			return {
				status: "eof",
				exitCode: 0,
				skippedRecords: kind === "unreadable" ? 1 : 0,
			};
		});
		const result = await start({ afterCursor: "s=99" });
		expect(result.checkpointCursor).toBe("s=1");
		expect(f.messages.map((m) => m.gap)).toEqual(["cursor_unavailable"]);
		expect(f.messages[0]).toMatchObject({
			entries: [],
			dropped: 0,
			checkpointCursor: null,
		});
		expect(f.argv[0]).toContain("--cursor=s=1");
	},
);

test("pause before a pending batch preserves the last sent checkpoint", async () => {
	await start();
	await child().emit([record(1), record(2)]);
	expect(await stopFollow(f.conn)).toEqual({
		success: true,
		checkpointCursor: "s=1",
	});
	expect(f.messages).toEqual([]);
	expect(f.time.timers.size).toBe(0);
	expect(child().signals).toEqual(["SIGTERM"]);
	await start({ afterCursor: "s=1" });
	await child().emit([record(1), record(2)]);
	f.time.advance(250);
	expect(f.messages.flatMap((m) => m.entries.map((e) => e.cursor))).toEqual([
		"s=2",
	]);
	expect(await stopFollow(f.conn)).toEqual({
		success: true,
		checkpointCursor: "s=2",
	});
});

test("an excluded but existing checkpoint does not discard the first matching entry", async () => {
	await start({ afterCursor: "s=1", levels: ["error"] });
	expect(f.scan.mock.calls[0]?.[0].matches).toEqual([
		`_BOOT_ID=${record(1).bootId}`,
	]);
	await child().emit([
		record(2, { PRIORITY: "3" }),
		record(3, { PRIORITY: "3" }),
	]);
	f.time.advance(250);
	expect(f.messages.map((m) => m.gap)).toEqual([undefined]);
	expect(f.messages.flatMap((m) => m.entries.map((e) => e.cursor))).toEqual([
		"s=2",
		"s=3",
	]);
});

test("an empty boot starts at its beginning and delivers its first record", async () => {
	f.scan.mockResolvedValue({ status: "eof", exitCode: 0, skippedRecords: 0 });
	expect((await start()).checkpointCursor).toBe(
		`boot-start:${record(1).bootId}:${getLogState().historyEpoch}`,
	);
	expect(f.argv[0]?.filter((arg) => arg.startsWith("--cursor"))).toEqual([]);
	await child().emit([record(1)]);
	f.time.advance(250);
	expect(f.messages.flatMap((m) => m.entries.map((e) => e.cursor))).toEqual([
		"s=1",
	]);
});

test("native boot start with unprovable retention reports a gap and reads retained history once", async () => {
	f.scan.mockResolvedValueOnce({
		status: "eof",
		exitCode: 0,
		skippedRecords: 0,
	});
	const { checkpointCursor } = await start();
	if (checkpointCursor === null) throw new Error("missing boot checkpoint");
	await stopFollow(f.conn);
	await start({ afterCursor: checkpointCursor });
	await child().emit([record(3), record(4)]);
	f.time.advance(250);
	child().finish();
	await stopFollow(f.conn);
	expect(
		f.messages.map(({ gap, entries }) => [
			gap,
			entries.map(({ cursor }) => cursor),
		]),
	).toEqual([
		["cursor_unavailable", []],
		[undefined, ["s=3", "s=4"]],
	]);
	expect(f.children).toHaveLength(2);
	expect(f.argv[1]?.filter((arg) => arg.startsWith("--cursor"))).toEqual([]);
});

test.each(["boot", "epoch"] as const)(
	"uses the expected replay position for a stale boot-start %s",
	async (part) => {
		f.scan.mockResolvedValueOnce({
			status: "eof",
			exitCode: 0,
			skippedRecords: 0,
		});
		const { checkpointCursor } = await start();
		if (checkpointCursor === null) throw new Error("missing boot checkpoint");
		await stopFollow(f.conn);
		const stale =
			part === "boot"
				? checkpointCursor.replace(record(1).bootId, "b".repeat(32))
				: checkpointCursor.replace(
						/:\d+$/,
						`:${getLogState().historyEpoch + 1}`,
					);
		const resumed = await start({ afterCursor: stale });
		if (part === "epoch") {
			expect(resumed.checkpointCursor).toBe("s=1");
			expect(f.messages.map((message) => message.gap)).toEqual([
				"cursor_unavailable",
			]);
			expect(f.argv[1]).toContain("--cursor=s=1");
			return;
		}
		expect(resumed.checkpointCursor).toBe(checkpointCursor);
		expect(f.argv[1]?.filter((arg) => arg.startsWith("--cursor"))).toEqual([]);
		await child().emit([record(1), record(2)]);
		f.time.advance(250);
		expect(
			f.messages.map(({ gap, entries }) => [
				gap,
				entries.map(({ cursor }) => cursor),
			]),
		).toEqual([[undefined, ["s=1", "s=2"]]]);
	},
);

test("more than 2000 catchup records announce a gap and restart at fresh head", async () => {
	await start();
	f.rows.push(record(3000));
	await child().emit(Array.from({ length: 2001 }, (_, i) => record(i + 2)));
	await f.sent;
	expect(f.messages.map((m) => m.gap)).toEqual(["catchup_exceeded"]);
	expect(f.messages[0]?.checkpointCursor).toBe("s=3000");
	expect(f.messages[0]?.dropped).toBe(0);
	// The subscription remains usable after its bounded catchup was discarded.
	await stopFollow(f.conn);
	expect(f.argv.at(-1)).toContain("--cursor=s=3000");
	expect(f.children[0]?.signals).toEqual(["SIGTERM"]);
});

test("matching residual text and relevant suppression use the shared paging rules", async () => {
	await start({ sources: ["app"], text: "CERAlive.SERVICE" });
	await child().emit([
		record(2, { MESSAGE: "unrelated" }),
		record(3, {
			MESSAGE: "Suppressed ceralive.service",
			MESSAGE_ID: "a596d6fe7bfa4994828e72309e95d61e",
		}),
		record(4, { MESSAGE: "ceralive.service ordinary" }),
		record(5, { MESSAGE: "ignored trailing record" }),
	]);
	f.time.advance(250);
	expect(f.messages[0]).toMatchObject({
		gap: "suppressed",
		checkpointCursor: "s=5",
	});
	expect(f.messages[0]?.entries.map((e) => e.cursor)).toEqual(["s=3", "s=4"]);
});
