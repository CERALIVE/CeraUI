import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logFollowMessageSchema } from "@ceraui/rpc/schemas";
import * as logging from "../helpers/logger.ts";
import * as mocks from "../mocks/mock-service.ts";
import {
	startFollow,
	stopAllFollows,
	stopFollow,
} from "../modules/device-logs/follow.ts";
import { manualClock } from "./helpers/device-journal.ts";

let mock: ReturnType<typeof spyOn<typeof mocks, "shouldUseMocks">>;
let spawnGuard: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
beforeEach(() => {
	mock = spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	spawnGuard = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("unexpected native process in mock-ring follow");
	});
	logging.clearRecentLogLines();
});
afterEach(async () => {
	await stopAllFollows("cleared");
	mock.mockRestore();
	spawnGuard.mockRestore();
	logging.clearRecentLogLines();
});
function emit(message: string, level = "debug") {
	return new Promise<void>((resolve, reject) =>
		logging.logger.write(
			{ message, level, module: "follow-fixture" },
			(error) => (error ? reject(error) : resolve()),
		),
	);
}
test("real filtered ring resumes from an excluded debug checkpoint without losing errors", async () => {
	const time = manualClock();
	const messages: ReturnType<typeof logFollowMessageSchema.parse>[] = [];
	const conn = {
		send: (frame: string) =>
			messages.push(
				logFollowMessageSchema.parse(JSON.parse(frame)["logs.follow"]),
			),
	};
	await emit("debug head");
	const start = await startFollow(
		conn,
		{ levels: ["error"] },
		{ clock: time.clock },
	);
	expect(start.ok).toBe(true);
	const pause = await stopFollow(conn);
	expect(pause.checkpointCursor).toBe(`mock=${logging.getLogRingOffset()}`);
	expect(messages).toEqual([]);
	await emit("first error", "error");
	await emit("second error", "error");
	const spawn = spyOn(Bun, "spawn");
	try {
		await startFollow(
			conn,
			{ levels: ["error"], afterCursor: pause.checkpointCursor ?? undefined },
			{ clock: time.clock },
		);
		time.advance(250);
		await emit("live error", "error");
		time.advance(250);
		expect(messages.map((m) => m.gap)).toEqual([undefined, undefined]);
		expect(messages.flatMap((m) => m.entries.map((e) => e.message))).toEqual([
			"[follow-fixture] first error",
			"[follow-fixture] second error",
			"[follow-fixture] live error",
		]);
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
	}
});
test("real ring pending at pause is replayed exactly once after resume", async () => {
	const time = manualClock();
	const messages: ReturnType<typeof logFollowMessageSchema.parse>[] = [];
	const conn = {
		send: (frame: string) =>
			messages.push(
				logFollowMessageSchema.parse(JSON.parse(frame)["logs.follow"]),
			),
	};
	await emit("head");
	await startFollow(conn, {}, { clock: time.clock });
	await emit("pending", "info");
	const pause = await stopFollow(conn);
	expect(messages).toEqual([]);
	expect(time.timers.size).toBe(0);
	await startFollow(
		conn,
		{ afterCursor: pause.checkpointCursor ?? undefined },
		{ clock: time.clock },
	);
	time.advance(250);
	expect(messages.flatMap((m) => m.entries.map((e) => e.message))).toEqual([
		"[follow-fixture] pending",
	]);
});

test("a dropped middle frame ends follow at the accepted cursor and Resume replays it", async () => {
	const time = manualClock();
	const messages: ReturnType<typeof logFollowMessageSchema.parse>[] = [];
	const conn = {
		send(frame: string) {
			const message = logFollowMessageSchema.parse(
				JSON.parse(frame)["logs.follow"],
			);
			if (
				message.entries[0]?.message === "[follow-fixture] missing" &&
				messages.length === 1
			)
				return 0;
			messages.push(message);
			return messages.length === 1 ? -1 : Buffer.byteLength(frame);
		},
	};
	await emit("head");
	expect((await startFollow(conn, {}, { clock: time.clock })).ok).toBe(true);
	await emit("accepted");
	time.advance(250);
	const accepted = `mock=${logging.getLogRingOffset() + 1}`;
	await emit("missing");
	time.advance(250);
	await emit("later");
	time.advance(250);
	expect(
		messages.map(({ checkpointCursor, ended }) => ({
			checkpointCursor,
			ended,
		})),
	).toEqual([
		{ checkpointCursor: accepted, ended: undefined },
		{ checkpointCursor: accepted, ended: "follower_exit" },
	]);
	const afterCursor = messages[1]?.checkpointCursor;
	if (!afterCursor) throw new Error("missing recovery checkpoint");
	expect(
		(await startFollow(conn, { afterCursor }, { clock: time.clock })).ok,
	).toBe(true);
	time.advance(250);
	expect(messages.map((m) => m.entries.map((entry) => entry.message))).toEqual([
		["[follow-fixture] accepted"],
		[],
		["[follow-fixture] missing", "[follow-fixture] later"],
	]);
});

test("Resume replays the first dropped frame after an empty boot start", async () => {
	const time = manualClock();
	const messages: ReturnType<typeof logFollowMessageSchema.parse>[] = [];
	let drop = true;
	const conn = {
		send(frame: string) {
			const message = logFollowMessageSchema.parse(
				JSON.parse(frame)["logs.follow"],
			);
			if (drop && message.entries.length > 0) {
				drop = false;
				return 0;
			}
			messages.push(message);
			return Buffer.byteLength(frame);
		},
	};
	const started = await startFollow(conn, {}, { clock: time.clock });
	if (!started.ok) throw new Error(started.error);
	const afterCursor = started.checkpointCursor;
	if (afterCursor === null) throw new Error("missing boot-start checkpoint");
	await emit("first");
	time.advance(250);
	expect(messages).toMatchObject([
		{ ended: "follower_exit", checkpointCursor: afterCursor },
	]);
	expect(
		await startFollow(conn, { afterCursor }, { clock: time.clock }),
	).toMatchObject({
		ok: true,
		checkpointCursor: afterCursor,
	});
	time.advance(250);
	expect(
		messages.flatMap((m) => m.entries.map((entry) => entry.message)),
	).toEqual(["[follow-fixture] first"]);
});

test("Resume on a new socket replays an empty boot after both sends drop", async () => {
	const time = manualClock();
	const messages: ReturnType<typeof logFollowMessageSchema.parse>[] = [];
	const old = { send: () => 0, terminate: () => undefined };
	const sent = spyOn(old, "send");
	const closed = spyOn(old, "terminate");
	const started = await startFollow(old, {}, { clock: time.clock });
	if (!started.ok) throw new Error(started.error);
	await emit("first missed entry");
	time.advance(250);
	expect(sent).toHaveBeenCalledTimes(2);
	expect(closed).toHaveBeenCalledTimes(1);
	await stopFollow(old);

	const backlog = [
		"first missed entry",
		...Array.from({ length: 130 }, (_, i) => `while disconnected ${i}`),
	];
	for (const message of backlog.slice(1)) await emit(message);
	const fresh = {
		send(frame: string) {
			messages.push(
				logFollowMessageSchema.parse(JSON.parse(frame)["logs.follow"]),
			);
			return Buffer.byteLength(frame);
		},
	};
	expect(
		(
			await startFollow(
				fresh,
				{ afterCursor: started.checkpointCursor ?? undefined },
				{ clock: time.clock },
			)
		).ok,
	).toBe(true);
	time.advance(250);
	expect(
		messages.flatMap((m) => m.entries.map((entry) => entry.message)),
	).toEqual(backlog.map((message) => `[follow-fixture] ${message}`));
});
