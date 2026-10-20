import { notificationBroadcast } from "../ui/notifications.ts";
import {
	type DisruptiveRefusalReason,
	isDisruptiveActionPending,
} from "./disruptive-action-reservation.ts";

export function notifyDisruptiveActionRefused(
	reason?: DisruptiveRefusalReason,
): void {
	const pending =
		reason === "update_in_progress" && isDisruptiveActionPending();
	notificationBroadcast(
		"disruptive_action_refused",
		"warning",
		pending
			? "Device is busy, try again in a moment"
			: "This action was not run. The device must confirm that no stream is live and that no update is in progress first.",
		10,
		false,
		true,
		false,
		pending ? "network.os.deviceBusy" : "notifications.disruptiveActionRefused",
	);
}
