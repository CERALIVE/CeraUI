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
	test.each([true, false])(
		"commits despite recovered cleanup failure and retries on the next reconcile (active=%s)",
		async (active) => {
			const desired = prepared(
				[uplink("new", "eth0", 100)],
				active ? undefined : [],
			);
			const stale = prepared([uplink("stale", "wwan0", 100)]).routes[0];
			if (stale === undefined) throw new Error("missing stale route fixture");
			let rejectCleanup = true;
			const effects: string[] = [];
			const statuses: SteeringAvailability[] = [];
			const applier = new UplinkSteeringApplier({
				discoverRoutes: async () => [stale],
				ensureRoute: async (route) => ({ route, changed: true }),
				rollbackRoute: async () => {
					effects.push("rollback");
				},
				removeRoute: async () => {
					effects.push("remove");
				},
				applyRuleset: async () => {
					effects.push("ruleset");
				},
				deactivateSharing: async () => {
					effects.push("deactivate");
				},
				flushConntrack: async () => {
					effects.push("flush");
					if (rejectCleanup) throw new Error("cleanup refused");
				},
				setIpForwarding: async (enabled) => {
					effects.push(`forward:${enabled}`);
				},
				publishFlowsReset: () => {},
			});
			const coordinator = new UplinkSteeringCoordinator({
				readDesiredState: async () => desired,
				apply: (previous, next) => applier.apply(previous, next),
				retryCleanup: () => applier.retryPendingCleanup(),
				publishAvailability: (status) => statuses.push(status),
				waitBeforeRetry: async () => {
					effects.push("apply-retry");
				},
			});

			await coordinator.requestReconcile();
			expect(coordinator.appliedState()).toBe(desired);
			expect(statuses).toEqual([{ available: true }]);
			expect(effects).toContain(`forward:${active}`);
			expect(effects).not.toContain("rollback");
			expect(effects).not.toContain("apply-retry");
			expect(effects.filter((effect) => effect === "deactivate")).toHaveLength(
				active ? 0 : 1,
			);
			rejectCleanup = false;
			effects.length = 0;

			await coordinator.requestReconcile();
			expect(effects).toEqual(["flush", "remove"]);
			effects.length = 0;
			await coordinator.requestReconcile();
			expect(effects).toEqual([]);
		},
	);

	test("cleanup dependency errors never undo a successful or unchanged reconcile", async () => {
		const desired = prepared([uplink("a", "wwan0", 100)]);
		let applies = 0;
		let cleanups = 0;
		const statuses: SteeringAvailability[] = [];
		const coordinator = new UplinkSteeringCoordinator({
			readDesiredState: async () => desired,
			apply: async () => {
				applies++;
			},
			retryCleanup: async () => {
				cleanups++;
				throw new Error("cleanup port failed");
			},
			publishAvailability: (status) => statuses.push(status),
			waitBeforeRetry: async () => {
				throw new Error("unexpected apply retry");
			},
		});
		await coordinator.requestReconcile();
		await coordinator.requestReconcile();
		expect(applies).toBe(1);
		expect(cleanups).toBe(2);
		expect(statuses).toEqual([{ available: true }, { available: true }]);
		expect(coordinator.appliedState()).toBe(desired);
	});

	test("failed activation cannot discard pending cleanup on an unchanged inactive reconcile", async () => {
		const inactive = prepared([], []);
		const revived = prepared([uplink("stale", "wwan0", 100)]);
		const stale = revived.routes[0];
		if (stale === undefined) throw new Error("missing stale route fixture");
		let desired = inactive;
		let cleanupFails = true;
		const effects: string[] = [];
		const statuses: SteeringAvailability[] = [];
		const applier = new UplinkSteeringApplier({
			discoverRoutes: async () => [stale],
			ensureRoute: async (route) => ({ route, changed: false }),
			rollbackRoute: async () => {
				effects.push("rollback");
			},
			removeRoute: async () => {
				effects.push("remove");
			},
			applyRuleset: async () => {
				effects.push("activate");
			},
			deactivateSharing: async () => {
				effects.push("deactivate");
			},
			flushConntrack: async () => {
				effects.push("flush");
				if (cleanupFails) throw new Error("cleanup refused");
			},
			setIpForwarding: async (enabled) => {
				effects.push(`forward:${enabled}`);
				if (enabled) throw new Error("sysctl refused");
			},
			publishFlowsReset: () => {},
		});
		const coordinator = new UplinkSteeringCoordinator({
			readDesiredState: async () => desired,
			apply: (previous, next) => applier.apply(previous, next),
			retryCleanup: () => applier.retryPendingCleanup(),
			publishAvailability: (status) => statuses.push(status),
			waitBeforeRetry: async () => {},
		});
		await coordinator.requestReconcile();
		expect(coordinator.appliedState()).toBe(inactive);
		expect(effects).toEqual(["deactivate", "flush", "forward:false", "flush"]);
		effects.length = 0;
		desired = revived;

		await coordinator.requestReconcile();

		expect(coordinator.appliedState()).toBe(inactive);
		expect(effects).toEqual([
			"activate",
			"forward:true",
			"deactivate",
			"activate",
			"forward:true",
			"deactivate",
			"activate",
			"forward:true",
			"deactivate",
		]);
		expect(statuses.at(-1)).toMatchObject({ available: false });
		effects.length = 0;
		desired = inactive;
		await coordinator.requestReconcile();
		expect(effects).toEqual(["flush"]);
		effects.length = 0;
		cleanupFails = false;
		await coordinator.requestReconcile();
		expect(effects).toEqual(["flush", "remove"]);
		expect(coordinator.appliedState()).toBe(inactive);
		expect(statuses.at(-1)).toEqual({ available: true });
		effects.length = 0;
		await coordinator.requestReconcile();
		expect(effects).toEqual([]);
	});

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
