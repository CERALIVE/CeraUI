import { describe, expect, it } from "bun:test";

import { notifyServiceReady } from "../helpers/systemd-ready.ts";

describe("systemd startup readiness", () => {
	it("does not spawn a notifier outside a notify service", async () => {
		let calls = 0;
		await notifyServiceReady(undefined, async () => {
			calls += 1;
			return "";
		});
		expect(calls).toBe(0);
	});

	it("awaits the manager acknowledgement using the main process identity", async () => {
		const ack = Promise.withResolvers<string>();
		let completed = false;
		const calls: unknown[] = [];
		const notifying = notifyServiceReady(
			"/run/systemd/notify",
			(bin, args, opts) => {
				calls.push({ bin, args, opts });
				return ack.promise;
			},
		).then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(calls).toEqual([
			{
				bin: "/usr/bin/systemd-notify",
				args: [
					"--ready",
					"--pid=parent",
					"--status=Control server bound; boot signals reserved",
				],
				opts: { timeout: 5_000 },
			},
		]);
		ack.resolve("");
		await notifying;
		expect(completed).toBe(true);
	});

	it("propagates a refused notification instead of claiming startup succeeded", async () => {
		const failure = new Error("notification refused");
		await expect(
			notifyServiceReady("/run/systemd/notify", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});
});
