import { describe, expect, test } from "bun:test";
import type {
	ConnectionTelemetry,
	SrtlaSendOptions,
	SrtlaSendOptionsInput,
	Telemetry,
	TelemetryUpdate,
	WatchTelemetryHandle,
	WatchTelemetryOptions,
} from "./index";
import * as pkg from "./index";
import {
	buildSrtlaSendArgs,
	connectionTelemetrySchema,
	getSrtlaSendExec,
	isSrtlaSendRunning,
	readTelemetry,
	SENDER_TELEMETRY_PATH_PREFIX,
	SENDER_TELEMETRY_STALE_MS,
	senderTelemetryPath,
	sendSrtlaSendHup,
	spawnSrtlaSend,
	srtlaSendOptionsSchema,
	telemetrySchema,
	watchTelemetry,
} from "./index";

// Every public runtime export the retired npm sender binding promised, plus
// the absorption's additions. A renamed/removed export drops out
// of `pkg` and fails the assertion below — the export-stability gate, and the
// reason `apps/backend` needed no rewrite beyond the import-source swap.
const EXPECTED_RUNTIME_EXPORTS = [
	"srtlaSendOptionsSchema",
	"buildSrtlaSendArgs",
	"getSrtlaSendExec",
	"spawnSrtlaSend",
	"sendSrtlaSendHup",
	"isSrtlaSendRunning",
	"SENDER_TELEMETRY_STALE_MS",
	"SENDER_TELEMETRY_PATH_PREFIX",
	"senderTelemetryPath",
	"connectionTelemetrySchema",
	"telemetrySchema",
	"readTelemetry",
	"watchTelemetry",
	"CONN_TIMEOUT_MS",
	"CAPABILITIES_JSON_FLAG",
	"DEFAULT_SRTLA_SEND_PATH",
	"buildCapabilitiesProbeArgs",
	"controlSocketPath",
] as const;

describe("@ceraui/srtla-send export stability", () => {
	test("every pre-existing + additive runtime export is present", () => {
		const exportsRecord: Record<string, unknown> = { ...pkg };
		for (const name of EXPECTED_RUNTIME_EXPORTS) {
			expect(exportsRecord[name]).toBeDefined();
		}
	});

	test("named imports resolve to the expected kinds", () => {
		expect(typeof buildSrtlaSendArgs).toBe("function");
		expect(typeof getSrtlaSendExec).toBe("function");
		expect(typeof spawnSrtlaSend).toBe("function");
		expect(typeof sendSrtlaSendHup).toBe("function");
		expect(typeof isSrtlaSendRunning).toBe("function");
		expect(typeof readTelemetry).toBe("function");
		expect(typeof watchTelemetry).toBe("function");
		expect(typeof senderTelemetryPath).toBe("function");
		expect(typeof SENDER_TELEMETRY_STALE_MS).toBe("number");
		expect(typeof SENDER_TELEMETRY_PATH_PREFIX).toBe("string");
		expect(srtlaSendOptionsSchema).toBeDefined();
		expect(connectionTelemetrySchema).toBeDefined();
		expect(telemetrySchema).toBeDefined();
	});

	test("additive senderTelemetryPath is re-exported at the package root", () => {
		expect(pkg.senderTelemetryPath(6000)).toBe(senderTelemetryPath(6000));
	});

	// Type-only exports are verified by `tsc --noEmit`: referencing each in a type
	// position makes a rename/removal a compile error, not a runtime one.
	test("type-only exports remain referenceable", () => {
		const optionsInput: SrtlaSendOptionsInput = { srtlaHost: "host" };
		const options: SrtlaSendOptions =
			srtlaSendOptionsSchema.parse(optionsInput);
		const conn: ConnectionTelemetry = {
			conn_id: "0",
			rtt_ms: 1,
			nak_count: 0,
			weight_percent: 100,
			window: 0,
			in_flight: 0,
			bitrate_bps: 0,
		};
		const snapshot: Telemetry = {
			schema_version: 1,
			last_updated_ms: 0,
			connections: [conn],
		};
		const update: TelemetryUpdate = { data: snapshot, stale: false };
		const watchOpts: WatchTelemetryOptions = { intervalMs: 1000 };
		const handle: WatchTelemetryHandle = { stop: () => {} };

		expect(options.srtlaHost).toBe("host");
		expect(update.stale).toBe(false);
		expect(watchOpts.intervalMs).toBe(1000);
		expect(typeof handle.stop).toBe("function");
	});
});
