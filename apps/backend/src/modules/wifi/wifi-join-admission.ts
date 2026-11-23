import type {
	Notification,
	NotificationsMessage,
	WifiNewInput,
} from "@ceraui/rpc/schemas";
import { sendToClient } from "../../rpc/events.ts";
import type { AppWebSocket } from "../../rpc/types.ts";

export function refuseLegacyOpenJoin(
	ws: AppWebSocket,
	input: WifiNewInput,
): boolean {
	if (input.password !== "" || input.bssid !== undefined) return false;

	sendToClient(ws, "wifi", {
		new: { error: "open-target-unverified", device: input.device },
	});
	const band: Notification = {
		name: "wifi-open-reload",
		type: "warning",
		key: "notifications.updateAvailableDescription",
		msg: "A new version is available. Refresh to update.",
		is_dismissable: true,
		is_persistent: true,
		duration: 0,
	};
	// Separate stable names let the old tab render both without stacking on retry.
	sendToClient(ws, "notification", {
		show: [
			band,
			{
				...band,
				name: "wifi-open-reload-toast",
				is_persistent: false,
				duration: 60,
			},
		],
	} satisfies NotificationsMessage);
	return true;
}
