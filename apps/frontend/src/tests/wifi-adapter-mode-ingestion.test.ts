/**
 * The `wifi` broadcast's additive `adapter_mode` frames must reach the keyed
 * async-operation store.
 *
 * `wifi.setAdapterMode` only promises that a terminal frame FOLLOWS, so the
 * op stays `pending` after the RPC resolves and the confirming/failing signal
 * arrives exclusively through this ingestion path. A frame the handler drops is
 * a control that spins until the TTL valve fires.
 *
 * The key is asserted through `wifiModeOpKey` rather than a re-typed literal:
 * the handler builds it inline (matching its three sibling arms), so this is
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
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { wifiModeOpKey } from "$main/network/wifi-station-lock";

const KEY = wifiModeOpKey("0");

describe("wifi adapter_mode ingestion", () => {
	beforeEach(() => {
		resetState();
		initAsyncOperations();
		initSubscriptions();
	});

	it("a pending frame begins the op and records the target mode", () => {
		handlers.message?.("wifi", {
			adapter_mode: { device: 0, mode: "hybrid", pending: true },
		});
		expect(getOperationPhase(KEY)).toBe("pending");
		expect(getOperationTarget(KEY)).toBe("hybrid");
	});

	it("a terminal success confirms it", () => {
		handlers.message?.("wifi", {
			adapter_mode: { device: 0, mode: "hybrid", pending: true },
		});
		handlers.message?.("wifi", {
			adapter_mode: { device: 0, mode: "hybrid", success: true },
		});
		expect(getOperationPhase(KEY)).toBe("confirmed");
	});

	it("a terminal error fails it and keeps the device's own typed reason", () => {
		handlers.message?.("wifi", {
			adapter_mode: { device: 0, mode: "hybrid", pending: true },
		});
		handlers.message?.("wifi", {
			adapter_mode: { device: 0, error: "capability-unproven" },
		});
		expect(getOperationPhase(KEY)).toBe("failed");
		expect(getOperationReason(KEY)).toBe("capability-unproven");
	});

	it("keys on the NUMERIC adapter id the hotspot frames already use", () => {
		// The wire may carry the id as a number or a string; both must resolve to
		// the same op, or one client's transition is invisible to the other.
		handlers.message?.("wifi", {
			adapter_mode: { device: "0", mode: "station", pending: true },
		});
		expect(getOperationPhase(KEY)).toBe("pending");
	});

	it("leaves a sibling adapter's op untouched", () => {
		handlers.message?.("wifi", {
			adapter_mode: { device: 0, mode: "hotspot", pending: true },
		});
		expect(getOperationPhase(wifiModeOpKey("1"))).toBe("idle");
	});

	it("ignores a wifi frame that carries no adapter_mode at all", () => {
		handlers.message?.("wifi", { connect: true, device: 0 });
		expect(getOperationPhase(KEY)).toBe("idle");
	});
});
