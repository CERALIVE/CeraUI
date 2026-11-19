import type { ManagedProcess } from "../../helpers/spawn-policy.ts";
import { journalLine } from "./device-journal.ts";

export function historyJournal(
	options: {
		readonly lines?: readonly string[];
		readonly reap?: Promise<void>;
		readonly cancel?: Promise<void>;
		readonly mode?:
			| "ordinary"
			| "reader-cancel-hooks"
			| "follow-cancel-hook"
			| "kill-throws";
	} = {},
) {
	const exit = Promise.withResolvers<number>();
	const killed = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	const signals: Array<NodeJS.Signals | number | undefined> = [];
	let stdout: ReadableStreamDefaultController<Uint8Array>;
	let stderr: ReadableStreamDefaultController<Uint8Array>;
	let outClosed = false;
	let errClosed = false;
	let alive = true;
	let code: number | null = null;
	let signal: NodeJS.Signals | number | null = null;
	let consumed: ReturnType<typeof Promise.withResolvers<void>> | undefined;
	let cancelCount = 0;
	const encode = (text: string) => new TextEncoder().encode(text);
	const output = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				stdout = controller;
				for (const line of options.lines ?? [])
					controller.enqueue(encode(line));
			},
			pull() {
				consumed?.resolve();
			},
			cancel() {
				outClosed = true;
				cancelCount++;
				cancelled.resolve();
				consumed?.resolve();
				return options.cancel;
			},
		},
		{ highWaterMark: 0 },
	);
	const errors = new ReadableStream<Uint8Array>({
		start(controller) {
			stderr = controller;
		},
		cancel() {
			errClosed = true;
			cancelCount++;
			cancelled.resolve();
			return options.cancel;
		},
	});
	const finish = (result = 0) => {
		if (!outClosed) {
			outClosed = true;
			stdout.close();
		}
		if (!errClosed) {
			errClosed = true;
			stderr.close();
		}
		if (alive) {
			alive = false;
			code = result;
			exit.resolve(result);
		}
		consumed?.resolve();
	};
	const proc = {
		stdout: output,
		stderr: errors,
		get exitCode() {
			return code;
		},
		get signalCode() {
			return signal;
		},
		exited: exit.promise.then(async (result) => {
			await options.reap;
			return result;
		}),
		kill(next?: NodeJS.Signals | number) {
			signals.push(next);
			if (options.mode === "kill-throws")
				throw new Error("kill failed before termination");
			if (!alive) return;
			signal = next ?? "SIGTERM";
			code = next === "SIGKILL" ? 137 : 143;
			alive = false;
			killed.resolve();
			exit.resolve(code);
			if (options.mode === "reader-cancel-hooks") return;
			if (options.mode === "follow-cancel-hook") {
				stdout.enqueue(
					encode(journalLine({ MESSAGE: "buffered at termination" })),
				);
				if (!errClosed) {
					errClosed = true;
					stderr.close();
				}
				return;
			}
			finish(code);
		},
	} satisfies ManagedProcess;
	return {
		proc,
		signals,
		finish,
		killed: killed.promise,
		cancelled: cancelled.promise,
		get alive() {
			return alive;
		},
		get cancelCount() {
			return cancelCount;
		},
		async emit(text: string) {
			consumed = Promise.withResolvers<void>();
			stdout.enqueue(encode(text));
			await consumed.promise;
		},
	};
}
