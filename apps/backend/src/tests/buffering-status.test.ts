import { describe, expect, test } from "bun:test";

import type { BufferingStatus } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
	extractBufferingStatus,
} from "../modules/streaming/cerastream-backend.ts";

// Task 34: the backend consumes the additive store-and-forward fields off the
// cerastream `status` event and re-broadcasts them on the existing `status` event
// bus (NOT device-stats). These tests pin the capability gate (absent buffering →
// nothing) and the engage/recover broadcast path.

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

interface BridgeHarness {
	bridge: CerastreamBackendDeps["bridge"];
	statusBroadcasts: { count: number };
	bufferingBroadcasts: Array<BufferingStatus>;
}

function makeBridge(): BridgeHarness {
	const statusBroadcasts = { count: 0 };
	const bufferingBroadcasts: Array<BufferingStatus> = [];
	return {
		statusBroadcasts,
		bufferingBroadcasts,
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			broadcastStatus: () => {
				statusBroadcasts.count += 1;
			},
			broadcastBuffering: (payload) => {
				bufferingBroadcasts.push(payload);
			},
		},
	};
}

function makeBackend(): { backend: CerastreamBackend; bridgeH: BridgeHarness } {
	const bridgeH = makeBridge();
	const backend = new CerastreamBackend({
		connect: async () => {
			throw new Error("connect unused in handleEvent tests");
		},
		connectOptions: {},
		getConfig: () => ({}) as RuntimeConfig,
		saveConfig: () => {},
		bridge: bridgeH.bridge,
		execPath: "cerastream",
		configPath: "/tmp/cerastream-buffering.json",
		logger: silentLogger,
	});
	return { backend, bridgeH };
}

describe("extractBufferingStatus (capability gate)", () => {
	test("returns null when the engine does not advertise buffering", () => {
		expect(
			extractBufferingStatus({ type: "status", seq: 0, streaming: true }),
		).toBeNull();
		expect(extractBufferingStatus(null)).toBeNull();
		expect(extractBufferingStatus(undefined)).toBeNull();
		expect(extractBufferingStatus({ buffering: "yes" })).toBeNull();
	});

	test("reads active + byte counters when present", () => {
		expect(
			extractBufferingStatus({
				type: "status",
				seq: 1,
				streaming: true,
				buffering: true,
				spooled_bytes: 1024,
				data_headroom_bytes: 2048,
				disk_warning: true,
			}),
		).toEqual({
			active: true,
			spooled_bytes: 1024,
			data_headroom_bytes: 2048,
			disk_warning: true,
		});
	});

	test("active:false (recovery) parses with no byte counters required", () => {
		expect(extractBufferingStatus({ buffering: false })).toEqual({
			active: false,
		});
	});

	test("drops malformed/negative byte counters defensively", () => {
		expect(
			extractBufferingStatus({
				buffering: true,
				spooled_bytes: -5,
				data_headroom_bytes: "lots",
			}),
		).toEqual({ active: true });
	});
});

describe("CerastreamBackend buffering bridge", () => {
	test("a status event with buffering active broadcasts the payload + caches telemetry", () => {
		const { backend, bridgeH } = makeBackend();

		backend.handleEvent({
			type: "status",
			seq: 0,
			state: "streaming",
			streaming: true,
			buffering: true,
			spooled_bytes: 4096,
			data_headroom_bytes: 8192,
		} as Parameters<CerastreamBackend["handleEvent"]>[0]);

		expect(bridgeH.bufferingBroadcasts).toEqual([
			{ active: true, spooled_bytes: 4096, data_headroom_bytes: 8192 },
		]);
		expect(bridgeH.statusBroadcasts.count).toBe(1);
		const telemetry = backend.getTelemetry() as {
			buffering?: BufferingStatus;
		};
		expect(telemetry.buffering?.active).toBe(true);
	});

	test("recovery (buffering:false) broadcasts active:false", () => {
		const { backend, bridgeH } = makeBackend();

		backend.handleEvent({
			type: "status",
			seq: 1,
			state: "streaming",
			streaming: true,
			buffering: false,
		} as Parameters<CerastreamBackend["handleEvent"]>[0]);

		expect(bridgeH.bufferingBroadcasts).toEqual([{ active: false }]);
	});

	test("a plain status event (no buffering) never broadcasts buffering (capability absent)", () => {
		const { backend, bridgeH } = makeBackend();

		backend.handleEvent({
			type: "status",
			seq: 2,
			state: "streaming",
			streaming: true,
		});

		expect(bridgeH.bufferingBroadcasts).toHaveLength(0);
		expect(bridgeH.statusBroadcasts.count).toBe(1);
	});
});
