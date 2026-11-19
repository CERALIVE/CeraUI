import { expect, onTestFinished } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceEvent } from "@ceraui/rpc/schemas";
import {
	resetEventEmitterForTest,
	setEventSink,
} from "../modules/events/emit.ts";
import { appendEvent, readEvents } from "../modules/events/store.ts";
import { NO_INTERNET_NOTIFICATION } from "../modules/network/gateways.ts";
import {
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";

export function networkEventsFixture() {
	const baseDir = mkdtempSync(join(tmpdir(), "network-events-"));
	let now = 100_000;
	const pushed: DeviceEvent[] = [];
	const warnings: string[] = [];
	const timers = new Set<{ due: number; fire: () => void }>();
	resetEventEmitterForTest({
		now: () => now,
		bootId: () => "66d8d1808694489b8c3a3fb4795cab24",
		tailSeq: () => 0,
		appendEvent: (event, options) =>
			appendEvent(event, { ...options, baseDir }),
		warn: (message) => warnings.push(message),
		schedule: (fire, ms) => {
			const timer = { due: now + ms, fire };
			timers.add(timer);
			return {
				unref: () => undefined,
				cancel: () => timers.delete(timer),
			};
		},
	});
	setEventSink((event) => pushed.push(event));
	onTestFinished(() => {
		resetEventEmitterForTest();
		if (notificationExists(NO_INTERNET_NOTIFICATION))
			notificationRemove(NO_INTERNET_NOTIFICATION);
		rmSync(baseDir, { recursive: true, force: true });
		expect(warnings).toEqual([]);
	});
	return {
		now: () => now,
		advance(ms = 31_000) {
			now += ms;
			for (const timer of timers) {
				if (timer.due <= now) {
					timers.delete(timer);
					timer.fire();
				}
			}
		},
		events() {
			const stored = readEvents({ baseDir });
			expect(stored).toEqual(pushed);
			return stored.map(({ code, params, suppressed }) => ({
				code,
				params,
				...(suppressed === undefined ? {} : { suppressed }),
			}));
		},
	};
}
