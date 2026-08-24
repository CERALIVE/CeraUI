/**
 * The `eth_role` broadcast must reach the keyed async-operation store.
 *
 * `network.setEthernetRole` resolving does NOT mean the port took the role — the
 * device's terminal frame does — so the op stays `pending` past the RPC and the
 * confirming/failing signal arrives exclusively through this ingestion path. A
 * frame the handler drops is a control that spins until the TTL valve fires.
 *
 * The already-applied branch is the shape this arm exists for: it publishes its
 * terminal DIRECTLY, with NO pending frame, because nothing was dispatched and
 * no NetworkManager answer will ever settle. A handler that only settled a
 * pending→terminal SEQUENCE would leave every re-declaration of the current role
 * spinning.
 *
 * The key is asserted through `ethernetRoleOpKey` rather than a re-typed
 * literal: the handler builds it inline (matching its sibling arms), so this is
 * what pins the two spellings together.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: { message?: (t: string, d: unknown, s?: number) => void } = {};

vi.mock("$lib/rpc/client", () => ({
	rpc: { wifi: { getAdapterModes: vi.fn(async () => ({})) } },
	rpcClient: {
		onMessage: (fn: (t: string, d: unknown, s?: number) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	beginOperation,
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { ethernetRoleOpKey } from "$main/network/ethernet-role-view";

const KEY = ethernetRoleOpKey("eth0");

describe("eth_role ingestion", () => {
	beforeEach(() => {
		resetState();
		initAsyncOperations();
		initSubscriptions();
	});

	it("a pending frame begins the op and records the target role", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getOperationTarget(KEY)).toBe("shared-lan");
	});

	it("a pending→terminal sequence confirms it", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", success: true },
		});
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("a DIRECT terminal with no pending frame still settles the op", () => {
		// The already-applied branch: the dispatcher (osCommand) begins the op
		// before the RPC leaves, so the terminal lands on a pending op even though
		// the device never published a pending frame of its own.
		beginOperation(KEY, "uplink");
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "uplink", success: true },
		});
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("a terminal error fails it and keeps the device's own typed reason", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", error: "apply_failed" },
		});
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getOperationReason(KEY)).toBe("apply_failed");
	});

	it("a DIRECT terminal error settles it too", () => {
		beginOperation(KEY, "shared-lan");
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", error: "no_connection" },
		});
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getOperationReason(KEY)).toBe("no_connection");
	});

	it("leaves a sibling port's op untouched", () => {
		handlers.message?.("eth_role", {
			eth_role: { name: "eth0", role: "shared-lan", pending: true },
		});
		expect(getOperationPhase(ethernetRoleOpKey("eth1"))).toBe("idle");
	});

	it("ignores a frame carrying no name", () => {
		handlers.message?.("eth_role", { eth_role: { role: "uplink" } });
		expect(getOperationPhase(KEY)).toBe("idle");
	});

	it("ignores a frame with no eth_role payload at all", () => {
		handlers.message?.("eth_role", {});
		expect(getOperationPhase(KEY)).toBe("idle");
	});
});
