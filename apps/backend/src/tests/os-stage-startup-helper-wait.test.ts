import { afterEach, expect, test } from "bun:test";
import {
	osUpdateAdmissionReady,
	reconcileOsStageStartup,
} from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { orphanHarness } from "./helpers/os-stage-orphan-harness.ts";
import { record as orphanRecord } from "./helpers/os-stage-orphan-record.ts";
import {
	finishOrphanScopes,
	orphanBody,
} from "./helpers/os-stage-orphan-scope.ts";
import { harness, record } from "./helpers/os-stage-startup-harness.ts";

afterEach(async () => {
	cleanupRecovery();
	await finishOrphanScopes();
});

test.each([false, true])(
	"startup final proof handles post-sweep helper churn (persistent=%s) within its original budget",
	async (persistent) => {
		// Given recovery is complete at 315s and sweep exposes a new read-side child.
		const h = harness();
		let retired = false;
		const deps = {
			...h.deps,
			observe: async () => {
				const snapshot = await h.deps.observe({
					processes: new Set(record.processes),
					resources: new Set(record.resources),
				});
				return h.calls.includes("sweep") && !retired && snapshot
					? { ...snapshot, processes: [...snapshot.processes, "helper:9"] }
					: snapshot;
			},
			sleep: async (ms: number) => {
				if (h.calls.includes("sweep") && !persistent) retired = true;
				await h.deps.sleep(ms);
			},
		};
		// When final release uses fresh proof instead of the earlier recovery census.
		const result = reconcileOsStageStartup(deps);
		if (persistent) {
			await expect(result).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			// Then persistent uncertainty consumes only the remaining 45s and retains the owner.
			expect(h.now()).toBe(360_000);
			expect(h.calls).not.toContain("release");
			expect(osUpdateAdmissionReady()).toBe(false);
		} else {
			await expect(result).resolves.toHaveProperty(
				"reason",
				"os_stage_outcome_unknown_after_restart",
			);
			// Then physical cleanup can finish, but restart never claims install success.
			expect(h.calls).toContain("release");
			expect(h.now()).toBe(315_100);
		}
	},
);

test(
	"acknowledged orphan proof waits for helper retirement under its real temporary flock",
	orphanBody(async () => {
		// Given an acknowledged/exited guardian and new helper churn after sweep.
		const h = await orphanHarness("released");
		let now = 0;
		let retired = false;
		// When the orphan's second proof must rescan while preserving CONTROL and its lock.
		await expect(
			h.reconcile({
				now: () => now,
				sleep: async (ms) => {
					expect(await h.contender()).toBe(75);
					retired = true;
					now += ms;
				},
				observe: async () =>
					h.effects.includes("sweep-under-flock") && !retired
						? {
								...orphanRecord.baseline,
								processes: [...orphanRecord.baseline.processes, "helper:9"],
							}
						: orphanRecord.baseline,
			}),
		).resolves.toHaveProperty(
			"reason",
			"os_stage_outcome_unknown_after_restart",
		);
		// Then helper exit permits physical retirement, never a new install or daemon restart.
		expect(now).toBe(100);
		expect(h.effects).not.toContain("forbidden-restart");
		expect(h.effects).toContain("stop-owned-exited-unit");
	}),
);
