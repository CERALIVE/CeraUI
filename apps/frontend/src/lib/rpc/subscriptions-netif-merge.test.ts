// @vitest-environment jsdom
/**
 * netif merge — additive-optional field propagation (Final-Wave Fix 1).
 *
 * Regression guard for a silent field drop in the REAL `subscriptions.svelte.ts`
 * netif merge: the `live` object copied only `tp`/`ip`/`error`/`mac`, so the two
 * collision-surfacing fields `same_subnet_group` (Todo 11) and
 * `policy_route_missing` (Todo 12) were stripped on every broadcast — leaving
 * `CollisionBands.svelte` (Todo 13) permanently starved of live data even though
 * its own unit test passed (it injects the netif PROP directly, bypassing this
 * merge).
 *
 * This drives the ACTUAL production path — `initSubscriptions()` registers
 * `handleMessage` via `rpcClient.onMessage`; we capture that handler and feed it
 * real `netif` frames, then read the merged result back through the public
 * `getNetif()` getter. It would FAIL against the pre-fix merge (both fields
 * absent from `getNetif()`), unlike `CollisionBands.test.ts`.
 */
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

import { getNetif, initSubscriptions, resetState } from "./subscriptions.svelte";

/** Feed a `netif` frame through the exact handler the transport calls. */
function pushNetif(msg: NetifMessage): void {
	if (!captured) throw new Error("message handler was never registered");
	captured("netif", msg);
}

beforeEach(() => {
	resetState();
	initSubscriptions();
});

describe("netif merge propagates same_subnet_group + policy_route_missing (Fix 1)", () => {
	it("retains both additive-optional fields from a post-login snapshot", () => {
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
				policy_route_missing: true,
			},
		});

		const netif = getNetif();
		expect(netif?.usb0?.same_subnet_group).toBe("192.168.0.0/24");
		expect(netif?.usb1?.policy_route_missing).toBe(true);
	});

	it("persists both fields across a steady-state tick that omits them", () => {
		pushNetif({
			usb0: {
				tp: 1,
				enabled: true,
				ip: "192.168.0.10",
				same_subnet_group: "192.168.0.0/24",
				policy_route_missing: true,
			},
		});
		// A later tick carries only the live throughput — the two optional fields
		// must survive via the `...existing` spread, exactly like ip/error/mac do.
		pushNetif({ usb0: { tp: 999, enabled: true, ip: "192.168.0.10" } });

		const netif = getNetif();
		expect(netif?.usb0?.tp).toBe(999);
		expect(netif?.usb0?.same_subnet_group).toBe("192.168.0.0/24");
		expect(netif?.usb0?.policy_route_missing).toBe(true);
	});

	it("updates both fields when a later frame carries new values", () => {
		pushNetif({
			usb0: { tp: 1, enabled: true, same_subnet_group: "192.168.0.0/24" },
		});
		pushNetif({
			usb0: {
				tp: 1,
				enabled: true,
				same_subnet_group: "10.10.0.0/24",
				policy_route_missing: true,
			},
		});

		const netif = getNetif();
		expect(netif?.usb0?.same_subnet_group).toBe("10.10.0.0/24");
		expect(netif?.usb0?.policy_route_missing).toBe(true);
	});

	it("does not fabricate the fields on an interface that never carried them", () => {
		pushNetif({ eth0: { tp: 5, enabled: true, ip: "10.0.9.1" } });

		const netif = getNetif();
		expect(netif?.eth0?.same_subnet_group).toBeUndefined();
		expect(netif?.eth0?.policy_route_missing).toBeUndefined();
	});
});
