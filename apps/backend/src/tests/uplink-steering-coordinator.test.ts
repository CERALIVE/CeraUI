import { describe, expect, test } from "bun:test";

import { flushConntrack } from "../modules/network/uplink-sharing.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
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

	test.each(["zero matches", "permission denied"])(
		"#435 retires an empty mark and converges, but retains state on %s",
		async (result) => {
			const initial = prepared([uplink("a", "wwan0", 100)]);
			const next = prepared([uplink("b", "wwan1", 100)]);
			let current = initial;
			const stderr = await Bun.file(
				new URL(
					"./fixtures/real-device/conntrack-1.4.8-zero-delete.txt",
					import.meta.url,
				),
			).text();
			const error = Object.assign(new Error("conntrack failed"), {
				code: 1,
				stdout: "",
				stderr:
					result === "zero matches"
						? stderr
						: "Operation failed: Permission denied",
			});
			const effects: string[] = [];
			const statuses: SteeringAvailability[] = [];
			const applier = new UplinkSteeringApplier({
				discoverRoutes: async () => [],
				ensureRoute: async (route) => ({ route, changed: true }),
				rollbackRoute: async () => {
					effects.push("rollback");
				},
				removeRoute: async (route) => {
					effects.push(`remove:${route.mark}`);
				},
				applyRuleset: async (_rules, mode) => {
					effects.push(mode);
				},
				deactivateSharing: async () => {
					effects.push("deactivate");
				},
				flushConntrack: (mark) =>
					flushConntrack(mark, {
						run: async () => {
							effects.push(`flush:${mark}`);
							throw error;
						},
					}),
				setIpForwarding: async () => {},
				publishFlowsReset: () => {
					effects.push("reset");
				},
			});
			const coordinator = new UplinkSteeringCoordinator({
				readDesiredState: async () => current,
				apply: (previous, desired) => applier.apply(previous, desired),
				publishAvailability: (status) => {
					statuses.push(status);
				},
				waitBeforeRetry: async () => {},
			});
			await coordinator.requestReconcile();
			expect(coordinator.appliedState()).toBe(initial);
			effects.length = 0;
			current = next;

			await coordinator.requestReconcile();

			if (result === "permission denied") {
				expect(coordinator.appliedState()).toBe(initial);
				expect(effects).not.toContain(`remove:${initial.routes[0]?.mark}`);
				expect(statuses.at(-1)).toMatchObject({ available: false });
				return;
			}
			expect(coordinator.appliedState()).toBe(next);
			expect(effects).toEqual([
				"reload",
				`flush:${initial.routes[0]?.mark}`,
				`remove:${initial.routes[0]?.mark}`,
				"reset",
				"reload",
			]);
			expect(statuses.at(-1)).toEqual({ available: true });
			effects.length = 0;
			await coordinator.requestReconcile();
			expect(effects).toEqual([]);
		},
	);
});
