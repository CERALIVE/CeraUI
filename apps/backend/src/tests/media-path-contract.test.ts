import { describe, expect, test } from "bun:test";

import type {
	CerastreamClient,
	StartParams,
	Subscription,
} from "@ceralive/cerastream";
import type {
	ControlClient,
	createControlClient,
	HelloResult,
} from "@ceralive/srtla-send/control";
import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry as WatchTelemetryFn,
} from "@ceralive/srtla-send/telemetry";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import {
	buildLinkTelemetry,
	setControlClientFactoryForTest,
	setIfaceResolverForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";

const CONFIG: RuntimeConfig = {
	pipeline: "h264_hdmi_1080p",
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
};

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "stream-1",
	reducedPacketSize: false,
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

type CerastreamCall =
	| { readonly op: "start"; readonly params: StartParams }
	| {
			readonly op: "set-bitrate";
			readonly params: { readonly max_bitrate: number };
	  }
	| { readonly op: "subscribe-events" };

function makeCerastreamHarness(): {
	readonly backend: CerastreamBackend;
	readonly calls: CerastreamCall[];
} {
	const calls: CerastreamCall[] = [];
	let config = { ...CONFIG };
	const subscription: Subscription = { result: { subscribed: [] }, close() {} };
	const client: CerastreamClient = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.4.0",
			engine_version: "test",
		},
		start: async (params) => {
			calls.push({ op: "start", params });
			return { session_id: "s1", state: "streaming" };
		},
		stop: async () => ({ state: "idle" }),
		reloadConfig: async (params) => ({ applied: params }),
		setBitrate: async (params) => {
			calls.push({ op: "set-bitrate", params });
			return { applied: { max_bitrate: params.max_bitrate } };
		},
		switchInput: async (params) => ({
			active_input: params.input_id,
			mode: params.mode,
		}),
		listDevices: async () => ({ devices: [] }),
		subscribeEvents: async () => {
			calls.push({ op: "subscribe-events" });
			return subscription;
		},
		previewSession: async () => ({
			session_id: "p1",
			tier: "webcodecs",
			transport: { kind: "uds-binary", socket: "/run/cerastream/preview.sock" },
		}),
		close: async () => {},
	};
	const backend = new CerastreamBackend({
		connect: async () => client,
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		bridge: {
			notify() {},
			notificationExists: () => false,
			broadcastStatus() {},
			broadcastBuffering() {},
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-media-path-contract.json",
		logger: silentLogger,
		getActiveInput: () => undefined,
		isEmbeddedAudioActive: () => false,
	});
	config = { ...CONFIG };
	return { backend, calls };
}

function captureWatch() {
	const calls: Array<{
		readonly path: string;
		readonly cb: (update: TelemetryUpdate) => void;
	}> = [];
	let stopped = 0;
	const watch: typeof WatchTelemetryFn = (path, cb) => {
		calls.push({ path, cb });
		return {
			stop: () => {
				stopped += 1;
			},
		};
	};
	return {
		watch,
		emit: (data: Telemetry | null) => {
			for (const call of calls) call.cb({ data, stale: data === null });
		},
		get path() {
			return calls[calls.length - 1]?.path;
		},
		get stopped() {
			return stopped;
		},
	};
}

function telemetry(): Telemetry {
	return {
		schema_version: 1,
		last_updated_ms: Date.now(),
		connections: [
			{
				conn_id: "0",
				rtt_ms: 42,
				nak_count: 3,
				weight_percent: 100,
				window: 1000,
				in_flight: 0,
				bitrate_bps: 1_000_000,
			},
		],
	};
}

describe("media-path backend contracts", () => {
	test("cerastream start then setBitrate use the JSON-RPC wire shapes CeraUI relies on", async () => {
		const { backend, calls } = makeCerastreamHarness();
		backend.start(CONFIG, RUN_OPTS);
		await backend.settle();
		backend.setBitrate({ max_br: 9000 });
		await backend.settle();

		const start = calls.find((call) => call.op === "start");
		expect(start?.params).toMatchObject({
			pipeline: "h264_hdmi_1080p",
			srt: {
				host: "127.0.0.1",
				port: 9000,
				streamid: "stream-1",
				latency_ms: 2000,
				reduced_packet_size: false,
			},
			bitrate: { min_bitrate: 300, max_bitrate: 8000, balancer: "adaptive" },
		});
		const bitrate = calls.find((call) => call.op === "set-bitrate");
		expect(bitrate?.params).toEqual({ max_bitrate: 9000 });
	});

	test("srtla-send telemetry watch cuts over to stats-subscription without changing link shape", async () => {
		stopLinkTelemetry();
		setIfaceResolverForTest(() => "usb0");
		const watcher = captureWatch();
		let capturedSocket = "";
		let push = (_data: Telemetry | null): void => {
			throw new Error("stats subscription was not registered");
		};
		const client: ControlClient = {
			hello: async (): Promise<HelloResult> => ({
				schema_version: 1,
				engine: "srtla_send",
				capabilities: ["stats-subscription"],
			}),
			rawRequest: async () => null,
			subscribeStats: (onEvent) => {
				push = onEvent;
				return () => {};
			},
			close() {},
		};
		const factory = async (
			opts: Parameters<typeof createControlClient>[0],
		): Promise<ControlClient | null> => {
			capturedSocket = opts.socketPath;
			return client;
		};
		setControlClientFactoryForTest(factory);
		try {
			startLinkTelemetry("/tmp/srtla-send-stats-9000.json", ["10.0.0.1"], {
				watch: watcher.watch,
				controlSocket: "/tmp/srtla-send-control-9000.sock",
			});
			await Bun.sleep(0);
			expect(capturedSocket).toBe("/tmp/srtla-send-control-9000.sock");
			expect(watcher.path).toBe("/tmp/srtla-send-stats-9000.json");
			expect(watcher.stopped).toBe(1);
			push(telemetry());
			expect(buildLinkTelemetry()?.links).toEqual([
				{
					conn_id: "0",
					iface: "usb0",
					rtt_ms: 42,
					nak_count: 3,
					weight_percent: 100,
					stale: false,
				},
			]);
		} finally {
			stopLinkTelemetry();
			setControlClientFactoryForTest(null);
			setIfaceResolverForTest(null);
		}
	});
});
