import { expect, spyOn, test } from "bun:test";
import type { ManagedProcess } from "../helpers/spawn-policy.ts";
import { joinFollowProcess } from "../modules/device-logs/follow-stream.ts";
import { manualClock } from "./helpers/device-journal.ts";

function heldProcess(ignoreTerm = false) {
	const exit = Promise.withResolvers<number>();
	let out: ReadableStreamDefaultController<Uint8Array>;
	let err: ReadableStreamDefaultController<Uint8Array>;
	const signals: string[] = [];
	let done = false;
	let outputClosed = false;
	let errorClosed = false;
	const proc: ManagedProcess = {
		stdout: new ReadableStream({
			start(c) {
				out = c;
			},
			cancel() {
				outputClosed = true;
			},
		}),
		stderr: new ReadableStream({
			start(c) {
				err = c;
			},
			cancel() {
				errorClosed = true;
			},
		}),
		exited: exit.promise,
		exitCode: null,
		signalCode: null,
		kill(signal) {
			signals.push(String(signal));
			if (signal === "SIGTERM" && ignoreTerm) return;
			if (done) return;
			done = true;
			proc.signalCode = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
			if (!outputClosed) {
				outputClosed = true;
				out.close();
			}
			if (!errorClosed) {
				errorClosed = true;
				err.close();
			}
			exit.resolve(143);
		},
	};
	return {
		proc,
		signals,
		finish(signal: ManagedProcess["signalCode"] = null) {
			if (done) return;
			done = true;
			proc.exitCode = signal === null ? 0 : null;
			proc.signalCode = signal;
			if (!outputClosed) {
				outputClosed = true;
				out.close();
			}
			if (!errorClosed) {
				errorClosed = true;
				err.close();
			}
			exit.resolve(signal === null ? 0 : 130);
		},
		abort() {
			if (proc.exitCode === null && proc.signalCode === null)
				proc.kill("SIGTERM");
		},
		failOutput(error: Error) {
			outputClosed = true;
			out.error(error);
		},
	};
}
test("a resistant child is killed at 100ms and reaped before stop completes", async () => {
	const time = manualClock();
	const controller = new AbortController();
	const handle = heldProcess(true);
	let joined = false;
	const task = joinFollowProcess(handle, {
		clock: time.clock,
		signal: controller.signal,
		onRecord: () => "continue",
	}).then(() => {
		joined = true;
	});
	controller.abort();
	expect(handle.signals).toEqual(["SIGTERM"]);
	expect(time.timers.size).toBe(1);
	time.advance(99);
	expect(joined).toBe(false);
	expect(handle.signals).toEqual(["SIGTERM"]);
	time.advance(1);
	await task;
	expect(handle.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(time.timers.size).toBe(0);
});
test("an already aborted scope retires once and disarms its escalation", async () => {
	const time = manualClock();
	const controller = new AbortController();
	controller.abort();
	const handle = heldProcess();
	const task = joinFollowProcess(handle, {
		clock: time.clock,
		signal: controller.signal,
		onRecord: () => "continue",
	});
	expect(time.timers.size).toBe(0);
	await task;
	expect(handle.signals).toEqual(["SIGTERM"]);
	expect(time.timers.size).toBe(0);
});
test.each([null, "SIGINT"] as const)(
	"escalation does not signal an already visible exit (%s) before reaping",
	async (signal) => {
		const time = manualClock();
		const controller = new AbortController();
		const handle = heldProcess(true);
		const task = joinFollowProcess(handle, {
			clock: time.clock,
			signal: controller.signal,
			onRecord: () => "continue",
		});
		controller.abort();
		handle.finish(signal);
		time.advance(100);
		await task;
		expect(handle.signals).toEqual(["SIGTERM"]);
		expect(time.timers.size).toBe(0);
	},
);
test("an early exit cancels the pending escalation and removes its abort listener", async () => {
	const time = manualClock();
	const controller = new AbortController();
	const add = spyOn(controller.signal, "addEventListener");
	const remove = spyOn(controller.signal, "removeEventListener");
	const handle = heldProcess(true);
	try {
		const task = joinFollowProcess(handle, {
			clock: time.clock,
			signal: controller.signal,
			onRecord: () => "continue",
		});
		controller.abort();
		expect(time.timers.size).toBe(1);
		handle.finish();
		await task;
		expect(time.timers.size).toBe(0);
		const listener = add.mock.calls[0]?.[1];
		if (listener === undefined) throw new Error("missing abort listener");
		expect(remove.mock.calls).toEqual([["abort", listener]]);
		expect(handle.signals).toEqual(["SIGTERM"]);
	} finally {
		add.mockRestore();
		remove.mockRestore();
	}
});
test("an output error and concurrent stop share one retirement and wait for reaping", async () => {
	const time = manualClock();
	const controller = new AbortController();
	const handle = heldProcess(true);
	const term = Promise.withResolvers<void>();
	const kill = handle.proc.kill;
	handle.proc.kill = (signal) => {
		kill(signal);
		if (signal === "SIGTERM") term.resolve();
	};
	const failure = new Error("pipe failed");
	const task = joinFollowProcess(handle, {
		clock: time.clock,
		signal: controller.signal,
		onRecord: () => "continue",
	}).catch((error) => error);
	handle.failOutput(failure);
	await term.promise;
	controller.abort();
	expect(handle.signals).toEqual(["SIGTERM"]);
	expect(time.timers.size).toBe(1);
	time.advance(100);
	expect(await task).toBe(failure);
	expect(handle.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(time.timers.size).toBe(0);
});
