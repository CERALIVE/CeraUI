import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logFollowStartOutputSchema } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import * as policy from "../helpers/spawn-policy.ts";
import {
	startFollow,
	stopAllFollows,
	stopFollow,
} from "../modules/device-logs/follow.ts";
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
test.each([0, 1, 143])(
	"unexpected exit %i announces once and clears timers",
	async (code) => {
		await start();
		child().finish(code);
		await f.sent;
		expect(f.messages.map((m) => m.ended)).toEqual(["follower_exit"]);
		expect(f.time.timers.size).toBe(0);
		expect(await stopFollow(f.conn)).toEqual({
			success: false,
			checkpointCursor: null,
		});
	},
);

test("a fifth socket is busy and replacing a socket reaps its child first", async () => {
	for (let n = 0; n < 4; n++) {
		expect(
			(
				await startFollow(
					n === 0 ? f.conn : { send: Buffer.byteLength },
					{},
					f.options,
				)
			).ok,
		).toBe(true);
	}
	expect(await startFollow({ send: Buffer.byteLength }, {}, f.options)).toEqual(
		{
			ok: false,
			error: "BUSY",
		},
	);
	await start();
	expect(f.children[0]?.signals).toEqual(["SIGTERM"]);
	expect(f.children.length).toBe(5);
});

test("clear announces termination and leaves no follow or timer", async () => {
	await start();
	await stopAllFollows("cleared");
	expect(f.messages.map((m) => m.ended)).toEqual(["cleared"]);
	expect(f.messages[0]).toMatchObject({ dropped: 0, checkpointCursor: "s=1" });
	expect(f.time.timers.size).toBe(0);
	expect(await stopFollow(f.conn)).toEqual({
		success: false,
		checkpointCursor: null,
	});
});

test.each(["Stop", "Clear"] as const)(
	"%s reports a TERM failure once after reap and settles successfully",
	async (action) => {
		await start();
		const follower = child();
		const kill = spyOn(follower.proc, "kill").mockImplementation(() => {
			throw new Error("private subprocess detail");
		});
		const warn = spyOn(logger, "warn");
		const stopping =
			action === "Stop" ? stopFollow(f.conn) : stopAllFollows("cleared");
		try {
			expect(warn.mock.calls).toEqual([]);
			follower.finish();
			expect(await stopping).toEqual(
				action === "Stop"
					? { success: true, checkpointCursor: "s=1" }
					: undefined,
			);
			expect<readonly unknown[]>(warn.mock.calls).toEqual([
				[
					"Journal follower signal failed after reap",
					{ module: "device-logs", signal: "SIGTERM" },
				],
			]);
			expect(f.time.timers.size).toBe(0);
			expect(await stopFollow(f.conn)).toEqual({
				success: false,
				checkpointCursor: null,
			});
		} finally {
			follower.finish();
			await stopping;
			warn.mockRestore();
			kill.mockRestore();
		}
	},
);

test("a stopped follower never flushes its queued entry on unexpected pipe completion", async () => {
	await start();
	await child().emit([record(2)]);
	const stopped = stopFollow(f.conn);
	await stopped;
	f.time.advance(1000);
	expect(f.messages).toEqual([]);
});

test("default scheduling and watcher composition use the platform boundaries", async () => {
	const schedule = spyOn(globalThis, "setTimeout").mockImplementation(
		Object.assign(
			(...args: unknown[]) =>
				Reflect.apply(f.time.clock.setTimeout, f.time.clock, args),
			{ __promisify__: setTimeout.__promisify__ },
		),
	);
	const cancel = spyOn(globalThis, "clearTimeout").mockImplementation((timer) =>
		f.time.clock.clearTimeout(Number(timer)),
	);
	const watcher = spyOn(policy, "spawnWatcher").mockImplementation((argv) => {
		const proc = f.options.spawn(argv);
		return {
			proc,
			abort: () => {
				if (proc.exitCode === null) proc.kill("SIGTERM");
			},
		};
	});
	try {
		expect((await startFollow(f.conn, {})).ok).toBe(true);
		await child().emit([record(2)]);
		f.time.advance(250);
		expect(f.messages[0]?.entries.map((r) => r.cursor)).toEqual(["s=2"]);
		expect(schedule.mock.calls.map((call) => call[1])).toEqual([250]);
		expect(cancel.mock.calls.map((call) => Number(call[0]))).toEqual([1]);
		expect(watcher.mock.calls[0]?.[0][0]).toBe("journalctl");
		await stopFollow(f.conn);
		expect(f.time.timers.size).toBe(0);
	} finally {
		schedule.mockRestore();
		cancel.mockRestore();
		watcher.mockRestore();
	}
});

test("stop between a completed head probe and watcher admission cancels the start", async () => {
	let stopping: ReturnType<typeof stopFollow> | undefined;
	f.scan.mockImplementationOnce(async (input) => {
		input.onRecord(record(1));
		queueMicrotask(() =>
			queueMicrotask(() => {
				stopping = stopFollow(f.conn);
			}),
		);
		return { status: "stopped", exitCode: 143, skippedRecords: 0 };
	});
	expect(await startFollow(f.conn, {}, f.options)).toEqual({
		ok: false,
		error: "READ_FAILED",
	});
	await stopping;
	expect(f.argv).toEqual([]);
});

test("pause disarms its timer synchronously before waiting for process reaping", async () => {
	await start();
	await child().emit([record(2)]);
	const stopped = stopFollow(f.conn);
	f.time.advance(250);
	expect(f.messages).toEqual([]);
	expect(await stopped).toEqual({ success: true, checkpointCursor: "s=1" });
});

test("stopping during a pending head scan returns the initial null checkpoint", async () => {
	f.scan.mockImplementationOnce(
		async (input) =>
			new Promise((resolve) => {
				input.signal?.addEventListener(
					"abort",
					() =>
						resolve({ status: "stopped", exitCode: null, skippedRecords: 0 }),
					{ once: true },
				);
			}),
	);
	const starting = startFollow(f.conn, {}, f.options);
	const stopping = stopFollow(f.conn);
	expect(await starting).toEqual({ ok: false, error: "READ_FAILED" });
	expect(await stopping).toEqual({ success: true, checkpointCursor: null });
	expect(f.argv).toEqual([]);
});

test("catchup cancels the old flush before waiting on its new head and removes its abort listener", async () => {
	await start();
	const scope = f.scan.mock.calls[0]?.[0].signal;
	if (!scope) throw new Error("missing scope");
	const remove = spyOn(scope, "removeEventListener");
	const probed = Promise.withResolvers<Parameters<typeof f.scan>[0]>();
	const head = Promise.withResolvers<{
		status: "stopped";
		exitCode: number;
		skippedRecords: number;
	}>();
	f.scan.mockImplementationOnce((input) => {
		probed.resolve(input);
		return head.promise;
	});
	try {
		await child().emit(Array.from({ length: 2001 }, (_, n) => record(n + 2)));
		const probe = await probed.promise;
		f.time.advance(250);
		expect(f.messages).toEqual([]);
		expect(remove.mock.calls[0]?.[0]).toBe("abort");
		expect(remove.mock.calls[0]?.[1]).toBeInstanceOf(Function);
		probe.onRecord(record(3000));
		head.resolve({ status: "stopped", exitCode: 143, skippedRecords: 0 });
		await f.sent;
		expect(f.messages[0]).toMatchObject({
			gap: "catchup_exceeded",
			checkpointCursor: "s=3000",
		});
	} finally {
		remove.mockRestore();
	}
});
