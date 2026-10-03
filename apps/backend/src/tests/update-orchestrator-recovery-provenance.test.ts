import { expect, test } from "bun:test";
import { updateOrchestratorPersistedStateSchema } from "@ceraui/rpc/schemas";
import { toPersisted } from "../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";

test.each([
	"apt-exit-nonzero",
	"commit_unit_absent_on_resume",
	"commit_resume_inconclusive",
])(
	"C-R5 rejects confirmation when an unsafe matching record names %s",
	(reason) => {
		// Given a contradictory package/X6 record whose identity and reason match perfectly.
		const state: OrchestratorState = {
			...initialOrchestratorState(0),
			phase: "failed",
			failureReason: reason,
			osStageRecovery: {
				candidateKey: "candidate",
				activeAttemptId: null,
				failedRounds: 1,
				nextRetryAt: null,
				mode: "unsafe",
				reason,
			},
		};
		// When positive OS evidence is reported for that record.
		const next = reduceOrchestrator(state, {
			type: "OS_STAGE_RECOVERY_CONFIRMED",
			now: 1,
			candidateKey: "candidate",
		});
		// Then the reducer refuses clearance independently of persistence validation.
		expect(next).toBe(state);
		expect(
			updateOrchestratorPersistedStateSchema.safeParse(toPersisted(state))
				.success,
		).toBe(false);
	},
);

test("C-R5 generic terminal errors remain persistable but are not positively identified OS unsafe reasons", () => {
	const state: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "failed",
		failureReason: "rauc failed",
		osStageRecovery: {
			candidateKey: "candidate",
			activeAttemptId: null,
			failedRounds: 1,
			nextRetryAt: null,
			mode: "unsafe",
			reason: "rauc failed",
		},
	};
	expect(
		updateOrchestratorPersistedStateSchema.safeParse(toPersisted(state))
			.success,
	).toBe(true);
	expect(
		reduceOrchestrator(state, {
			type: "OS_STAGE_RECOVERY_CONFIRMED",
			now: 1,
			candidateKey: "candidate",
		}),
	).toBe(state);
});
