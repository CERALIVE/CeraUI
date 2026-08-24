import { beforeEach, describe, expect, it, vi } from "vitest";

let messageHandler:
	| ((type: string, data: unknown, seq?: number) => void)
	| undefined;

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (
			handler: (type: string, data: unknown, seq?: number) => void,
		) => {
			messageHandler = handler;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getUplinks,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

describe("uplinks broadcast ingestion", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("reaches frontend state through the real subscription handler", () => {
		messageHandler?.("uplinks", [
			{
				iface: "eth0",
				kind: "ethernet",
				state: "degraded",
				reason: "captive_portal",
				weight: 25,
				lastTransition: 100,
				staleAt: 15_100,
				probes: { successes: 0, failures: 0 },
				signals: { activeAt: 100 },
			},
		]);

		expect(getUplinks()?.[0]).toMatchObject({
			iface: "eth0",
			state: "degraded",
		});
	});
});
