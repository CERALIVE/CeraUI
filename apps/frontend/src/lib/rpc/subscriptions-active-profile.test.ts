// @vitest-environment jsdom
/**
 * device.activeProfile message handling — explicit no-op consumer (TD-active-profile-ui-fanout).
 *
 * The platform status-relay frame "device.activeProfile" is broadcast to all
 * authenticated UI clients via the subscriptions fan-out, but the UI has no
 * consumer for it (it drives nothing in the frontend). This test verifies that
 * dispatching the frame produces NO console.warn and mutates no store — the
 * frame is explicitly ignored via a no-op case in the message switch.
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

import {
	getConfig,
	getStatus,
	initSubscriptions,
	resetState,
} from "./subscriptions.svelte";

/** Feed a `device.activeProfile` frame through the exact handler the transport calls. */
function pushActiveProfile(data: unknown): void {
	if (!captured) throw new Error("message handler was never registered");
	captured("device.activeProfile", data);
}

beforeEach(() => {
	resetState();
	initSubscriptions();
});

describe("device.activeProfile message handling (TD-active-profile-ui-fanout)", () => {
	it("dispatches the frame with NO console.warn call", () => {
		const warnSpy = vi.spyOn(console, "warn");

		pushActiveProfile({
			stream_profile: "balanced",
			srt_latency: 1500,
			fec_enabled: true,
			recovery_mode: "standard",
		});

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("mutates no store when the frame is dispatched", () => {
		const configBefore = getConfig();
		const statusBefore = getStatus();

		pushActiveProfile({
			stream_profile: "balanced",
			srt_latency: 1500,
			fec_enabled: true,
			recovery_mode: "standard",
		});

		const configAfter = getConfig();
		const statusAfter = getStatus();

		expect(configAfter).toBe(configBefore);
		expect(statusAfter).toBe(statusBefore);
	});

	it("handles multiple frames without side effects", () => {
		const warnSpy = vi.spyOn(console, "warn");

		pushActiveProfile({ stream_profile: "low-latency", srt_latency: 500 });
		pushActiveProfile({ stream_profile: "resilient", srt_latency: 3000 });
		pushActiveProfile({ stream_profile: "balanced", srt_latency: 1500 });

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
