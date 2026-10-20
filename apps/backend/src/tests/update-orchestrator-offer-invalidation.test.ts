import { afterEach, describe, expect, test } from "bun:test";
import { OsAgentError } from "../modules/system/update-orchestrator/os-agent.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	getOrchestratorState,
	getOsUpdateSummary,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	cleanupRecovery,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";

afterEach(cleanupRecovery);

for (const wrapped of [false, true]) {
	describe(wrapped ? "B wrapped admission" : "direct admission", () => {
		test.each([
			"manifest_changed_before_stage",
			"expired",
			"serial_replayed",
			"version_quarantined",
			"downgrade_or_same",
		])(
			"C-R4 rediscoveries replace a pre-write invalid offer when admission refuses %s",
			async (reason) => {
				// Given a stage producer refusing strict admission before any RAUC write.
				let stages = 0;
				let writes = 0;
				const h = await recoveryHarness({
					stageOs: async () => {
						if (++stages === 1) {
							const cause = new OsAgentError(reason);
							throw wrapped
								? new OsStageError("rauc_install_failed", { cause })
								: cause;
						}
						writes++;
					},
				});
				// When strict staging admission invalidates the cached offer.
				await runOrchestratorTick();
				// Then no write occurred; stale permission is dropped and fresh discovery is due.
				expect(writes).toBe(0);
				expect(getOrchestratorState().phase).toBe("idle");
				expect(getOrchestratorState().osStageRecovery).toBeUndefined();
				expect(getOsUpdateSummary().candidate).toBeNull();
				await runOrchestratorTick();
				expect(h.calls.checks).toBe(2);
				expect(writes).toBe(0);
				await runOrchestratorTick();
				expect(writes).toBe(1);
				expect(getOrchestratorState().phase).toBe("os-staged");
			},
		);
	});
}

test.each([
	new Error("expired"),
	new OsAgentError("rauc_install_failed"),
	new Error("rauc failed"),
])("C-R4 keeps other untyped failures terminal (%s)", async (error) => {
	await recoveryHarness({
		stageOs: async () => {
			throw error;
		},
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("failed");
});

test("C-R4 an unsafe wrapper cannot invalidate an offer even with an admission cause", async () => {
	await recoveryHarness({
		stageOs: async () => {
			throw new OsStageError("rauc_recovery_unproven", {
				cause: new OsAgentError("expired"),
			});
		},
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("failed");
	expect(getOrchestratorState().osStageRecovery?.mode).toBe("unsafe");
});
