import { describe, expect, test } from "bun:test";

import type { PreparedSteeringState } from "../modules/network/uplink-steering/applier.ts";
import type { SteeringAvailability } from "../modules/network/uplink-steering/contracts.ts";
import {
	UplinkSteeringCoordinator,
	type UplinkSteeringCoordinatorDeps,
} from "../modules/network/uplink-steering/coordinator.ts";
import { prepared, uplink } from "./uplink-steering-test-fixtures.ts";

describe("UplinkSteeringCoordinator", () => {
	test("coalesces concurrent triggers and converges to the latest state", async () => {
		const first = prepared([uplink("a", "wwan0", 100)]);
		const latest = prepared([uplink("c", "wlan0", 25)]);
		let current = first;
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const applied: PreparedSteeringState[] = [];
		let active = 0;
		let maxActive = 0;
		const statuses: SteeringAvailability[] = [];
		const deps: UplinkSteeringCoordinatorDeps = {
			readDesiredState: async () => current,
			apply: async (_previous, next) => {
				active++;
				maxActive = Math.max(maxActive, active);
				applied.push(next);
				if (applied.length === 1) await firstBlocked;
				active--;
			},
			publishAvailability: (status) => statuses.push(status),
		};
		const coordinator = new UplinkSteeringCoordinator(deps);

		const firstRun = coordinator.requestReconcile();
		await Promise.resolve();
		current = prepared([uplink("b", "eth0", 100)]);
		const secondRun = coordinator.requestReconcile();
		current = latest;
		const thirdRun = coordinator.requestReconcile();
		releaseFirst?.();
		await Promise.all([firstRun, secondRun, thirdRun]);

		expect(maxActive).toBe(1);
		expect(applied).toEqual([first, latest]);
		expect(coordinator.appliedState()).toEqual(latest);
		expect(statuses[statuses.length - 1]).toEqual({ available: true });
	});

	test("keeps the last applied state and reports a typed degraded verdict", async () => {
		const initial = prepared([uplink("a", "wwan0", 100)]);
		const failed = prepared([uplink("b", "wlan0", 100)]);
		let current = initial;
		let reject = false;
		const calls: Array<PreparedSteeringState | undefined> = [];
		const statuses: SteeringAvailability[] = [];
		const retryDelays: number[] = [];
		const coordinator = new UplinkSteeringCoordinator({
			readDesiredState: async () => current,
			apply: async (previous) => {
				calls.push(previous);
				if (reject) throw new Error("reload refused");
			},
			publishAvailability: (status) => statuses.push(status),
			waitBeforeRetry: async (delayMs) => {
				retryDelays.push(delayMs);
			},
		});

		await coordinator.requestReconcile();
		current = failed;
		reject = true;
		await coordinator.requestReconcile();

		expect(calls).toEqual([undefined, initial, initial, initial]);
		expect(retryDelays).toEqual([100, 500]);
		expect(coordinator.appliedState()).toEqual(initial);
		expect(statuses[statuses.length - 1]).toMatchObject({
			available: false,
			reason: "ruleset_reload_failed",
		});
	});

	test("recovers within the bounded retry budget and republishes availability", async () => {
		const desired = prepared([uplink("a", "wwan0", 100)]);
		let attempts = 0;
		const statuses: SteeringAvailability[] = [];
		const retryDelays: number[] = [];
		const coordinator = new UplinkSteeringCoordinator({
			readDesiredState: async () => desired,
			apply: async () => {
				attempts++;
				if (attempts < 3) throw new Error("carrier not ready");
			},
			publishAvailability: (status) => statuses.push(status),
			waitBeforeRetry: async (delayMs) => {
				retryDelays.push(delayMs);
			},
		});

		await coordinator.requestReconcile();

		expect(attempts).toBe(3);
		expect(retryDelays).toEqual([100, 500]);
		expect(statuses[statuses.length - 1]).toEqual({ available: true });
		expect(coordinator.appliedState()).toEqual(desired);
	});

	test("does not reapply a byte-identical desired model", async () => {
		const desired = prepared([uplink("a", "wwan0", 100)]);
		let applies = 0;
		const coordinator = new UplinkSteeringCoordinator({
			readDesiredState: async () => desired,
			apply: async () => {
				applies++;
			},
			publishAvailability: () => {},
		});

		await coordinator.requestReconcile();
		await coordinator.requestReconcile();

		expect(applies).toBe(1);
	});
});
