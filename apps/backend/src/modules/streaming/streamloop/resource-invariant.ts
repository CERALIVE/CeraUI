import { logger } from "../../../helpers/logger.ts";
import { notificationBroadcast } from "../../ui/notifications.ts";

export function reportSessionInvariant(
	generation: number,
	reason: string,
): void {
	logger.error("stream-session invariant violation", { generation, reason });
	notificationBroadcast(
		"stream_session_recovered",
		"warning",
		"The stream session had inconsistent resource ownership and was recovered.",
		10,
		false,
		true,
	);
}
