// @vitest-environment jsdom
import {
	type WifiAdapterMode,
	type WifiMessage,
	type WifiStatus,
	wifiAdapterModeErrorSchema,
} from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	beginOperation,
	confirmOperation,
	destroyAsyncOperations,
	failOperation,
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	initAsyncOperations,
	osCommand,
	timeoutOperation,
} from "$lib/rpc/async-operation.svelte";
import { rpc, rpcClient } from "$lib/rpc/client";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { wifiModeOpKey } from "$main/network/wifi-station-lock";

vi.mock(
	"$lib/env",
	async (importOriginal: () => Promise<typeof import("$lib/env")>) => ({
		...(await importOriginal()),
		getRpcSocketUrl: () => "ws://mode.test/ws",
	}),
);
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

class ModeSocket {
	static current: ModeSocket | undefined;
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState: number = ModeSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	readonly ids: string[] = [];

	constructor(readonly url: string) {
		ModeSocket.current = this;
	}

	send(raw: string): void {
		const request: unknown = JSON.parse(raw);
		if (
			typeof request !== "object" ||
			request === null ||
			!("id" in request) ||
			typeof request.id !== "string" ||
			!("path" in request) ||
			!Array.isArray(request.path)
		)
			return;
		if (request.path[0] === "wifi" && request.path[1] === "getAdapterModes")
			this.deliver({ id: request.id, result: {} });
		else this.ids.push(request.id);
	}

	deliver(frame: unknown): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	open(): void {
		this.readyState = ModeSocket.OPEN;
		this.onopen?.();
	}

	close(): void {
		if (this.readyState === ModeSocket.CLOSED) return;
		this.readyState = ModeSocket.CLOSED;
		this.onclose?.();
	}
}

const key = wifiModeOpKey("0", "radio-A");
const wifi: WifiStatus = {
	"0": {
		ifname: "wlan0",
		hw: "Mode request test radio",
		conn: "station-uuid",
		saved: {},
		incarnation: "radio-A",
	},
};
let sequence = 0;

function socket(): ModeSocket {
	const current = ModeSocket.current;
	if (!current) throw new Error("missing mode socket");
	return current;
}

function broadcast(outcome: NonNullable<WifiMessage["adapter_mode"]>): void {
	socket().deliver({ wifi: { adapter_mode: outcome }, seq: ++sequence });
}

function pending(): void {
	broadcast({
		device: 0,
		incarnation: "radio-A",
		mode: "hotspot",
		pending: true,
	});
}

function requestMode(target: WifiAdapterMode) {
	return osCommand({
		key,
		target,
		rpc: () =>
			rpc.wifi.setAdapterMode({
				device: "0",
				mode: target,
				incarnation: "radio-A",
			}),
		silent: true,
	});
}

function privateBusy(): void {
	socket().deliver({
		wifi: {
			adapter_mode: {
				device: "0",
				incarnation: "radio-A",
				error: "DEVICE_BUSY",
			},
		},
	});
}

function reply(result: { success: boolean; error?: "DEVICE_BUSY" }): void {
	const id = socket().ids.at(-1);
	if (!id) throw new Error("missing mode RPC");
	socket().deliver({ id, result });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", ModeSocket);
	rpcClient.disconnect();
	resetState();
	initAsyncOperations();
	ModeSocket.current = undefined;
	sequence = 0;
	initSubscriptions();
	if (ModeSocket.current === undefined) rpcClient.connect();
	socket().open();
	socket().deliver({ status: { wifi }, seq: ++sequence });
});

afterEach(() => {
	rpcClient.disconnect();
	destroyAsyncOperations();
	resetState();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

for (const target of ["hotspot", "station"] as const) {
	it(`a private busy refusal for ${target} cannot fail the accepted hotspot displayed by its requester`, async () => {
		const command = requestMode(target);
		pending();
		privateBusy();
		reply({ success: false, error: "DEVICE_BUSY" });
		await command;
		expect(getOperationPhase(key)).toBe("pending");
		expect(getOperationTarget(key)).toBe("hotspot");
		broadcast({
			device: 0,
			incarnation: "radio-A",
			mode: "hotspot",
			success: true,
		});
		expect(getOperationPhase(key)).toBe("confirmed");
	});
}

it("a private refusal leaves settlement to its correlated RPC reply", async () => {
	const command = requestMode("hotspot");
	privateBusy();
	const beforeReply = getOperationPhase(key);
	reply({ success: false, error: "DEVICE_BUSY" });
	await command;
	expect(beforeReply).toBe("pending");
	expect(getOperationPhase(key)).toBe("failed");
	expect(getOperationReason(key)).toBe("DEVICE_BUSY");
});

for (const error of wifiAdapterModeErrorSchema.options) {
	it(`an observer settles the accepted transaction's ${error} terminal`, () => {
		pending();
		broadcast({ device: 0, incarnation: "radio-A", error });
		expect(getOperationPhase(key)).toBe("failed");
		expect(getOperationReason(key)).toBe(error);
	});
}

for (const reconnect of ["before-pending", "after-pending"] as const) {
	it(`a requester reconnecting ${reconnect} settles the busy terminal`, async () => {
		const command = requestMode("hotspot");
		if (reconnect === "after-pending") pending();
		rpcClient.disconnect();
		await command;
		rpcClient.connect();
		socket().open();
		socket().deliver({ status: { wifi }, seq: ++sequence });
		if (reconnect === "before-pending") pending();
		broadcast({ device: 0, incarnation: "radio-A", error: "DEVICE_BUSY" });
		expect(getOperationPhase(key)).toBe("failed");
		expect(getOperationReason(key)).toBe("DEVICE_BUSY");
	});
}

for (const phase of ["confirmed", "failed", "timed_out"] as const) {
	it(`a private entry refusal does not reopen a ${phase} attempt`, () => {
		beginOperation(key, "hotspot");
		if (phase === "confirmed") confirmOperation(key);
		else if (phase === "failed") failOperation(key, "activation-failed");
		else timeoutOperation(key);
		privateBusy();
		expect(getOperationPhase(key)).toBe(phase);
	});
}
