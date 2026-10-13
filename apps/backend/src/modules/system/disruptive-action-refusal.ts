import { notificationBroadcast } from "../ui/notifications.ts";

export function notifyDisruptiveActionRefused(): void {
	notificationBroadcast(
		"disruptive_action_refused",
		"warning",
		"This action was not run. The device must confirm that no stream is live and that no update is in progress first.",
		10,
		false,
		true,
		false,
		"notifications.disruptiveActionRefused",
	);
}
