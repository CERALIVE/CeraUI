import { describe, expect, test } from "bun:test";
import {
	type RaucStageSnapshot,
	raucQuiescenceRefusal,
	recoverRaucStage,
} from "../modules/system/update-orchestrator/os-stage-recovery.ts";

const baseline: RaucStageSnapshot = {
	instance: "659:10",
	active: true,
	operation: "idle",
	processes: ["659:10"],
	resources: [],
	bootId: "boot-B",
	bootPrimary: "rootfs.1",
	bootedSlot: "rootfs.1",
	bootedDevice: "179:5",
	bootedHealthy: true,
	targetSlot: "rootfs.0",
	targetDevice: "179:4",
	targetInactive: true,
	activationArmed: false,
};

const ownership = {
	baseline,
	processes: new Set(["659:10", "358961:22", "358962:23"]),
	resources: new Set(["mount:51", "nbd:43:358962:23", "verity:rauc-uuid"]),
};

const ready = { ...baseline, instance: "371279:99", processes: ["371279:99"] };

describe("positive RAUC recovery proof", () => {
	test("replays the captured 5:15 daemon termination rather than treating queue submission as recovery", async () => {
		// Given Rock 32-rauc-journal.txt:36-53: SIGTERM 08:23:53.914,
		// stop-sigterm timeout +90s, 'Processes still around after SIGKILL' +180s,
		// final-sigterm timeout +270s, new daemon 371279 at 08:29:08.289 (+315s).
		let now = 0;
		let polls = 0;
		// When the observer replays those instance/resource lifetimes on a fake clock.
		const result = await recoverRaucStage(
			ownership,
			{
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
				cliSettled: () => true,
				lockHeld: async () => true,
				observe: async () => {
					polls++;
					return now < 315000
						? {
								...baseline,
								active: false,
								operation: null,
								processes: ["659:10", "358961:22"],
								resources: ["mount:51", "verity:rauc-uuid"],
							}
						: ready;
				},
			},
			true,
		);
		// Then only the new idle daemon with retired resources permits retry.
		expect(now).toBe(315000);
		expect(polls).toBe(316);
		expect(result.instance).toBe("371279:99");
	});

	test.each([
		["active old instance", { instance: baseline.instance }],
		["Operation missing", { operation: null }],
		["mount survives", { resources: ["mount:51"] }],
		["NBD survives", { resources: ["nbd:43:358962:23"] }],
		["verity survives", { resources: ["verity:rauc-uuid"] }],
		["missed RAUC ownership", { resources: ["mount:unexpected"] }],
		[
			"old installer survives new daemon",
			{ processes: ["371279:99", "358961:22"] },
		],
		[
			"missed installer ownership",
			{ processes: ["371279:99", "unknown-child:100"] },
		],
		["booted identity changed", { bootedDevice: "179:4" }],
		["boot id changed", { bootId: "another-boot" }],
		["booted health absent", { bootedHealthy: false }],
		["target active", { targetInactive: false }],
		["target identity changed", { targetDevice: "179:8" }],
		["marker armed", { activationArmed: true }],
	] satisfies readonly (readonly [string, Partial<RaucStageSnapshot>])[])(
		"refuses %s",
		(_name, patch) => {
			// Given one independently unsafe observation, when applying the retry predicate.
			const refusal = raucQuiescenceRefusal({
				ownership,
				current: { ...ready, ...patch },
				cliSettled: true,
				lockHeld: true,
				requireNewInstance: true,
			});
			// Then it cannot authorize another installer.
			expect(refusal).not.toBeNull();
		},
	);

	test("six-minute expiry is unsafe and never releases the lock", async () => {
		// Given even the CLI remains unsettled throughout the engineering deadline.
		let now = 0;
		let heldChecks = 0;
		// When recovery expires without proof.
		const outcome = recoverRaucStage(
			ownership,
			{
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
				observe: async () => ready,
				cliSettled: () => false,
				lockHeld: async () => {
					heldChecks++;
					return true;
				},
			},
			true,
		);
		// Then the typed unsafe outcome retains the owner; this API has no release effect.
		await expect(outcome).rejects.toMatchObject({
			reason: "rauc_recovery_unproven",
			mode: "unsafe",
			diagnostics: { refusal: "cli-unsettled" },
		});
		expect(now).toBe(360000);
		expect(heldChecks).toBe(361);
	});

	test("confirmed success may keep the same idle daemon once its installer is gone", () => {
		// Given RAUC finished normally without a daemon restart, when proving cleanup.
		const refusal = raucQuiescenceRefusal({
			ownership,
			current: baseline,
			cliSettled: true,
			lockHeld: true,
			requireNewInstance: false,
		});
		// Then no unnecessary service restart is required.
		expect(refusal).toBeNull();
	});
});

test("a captured new idle daemon may be present in ownership without being an old installer", () => {
	expect(
		raucQuiescenceRefusal({
			ownership: {
				...ownership,
				processes: new Set([...ownership.processes, ready.instance]),
			},
			current: ready,
			cliSettled: true,
			lockHeld: true,
			requireNewInstance: true,
		}),
	).toBeNull();
});
