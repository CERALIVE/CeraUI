import { describe, expect, test } from "bun:test";

// Version-skew guard for the @ceralive/cerastream binding surface (lifted from
// the template the package ships at tests/cerastream-bindings-skew.test.ts).
//
// UNLIKE @ceralive/srtla (a sibling `link:` dep), @ceralive/cerastream is a
// vendored npm package — but it is still subject to skew: CerastreamBackend
// (this repo) and the Rust IPC server both derive from THIS contract, and a
// rename / removal / signature change here breaks every consumer silently if
// nothing pins the surface. The exact symbols CerastreamBackend +
// cerastream-error-mapping import are asserted here so a refreshed tarball whose
// surface drifted fails loud and immediately instead of at stream start.
//
// Schema-shape assertions use `.parse` duck-typing rather than `instanceof
// z.ZodType`: the vendored package bundles its own zod, so a cross-instance
// `instanceof` is not a reliable guard for a consumer copy.

import * as bindings from "@ceralive/cerastream";
import {
	CERASTREAM_BIN,
	CONTROL_SOCKET_PATH,
	connect,
	DEFAULT_CONFIG_PATH,
	EVENT_TOPICS,
	eventParamsSchema,
	getCerastreamExec,
	NotImplementedError,
	PREVIEW_SOCKET_PATH,
	PROTOCOL_VERSION,
	processErrorCodeSchema,
	requestSchemas,
	rpcErrorCodeSchema,
	SCHEMA_VERSION,
	serializeCerastreamConfig,
	startParamsSchema,
	V1_METHODS,
	writeCerastreamConfig,
} from "@ceralive/cerastream";

function isZodSchema(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { parse?: unknown }).parse === "function" &&
		typeof (value as { safeParse?: unknown }).safeParse === "function"
	);
}

