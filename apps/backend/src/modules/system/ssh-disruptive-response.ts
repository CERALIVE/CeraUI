import { notifyDisruptiveActionRefused } from "./disruptive-action-refusal.ts";
import { DisruptiveActionRefusal } from "./disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "./disruptive-action-runtime.ts";

export async function sshDisruptiveResponse(
	effect: () => Promise<boolean>,
): Promise<{ success: boolean; error?: string }> {
	const decision = getDisruptiveActionDecision();
	if (!decision.allowed) {
		notifyDisruptiveActionRefused(decision.reason);
		return { success: false, error: decision.reason };
	}
	try {
		return { success: await effect() };
	} catch (error) {
		if (!(error instanceof DisruptiveActionRefusal)) throw error;
		notifyDisruptiveActionRefused(error.reason);
		return { success: false, error: error.reason };
	}
}
