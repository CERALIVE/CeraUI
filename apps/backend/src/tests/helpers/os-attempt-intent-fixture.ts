import { osAttemptIntentSchema } from "../../modules/system/update-orchestrator/os-attempt-intent.ts";
import type { OsChannelManifest } from "../../modules/system/update-orchestrator/os-manifest.ts";
import { osStageCandidateKey } from "../../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	fromPersisted,
	saveOrchestratorState,
	toPersisted,
} from "../../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";
import { input, manifest } from "./os-stage-unlaunched-fixture.ts";
import { runtimeFixture } from "./os-unlaunched-runtime-fixture.ts";

export function attemptIntent(
	before: OrchestratorState = {
		...initialOrchestratorState(123),
		phase: "os-available",
		cellularOverrideId: manifest.version,
	},
	candidate: OsChannelManifest = manifest,
) {
	const staged = reduceOrchestrator(before, {
		type: "OS_STAGING_STARTED",
		now: 456,
		attempt: {
			attemptId: input.attemptId,
			candidateKey: osStageCandidateKey(candidate),
		},
	});
	return osAttemptIntentSchema.parse({
		schema: 1,
		attemptId: input.attemptId,
		manifest: candidate,
		phase: "publishing",
		before: toPersisted(before),
		staged: toPersisted(staged),
	});
}

export function intentCrashFixture(
	phase: "publishing" | "launching" = "publishing",
	disk: "before" | "staged" = "staged",
) {
	const f = runtimeFixture();
	const intent = { ...attemptIntent(), phase };
	f.intentStore.write(intent, null);
	saveOrchestratorState(fromPersisted(intent[disk]), f.file);
	return { ...f, intent };
}
