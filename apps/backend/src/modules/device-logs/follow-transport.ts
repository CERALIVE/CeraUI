import {
	LOG_FOLLOW_EVENT,
	LOG_FOLLOW_GAP_FROM,
	type LogFollowMessage,
} from "@ceraui/rpc/schemas";
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
	const send = ({ gapFrom, ...message }: LogFollowMessage) => {
		const id = getSocketSenderId(conn);
		// The old payload parser rejects unknown fields. A sibling envelope
		// field keeps the original payload valid and shares its send outcome.
		return conn.send(
			gapFrom === undefined
				? buildMsg(LOG_FOLLOW_EVENT, message, id)
				: JSON.stringify({
						[LOG_FOLLOW_EVENT]: message,
						[LOG_FOLLOW_GAP_FROM]: gapFrom,
						id: id ?? undefined,
					}),
		);
	};
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
