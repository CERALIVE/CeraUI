// @vitest-environment jsdom
import type {
	SetWifiAdapterModeOutput,
	WifiMessage,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	beginOperation,
	destroyAsyncOperations,
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	initAsyncOperations,
	osCommand,
} from "$lib/rpc/async-operation.svelte";
import { noteLinkState } from "$lib/rpc/session-epoch.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import {
	wifiHotspotConfigOpKey,
	wifiModeOpKey,
} from "$main/network/wifi-station-lock";

const wire = vi.hoisted(() => ({
	message: (_type: string, _data: unknown) => {},
}));

vi.mock("$lib/rpc/client", () => ({
	ConnectionResetError: class ConnectionResetError extends Error {},
	rpc: { wifi: { getAdapterModes: vi.fn(async () => ({})) } },
	rpcClient: {
		onMessage: (fn: typeof wire.message) => {
			wire.message = fn;
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getSocket: () => undefined,
		sendLegacy: () => {},
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const key = wifiModeOpKey("0", "radio-A");
const status: WifiStatus = {
	"0": {
		ifname: "wlan0",
		hw: "Pending echo test radio",
		conn: "station-uuid",
		saved: {},
		incarnation: "radio-A",
	},
};

function emit(outcome: NonNullable<WifiMessage["adapter_mode"]>) {
	wire.message("wifi", { adapter_mode: outcome });
}

beforeEach(() => {
	vi.clearAllMocks();
	resetState();
	initAsyncOperations();
	initSubscriptions();
	noteLinkState("connected");
	wire.message("status", { wifi: status });
});

afterEach(() => {
	destroyAsyncOperations();
	resetState();
});

for (const mode of ["hotspot", "hybrid"] as const) {
	it(`a pending ${mode} echo replaces the original RPC's settlement ownership`, async () => {
		const reply = Promise.withResolvers<SetWifiAdapterModeOutput>();
		const command = osCommand({
			key,
			target: "hotspot",
			rpc: () => reply.promise,
			silent: true,
		});
		try {
			emit({ device: 0, incarnation: "radio-A", pending: true, mode });
			reply.resolve({ success: false, error: "DEVICE_BUSY" });
			await command;
			expect(getOperationPhase(key)).toBe("pending");
			expect(getOperationTarget(key)).toBe(mode);
			emit({ device: 0, incarnation: "radio-A", success: true });
			expect(getOperationPhase(key)).toBe("confirmed");
		} finally {
			reply.resolve({ success: true, accepted: true });
			await command;
		}
	});
}

it("an observed pending mode without a local command remains foreign", () => {
	emit({
		device: 0,
		incarnation: "radio-A",
		pending: true,
		mode: "hotspot",
	});
	expect(getOperationPhase(key)).toBe("pending");
	expect(getOperationTarget(key)).toBe("hotspot");
});

it("a pending mode after a terminal cannot be settled by the retired RPC", async () => {
	const reply = Promise.withResolvers<SetWifiAdapterModeOutput>();
	const command = osCommand({
		key,
		target: "hotspot",
		rpc: () => reply.promise,
		silent: true,
	});
	emit({ device: 0, incarnation: "radio-A", success: true });
	emit({
		device: 0,
		incarnation: "radio-A",
		pending: true,
		mode: "hotspot",
	});
	reply.resolve({ success: false, error: "DEVICE_BUSY" });
	await command;
	expect(getOperationPhase(key)).toBe("pending");
	emit({ device: 0, incarnation: "radio-A", success: true });
	expect(getOperationPhase(key)).toBe("confirmed");
});

it("finding 14: the accepted mode's busy terminal settles after its pending echo and failed reply", async () => {
	const reply = Promise.withResolvers<SetWifiAdapterModeOutput>();
	const command = osCommand({
		key,
		target: "hotspot",
		rpc: () => reply.promise,
		silent: true,
	});
	emit({
		device: 0,
		incarnation: "radio-A",
		pending: true,
		mode: "hotspot",
	});
	emit({ device: 0, incarnation: "radio-A", error: "DEVICE_BUSY" });
	reply.resolve({ success: false, error: "DEVICE_BUSY" });
	await command;
	expect(getOperationPhase(key)).toBe("failed");
	expect(getOperationReason(key)).toBe("DEVICE_BUSY");
});

for (const error of ["binding-required", "radio-changed"] as const) {
	for (const local of [false, true]) {
		it(`a requester's ${error} frame leaves its ${local ? "local" : "foreign"} accepted mode alone`, async () => {
			if (local)
				await osCommand({
					key,
					target: "hotspot",
					rpc: async () => ({ success: true, accepted: true }),
					silent: true,
				});
			emit({
				device: 0,
				incarnation: "radio-A",
				pending: true,
				mode: "hotspot",
			});
			emit({ device: "0", incarnation: "radio-A", error });
			expect(getOperationPhase(key)).toBe("pending");
			emit({ device: 0, incarnation: "radio-A", success: true });
			expect(getOperationPhase(key)).toBe("confirmed");
		});
	}
	it(`the correlated ${error} RPC reply still fails its own undispatched mode attempt`, async () => {
		const reply = Promise.withResolvers<SetWifiAdapterModeOutput>();
		const command = osCommand({
			key,
			target: "hotspot",
			rpc: () => reply.promise,
			silent: true,
		});
		emit({ device: "0", incarnation: "radio-A", error });
		reply.resolve({ success: false, error });
		await command;
		expect(getOperationPhase(key)).toBe("failed");
		expect(getOperationReason(key)).toBe(error);
	});
}

it("a tokenless config refusal does not settle the requester's existing config operation", () => {
	const configKey = wifiHotspotConfigOpKey("0", "radio-A");
	beginOperation(configKey);
	wire.message("wifi", {
		hotspot: {
			config: { device: 0, incarnation: "radio-A", error: "binding-required" },
		},
	});
	expect(getOperationPhase(configKey)).toBe("pending");
	wire.message("wifi", {
		hotspot: { config: { device: 0, incarnation: "radio-A", success: true } },
	});
	expect(getOperationPhase(configKey)).toBe("confirmed");
});
