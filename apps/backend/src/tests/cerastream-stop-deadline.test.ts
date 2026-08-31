import { expect, test } from "bun:test";

import type {
	CerastreamClient,
	EventParams,
	StartResult,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import { ENGINE_STOP_REQUEST_DEADLINE_MS } from "../modules/streaming/start-lifecycle-timing.ts";

const CONFIG: RuntimeConfig = {
	max_br: 8_000,
	srt_latency: 2_000,
	balancer: "adaptive",
	pipeline: "test",
};

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
	let resolvePromise: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function fakeClient(
	name: string,
	trace: string[],
	stopGate?: Promise<{ state: "idle" }>,
): CerastreamClient {
	const closed = deferred<never>();
	return {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.1.0",
			engine_version: "test",
		},
		start: async (): Promise<StartResult> => ({
			session_id: "session-1",
			state: "streaming",
		}),
		stop: async () => {
			trace.push(`${name}:stop`);
			return stopGate === undefined
				? { state: "idle" }
				: await Promise.race([stopGate, closed.promise]);
		},
		reloadConfig: async (params) => ({ applied: params }),
		setBitrate: async (params) => ({
			applied: { max_bitrate: params.max_bitrate },
		}),
		switchInput: async (params) => ({
			active_input: params.input_id,
			mode: params.mode,
		}),
		listDevices: async () => ({ devices: [] }),
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
		) => ({ result: { subscribed: ["status"] }, close: () => undefined }),
		close: async () => {
			trace.push(`${name}:close`);
		},
	};
}

function backendWithTimers(
	connect: CerastreamBackendDeps["connect"],
	deadlines: Map<number, () => void>,
): CerastreamBackend {
	const logger: CerastreamBackendDeps["logger"] = {
		debug() {},
		info() {},
		warn() {},
		error() {},
	};
	return new CerastreamBackend({
		connect,
		connectOptions: {},
		getConfig: () => CONFIG,
		saveConfig: () => undefined,
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => undefined,
			broadcastStatus: () => undefined,
			broadcastBuffering: () => undefined,
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-stop-deadline.json",
		logger,
		scheduleTimeout: (callback, delayMs) => {
			deadlines.set(delayMs, callback);
			return setTimeout(() => undefined, 60_000);
		},
		cancelTimeout: (timer) => clearTimeout(timer),
	});
}

async function start(backend: CerastreamBackend): Promise<void> {
	await backend.start(CONFIG, {
		pipeline: "test",
		host: "127.0.0.1",
		port: 9_000,
		streamid: "test",
	});
}

test("a stop connection that resolves after the deadline is closed without dispatch", async () => {
	const trace: string[] = [];
	const deadlines = new Map<number, () => void>();
	const lateConnection = deferred<CerastreamClient>();
	const sessionClient = fakeClient("session", trace);
	const lateClient = fakeClient("late", trace);
	let connection = 0;
	const backend = backendWithTimers(async () => {
		connection += 1;
		return connection === 1 ? sessionClient : await lateConnection.promise;
	}, deadlines);
	await start(backend);
	let stopped = false;

	expect(backend.stop(() => (stopped = true))).toBe(true);
	await Bun.sleep(0);
	const expire = deadlines.get(ENGINE_STOP_REQUEST_DEADLINE_MS);
	expect(expire).toBeDefined();
	expire?.();
	await backend.settle();
	lateConnection.resolve(lateClient);
	await Bun.sleep(0);

	expect(stopped).toBe(false);
	expect(trace).toContain("session:close");
	expect(trace).toContain("late:close");
	expect(trace).not.toContain("late:stop");
});

test("an unacknowledged stop is closed at the deadline and never calls back late", async () => {
	const trace: string[] = [];
	const deadlines = new Map<number, () => void>();
	const acknowledgement = deferred<{ state: "idle" }>();
	const clients = [
		fakeClient("session", trace),
		fakeClient("stop", trace, acknowledgement.promise),
	];
	const backend = backendWithTimers(async () => {
		const client = clients.shift();
		if (client === undefined) throw new Error("unexpected connection");
		return client;
	}, deadlines);
	await start(backend);
	let stopped = false;

	expect(backend.stop(() => (stopped = true))).toBe(true);
	await Bun.sleep(0);
	expect(trace).toContain("stop:stop");
	const expire = deadlines.get(ENGINE_STOP_REQUEST_DEADLINE_MS);
	expect(expire).toBeDefined();
	expire?.();
	await backend.settle();
	acknowledgement.resolve({ state: "idle" });
	await Bun.sleep(0);

	expect(stopped).toBe(false);
	expect(trace).toContain("session:close");
	expect(trace).toContain("stop:close");
});
