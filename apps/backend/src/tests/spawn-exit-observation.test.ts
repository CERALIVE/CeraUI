import { expect, spyOn, test } from "bun:test";
import type { Subprocess } from "bun";
import { execFileP } from "../helpers/exec.ts";

test("an executable missing before spawn has no exit observer", async () => {
	const observations: Promise<number>[] = [];
	await expect(
		execFileP(`/nonexistent-${crypto.randomUUID()}`, [], {
			onChildExit: (exit) => observations.push(exit),
		}),
	).rejects.toMatchObject({ code: "ENOENT" });
	expect(observations).toEqual([]);
});

test("a locked stderr after spawn retires the child without losing its exit", async () => {
	const exit = Promise.withResolvers<number>();
	const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>();
	const stderr = new ReadableStream<Uint8Array<ArrayBuffer>>();
	const locked = stderr.getReader();
	const observations: Promise<number>[] = [];
	const signals: (number | NodeJS.Signals | undefined)[] = [];
	const unused = () => {
		throw new Error("unused child operation");
	};
	const child = {
		stdin: undefined,
		stdout,
		stderr,
		readable: stdout,
		terminal: undefined,
		stdio: [null, null, null],
		pid: 1,
		exited: exit.promise,
		exitCode: null,
		signalCode: null,
		killed: false,
		kill(signal) {
			signals.push(signal);
		},
		ref: unused,
		unref: unused,
		send: unused,
		disconnect: unused,
		resourceUsage: unused,
		[Symbol.asyncDispose]: unused,
	} satisfies Subprocess<"ignore", "pipe", "pipe">;
	const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
	try {
		await expect(
			execFileP("fixture", [], {
				onChildExit: (exited) => observations.push(exited),
			}),
		).rejects.toBeInstanceOf(TypeError);
		expect(observations).toEqual([exit.promise]);
		expect(signals).toEqual(["SIGKILL"]);
		expect(stdout.locked).toBe(false);
		exit.resolve(137);
		expect(await Promise.all(observations)).toEqual([137]);
	} finally {
		exit.resolve(137);
		locked.releaseLock();
		spawn.mockRestore();
	}
});
