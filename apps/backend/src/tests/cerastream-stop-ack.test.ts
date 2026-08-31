import { expect, test } from "bun:test";

import type {
	CaptureDevice,
	CerastreamClient,
	EventParams,
	ListDevicesResult,
	StartResult,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";

const STREAM_CONFIG: RuntimeConfig = {
	max_br: 8_000,
	srt_latency: 2_000,
	balancer: "adaptive",
	pipeline: "test",
};

const RUN_OPTIONS: StreamRunOptions = {
	pipeline: "test",
	host: "127.0.0.1",
	port: 9_000,
	streamid: "test",
};

const CAPTURE_DEVICE: CaptureDevice = {
	input_id: "cam0",
	device_path: "/dev/video0",
	display_name: "Capture 0",
	media_class: "video",
};

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
	readonly reject: (error: Error) => void;
}

function deferred<Value>(): Deferred<Value> {
	let resolvePromise: (value: Value) => void = () => undefined;
	let rejectPromise: (error: Error) => void = () => undefined;
	const promise = new Promise<Value>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

interface FakeClientOptions {
	readonly name: string;
	readonly trace: string[];
	readonly stopGate?: Promise<{ state: "idle" }>;
	readonly listGate?: Promise<ListDevicesResult>;
}

function makeClient(options: FakeClientOptions): CerastreamClient {
	const closed = deferred<never>();
	const record = (operation: string): void => {
		options.trace.push(`${options.name}:${operation}`);
	};
	return {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.1.0",
			engine_version: "test",
		},
		start: async (): Promise<StartResult> => {
			record("start");
			return { session_id: "session-1", state: "streaming" };
		},
		stop: async () => {
			record("stop");
			if (options.stopGate === undefined) return { state: "idle" };
			return await Promise.race([options.stopGate, closed.promise]);
		},
		reloadConfig: async (params) => ({ applied: params }),
		setBitrate: async (params) => ({
			applied: { max_bitrate: params.max_bitrate },
		}),
		switchInput: async (params) => ({
			active_input: params.input_id,
			mode: params.mode,
		}),
		listDevices: async () => {
			record("list-devices");
			if (options.listGate === undefined) {
				return { devices: [CAPTURE_DEVICE] };
			}
			return await Promise.race([options.listGate, closed.promise]);
		},
		getCapabilities: async () => ({
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "1920x1080",
			},
			encoder: {
				codecs: ["h264", "h265"],
				bitrate_range: { min: 500, max: 50_000, unit: "kbps" },
			},
			sources: [],
		}),
		changeConfig: async () => ({
			attempt_id: "change-1",
			phase: "applied",
			state: "streaming",
		}),
		previewSession: async () => ({
			session_id: "preview-1",
			tier: "webcodecs",
			transport: {
				kind: "uds-binary",
				socket: "/run/cerastream/preview.sock",
			},
		}),
		subscribeEvents: async (
			_params,
			_listener: (event: EventParams) => void,
		) => ({
			result: { subscribed: ["status"] },
			close: () => record("unsubscribe"),
		}),
		close: async () => {
			record("close");
			closed.reject(new Error(`${options.name}_closed`));
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(0);
	}
	expect(predicate()).toBe(true);
}

test("stop is not acknowledged until a separately dispatched engine stop reaches idle", async () => {
	// Given one session connection occupied by a device-list request and a fresh
	// stop connection whose engine acknowledgement is controlled by the test.
	const trace: string[] = [];
	const pendingList = deferred<ListDevicesResult>();
	const queuedSessionStop = deferred<{ state: "idle" }>();
	const stopAcknowledgement = deferred<{ state: "idle" }>();
	const sessionClient = makeClient({
		name: "session",
		trace,
		listGate: pendingList.promise,
		stopGate: queuedSessionStop.promise,
	});
	const stopClient = makeClient({
		name: "stop",
		trace,
		stopGate: stopAcknowledgement.promise,
	});
	let connection = 0;
	const logger: CerastreamBackendDeps["logger"] = {
		debug() {},
		info() {},
		warn() {},
		error() {},
	};
	const backend = new CerastreamBackend({
		connect: async () => {
			connection += 1;
			return connection === 1 ? sessionClient : stopClient;
		},
		connectOptions: {},
		getConfig: () => STREAM_CONFIG,
		saveConfig: () => undefined,
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => undefined,
			broadcastStatus: () => undefined,
			broadcastBuffering: () => undefined,
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-stop-ack.json",
		logger,
	});
	await backend.start(STREAM_CONFIG, RUN_OPTIONS);
	const listing = backend.listDevices().catch((error: unknown) => error);
	await waitFor(() => trace.includes("session:list-devices"));
	let stopped = false;

	// When stop begins while the original connection cannot read another request.
	expect(
		backend.stop(() => {
			stopped = true;
		}),
	).toBe(true);
	await waitFor(() => trace.includes("session:close"));
	await Bun.sleep(0);
	const acknowledgedBeforeIdle = stopped;
	const stopConnectionClosedBeforeIdle = trace.includes("stop:close");
	stopAcknowledgement.resolve({ state: "idle" });
	await backend.settle();
	await listing;

	// Then CeraUI reports stopped only after the independent stop reaches Idle.
	expect(acknowledgedBeforeIdle).toBe(false);
	expect(stopConnectionClosedBeforeIdle).toBe(false);
	expect(trace).toContain("stop:stop");
	expect(trace).not.toContain("session:stop");
	expect(trace).toContain("stop:close");
	expect(connection).toBe(2);
	expect(stopped).toBe(true);
});
