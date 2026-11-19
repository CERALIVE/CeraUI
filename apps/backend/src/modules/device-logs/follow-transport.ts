import { LOG_FOLLOW_EVENT, type LogFollowMessage } from "@ceraui/rpc/schemas";
import type { ServerWebSocketSendStatus } from "bun";
import { buildMsg, getSocketSenderId } from "../../rpc/compat.ts";
import type { MessageSocket } from "../ui/message-socket.ts";

export interface FollowSocket extends MessageSocket {
	send(message: string): ServerWebSocketSendStatus;
	terminate?(): void;
}

export function createFollowTransport(
	conn: FollowSocket,
	session: AbortSignal | undefined,
) {
	const send = (message: LogFollowMessage) =>
		conn.send(buildMsg(LOG_FOLLOW_EVENT, message, getSocketSenderId(conn)));
	return {
		send(message: LogFollowMessage, checkpointCursor: string | null) {
			if (session?.aborted) return "failed";
			let status: ServerWebSocketSendStatus;
			try {
				status = send(message);
			} catch {
				return "failed";
			}
			// Bun queues -1 behind the socket's bounded backpressure limit.
			if (status !== 0) return "accepted";
			if (session?.aborted) return "failed";
			try {
				if (
					send({
						subscriptionId: message.subscriptionId,
						entries: [],
						checkpointCursor,
						dropped: 0,
						ended: message.ended === "cleared" ? "cleared" : "follower_exit",
					}) !== 0
				)
					return "dropped";
			} catch {
				// The notice also failed. The client must see a disconnect.
			}
			conn.terminate?.();
			return "dropped";
		},
	};
}
