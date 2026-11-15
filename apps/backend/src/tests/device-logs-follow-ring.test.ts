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
