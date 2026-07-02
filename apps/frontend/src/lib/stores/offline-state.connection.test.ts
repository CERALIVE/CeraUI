/**
 * offline-state connection tracking — driven via the transport-level client API
 * (`rpcClient.onConnectionChange` / `getConnectionState`), NOT raw socket
 * readyState. offline-state is the pre-auth strip's source of truth (Auth.svelte),
 * so these transitions must resolve without any authentication or initSubscriptions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "$lib/rpc/client";

let seedState: ConnectionState = "connecting";
let onlineFlag = true;
let capturedHandler: ((state: ConnectionState) => void) | null = null;

const onConnectionChange = vi.fn((handler: (state: ConnectionState) => void) => {
	capturedHandler = handler;
	return () => {
		capturedHandler = null;
	};
});
const getConnectionState = vi.fn((): ConnectionState => seedState);

vi.mock("$lib/rpc/client", () => ({
	rpcClient: {
		getConnectionState: () => getConnectionState(),
		onConnectionChange: (handler: (state: ConnectionState) => void) =>
			onConnectionChange(handler),
	},
}));

vi.mock("./pwa.svelte", () => ({
	getIsOnline: () => onlineFlag,
}));

type OfflineStateModule = typeof import("./offline-state.svelte");

async function loadOfflineState(
	seed: ConnectionState,
): Promise<OfflineStateModule> {
	seedState = seed;
	vi.resetModules();
	return await import("./offline-state.svelte");
}

beforeEach(() => {
	seedState = "connecting";
	onlineFlag = true;
	capturedHandler = null;
	onConnectionChange.mockClear();
	getConnectionState.mockClear();
});

describe("offline-state connection tracking", () => {
	it("seeds connectionState from rpcClient.getConnectionState() at init", async () => {
		const mod = await loadOfflineState("connecting");
		expect(getConnectionState).toHaveBeenCalled();
		expect(mod.getConnectionState()).toBe("connecting");
	});

	it("subscribes exactly once and replays no raw socket listeners", async () => {
		await loadOfflineState("connecting");
		expect(onConnectionChange).toHaveBeenCalledTimes(1);
		expect(capturedHandler).toBeTypeOf("function");
	});

	it("reflects a connected push via onConnectionChange", async () => {
		const mod = await loadOfflineState("connecting");
		capturedHandler?.("connected");
		expect(mod.getConnectionState()).toBe("connected");
		expect(mod.getIsFullyOffline()).toBe(false);
	});

	it("flips to disconnected and fully-offline on a simulated drop", async () => {
		const mod = await loadOfflineState("connected");
		capturedHandler?.("disconnected");
		expect(mod.getConnectionState()).toBe("disconnected");
		expect(mod.getIsFullyOffline()).toBe(true);
	});

	it("treats an error push as fully offline", async () => {
		const mod = await loadOfflineState("connected");
		capturedHandler?.("error");
		expect(mod.getConnectionState()).toBe("error");
		expect(mod.getIsFullyOffline()).toBe(true);
	});

	it("stays reliable pre-auth: transitions resolve with no subscriptions init", async () => {
		const mod = await loadOfflineState("connecting");
		capturedHandler?.("connected");
		expect(mod.getConnectionState()).toBe("connected");
		capturedHandler?.("disconnected");
		expect(mod.getIsFullyOffline()).toBe(true);
	});

	it("reports fully offline when the browser is offline even while connected", async () => {
		const mod = await loadOfflineState("connected");
		capturedHandler?.("connected");
		onlineFlag = false;
		expect(mod.getIsFullyOffline()).toBe(true);
	});
});