describe("cerastream bindings version-skew guard", () => {
	test("required client surface exists with matching identity", () => {
		expect(typeof bindings.connect).toBe("function");
		expect(connect).toBe(bindings.connect);
		expect(typeof bindings.NotImplementedError).toBe("function");
		expect(NotImplementedError).toBe(bindings.NotImplementedError);
	});

	test("config + path helpers CerastreamBackend drives exist", () => {
		expect(typeof serializeCerastreamConfig).toBe("function");
		expect(typeof writeCerastreamConfig).toBe("function");
		expect(typeof getCerastreamExec).toBe("function");
		expect(typeof CERASTREAM_BIN).toBe("string");
		expect(typeof DEFAULT_CONFIG_PATH).toBe("string");
	});

	test("wire constants are frozen at their ADR-0002 values", () => {
		expect(PROTOCOL_VERSION).toBe("cerastream-ipc/1");
		expect(CONTROL_SOCKET_PATH).toBe("/run/cerastream/control.sock");
		expect(PREVIEW_SOCKET_PATH).toBe("/run/cerastream/preview.sock");
	});

	test("the eight v1 methods each expose params + result schemas", () => {
		expect([...V1_METHODS]).toEqual([
			"start",
			"stop",
			"reload-config",
			"set-bitrate",
			"switch-input",
			"list-devices",
			"subscribe-events",
			"preview-session",
		]);
		for (const method of V1_METHODS) {
			expect(isZodSchema(requestSchemas[method]?.params)).toBe(true);
			expect(isZodSchema(requestSchemas[method]?.result)).toBe(true);
		}
	});

	test("start params validate the unified-config shape CerastreamBackend sends", () => {
		const parsed = startParamsSchema.parse({
			pipeline: "h264_camlink_1080p",
			srt: { host: "relay.example.com", port: 8890, latency_ms: 2000 },
			bitrate: { min_bitrate: 500, max_bitrate: 6000 },
		});
		expect(parsed.srt.port).toBe(8890);
		expect(parsed.bitrate.balancer).toBe("adaptive");
	});

	test("event topics + discriminated union stay in lockstep", () => {
		expect([...EVENT_TOPICS]).toEqual([
			"status",
			"switch",
			"device",
			"bitrate",
			"srt-stats",
			"error",
			"preview",
		]);
		expect(eventParamsSchema.options.length).toBe(EVENT_TOPICS.length);
	});

	test("error-code enums expose the two-tier contract", () => {
		expect(rpcErrorCodeSchema.options).toContain(
			"cerastream.bitrate.out_of_range",
		);
		// Tier 2 must map 1:1 onto CeraUI's PROCESS_ERROR_CODES (the table swap).
		expect(processErrorCodeSchema.options).toContain("srt_connection_lost");
		expect(processErrorCodeSchema.options.length).toBe(7);
	});

	test("SCHEMA_VERSION is pinned to 0.4.0", () => {
		expect(SCHEMA_VERSION).toBe("0.4.0");
	});

	test("0.4.0 surface: startParamsSchema has additive optional fields", () => {
		// Minimal config (backward compat)
		const minimal = startParamsSchema.parse({
			pipeline: "h264_camlink_1080p",
			srt: { host: "relay.example.com", port: 8890, latency_ms: 2000 },
			bitrate: { min_bitrate: 500, max_bitrate: 6000 },
		});
		expect(minimal.codec).toBeUndefined();
		expect(minimal.resolution).toBeUndefined();
		expect(minimal.framerate).toBeUndefined();
		expect(minimal.audio).toBeUndefined();

		// Full 0.4.0 payload with new fields
		const full = startParamsSchema.parse({
			pipeline: "h264_camlink_1080p",
			srt: { host: "relay.example.com", port: 8890, latency_ms: 2000 },
			bitrate: { min_bitrate: 500, max_bitrate: 6000 },
			codec: "h265",
			resolution: "1920x1080",
			framerate: 30.0,
			audio: { device: "hw:0", codec: "aac", delay_ms: 100 },
		});
		expect(full.codec).toBe("h265");
		expect(full.resolution).toBe("1920x1080");
		expect(full.framerate).toBe(30.0);
		expect(full.audio?.device).toBe("hw:0");
		expect(full.audio?.codec).toBe("aac");
		expect(full.audio?.delay_ms).toBe(100);
	});

	test("0.4.0 surface: captureDeviceSchema has additive optional kind field", () => {
		// Minimal device (backward compat)
		const minimal = bindings.captureDeviceSchema.parse({
			input_id: "video0",
			device_path: "/dev/video0",
			display_name: "USB Camera",
			media_class: "video",
		});
		expect(minimal.kind).toBeUndefined();

		// Device with 0.4.0 kind field
		const withKind = bindings.captureDeviceSchema.parse({
			input_id: "video0",
			device_path: "/dev/video0",
			display_name: "USB Camera",
			media_class: "video",
			kind: "uvc_h264",
		});
		expect(withKind.kind).toBe("uvc_h264");
	});

	test("0.4.0 surface: statusEventSchema has additive optional active_encode field", () => {
		// Minimal status (backward compat)
		const minimal = bindings.statusEventSchema.parse({
			type: "status",
			seq: 1,
			state: "streaming",
			streaming: true,
		});
		expect(minimal.active_encode).toBeUndefined();

		// Status with 0.4.0 active_encode field
		const withEncode = bindings.statusEventSchema.parse({
			type: "status",
			seq: 1,
			state: "streaming",
			streaming: true,
			active_encode: {
				codec: "h264",
				resolution: "1920x1080",
				framerate: 30.0,
				active_input: "video0",
				decoder: "mppvideodec",
			},
		});
		expect(withEncode.active_encode?.codec).toBe("h264");
		expect(withEncode.active_encode?.resolution).toBe("1920x1080");
		expect(withEncode.active_encode?.framerate).toBe(30.0);
		expect(withEncode.active_encode?.active_input).toBe("video0");
		expect(withEncode.active_encode?.decoder).toBe("mppvideodec");
	});

	test("0.4.0 surface: getCapabilitiesResultSchema has additive optional preview field", () => {
		// Minimal capabilities (backward compat)
		const minimal = bindings.getCapabilitiesResultSchema.parse({
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "3840x2160",
			},
			encoder: {
				codecs: ["h264", "h265"],
				bitrate_range: { min: 300, max: 6000, unit: "kbps" },
			},
			sources: [],
		});
		expect(minimal.preview).toBeUndefined();

		// Capabilities with 0.4.0 preview field
		const withPreview = bindings.getCapabilitiesResultSchema.parse({
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "3840x2160",
			},
			encoder: {
				codecs: ["h264", "h265"],
				bitrate_range: { min: 300, max: 6000, unit: "kbps" },
			},
			sources: [],
			preview: {
				enabled: true,
				port: 9997,
				bound: true,
			},
		});
		expect(withPreview.preview?.enabled).toBe(true);
		expect(withPreview.preview?.port).toBe(9997);
		expect(withPreview.preview?.bound).toBe(true);
	});
});
