import type { ManagedProcess } from "../../helpers/spawn-policy.ts";

export function processOutput(
	chunks: (string | Uint8Array)[],
	errors = [new Uint8Array(90000)],
): ManagedProcess {
	return {
		stdout: new ReadableStream({
			start(c) {
				for (const chunk of chunks)
					c.enqueue(
						typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
					);
				c.close();
			},
		}),
		stderr: new ReadableStream({
			start(c) {
				for (const chunk of errors) c.enqueue(chunk);
				c.close();
			},
		}),
		exited: Promise.resolve(0),
		exitCode: 0,
		signalCode: null,
		kill: () => undefined,
	};
}
