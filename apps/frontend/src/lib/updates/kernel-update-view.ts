import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";

type KernelSummary = UpdateDetails["kernel"];

export const KERNEL_UPDATE_PHASES: readonly UpdateOrchestratorPhase[] = [
	"kernel-downloading",
	"kernel-staging",
	"kernel-staged",
	"kernel-verifying",
	"kernel-succeeded",
	"kernel-rolled-back",
	"kernel-failed",
];

const STATE_PHASES: ReadonlyMap<string, UpdateOrchestratorPhase> = new Map([
	["staging", "kernel-staging"],
	["staged", "kernel-staged"],
	["armed", "kernel-staged"],
	["activating", "kernel-verifying"],
	["activated", "kernel-verifying"],
	["succeeded", "kernel-succeeded"],
	["rolled_back", "kernel-rolled-back"],
	["failed", "kernel-failed"],
]);

/** Live work wins over a retained record from the previous attempt. */
export function kernelUpdatePhase(
	wire: UpdateOrchestratorWireState | undefined,
	kernel: KernelSummary,
): UpdateOrchestratorPhase | undefined {
	if (wire && KERNEL_UPDATE_PHASES.includes(wire.phase)) return wire.phase;
	if (kernel?.state != null) return STATE_PHASES.get(kernel.state);
	return kernel?.candidate ? "available" : undefined;
}

/** Match kernelRuntime.install's phase gate; unknown/pending records stay closed. */
export function kernelInstallable(
	wire: UpdateOrchestratorWireState | undefined,
	kernel: KernelSummary,
): boolean {
	return (
		wire !== undefined &&
		["idle", "available", "os-available"].includes(wire.phase) &&
		kernel?.candidate != null &&
		(kernel.state === null ||
			["succeeded", "rolled_back", "failed"].includes(kernel.state))
	);
}

const REASON_KEYS: ReadonlyMap<string, string> = new Map([
	["kernel_origin_mismatch", "originMismatch"],
	["kernel_download_failed", "downloadFailed"],
	["kernel_staging_failed", "stagingFailed"],
	["kernel_identity_mismatch", "identityMismatch"],
	["kernel_boot_failed", "bootFailed"],
	["kernel_interrupted", "interrupted"],
]);

export function kernelReasonKey(reason: string | null | undefined): string {
	const key = reason == null ? undefined : REASON_KEYS.get(reason);
	return `settings.updates.kernel.reason.${key ?? "generic"}`;
}
