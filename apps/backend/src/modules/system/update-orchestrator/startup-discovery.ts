import type { OrchestratorState } from "./types.ts";

/** Discovery has no surviving producer to reattach; both check clocks are persisted without a kind tag. */
export function normalizeStartupDiscovery(
	state: OrchestratorState,
	now: number,
): OrchestratorState {
	switch (state.phase) {
		case "checking":
			return {
				...state,
				phase: "idle",
				enteredAt: now,
				progress: null,
				packageCheck: { ...state.packageCheck, nextAttemptAt: now },
				osCheck: { ...state.osCheck, nextAttemptAt: now },
			};
		case "idle":
		case "available":
		case "awaiting-idle":
		case "downloading":
		case "committing":
		case "restarting-services":
		case "settled":
		case "os-available":
		case "os-staging":
		case "os-staged":
		case "os-activation-armed":
		case "os-verifying":
		case "sync-eligible":
		case "syncing":
		case "synced":
		case "quarantined":
		case "failed":
			return state;
		default: {
			const unreachable: never = state.phase;
			return unreachable;
		}
	}
}
