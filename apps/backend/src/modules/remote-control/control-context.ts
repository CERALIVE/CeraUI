import type { AppWebSocket, RPCContext } from "../../rpc/types.ts";

const noop = () => undefined;
const zero = () => 0;

function syntheticSocket(): AppWebSocket {
	const ws: AppWebSocket = {
		send: zero,
		sendText: zero,
		sendBinary: zero,
		close: noop,
		terminate: noop,
		ping: zero,
		pong: zero,
		publish: zero,
		publishText: zero,
		publishBinary: zero,
		subscribe: noop,
		unsubscribe: noop,
		isSubscribed: () => false,
		subscriptions: [],
		cork: () => {
			throw new Error("control-channel synthetic socket cannot cork");
		},
		remoteAddress: "control-channel",
		readyState: 1,
		binaryType: "nodebuffer",
		data: { isAuthenticated: true, lastActive: Date.now() },
		getBufferedAmount: zero,
	};
	return ws;
}

export function buildControlContext(): RPCContext {
	const ws = syntheticSocket();
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: noop,
		deauthenticate: noop,
		markActive: noop,
		getLastActive: () => Date.now(),
		setSenderId: noop,
		getSenderId: () => undefined,
		clearSenderId: noop,
	};
}
