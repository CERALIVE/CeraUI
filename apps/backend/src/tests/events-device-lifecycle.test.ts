import { afterEach, expect, spyOn, test } from "bun:test";
import type { EventCode, EventParams } from "@ceraui/rpc/events";
import {
	handleTerminationSignal,
	resetShutdownForTest,
} from "../helpers/shutdown.ts";
import { defaultRuntimeConfigBootDeps } from "../modules/config-boot.ts";
import * as emitter from "../modules/events/emit.ts";
import * as marker from "../modules/streaming/armed-stream-marker.ts";
import { warnOnHardwareIdentityDrift } from "../modules/system/device-detection.ts";
import * as refusal from "../modules/system/disruptive-action-refusal.ts";
import * as reservation from "../modules/system/disruptive-action-reservation.ts";
import * as runtime from "../modules/system/disruptive-action-runtime.ts";
import { submitPowerCommand } from "../modules/system/power-submission.ts";
import * as notifications from "../modules/ui/notifications.ts";

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	resetShutdownForTest();
	emitter.resetEventEmitterForTest();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
	restores.push(() => spy.mockRestore());
	return spy;
}
function recording(throws = false) {
	const calls: Array<[EventCode, EventParams<EventCode>]> = [];
	keep(spyOn(emitter, "emitEvent")).mockImplementation((code, params) => {
		calls.push([code, params]);
		if (throws) throw new Error("throwing consumer");
	});
	return calls;
}

for (const command of ["reboot", "poweroff"] as const) {
	for (const throws of [false, true]) {
		test(`${command} records intent before runner even when emitter throws=${throws}`, () => {
			const calls = recording(throws);
			const order: string[] = [];
			keep(spyOn(runtime, "getDisruptiveActionDecision")).mockReturnValue({
				allowed: true,
			});
			keep(spyOn(reservation, "reservePowerAction")).mockReturnValue({
				allowed: true,
				reservation: {
					active: () => true,
					retained: () => true,
					markUncertain: () => {},
					releaseAfterFailure: () => order.push("failure"),
					releaseAfterCompletion: () => order.push("complete"),
				},
			});
			keep(spyOn(marker, "notePlannedShutdown")).mockImplementation(() => {
				order.push("marker");
				return true;
			});
			const result = submitPowerCommand(command, (actual) => {
				expect(actual).toBe(command);
				expect(calls).toEqual([
					["shutdown_requested", { action: command, origin: "local" }],
				]);
				order.push("runner");
			});
			expect(result).toEqual({ success: true });
			expect(order).toEqual(["marker", "runner", "complete"]);
		});
	}
}

for (const throws of [false, true]) {
	test(`refused power request records only refusal even when emitter throws=${throws}`, () => {
		const calls = recording(throws);
		keep(spyOn(runtime, "getDisruptiveActionDecision")).mockReturnValue({
			allowed: false,
			reason: "streaming",
		});
		keep(spyOn(refusal, "notifyDisruptiveActionRefused")).mockImplementation(
			() => {},
		);
		const runner = () => {
			throw new Error("refused runner invoked");
		};
		expect(submitPowerCommand("reboot", runner)).toEqual({
			success: false,
			error: "streaming",
		});
		expect(calls).toEqual([["power_action_refused", { reason: "streaming" }]]);
	});
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	for (const throws of [false, true]) {
		test(`${signal} emits once before cleanup and keeps the latch when consumer throws=${throws}`, async () => {
			const calls = recording(throws);
			const order: string[] = [];
			const exited = Promise.withResolvers<number>();
			const deps = {
				stopSrtIngest: async () => {
					expect(calls).toEqual([["service_stopping", { signal }]]);
					order.push("srt");
				},
				stopDmesgWatchers: () => {
					order.push("dmesg");
				},
				gracefulShutdown: async () => {
					order.push("stream");
				},
				exit: (code: number) => exited.resolve(code),
			};
			handleTerminationSignal(signal, deps);
			handleTerminationSignal(signal, deps);
			expect(await exited.promise).toBe(0);
			expect(order).toEqual(["srt", "dmesg", "stream"]);
			expect(calls).toHaveLength(1);
		});
	}
}

test("other termination signals never enter the registry's SIGTERM/SIGINT event", async () => {
	const calls = recording();
	const exited = Promise.withResolvers<number>();
	handleTerminationSignal("SIGHUP", {
		stopSrtIngest: async () => {},
		stopDmesgWatchers: () => {},
		gracefulShutdown: async () => {},
		exit: (code) => exited.resolve(code),
	});
	expect(await exited.promise).toBe(0);
	expect(calls).toEqual([]);
});

for (const throws of [false, true]) {
	test(`hardware mismatch emits its identities and preserves warning when emitter throws=${throws}`, async () => {
		const calls = recording(throws);
		const warnings: string[] = [];
		const result = await warnOnHardwareIdentityDrift({
			isRealDevice: async () => true,
			detectKind: async () => "n100",
			configuredHw: () => "rk3588",
			warn: (message) => {
				warnings.push(message);
			},
		});
		expect(result).toEqual({ checked: true, drift: true });
		expect(calls).toEqual([
			["hardware_identity_drift", { detected: "n100", configured: "rk3588" }],
		]);
		expect(warnings).toHaveLength(1);
	});
}

for (const [real, detected, configured] of [
	[false, "n100", "rk3588"],
	[true, "unknown", "rk3588"],
	[true, "rk3588", "rk3588"],
] as const) {
	test(`no drift event for real=${real} detected=${detected} configured=${configured}`, async () => {
		const calls = recording();
		await warnOnHardwareIdentityDrift({
			isRealDevice: async () => real,
			detectKind: async () => detected,
			configuredHw: () => configured,
			warn: () => {},
		});
		expect(calls).toEqual([]);
	});
}

for (const throws of [false, true]) {
	test(`damaged reset announcement emits empty params and retains notice when emitter throws=${throws}`, () => {
		const calls = recording(throws);
		const notify = keep(
			spyOn(notifications, "notificationBroadcast"),
		).mockImplementation(() => {});
		defaultRuntimeConfigBootDeps.onDamagedReset(
			"/data/config.json.damaged-copy",
		);
		expect(calls).toEqual([["config_reset_damaged", {}]]);
		expect(notify).toHaveBeenCalledTimes(1);
	});
}
