import { describe, expect, it } from "vitest";
import { runStartWatchdog } from "./streaming-start-watchdog";
import {
	runStopWatchdog,
	type StopWatchdogDeps,
} from "./streaming-stop-watchdog";

describe("watchdog continuation ownership", () => {
	function cycle() {
		let current = true;
		const effects: string[] = [];
		const deps: StopWatchdogDeps = {
			isCurrent: () => current,
			pullStatus: () => Promise.resolve(true),
			reconcile: () => {
				effects.push("reconcile");
			},
			redispatchStop: () => {
				effects.push("stop");
			},
			delay: () => Promise.resolve(),
			setBannerVisible: () => {
				effects.push("banner");
			},
		};
		return {
			deps,
			effects,
			revoke: () => {
				current = false;
			},
		};
	}

	it("a lifetime revoked during the first pull has no post-await effects", async () => {
		const c = cycle();
		c.deps.pullStatus = () => {
			c.revoke();
			return Promise.resolve(true);
		};
		await runStopWatchdog(c.deps);
		expect(c.effects).toEqual([]);
	});

	it("revocation during banner publication forbids the imminent redispatch", async () => {
		const c = cycle();
		c.deps.setBannerVisible = () => {
			c.effects.push("banner");
			c.revoke();
		};
		await runStopWatchdog(c.deps);
		expect(c.effects).toEqual(["reconcile", "banner"]);
	});

	it("revocation during reconciliation forbids banner publication", async () => {
		const c = cycle();
		c.deps.reconcile = () => {
			c.effects.push("reconcile");
			c.revoke();
		};
		await runStopWatchdog(c.deps);
		expect(c.effects).toEqual(["reconcile"]);
	});

	it("revocation during delay forbids the second read", async () => {
		const c = cycle();
		let reads = 0;
		c.deps.pullStatus = () => {
			reads += 1;
			return Promise.resolve(true);
		};
		c.deps.delay = () => {
			c.revoke();
			return Promise.resolve();
		};
		await runStopWatchdog(c.deps);
		expect(reads).toBe(1);
	});

	it("revocation during the second read forbids its reconciliation and banner writes", async () => {
		const c = cycle();
		let reads = 0;
		c.deps.pullStatus = () => {
			reads += 1;
			if (reads === 2) c.revoke();
			return Promise.resolve(reads === 1);
		};
		await runStopWatchdog(c.deps);
		expect(c.effects).toEqual(["reconcile", "banner", "stop"]);
	});

	it("unknown Stop evidence never dispatches a Stop or reverts to idle", async () => {
		const c = cycle();
		c.deps.pullStatus = () => Promise.resolve(undefined);
		await runStopWatchdog(c.deps);
		expect(c.effects).toEqual(["banner"]);
	});

	for (const boundary of ["pull", "reconcile"] as const) {
		it(`Start lifetime revoked at ${boundary} never reverts`, async () => {
			const c = cycle();
			await runStartWatchdog({
				isCurrent: c.deps.isCurrent,
				pullStatus: () => {
					if (boundary === "pull") c.revoke();
					return Promise.resolve(false);
				},
				reconcile: () => {
					c.effects.push("reconcile");
					c.revoke();
				},
				revert: () => {
					c.effects.push("revert");
				},
			});
			expect(c.effects).toEqual(boundary === "pull" ? [] : ["reconcile"]);
		});
	}
});
