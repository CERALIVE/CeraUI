/**
 * Snapshot broadcasts publish only when their wire value changes.
 *
 * Each push below is a fresh JSON parse, matching the real transport. Identical
 * bytes must therefore preserve the store reference rather than invalidating
 * every reactive consumer on the broadcast cadence.
 */
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

import type {
	ActiveEncode,
	DeviceStats,
	EncoderLoad,
	LinkTelemetryMessage,
	SensorsStatus,
} from "@ceraui/rpc/schemas";
import {
	getAddons,
	getDeviceStats,
	getEncoderLoadSnapshot,
	getLinkTelemetry,
	getNetif,
	getSensors,
	getStatus,
	initSubscriptions,
	resetState,
} from "../lib/rpc/subscriptions.svelte";

function push(type: string, payload: unknown): void {
	if (messageHandler === undefined) {
		throw new Error("subscription message handler was not registered");
	}
	messageHandler(type, JSON.parse(JSON.stringify(payload)));
}

const sensors: SensorsStatus = {
	"SoC temperature": "52.0 °C",
	"SoC current": "1.2 A",
};

const deviceStats: DeviceStats = {
	disk: null,
	cpuLoad1: 0.25,
	socTemp: 52,
	ifaceRxTx: null,
	raucSlot: "rootfs.0",
};

const encoderLoad: EncoderLoad = {
	source: "mpp-service",
	cores: [{ core: "rkvenc0", kind: "percent", percent: 12.5 }],
	updatedAt: 1_725_000_000_000,
	simulated: false,
};

const addon = {
	enabled: true,
	phase: "active",
	versionMaterialized: "1.0.0",
	autoDisabled: false,
} as const;

beforeEach(() => {
	resetState();
	initSubscriptions();
});

describe("snapshot broadcast identity", () => {
	it.each([
		{
			name: "status",
			type: "status",
			initial: { is_streaming: false, cellular_initializing: false },
			changed: { is_streaming: false, cellular_initializing: true },
			read: getStatus,
		},
		{
			name: "sensors",
			type: "sensors",
			initial: sensors,
			changed: { ...sensors, "SoC temperature": "53.0 °C" },
			read: getSensors,
		},
		{
			name: "device-stats",
			type: "device-stats",
			initial: deviceStats,
			changed: { ...deviceStats, cpuLoad1: 0.5 },
			read: getDeviceStats,
		},
		{
			name: "encoder-load",
			type: "encoder-load",
			initial: encoderLoad,
			changed: { ...encoderLoad, updatedAt: 1_725_000_001_000 },
			read: getEncoderLoadSnapshot,
		},
		{
			name: "addons",
			type: "addons",
			initial: { display: addon },
			changed: { display: { ...addon, phase: "installing" } },
			read: getAddons,
		},
	])(
		"keeps the $name reference for identical frames and replaces it on change",
		({ type, initial, changed, read }) => {
			push(type, initial);
			const first = read();

			push(type, initial);
			expect(read()).toBe(first);

			push(type, changed);
			expect(read()).not.toBe(first);
		},
	);

	it("still clears live engine truth on the streaming stop edge", () => {
		const activeEncode: ActiveEncode = {
			codec: "h265",
			resolution: "1920x1080",
			framerate: 60,
			active_input: "/dev/video0",
		};
		const linkTelemetry: LinkTelemetryMessage = {
			links: [
				{
					conn_id: "c1",
					iface: "wwan0",
					rtt_ms: 42,
					nak_count: 0,
					weight_percent: 100,
					stale: false,
				},
			],
		};

		push("status", {
			is_streaming: true,
			active_encode: activeEncode,
			linkTelemetry,
		});
		push("status", {
			is_streaming: false,
			active_encode: activeEncode,
			linkTelemetry,
		});

		expect(getStatus()?.active_encode).toBeNull();
		expect(getLinkTelemetry()).toBeNull();
	});

	it("still preserves policy_route_missing when a netif frame omits it", () => {
		push("netif", {
			wwan0: {
				ip: "10.0.0.2",
				tp: 100,
				enabled: true,
				policy_route_missing: true,
			},
		});
		push("netif", {
			wwan0: { ip: "10.0.0.2", tp: 120, enabled: true },
		});

		expect(getNetif()?.wwan0?.policy_route_missing).toBe(true);
	});
});
