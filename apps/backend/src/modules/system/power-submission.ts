import { logger } from "../../helpers/logger.ts";
import { emitDeviceEvent } from "../events/device-emit.ts";
import { notePlannedShutdown } from "../streaming/armed-stream-marker.ts";
import { notifyDisruptiveActionRefused } from "./disruptive-action-refusal.ts";
import {
	isPositiveDisruptiveFailure,
	reservePowerAction,
} from "./disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "./disruptive-action-runtime.ts";

export function submitPowerCommand(
	command: "reboot" | "poweroff",
	runner: (command: "reboot" | "poweroff") => void,
): { success: boolean; error?: string } {
	const admission = reservePowerAction(
		getDisruptiveActionDecision({ powerAction: command }),
		command,
	);
	if (!admission.allowed) {
		emitDeviceEvent("power_action_refused", { reason: admission.reason });
		notifyDisruptiveActionRefused(admission.reason);
		return { success: false, error: admission.reason };
	}
	let effectInvoked = false;
	try {
		notePlannedShutdown(command);
		emitDeviceEvent("shutdown_requested", { action: command, origin: "local" });
		effectInvoked = true;
		runner(command);
		admission.reservation.releaseAfterCompletion();
		return { success: true };
	} catch (error) {
		if (!effectInvoked || isPositiveDisruptiveFailure(error))
			admission.reservation.releaseAfterFailure();
		logger.error("System power submission failed", { command, error });
		return {
			success: false,
			error: error instanceof Error ? error.message : "power_submission_failed",
		};
	}
}
