/**
 * A settable, reactive `update_orchestrator` push for dialog tests whose
 * behaviour keys on the pushed phase changing WHILE the dialog is open (the
 * dialog's follower reads it inside an `$effect`, so a plain object would never
 * re-run it).
 */
import type {
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";

let wire = $state<UpdateOrchestratorWireState | undefined>(undefined);

export function orchestratorAt(
	phase: UpdateOrchestratorPhase,
): UpdateOrchestratorWireState {
	return {
		schema: 1,
		phase,
		progress: null,
		failure_reason: null,
		cellular_override_id: null,
	};
}

export const reactiveOrchestrator = {
	get value(): UpdateOrchestratorWireState | undefined {
		return wire;
	},
	set value(next: UpdateOrchestratorWireState | undefined) {
		wire = next;
	},
	reset(): void {
		wire = undefined;
	},
};
