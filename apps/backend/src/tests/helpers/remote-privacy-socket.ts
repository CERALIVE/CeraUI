import { afterEach, beforeEach, mock, spyOn } from "bun:test";
import * as mockService from "../../mocks/mock-service.ts";
import * as dns from "../../modules/network/dns.ts";
import { getRemoteWebSocket, initRemote } from "../../modules/remote/remote.ts";
import * as ssh from "../../modules/system/ssh.ts";
import { StubRemoteSocket } from "./status-client.ts";

mock.module("ws", () => ({ default: StubRemoteSocket }));

export function useRemotePrivacySocket(): void {
	let intervals: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
	beforeEach(() => {
		spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
		spyOn(dns, "dnsCacheResolve").mockResolvedValue({
			addrs: ["127.0.0.1"],
			fromCache: false,
		});
		spyOn(ssh, "getSshStatus").mockResolvedValue(undefined);
		intervals = spyOn(globalThis, "setInterval");
	});
	afterEach(() => {
		for (const result of intervals.mock.results)
			if (result.type === "return") clearInterval(result.value);
		mock.restore();
	});
}

export async function authenticateRemote(): Promise<StubRemoteSocket> {
	await initRemote();
	const socket = getRemoteWebSocket();
	if (!(socket instanceof StubRemoteSocket)) throw new Error("missing remote");
	socket.emit("message", Buffer.from('{"remote":{"auth/encoder":true}}'));
	return socket;
}
