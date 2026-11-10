import type { RPCContext } from "../../rpc/types.ts";
import { statusClient } from "./status-client.ts";

export function wifiProtocolContext(
	onFrame: (frame: string) => void = () => undefined,
): RPCContext {
	return {
		ws: statusClient(onFrame),
		isAuthenticated: () => true,
		authenticate: () => undefined,
		deauthenticate: () => undefined,
		markActive: () => undefined,
		getLastActive: () => 0,
		setSenderId: () => undefined,
		getSenderId: () => undefined,
		clearSenderId: () => undefined,
	};
}
