import { logger } from "../../helpers/logger.ts";
import { notePlannedShutdown } from "../streaming/armed-stream-marker.ts";
import { notifyDisruptiveActionRefused } from "./disruptive-action-refusal.ts";
import {
	isPositiveDisruptiveFailure,
	reserveDisruptiveAction,
} from "./disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "./disruptive-action-runtime.ts";

export function submitPowerCommand(
	command: "reboot" | "poweroff",
	runner: (command: "reboot" | "poweroff") => void,
): { success: boolean; error?: string } {
	const admission = reserveDisruptiveAction(getDisruptiveActionDecision());
	if (!admission.allowed) {
		notifyDisruptiveActionRefused();
		return { success: false, error: admission.reason };
	}
	let effectInvoked = false;
	try {
		notePlannedShutdown(command);
		effectInvoked = true;
		runner(command);
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
