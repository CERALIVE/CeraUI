import { expect, mock, test } from "bun:test";
import { initControlChannel, isConnected, sendFrame } from "./channel.ts";
import type { Frame } from "./protocol.ts";

test("a refused real control socket handles error and close without an uncaught exception or a disconnected send", async () => {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const port = listener.port;
	listener.stop(true);
	expect(port).toBeGreaterThan(0);
	expect(port).toBeLessThanOrEqual(65535);

	const events: string[] = [];
	const errors: string[] = [];
	const closed = Promise.withResolvers<void>();
	const uncaught = mock((_error: Error) => closed.resolve());
	const deadline = setTimeout(
		() => closed.reject(new Error("control socket did not close")),
		2000,
	);
	const frame: Frame = {
		v: 1,
		kind: "status",
		type: "status",
		cid: crypto.randomUUID(),
		seq: 0,
		payload: {},
	};
	process.on("uncaughtException", uncaught);
	try {
		// Keep createSocket at its production default so ws emits the real failure.
		await initControlChannel({
			canDial: () => true,
			resolveEndpoint: () => ({
				url: `ws://127.0.0.1:${port}`,
				host: "127.0.0.1",
				pinned: true,
			}),
			getControlToken: () => undefined,
			logger: {
				info() {},
				warn() {},
				error(message) {
					events.push("error");
					errors.push(message);
				},
			},
			setTimer(fn, ms) {
				events.push("close");
				closed.resolve();
				return setTimeout(fn, ms);
			},
		});
		expect(sendFrame(frame)).toBe(false);
		await closed.promise;
		expect(uncaught).not.toHaveBeenCalled();
		expect(events).toEqual(["error", "close"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toStartWith("control-channel: socket error:");
		expect(isConnected()).toBe(false);
		expect(sendFrame(frame)).toBe(false);
	} finally {
		clearTimeout(deadline);
		await initControlChannel({ canDial: () => false });
		process.off("uncaughtException", uncaught);
	}
});
