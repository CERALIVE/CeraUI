import type {
	KernelIdentity,
	KernelState,
	SlotOverlay,
} from "./kernel-state.ts";
import { overlayMatches } from "./kernel-state.ts";
import type { OrchestratorPhase } from "./types.ts";

export type KernelVerdict = {
	readonly phase: Extract<OrchestratorPhase, `kernel-${string}`>;
	readonly reason: string | null;
};
export function judgeKernelState(
	state: KernelState,
	bootedSlot: string,
	bootedKernel: Pick<KernelIdentity, "package" | "version">,
	overlay: SlotOverlay | null,
): KernelVerdict {
	switch (state.state) {
		case "staging":
			return { phase: "kernel-staging", reason: null };
		case "staged":
		case "armed":
			return overlayMatches(state, overlay) && overlay?.status === "pending"
				? { phase: "kernel-staged", reason: null }
				: { phase: "kernel-failed", reason: "kernel_identity_mismatch" };
		case "activating":
		case "activated":
			return { phase: "kernel-verifying", reason: null };
		case "succeeded":
			return bootedSlot === state.target_slot &&
				bootedKernel.package === state.package &&
				bootedKernel.version === state.version &&
				overlayMatches(state, overlay) &&
				overlay?.status === "confirmed"
				? { phase: "kernel-succeeded", reason: null }
				: { phase: "kernel-verifying", reason: "kernel_identity_mismatch" };
		case "rolled_back":
			return bootedSlot === state.booted_slot_at_stage
				? {
						phase: "kernel-rolled-back",
						reason: state.reason ?? "kernel_boot_failed",
					}
				: { phase: "kernel-verifying", reason: "kernel_identity_mismatch" };
		case "failed":
			return {
				phase: "kernel-failed",
				reason:
					state.reason === "interrupted"
						? "kernel_interrupted"
						: (state.reason ?? "kernel_staging_failed"),
			};
		default: {
			const exhaustive: never = state.state;
			return exhaustive;
		}
	}
}
