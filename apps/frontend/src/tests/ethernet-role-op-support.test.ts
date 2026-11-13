import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(
	(): {
		message?: (type: string, data: unknown) => void;
		connection?: (state: "connected" | "disconnected") => void;
	} => ({}),
);

vi.mock("$lib/rpc/client", () => ({
	ConnectionResetError: class ConnectionResetError extends Error {},
	rpc: {},
	rpcClient: {
		onMessage: (handler: (type: string, data: unknown) => void) => {
			handlers.message = handler;
		},
		onConnectionChange: (
			handler: (state: "connected" | "disconnected") => void,
		) => {
			handlers.connection = handler;
		},
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getNetif,
	initSubscriptions,
	resetState,
	supportsEthernetRoleOp,
} from "$lib/rpc/subscriptions.svelte";

const row = { tp: 0, enabled: true, ethRole: "uplink" };

describe("Ethernet role capability negotiation (#489)", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
		handlers.connection?.("connected");
	});

	it("uses only an explicit per-port advertisement and retracts omissions", () => {
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
		handlers.message?.("netif", {
			eth0: { ...row, ethRoleOp: true },
			eth1: row,
		});
		expect(supportsEthernetRoleOp("eth0")).toBe(true);
		expect(supportsEthernetRoleOp("eth1")).toBe(false);

		handlers.message?.("netif", { eth0: row });
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
		handlers.message?.("netif", { eth0: { ...row, ethRoleOp: false } });
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
	});

	it("clears support on reconnect while cached interface state remains visible", () => {
		handlers.message?.("netif", { eth0: { ...row, ethRoleOp: true } });
		expect(supportsEthernetRoleOp("eth0")).toBe(true);
		handlers.connection?.("disconnected");
		expect(getNetif()?.eth0?.ethRole).toBe("uplink");
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
		handlers.connection?.("connected");
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
		handlers.message?.("netif", { eth0: row });
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
		handlers.message?.("netif", { eth0: { ...row, ethRoleOp: true } });
		expect(supportsEthernetRoleOp("eth0")).toBe(true);
	});

	it("clears support when a port disappears or subscription state resets", () => {
		handlers.message?.("netif", { eth0: { ...row, ethRoleOp: true } });
		handlers.message?.("netif", {});
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
		handlers.message?.("netif", { eth0: { ...row, ethRoleOp: true } });
		resetState();
		expect(supportsEthernetRoleOp("eth0")).toBe(false);
	});
});
