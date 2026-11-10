import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { AppWebSocket } from "../../rpc/types.ts";

export class StubRemoteSocket
	extends EventEmitter
	implements Pick<WebSocket, "send">
{
	readonly sent: string[] = [];
	send(
		message: Parameters<WebSocket["send"]>[0],
		options?: Parameters<WebSocket["send"]>[1] | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): void {
		if (typeof message !== "string")
			throw new Error("expected a JSON text frame");
		this.sent.push(message);
		if (typeof options === "function") options();
		else callback?.();
	}
}

/** A complete socket contract; unsupported operations fail instead of hiding use. */
export function statusClient(onFrame: (frame: string) => void): AppWebSocket {
	const unsupported = (): never => {
		throw new Error("status client only supports text frames");
	};
	const sendText = (frame: string): number => {
		onFrame(frame);
		return Buffer.byteLength(frame);
	};
	return {
		data: { isAuthenticated: true, lastActive: 0 },
		remoteAddress: "127.0.0.1",
		readyState: 1,
		binaryType: "nodebuffer",
		send(frame) {
			return typeof frame === "string" ? sendText(frame) : unsupported();
		},
		sendText,
		sendBinary: unsupported,
		close: unsupported,
		terminate: unsupported,
		pause: unsupported,
		resume: unsupported,
		isPaused: false,
		ping: unsupported,
		pong: unsupported,
		publish: unsupported,
		publishText: unsupported,
		publishBinary: unsupported,
		subscribe: unsupported,
		unsubscribe: unsupported,
		isSubscribed: unsupported,
		subscriptions: [],
		cork: unsupported,
		getBufferedAmount: () => 0,
	};
}
