// @vitest-environment jsdom
/** Netif frames preserve same-subnet data and ignore the retired diagnostic. */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the message handler `initSubscriptions` wires into the transport, and
// stub every socket touchpoint so no real WebSocket is opened.
let captured: ((type: string, data: unknown, seq?: number) => void) | undefined;
vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (h: (type: string, data: unknown, seq?: number) => void) => {
			captured = h;
			return () => {};
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getSocket: () => null,
		sendLegacy: () => {},
	},
}));

import type { NetifMessage } from "@ceraui/rpc/schemas";

import {
	getNetif,
	initSubscriptions,
	resetState,
} from "./subscriptions.svelte";

/** Feed a `netif` frame through the exact handler the transport calls. */
function pushNetif(msg: NetifMessage): void {
	if (!captured) throw new Error("message handler was never registered");
	captured("netif", msg);
}

const legacy = { policy_route_missing: true };

beforeEach(() => {
	resetState();
	initSubscriptions();
});

describe("netif merge preserves same-subnet data and ignores legacy diagnostics", () => {
	it("retains same-subnet data while stripping a legacy diagnostic", () => {
		pushNetif({
			usb0: {
				tp: 1,
				enabled: true,
				ip: "192.168.0.10",
				same_subnet_group: "192.168.0.0/24",
			},
			usb1: {
				tp: 2,
				enabled: true,
				ip: "10.0.0.2",
				...legacy,
			},
		});

		const netif = getNetif();
		expect(netif?.usb0?.same_subnet_group).toBe("192.168.0.0/24");
		expect(netif?.usb1).not.toHaveProperty("policy_route_missing");
	});

	it("persists same-subnet data across a steady-state tick that omits it", () => {
		pushNetif({
			usb0: {
				tp: 1,
				enabled: true,
				ip: "192.168.0.10",
				same_subnet_group: "192.168.0.0/24",
				...legacy,
			},
		});
		// A later throughput tick must preserve the same-subnet group.
		pushNetif({ usb0: { tp: 999, enabled: true, ip: "192.168.0.10" } });

		const netif = getNetif();
		expect(netif?.usb0?.tp).toBe(999);
		expect(netif?.usb0?.same_subnet_group).toBe("192.168.0.0/24");
		expect(netif?.usb0).not.toHaveProperty("policy_route_missing");
	});

	it("updates same-subnet data when a later frame carries new values", () => {
		pushNetif({
			usb0: { tp: 1, enabled: true, same_subnet_group: "192.168.0.0/24" },
		});
		pushNetif({
			usb0: {
				tp: 1,
				enabled: true,
				same_subnet_group: "10.10.0.0/24",
				...legacy,
			},
		});

		const netif = getNetif();
		expect(netif?.usb0?.same_subnet_group).toBe("10.10.0.0/24");
		expect(netif?.usb0).not.toHaveProperty("policy_route_missing");
	});

	it("does not fabricate the fields on an interface that never carried them", () => {
		pushNetif({ eth0: { tp: 5, enabled: true, ip: "10.0.9.1" } });

		const netif = getNetif();
		expect(netif?.eth0?.same_subnet_group).toBeUndefined();
		expect(netif?.eth0).not.toHaveProperty("policy_route_missing");
	});

	it("ignores both true and false legacy verdicts", () => {
		for (const verdict of [true, false]) {
			const legacyFrame = {
				wlan0: {
					tp: 2,
					enabled: false,
					ip: "10.42.0.1",
					policy_route_missing: verdict,
				},
			};
			pushNetif(legacyFrame);
			expect(getNetif()?.wlan0).toEqual({
				tp: 2,
				enabled: false,
				ip: "10.42.0.1",
			});
		}
	});
});
