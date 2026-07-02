import { describe, expect, test } from "bun:test";

import type { ActiveEncode } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
	extractActiveEncode,
} from "../modules/streaming/cerastream-backend.ts";

// Todo 19: the backend forwards the engine's additive `active_encode` field off
// the cerastream `status` event onto the CeraUI status broadcast — folded into
// telemetry and ridden by the EXISTING broadcastStatus() (no dedicated bridge
// method, unlike buffering). These tests pin the capability gate (absent
// active_encode → nothing) and the fold-into-telemetry path.

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function makeBackend(): {
	backend: CerastreamBackend;
	statusBroadcasts: { count: number };
} {
	const statusBroadcasts = { count: 0 };
	const bridge: CerastreamBackendDeps["bridge"] = {
		notify: () => {},
		notificationExists: () => false,
		broadcastStatus: () => {
			statusBroadcasts.count += 1;
		},
		broadcastBuffering: () => {},
	};
	const backend = new CerastreamBackend({
		connect: async () => {
			throw new Error("connect unused in handleEvent tests");
		},
		connectOptions: {},
		getConfig: () => ({}) as RuntimeConfig,
		saveConfig: () => {},
		bridge,
		execPath: "cerastream",
		configPath: "/tmp/cerastream-active-encode.json",
		logger: silentLogger,
	});
	return { backend, statusBroadcasts };
}

describe("extractActiveEncode (capability gate)", () => {
	test("returns null when the engine does not report active_encode", () => {
		expect(
			extractActiveEncode({ type: "status", seq: 0, streaming: true }),
		).toBeNull();
		expect(extractActiveEncode(null)).toBeNull();
		expect(extractActiveEncode(undefined)).toBeNull();
		expect(extractActiveEncode({ active_encode: "yes" })).toBeNull();
	});

	test("reads codec/resolution/framerate + optional active_input/decoder", () => {
		expect(
			extractActiveEncode({
				active_encode: {
					codec: "h265",
					resolution: "1920x1080",
					framerate: 30,
					active_input: "cam-0",
					decoder: "nvv4l2decoder",
				},
			}),
		).toEqual({
			codec: "h265",
			resolution: "1920x1080",
			framerate: 30,
			active_input: "cam-0",
			decoder: "nvv4l2decoder",
		});
	});

	test("returns a minimal payload when the optional fields are absent", () => {
		expect(
			extractActiveEncode({
				active_encode: { codec: "h264", resolution: "852x480", framerate: 60 },
			}),
		).toEqual({ codec: "h264", resolution: "852x480", framerate: 60 });
	});

	test("returns null on a partial/malformed active_encode (missing required)", () => {
		expect(
			extractActiveEncode({ active_encode: { codec: "h264", framerate: 30 } }),
		).toBeNull();
		expect(
			extractActiveEncode({
				active_encode: { codec: "h264", resolution: "852x480", framerate: "x" },
			}),
		).toBeNull();
	});
});

describe("CerastreamBackend active_encode bridge", () => {
	test("a status event with active_encode folds it into telemetry + rides broadcastStatus", () => {
		const { backend, statusBroadcasts } = makeBackend();

		backend.handleEvent({
			type: "status",
			seq: 0,
			state: "streaming",
			streaming: true,
			active_encode: {
				codec: "h265",
				resolution: "3840x2160",
				framerate: 30,
				active_input: "cam-0",
			},
		} as Parameters<CerastreamBackend["handleEvent"]>[0]);

		expect(statusBroadcasts.count).toBe(1);
		const telemetry = backend.getTelemetry() as {
			active_encode?: ActiveEncode;
		};
		expect(telemetry.active_encode).toEqual({
			codec: "h265",
			resolution: "3840x2160",
			framerate: 30,
			active_input: "cam-0",
		});
	});

	test("a plain status event (no active_encode) leaves telemetry without the field (capability absent)", () => {
		const { backend, statusBroadcasts } = makeBackend();

		backend.handleEvent({
			type: "status",
			seq: 1,
			state: "streaming",
			streaming: true,
		});

		expect(statusBroadcasts.count).toBe(1);
		const telemetry = backend.getTelemetry() as {
			active_encode?: ActiveEncode;
		};
		expect(telemetry.active_encode).toBeUndefined();
	});
});
