import {
	type DisruptiveActionDecision,
	decideDisruptiveAction,
} from "./disruptive-action-gate.ts";
import {
	isActiveDisruptiveOwner,
	isDisruptiveActionPending,
	type PowerAction,
	pendingPowerOwner,
} from "./disruptive-action-reservation.ts";
import { getBootReadiness } from "./readiness.ts";
import { isSoftwareUpdateRecoveryInconclusive } from "./software-update-recovery.ts";
import { isUpdating } from "./software-updates.ts";
import { getStreamLiveness } from "./stream-liveness-source.ts";
import {
	getOrchestratorDisruptionBusyReasons,
	isDisruptiveUpdateAuthoritySettled,
} from "./update-orchestrator/runtime.ts";

export function getDisruptiveActionDecision(options?: {
	readonly heldBy?: symbol;
	readonly scope?: "stale-services";
	readonly powerAction?: PowerAction;
}): DisruptiveActionDecision {
	if (options?.heldBy !== undefined && !isActiveDisruptiveOwner(options.heldBy))
		return { allowed: false, reason: "update_in_progress" };
	if (
		isDisruptiveActionPending() &&
		options?.heldBy === undefined &&
		(options?.powerAction === undefined ||
			pendingPowerOwner(options.powerAction) === undefined)
	)
		return { allowed: false, reason: "update_in_progress" };
	return decideDisruptiveAction({
		streamLiveness: getStreamLiveness(),
		updateBusy: [
			...getOrchestratorDisruptionBusyReasons().filter(
				(reason) =>
					options?.scope !== "stale-services" ||
					reason !== "restarting-services",
			),
			...(isUpdating() ? ["package-install" as const] : []),
			...(isSoftwareUpdateRecoveryInconclusive()
				? ["update-recovery" as const]
				: []),
			...(!isDisruptiveUpdateAuthoritySettled() &&
			getBootReadiness().degradedSubsystems.includes(
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
	const decision = getDisruptiveActionDecision({
		powerAction: type === "system.reboot" ? "reboot" : "factory-reset",
	});
	return decision.allowed
		? { ok: true }
		: { ok: false, refusal: decision.reason };
}
