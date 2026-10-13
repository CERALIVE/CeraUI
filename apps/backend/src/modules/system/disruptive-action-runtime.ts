import {
	type DisruptiveActionDecision,
	decideDisruptiveAction,
} from "./disruptive-action-gate.ts";
import { getBootReadiness } from "./readiness.ts";
import { isSoftwareUpdateRecoveryInconclusive } from "./software-update-recovery.ts";
import { isUpdating } from "./software-updates.ts";
import { getStreamLiveness } from "./stream-liveness-source.ts";
import { getOrchestratorDisruptionBusyReasons } from "./update-orchestrator/runtime.ts";

export function getDisruptiveActionDecision(): DisruptiveActionDecision {
	return decideDisruptiveAction({
		streamLiveness: getStreamLiveness(),
		updateBusy: [
			...getOrchestratorDisruptionBusyReasons(),
			...(isUpdating() ? ["package-install" as const] : []),
			...(isSoftwareUpdateRecoveryInconclusive()
				? ["update-recovery" as const]
				: []),
			...(getBootReadiness().degradedSubsystems.includes(
				"update-orchestrator-maintenance",
			)
				? ["maintenance" as const]
				: []),
		],
	});
}

const REMOTE_DISRUPTIVE_TYPES: ReadonlySet<string> = new Set([
	"system.reboot",
	"device.factoryReset",
]);

/** Remote self_fencing admission: reboot and factory reset use the same gate. */
export function admitRemoteDisruptiveAction(
	type: string,
): { ok: true } | { ok: false; refusal: string } {
	if (!REMOTE_DISRUPTIVE_TYPES.has(type)) return { ok: true };
	const decision = getDisruptiveActionDecision();
	return decision.allowed
		? { ok: true }
		: { ok: false, refusal: decision.reason };
}
