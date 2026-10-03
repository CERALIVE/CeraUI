import { expect, test } from "bun:test";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import type { OsUnlaunchedStageSettlement } from "../modules/system/update-orchestrator/os-unlaunched-state.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";

const key = osStageCandidateKey(manifest);
const active: OrchestratorState = {
	...initialOrchestratorState(1),
	phase: "os-staging",
	osStageRecovery: {
		candidateKey: key,
		attemptId: input.attemptId,
		activeAttemptId: input.attemptId,
		failedRounds: 2,
		nextRetryAt: null,
		mode: "automatic",
		reason: null,
	},
};
const event: OsUnlaunchedStageSettlement = {
	type: "OS_UNLAUNCHED_STAGE_SETTLED",
	now: 10,
	bootId: input.bootId,
	witness: { ...input, candidateKey: key, disposition: "unlaunched-unchanged" },
};
const failed: OrchestratorState = {
	...active,
	phase: "failed",
	failureReason: "rauc_recovery_unproven",
	osStageRecovery: {
		...active.osStageRecovery,
		candidateKey: key,
		attemptId: input.attemptId,
		activeAttemptId: null,
		failedRounds: 3,
		nextRetryAt: null,
		mode: "unsafe",
		reason: "rauc_recovery_unproven",
	},
};

test.each([active, failed])(
	"settles exactly one round when exact unlaunched provenance matches %#",
	(state) => {
		// Given either the active attempt or its already-counted unsafe failure.
		// When the completed witness is accepted.
		const settled = reduceOrchestrator(state, event);
		// Then both converge on one bounded operator recovery record.
		expect(settled).toMatchObject({
			phase: "os-available",
			failureReason: "rauc_install_failed",
			osStageRecovery: {
				failedRounds: 3,
				mode: "operator",
				reason: "rauc_install_failed",
				activeAttemptId: null,
				nextRetryAt: null,
			},
		});
		expect(reduceOrchestrator(settled, event)).toBe(settled);
	},
);

test.each([
	{ ...event, bootId: "another-boot" },
	{ ...event, witness: { ...event.witness, attemptId: "another-attempt" } },
	{
		...event,
		witness: {
			...event.witness,
			candidateKey: osStageCandidateKey({ ...manifest, serial: 14 }),
		},
	},
])("rejects stale provenance when identity differs %#", (stale) => {
	// Given another boot, attempt or signed candidate.
	// When delivered to an unsafe failure, then no transition occurs.
	expect(reduceOrchestrator(failed, stale)).toBe(failed);
});

test.each([
	"commit_unit_absent_on_resume",
	"apt-exit-nonzero",
	"commit_resume_inconclusive",
	"unknown",
])("rejects witness clearance when failure is %s", (reason) => {
	// Given a nonconfirmable terminal reason.
	const state: OrchestratorState = {
		...failed,
		failureReason: reason,
		osStageRecovery: {
			...failed.osStageRecovery,
			candidateKey: key,
			activeAttemptId: null,
			failedRounds: 3,
			nextRetryAt: null,
			mode: "unsafe",
			reason,
		},
	};
	// When witnessed, then terminal behavior remains unchanged.
	expect(reduceOrchestrator(state, event)).toBe(state);
});

test("rejects witness clearance when legacy identity is absent", () => {
	// Given the D8 legacy recovery shape: no persisted historical attempt.
	const state: OrchestratorState = {
		...failed,
		osStageRecovery: {
			candidateKey: key,
			activeAttemptId: null,
			failedRounds: 1,
			nextRetryAt: null,
			mode: "unsafe",
			reason: "rauc_recovery_unproven",
		},
	};
	// When witnessed, then candidate equality never substitutes for attempt identity.
	expect(reduceOrchestrator(state, event)).toBe(state);
});

test.each(["os-staged", "committing", "quarantined", "idle"] as const)(
	"rejects an unlaunched event when phase is %s",
	(phase) => {
		// Given a phase outside the narrow settlement contract.
		const state = { ...active, phase };
		// When witnessed, then no publication/package/terminal phase is reinterpreted.
		expect(reduceOrchestrator(state, event)).toBe(state);
	},
);
