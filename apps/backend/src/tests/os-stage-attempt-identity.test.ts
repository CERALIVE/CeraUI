import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	settleFailedOsStageRound,
	startOsStageAttempt,
} from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "os-identity-"));
const file = join(dir, "agent.json");
const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterAll(() => rmSync(dir, { recursive: true }));

test.each(["operator", "unsafe", "automatic"] as const)(
	"retains exact attempt provenance across persisted %s settlement",
	async (mode) => {
		// Given a freshly started OS attempt persisted before effects.
		const active = startOsStageAttempt(undefined, "candidate", attemptId);
		saveOrchestratorState(
			{
				...initialOrchestratorState(0),
				phase: "os-staging",
				osStageRecovery: active,
			},
			file,
		);
		const started = await loadOrchestratorState(file);
		expect(started?.osStageRecovery?.attemptId).toBe(attemptId);
		// When that attempt records one failed round and reloads.
		const reason = "rauc_recovery_unproven";
		const settled = settleFailedOsStageRound(active, mode, reason, 10);
		saveOrchestratorState(
			{
				...initialOrchestratorState(10),
				phase: mode === "unsafe" ? "failed" : "os-available",
				failureReason: reason,
				osStageRecovery: settled,
			},
			file,
		);
		const loaded = await loadOrchestratorState(file);
		// Then the historical identity remains while the active identity is gone.
		expect(loaded?.osStageRecovery).toMatchObject({
			attemptId,
			activeAttemptId: null,
			failedRounds: 1,
		});
	},
);

test("replaces historical identity when a newer same-candidate attempt starts", () => {
	// Given a settled first attempt for this candidate.
	const old = settleFailedOsStageRound(
		startOsStageAttempt(undefined, "candidate", attemptId),
		"operator",
		"rauc_install_failed",
		10,
	);
	// When a new attempt starts.
	const next = startOsStageAttempt(
		old,
		"candidate",
		"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	);
	// Then only the new identity can authorize settlement, with the budget retained.
	expect(next.attemptId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
	expect(next.activeAttemptId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
	expect(next.attemptId).not.toBe(attemptId);
	expect(next.failedRounds).toBe(1);
});
