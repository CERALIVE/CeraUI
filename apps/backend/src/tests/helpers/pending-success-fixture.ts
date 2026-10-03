import { pendingPackageSuccess } from "../../modules/system/update-orchestrator/pending-success-fence.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";
import { runtimeFixture } from "./os-unlaunched-runtime-fixture.ts";

export function pendingSuccessFixture() {
	const f = runtimeFixture();
	const baseline = {
		...initialOrchestratorState(0),
		phase: "committing" as const,
	};
	const success = reduceOrchestrator(baseline, {
		type: "COMMIT_SUCCEEDED",
		now: 10,
	});
	const h: {
		memory: OrchestratorState;
		now: number;
		osPending: boolean;
		writes: number;
		readonly file: string;
		readonly baseline: OrchestratorState;
		readonly success: OrchestratorState;
	} = {
		memory: baseline,
		now: 10,
		osPending: false,
		writes: 0,
		file: f.file,
		baseline,
		success,
	};
	saveOrchestratorState(baseline, f.file);
	pendingPackageSuccess.configure(
		{
			snapshot: () => h.memory,
			pending: () => h.osPending,
			acquireControl: acquireTestOsStageControl,
			readPersisted: () => loadOrchestratorState(f.file),
			persist: (state) => {
				h.writes++;
				saveOrchestratorState(state, f.file);
			},
		},
		(state) => {
			h.memory = state;
		},
		() => h.now,
	);
	return Object.assign(h, { [Symbol.dispose]: f.cleanup });
}
