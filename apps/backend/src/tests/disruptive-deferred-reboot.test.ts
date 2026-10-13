import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	cancelDisruptiveRetries,
	setDisruptiveRetryClockForTest,
} from "../modules/system/disruptive-retry.ts";
import {
	rebootAfterUpdate,
	resetRebootRunner,
	setRebootRunner,
} from "../modules/system/software-updates.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import * as notifications from "../modules/ui/notifications.ts";

const env = process.env.NODE_ENV;
beforeEach(() => {
	process.env.NODE_ENV = "production";
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("starting");
});
afterEach(() => {
	setDisruptiveRetryClockForTest(null);
	resetRebootRunner();
	resetOrchestratorRuntimeForTest();
	updateStreamLifecycleState("idle");
	if (env === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = env;
});

test("legacy completion reboot defers under unknown then executes after positive idle", async () => {
	// Given an automatic completion action with no operator refusal to announce.
	const calls: string[] = [];
	setRebootRunner((bin) => {
		calls.push(bin);
	});
	const callbacks: (() => Promise<void>)[] = [];
	setDisruptiveRetryClockForTest({
		schedule: (fn) => {
			callbacks.push(fn);
			return () => {};
		},
	});
	const broadcast = spyOn(notifications, "notificationBroadcast");
	try {
		// When completion is refused and the retained continuation later sees idle.
		rebootAfterUpdate();
		expect(calls).toEqual([]);
		expect(callbacks.length).toBe(1);
		updateStreamLifecycleState("idle");
		await callbacks[0]?.();
		// Then the deferred reboot is neither discarded nor falsely called refused.
		expect(calls).toEqual(["reboot"]);
		expect(broadcast).not.toHaveBeenCalled();
	} finally {
		broadcast.mockRestore();
	}
});

test("legacy deferred completion never reboots during repeated live wakeups", async () => {
	// Given a deferred automatic action and a fake polling clock.
	const callbacks: (() => Promise<void>)[] = [];
	setDisruptiveRetryClockForTest({
		schedule: (fn) => {
			callbacks.push(fn);
			return () => {};
		},
	});
	const calls: string[] = [];
	setRebootRunner((command) => {
		calls.push(command);
	});
	rebootAfterUpdate();
	updateStatus(true);
	// When wakeups see a live stream, then explicit positive idle.
	await callbacks.shift()?.();
	await callbacks.shift()?.();
	expect(calls).toEqual([]);
	updateStatus(false);
	updateStreamLifecycleState("idle");
	await callbacks.shift()?.();
	// Then only the idle recheck submits once.
	expect(calls).toEqual(["reboot"]);
	expect(callbacks.length).toBe(0);
});

test("shutdown cancels deferred completion without granting reboot permission", async () => {
	// Given a held deferred callback.
	const callbacks: (() => Promise<void>)[] = [];
	setDisruptiveRetryClockForTest({
		schedule: (fn) => {
			callbacks.push(fn);
			return () => {};
		},
	});
	const calls: string[] = [];
	setRebootRunner((command) => {
		calls.push(command);
	});
	rebootAfterUpdate();
	// When shutdown occurs before a late timer callback sees idle.
	cancelDisruptiveRetries();
	updateStreamLifecycleState("idle");
	await callbacks.shift()?.();
	// Then cancellation leaves no effect or restarted cadence.
	expect(calls).toEqual([]);
	expect(callbacks.length).toBe(0);
});
