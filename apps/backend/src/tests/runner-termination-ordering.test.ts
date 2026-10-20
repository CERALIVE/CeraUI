import { expect, spyOn, test } from "bun:test";
import type { Subprocess } from "bun";
import { execFileP } from "../helpers/exec.ts";
import {
	ALLOWED,
	RunAbortError,
	RunTimeoutError,
	run,
} from "../helpers/run.ts";
import {
	COMMAND_BUDGET,
	manualCommandTimer,
	settled,
} from "./helpers/termination-child.ts";

for (const runner of ["execFileP", "run"] as const) {
	for (const reason of ["timeout", "abort"] as const) {
		for (const exitFirst of [true, false]) {
			for (const code of [0, 7]) {
				test(`${runner} ${reason} ordering exitFirst=${exitFirst} code=${code}`, async () => {
					// GIVEN controlled exit, pipes and clock, independent of the collector.
					const exit = Promise.withResolvers<number>();
					const streams = Promise.withResolvers<void>();
					const output = () =>
						new ReadableStream<Uint8Array<ArrayBuffer>>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("OUTPUT"));
								void streams.promise.then(() => controller.close());
							},
						});
					const unused = () => {
						throw new Error("unused child operation");
					};
					const stdout = output();
					let observedExit: number | null = null;
					const child: Subprocess<"ignore", "pipe", "pipe"> = {
						stdin: undefined,
						stdout,
						stderr: output(),
						readable: stdout,
						terminal: undefined,
						stdio: [null, null, null],
						pid: 1,
						exited: exit.promise,
						get exitCode() {
							return observedExit;
						},
						signalCode: null,
						killed: false,
						kill() {
							observedExit = code;
							exit.resolve(code);
							streams.resolve();
						},
						ref: unused,
						unref: unused,
						send: unused,
						disconnect: unused,
						resourceUsage: unused,
						[Symbol.asyncDispose]: unused,
					};
					const spawn = spyOn(Bun, "spawn").mockReturnValue(child);
					using clock = manualCommandTimer();
					const abort = new AbortController();
					ALLOWED.add("test-ordering-child");
					const opts = { timeout: COMMAND_BUDGET, signal: abort.signal };
					const result = settled(
						runner === "run"
							? run("test-ordering-child", [], opts)
							: execFileP("test-ordering-child", [], opts),
					);
					try {
						// WHEN either genuine completion or termination is observed first.
						if (exitFirst) {
							observedExit = code;
							exit.resolve(code);
							if (code !== 0) streams.resolve();
							await new Promise<void>((resolve) => setImmediate(resolve));
						}
						if (reason === "abort") abort.abort();
						else clock.fire();
						streams.resolve();
						const outcome = await result;
						// THEN only zero completion before termination is success.
						if (exitFirst && code === 0) expect(outcome.kind).toBe("success");
						else {
							expect(outcome.kind).toBe("failure");
							if (outcome.kind !== "failure") throw new Error("false success");
							if (exitFirst) expect(outcome.error).toMatchObject({ code });
							else if (runner === "run")
								expect(outcome.error).toBeInstanceOf(
									reason === "timeout" ? RunTimeoutError : RunAbortError,
								);
						}
					} finally {
						child.kill();
						await result;
						spawn.mockRestore();
						ALLOWED.delete("test-ordering-child");
					}
				});
			}
		}
	}
}
