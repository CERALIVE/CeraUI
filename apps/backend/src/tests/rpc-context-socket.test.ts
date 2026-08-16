import { describe, expect, test } from "bun:test";

import { getSocketSenderId } from "../modules/ui/websocket-server.ts";
import { handleWifi } from "../modules/wifi/wifi.ts";
import { createContext } from "../rpc/context.ts";
import type { AppWebSocket } from "../rpc/types.ts";

function fakeSocket(sent: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now(), senderId: "cid-1" },
		send: (message: string) => {
			sent.push(message);
			return message.length;
		},
	} as unknown as AppWebSocket;
}

describe("the oRPC context socket is the socket the wifi handlers take", () => {
	test("context.ws is accepted by handleWifi with no cast at the call site", () => {
		const sent: string[] = [];
		const context = createContext(fakeSocket(sent));

		// A uuid no registered connection owns: `wifiConnect` returns before it
		// spawns anything, so this asserts the PARAMETER TYPE, not the flow.
		expect(() =>
			handleWifi(context.ws, {
				connect: "00000000-0000-0000-0000-000000000000",
			}),
		).not.toThrow();
	});

	test("context.ws carries the send + senderId surface those handlers use", () => {
		const sent: string[] = [];
		const context = createContext(fakeSocket(sent));

		expect(getSocketSenderId(context.ws)).toBe("cid-1");
		context.ws.send("frame");
		expect(sent).toEqual(["frame"]);
	});
});
