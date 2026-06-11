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
});
