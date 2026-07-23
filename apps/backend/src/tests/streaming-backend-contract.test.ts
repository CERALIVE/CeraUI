import { describe, expect, test } from "bun:test";

import type {
	CaptureDevice,
	CerastreamClient,
	EventParams,
	StartResult,
} from "@ceralive/cerastream";
import {
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
	cerastreamBackend,
	classifyConnectHandshakePhase,
} from "../modules/streaming/cerastream-backend.ts";
import { deriveStreamHealth } from "../modules/streaming/health.ts";
import {
	createLaunchTransaction,
	type LaunchDeadlineTimers,
} from "../modules/streaming/launch-transaction.ts";
import { START_PHASE_DEADLINES_MS } from "../modules/streaming/start-lifecycle-timing.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import type {
	StreamingBackend,
	StreamRunOptions,
} from "../modules/streaming/streaming-backend.ts";
import {
	DEFAULT_STREAMING_ENGINE,
	getConfiguredEngine,
	getStreamingBackend,
	resolveStreamingBackend,
} from "../modules/streaming/streaming-engine.ts";

// StreamingBackend contract suite for the cerastream engine (the only engine):
// structural conformance of the production singleton against the seam, plus the
// full behavioural contract exercised against a real CerastreamBackend driven by
// an in-memory fake control client.

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "stream-1",
	reducedPacketSize: false,
};

const STREAM_CONFIG: RuntimeConfig = {
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
	pipeline: "h264_hdmi_1080p",
};

const CAPTURE_DEVICE: CaptureDevice = {
	input_id: "cam0",
	device_path: "/dev/video0",
	display_name: "Capture 0",
	media_class: "video",
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

interface FakeClientHarness {
	client: CerastreamClient;
	calls: Array<{ op: string; params?: unknown }>;
	readonly subscribed: Promise<void>;
	readonly started: Promise<void>;
	emit(event: EventParams): void;
}

interface FakeClientOptions {
	readonly startResult?: StartResult;
	readonly startGate?: Promise<StartResult>;
	readonly stopGate?: Promise<{ state: "idle" }>;
	readonly subscribeGate?: Promise<void>;
}

function makeFakeClient(options: FakeClientOptions = {}): FakeClientHarness {
	const calls: Array<{ op: string; params?: unknown }> = [];
	let listener: ((event: EventParams) => void) | undefined;
	let resolveSubscribed: (() => void) | undefined;
	let resolveStarted: (() => void) | undefined;
	let rejectStartOnClose: ((error: Error) => void) | undefined;
	let rejectStopOnClose: ((error: Error) => void) | undefined;
	const startClosed =
		options.startGate === undefined
			? undefined
			: new Promise<never>((_resolve, reject) => {
					rejectStartOnClose = reject;
				});
	const stopClosed =
		options.stopGate === undefined
			? undefined
			: new Promise<never>((_resolve, reject) => {
					rejectStopOnClose = reject;
				});
	const subscribed = new Promise<void>((resolve) => {
		resolveSubscribed = resolve;
	});
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const client: CerastreamClient = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "test",
			engine_version: "test",
		},
		start: async (params) => {
			calls.push({ op: "start", params });
			resolveStarted?.();
			if (options.startGate !== undefined && startClosed !== undefined) {
				return await Promise.race([options.startGate, startClosed]);
			}
			return options.startResult ?? { session_id: "s1", state: "streaming" };
		},
		stop: async (params) => {
			calls.push({ op: "stop", params });
			if (options.stopGate !== undefined && stopClosed !== undefined) {
				return await Promise.race([options.stopGate, stopClosed]);
			}
			return { state: "idle" };
		},
		reloadConfig: async (params) => {
			calls.push({ op: "reload-config", params });
			return { applied: params };
		},
		setBitrate: async (params) => {
			calls.push({ op: "set-bitrate", params });
			return { applied: { max_bitrate: params.max_bitrate } };
		},
		switchInput: async (params) => {
			calls.push({ op: "switch-input", params });
			return { active_input: params.input_id, mode: params.mode };
		},
		listDevices: async (params) => {
			calls.push({ op: "list-devices", params });
			return { devices: [CAPTURE_DEVICE] };
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
		subscribeEvents: async (params, eventListener) => {
			calls.push({ op: "subscribe-events", params });
			listener = eventListener;
			resolveSubscribed?.();
			if (options.subscribeGate !== undefined) {
				await options.subscribeGate;
			}
			return {
				result: {
					subscribed: [
						"status",
						"switch",
						"device",
						"bitrate",
						"srt-stats",
						"error",
						"preview",
					],
				},
				close: () => calls.push({ op: "unsubscribe" }),
			};
		},
		previewSession: async (params) => {
			calls.push({ op: "preview-session", params });
			return {
				session_id: "p1",
				tier: "webcodecs",
				transport: {
					kind: "uds-binary",
					socket: "/run/cerastream/preview.sock",
				},
			};
		},
		close: async () => {
			calls.push({ op: "close" });
			const closed = new Error("client_closed");
			rejectStartOnClose?.(closed);
			rejectStopOnClose?.(closed);
		},
	};
	// `switch-audio` is dispatched by the backend through the client's raw
	// JSON-RPC primitive (it is absent from the binding's typed surface); expose
	// it on the fake so the audio passthrough is exercisable.
	(client as unknown as Record<string, unknown>).rawRequest = async (
		method: string,
		params?: unknown,
	) => {
		calls.push({ op: method, params });
		if (method === "switch-audio") {
			const p = params as { audio_input_id: string; mode?: "manual" | "auto" };
			return { active_audio_input: p.audio_input_id, mode: p.mode ?? "manual" };
		}
		return {};
	};
	return {
		client,
		calls,
		subscribed,
		started,
		emit: (event) => listener?.(event),
	};
}

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

function fakeDeadlineTimers(): {
	readonly timers: LaunchDeadlineTimers;
	readonly fire: () => void;
	readonly delay: () => number | undefined;
} {
	let callback: (() => void) | undefined;
	let delayMs: number | undefined;
	return {
		timers: {
			schedule: (next, delay) => {
				callback = next;
				delayMs = delay;
				return 1;
			},
			cancel: () => undefined,
		},
		fire: () => callback?.(),
		delay: () => delayMs,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(0);
	}
	expect(predicate()).toBe(true);
}

interface BridgeHarness {
	bridge: CerastreamBackendDeps["bridge"];
	notifications: Array<{ name: string; msg: string }>;
	srtlaNotified: { value: boolean };
	broadcasts: { count: number };
}

function makeBridge(): BridgeHarness {
	const notifications: Array<{ name: string; msg: string }> = [];
	const srtlaNotified = { value: false };
	const broadcasts = { count: 0 };
	return {
		notifications,
		srtlaNotified,
		broadcasts,
		bridge: {
			notify: (name, _type, msg) => {
				notifications.push({ name, msg });
			},
			notificationExists: (name) => name === "srtla" && srtlaNotified.value,
			broadcastStatus: () => {
				broadcasts.count += 1;
			},
			broadcastBuffering: (_payload) => undefined,
		},
	};
}

interface BackendHarness {
	backend: CerastreamBackend;
	fake: FakeClientHarness;
	bridgeH: BridgeHarness;
	config: RuntimeConfig;
	saveCount: () => number;
}

function makeBackend(
	opts: {
		connect?: CerastreamBackendDeps["connect"];
		config?: Partial<RuntimeConfig>;
		fakeOptions?: FakeClientOptions;
		scheduleTimeout?: CerastreamBackendDeps["scheduleTimeout"];
		cancelTimeout?: CerastreamBackendDeps["cancelTimeout"];
	} = {},
): BackendHarness {
	const fake = makeFakeClient(opts.fakeOptions);
	const bridgeH = makeBridge();
	const config: RuntimeConfig = { ...STREAM_CONFIG, ...opts.config };
	let saves = 0;
	const backend = new CerastreamBackend({
		connect: opts.connect ?? (async () => fake.client),
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {
			saves += 1;
		},
		bridge: bridgeH.bridge,
		execPath: "cerastream",
		configPath: "/tmp/cerastream-contract.json",
		logger: silentLogger,
		...(opts.scheduleTimeout ? { scheduleTimeout: opts.scheduleTimeout } : {}),
		...(opts.cancelTimeout ? { cancelTimeout: opts.cancelTimeout } : {}),
	});
	return { backend, fake, bridgeH, config, saveCount: () => saves };
}

// ---------------------------------------------------------------------------
// Structural conformance of the production singleton.
// ---------------------------------------------------------------------------

describe("StreamingBackend seam — cerastream satisfies the contract", () => {
	test("the production singleton exposes the full StreamingBackend surface", () => {
		const backend: StreamingBackend = cerastreamBackend;
		expect(typeof backend.start).toBe("function");
		expect(typeof backend.stop).toBe("function");
		expect(typeof backend.setBitrate).toBe("function");
		expect(typeof backend.reloadConfig).toBe("function");
		expect(typeof backend.writeConfig).toBe("function");
		expect(typeof backend.buildRunArgs).toBe("function");
		expect(typeof backend.configExists).toBe("function");
		expect(typeof backend.onError).toBe("function");
		expect(typeof backend.execPath).toBe("string");
		expect(typeof backend.tempPipelinePath).toBe("string");
		expect(typeof backend.configPath).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// Engine selection — cerastream is the only engine.
// ---------------------------------------------------------------------------

describe("engine selection", () => {
	test("resolveStreamingBackend resolves to the cerastream backend", () => {
		expect(resolveStreamingBackend("cerastream")).toBe(cerastreamBackend);
	});

	test("the configured engine is always cerastream (legacy values coerced)", () => {
		expect(DEFAULT_STREAMING_ENGINE).toBe("cerastream");
		expect(getConfiguredEngine()).toBe("cerastream");
		expect(getStreamingBackend()).toBe(cerastreamBackend);
	});
});

// ---------------------------------------------------------------------------
// CerastreamBackend behavioural contract (real backend + fake IPC client).
// ---------------------------------------------------------------------------

describe("CerastreamBackend behavioural contract", () => {
	test("a silent idle engine terminalizes reconciliation and admits start", async () => {
		// Given a connected, subscribed production backend whose idle engine emits
		// no status heartbeat, matching the board's active-engine/idle-health state.
		let reconcileTimeout: (() => void) | undefined;
		const { backend, fake } = makeBackend({
			scheduleTimeout: (callback) => {
				reconcileTimeout = callback;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancelTimeout: () => undefined,
		});
		let streaming = false;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => "attempt-after-idle-reconcile",
			setStreamingStatus: (next) => {
				streaming = next;
			},
			getStreamingStatus: () => streaming,
			stopRuntime: async () => undefined,
			queryRuntime: () => backend.reconcileRuntimeState(),
		});
		const reconciling = orchestrator.reconcile();
		await fake.subscribed;
		await waitFor(() => reconcileTimeout !== undefined);

		// When the bounded observation window expires without a status event.
		reconcileTimeout?.();
		const reconciled = await reconciling;
		const health = deriveStreamHealth({
			isStreaming: streaming,
			processAlive: null,
			framesAdvancing: null,
			frameCount: null,
			reconnecting: null,
			reconnectCount: 0,
			linkCount: 0,
			activeLinks: 0,
		});
		const started = await orchestrator.start({
			origin: "ui",
			launch: async () => undefined,
		});

		// Then idle is authoritative, health agrees, and Start owns generation one.
		expect(reconciled).toBe("idle");
		expect(health.state).toBe("idle");
		expect(started).toEqual({
			result: "started",
			attemptId: "attempt-after-idle-reconcile",
		});
		expect(orchestrator.snapshot()).toEqual({
			state: "streaming",
			generation: 1,
		});
	});

	test("a dead engine cannot retain the backend queue after lifecycle cleanup", async () => {
		// Production-wired reproduction of the board failure: generation one owns
		// the real CerastreamBackend queue while both start and stop replies hang.
		const deadStart = deferred<StartResult>();
		const deadStop = deferred<{ state: "idle" }>();
		const dead = makeFakeClient({
			startGate: deadStart.promise,
			stopGate: deadStop.promise,
		});
		const recovered = makeFakeClient();
		const bridgeH = makeBridge();
		const config: RuntimeConfig = { ...STREAM_CONFIG };
		let connections = 0;
		const backend = new CerastreamBackend({
			connect: async () => {
				connections += 1;
				if (connections === 1) return dead.client;
				if (connections === 2) throw new Error("engine_restart_window");
				return recovered.client;
			},
			connectOptions: {},
			getConfig: () => config,
			saveConfig: () => undefined,
			bridge: bridgeH.bridge,
			execPath: "cerastream",
			configPath: "/tmp/cerastream-contract.json",
			logger: silentLogger,
		});
		const stopTimers: Array<() => void> = [];
		const launchTimers: Array<{ callback: () => void; delayMs: number }> = [];
		let streaming = false;
		let nextAttempt = 0;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => {
				nextAttempt += 1;
				return `attempt-${nextAttempt}`;
			},
			setStreamingStatus: (next) => {
				streaming = next;
			},
			getStreamingStatus: () => streaming,
			stopRuntime: (generation) =>
				new Promise<void>((resolve) => {
					if (!backend.stop(resolve)) resolve();
					expect(generation).toBeGreaterThan(0);
				}),
			queryRuntime: async () => "idle",
			stopDeadlineMs: 12,
			retryPolicy: {
				maxAttempts: 1,
				totalBudgetMs: 10,
				attemptTimeoutMs: 10,
				baseDelayMs: 1,
				maxDelayMs: 1,
			},
			now: () => 10,
			scheduleTimeout: (callback) => {
				stopTimers.push(callback);
				return stopTimers.length;
			},
			cancelTimeout: () => undefined,
			scheduleLaunchDeadline: (callback, delayMs) => {
				launchTimers.push({ callback, delayMs });
				return launchTimers.length;
			},
			cancelLaunchDeadline: () => undefined,
		});
		const launch = () => backend.start(STREAM_CONFIG, RUN_OPTS);

		const first = orchestrator.start({ origin: "ui", launch });
		await dead.started;
		launchTimers.find(({ delayMs }) => delayMs === 10)?.callback();
		await Bun.sleep(0);
		stopTimers.shift()?.();
		expect(await first).toMatchObject({ result: "failed" });
		expect(streaming).toBe(false);
		expect(orchestrator.snapshot()).toEqual({
			state: "idle",
			generation: 1,
		});
		const deadOps = dead.calls.map(({ op }) => op);
		expect(deadOps.filter((op) => op === "start")).toHaveLength(1);
		expect(deadOps.filter((op) => op === "stop")).toHaveLength(2);
		expect(deadOps.filter((op) => op === "close")).toHaveLength(2);
		expect(deadOps.filter((op) => op === "unsubscribe")).toHaveLength(2);

		// A second owner must reach the recovered connect path and terminate; it
		// must not park behind generation one's dead queue and make a third RPC busy.
		const second = orchestrator.start({ origin: "ui", launch });
		for (let tick = 0; tick < 10; tick += 1) await Bun.sleep(0);
		expect(await second).toMatchObject({ result: "failed" });
		expect(streaming).toBe(false);
		expect(orchestrator.snapshot()).toEqual({
			state: "idle",
			generation: 2,
		});
		const third = await orchestrator.start({ origin: "ui", launch });
		expect(third).toMatchObject({ result: "started" });
		expect(connections).toBe(3);
		expect(streaming).toBe(true);
		expect(orchestrator.snapshot()).toEqual({
			state: "streaming",
			generation: 3,
		});

		await orchestrator.stop();
		await backend.settle();
	});

	test("reconciliation adopts an engine-held stream", async () => {
		// Given a fresh backend connected to an engine whose session survived it.
		const { backend, fake } = makeBackend();
		const reconciliation = backend.reconcileRuntimeState();
		await fake.subscribed;

		// When the subscribed engine reports its actual streaming state.
		fake.emit({ type: "status", seq: 1, state: "streaming", streaming: true });

		// Then the backend adopts the client and can stop the existing runtime.
		expect(await reconciliation).toBe("streaming");
		let stopped = false;
		expect(backend.stop(() => (stopped = true))).toBe(true);
		await backend.settle();
		expect(stopped).toBe(true);
		expect(fake.calls.map((call) => call.op)).toContain("stop");
	});

	test("reconciliation reports contradictory engine status as unknown", async () => {
		const { backend, fake } = makeBackend();
		let streaming = false;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => "attempt-disagreement",
			setStreamingStatus: (next) => {
				streaming = next;
			},
			getStreamingStatus: () => streaming,
			stopRuntime: async () => undefined,
			queryRuntime: () => backend.reconcileRuntimeState(),
		});
		const reconciliation = orchestrator.reconcile();
		await fake.subscribed;

		fake.emit({ type: "status", seq: 1, state: "streaming", streaming: false });

		expect(await reconciliation).toBe("reconciling");
		expect(streaming).toBe(false);
		expect(
			await orchestrator.start({ origin: "ui", launch: async () => undefined }),
		).toMatchObject({ result: "busy" });
	});

	test("reconciliation reports an engine query error as unknown", async () => {
		const { backend } = makeBackend({
			connect: async () => {
				throw new Error("engine unavailable");
			},
		});

		expect(await backend.reconcileRuntimeState()).toBe("unknown");
	});

	test("a silent subscribed reconciliation is bounded and resolves idle", async () => {
		for (let repeat = 0; repeat < 5; repeat += 1) {
			let timeoutCallback: (() => void) | undefined;
			let scheduledDelay: number | undefined;
			let cancelled = 0;
			const { backend, fake } = makeBackend({
				scheduleTimeout: (callback, delayMs) => {
					timeoutCallback = callback;
					scheduledDelay = delayMs;
					return repeat as unknown as ReturnType<typeof setTimeout>;
				},
				cancelTimeout: () => {
					cancelled += 1;
				},
			});
			const reconciliation = backend.reconcileRuntimeState();
			await fake.subscribed;
			await Promise.resolve();

			expect(scheduledDelay).toBe(2500);
			timeoutCallback?.();
			expect(await reconciliation).toBe("idle");
			expect(cancelled).toBe(1);
		}
	});

	test("a status event arriving after idle reconciliation cannot become owned", async () => {
		let timeoutCallback: (() => void) | undefined;
		const { backend, fake } = makeBackend({
			scheduleTimeout: (callback) => {
				timeoutCallback = callback;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancelTimeout: () => undefined,
		});
		const reconciliation = backend.reconcileRuntimeState();
		await fake.subscribed;
		await waitFor(() => timeoutCallback !== undefined);

		timeoutCallback?.();
		expect(await reconciliation).toBe("idle");
		fake.emit({ type: "status", seq: 2, state: "streaming", streaming: true });

		expect(backend.getTelemetry()).toBeNull();
		expect(backend.stop(() => undefined)).toBe(false);
	});

	test("start connects, subscribes, and sends the serialized config", async () => {
		const { backend, fake } = makeBackend();
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settle();

		const ops = fake.calls.map((c) => c.op);
		expect(ops).toContain("subscribe-events");
		expect(ops).toContain("start");

		const startCall = fake.calls.find((c) => c.op === "start");
		const params = startCall?.params as {
			srt: { host: string; port: number; streamid?: string };
			bitrate: { max_bitrate: number };
			pipeline: string;
		};
		expect(params.srt.host).toBe("127.0.0.1");
		expect(params.srt.port).toBe(9000);
		expect(params.srt.streamid).toBe("stream-1");
		expect(params.bitrate.max_bitrate).toBe(8000);
		expect(params.pipeline).toBe("h264_hdmi_1080p");
	});

	test("stop interrupts an in-flight start instead of waiting behind its queue", async () => {
		// Given an accepted start request whose reply remains in flight.
		const startGate = deferred<StartResult>();
		const { backend, fake } = makeBackend({
			fakeOptions: { startGate: startGate.promise },
		});
		const starting = backend.start(STREAM_CONFIG, RUN_OPTS);
		const startFailure = starting.catch((error: unknown) => error);
		await fake.started;
		let stopped = false;

		// When lifecycle cleanup requests a stop before that start reply settles.
		expect(backend.stop(() => (stopped = true))).toBe(true);
		await waitFor(() => stopped);

		// Then stop reaches the engine immediately instead of joining behind start.
		expect(fake.calls.map((call) => call.op)).toContain("stop");
		expect(stopped).toBe(true);
		expect(await startFailure).toMatchObject({
			failure: { phase: "start-rpc", class: "engine_internal" },
		});
		await backend.settle();
		expect(backend.stop(() => undefined)).toBe(false);
	});

	test("a starting reply remains pending until an authoritative streaming status event", async () => {
		const { backend, fake } = makeBackend({
			fakeOptions: {
				startResult: { session_id: "s-starting", state: "starting" },
			},
		});
		const start = backend.start(STREAM_CONFIG, RUN_OPTS);
		await fake.started;
		let settled = false;
		void start.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Bun.sleep(0);

		expect(settled).toBe(false);
		fake.emit({ type: "status", seq: 1, state: "streaming", streaming: true });
		await start;
		expect(settled).toBe(true);
	});

	test("a starting reply without a streaming heartbeat times out in playing-wait and rolls back", async () => {
		const clock = fakeDeadlineTimers();
		const { backend, fake } = makeBackend({
			fakeOptions: {
				startResult: { session_id: "s-starting", state: "starting" },
			},
		});
		const transaction = createLaunchTransaction("attempt-playing-timeout", {
			timers: clock.timers,
		});
		const start = backend.start(STREAM_CONFIG, RUN_OPTS, transaction);
		await fake.started;
		await waitFor(
			() => clock.delay() === START_PHASE_DEADLINES_MS["playing-wait"],
		);
		clock.fire();

		await expect(start).rejects.toMatchObject({
			failure: {
				attemptId: "attempt-playing-timeout",
				phase: "playing-wait",
				class: "start_timeout",
			},
		});
		expect(
			fake.calls
				.map((call) => call.op)
				.filter((op) => ["stop", "unsubscribe", "close"].includes(op)),
		).toEqual(["stop", "unsubscribe", "close"]);
		expect(fake.calls.filter((call) => call.op === "close")).toHaveLength(1);
		expect(fake.calls.filter((call) => call.op === "unsubscribe")).toHaveLength(
			1,
		);
		expect(backend.stop(() => undefined)).toBe(false);
	});

	test("a client acquired after the connect deadline is immediately closed with no ownership residue", async () => {
		const clock = fakeDeadlineTimers();
		const lateClient = deferred<CerastreamClient>();
		const harness = makeBackend({ connect: () => lateClient.promise });
		const transaction = createLaunchTransaction("attempt-late-connect", {
			timers: clock.timers,
		});
		const start = harness.backend.start(STREAM_CONFIG, RUN_OPTS, transaction);
		await waitFor(() => clock.delay() === START_PHASE_DEADLINES_MS.connect);
		clock.fire();
		await expect(start).rejects.toMatchObject({
			failure: { phase: "connect", class: "start_timeout" },
		});

		lateClient.resolve(harness.fake.client);
		await waitFor(() => harness.fake.calls.some((call) => call.op === "close"));
		expect(
			harness.fake.calls.filter((call) => call.op === "close"),
		).toHaveLength(1);
		expect(
			harness.fake.calls.some((call) => call.op === "subscribe-events"),
		).toBe(false);
		expect(harness.backend.stop(() => undefined)).toBe(false);
	});

	test("a subscription acquired after its deadline is immediately closed with no ownership residue", async () => {
		const clock = fakeDeadlineTimers();
		const subscribeGate = deferred<void>();
		const harness = makeBackend({
			fakeOptions: { subscribeGate: subscribeGate.promise },
		});
		const transaction = createLaunchTransaction("attempt-late-subscribe", {
			timers: clock.timers,
		});
		const start = harness.backend.start(STREAM_CONFIG, RUN_OPTS, transaction);
		await harness.fake.subscribed;
		await waitFor(() => clock.delay() === START_PHASE_DEADLINES_MS.subscribe);
		clock.fire();
		await expect(start).rejects.toMatchObject({
			failure: { phase: "subscribe", class: "start_timeout" },
		});

		subscribeGate.resolve(undefined);
		await waitFor(() =>
			harness.fake.calls.some((call) => call.op === "unsubscribe"),
		);
		expect(
			harness.fake.calls.filter((call) => call.op === "close"),
		).toHaveLength(1);
		expect(
			harness.fake.calls.filter((call) => call.op === "unsubscribe"),
		).toHaveLength(1);
		expect(harness.fake.calls.some((call) => call.op === "start")).toBe(false);
		expect(harness.backend.stop(() => undefined)).toBe(false);
	});

	test("setBitrate persists and pushes the value over IPC while streaming", async () => {
		const { backend, fake, config, saveCount } = makeBackend();
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settle();

		const applied = backend.setBitrate({ max_br: 9000 });
		expect(applied).toBe(9000);
		await backend.settle();

		expect(config.max_br).toBe(9000);
		expect(saveCount()).toBeGreaterThan(0);
		const sb = fake.calls.find((c) => c.op === "set-bitrate");
		expect((sb?.params as { max_bitrate: number }).max_bitrate).toBe(9000);
	});

	test("setBitrate persists without IPC when not streaming", async () => {
		const { backend, fake, config } = makeBackend();
		const applied = backend.setBitrate({ max_br: 7000 });
		expect(applied).toBe(7000);
		await backend.settle();

		expect(config.max_br).toBe(7000);
		expect(fake.calls.find((c) => c.op === "set-bitrate")).toBeUndefined();
	});

	test("setBitrate rejects an out-of-window value without a write", () => {
		const { backend, config } = makeBackend();
		const applied = backend.setBitrate({ max_br: 999_999 });
		expect(applied).toBeUndefined();
		expect(config.max_br).toBe(8000);
	});

	test("stop on an idle engine reports not-found and never signals onStopped", async () => {
		const { backend } = makeBackend();
		let stopped = false;
		const found = backend.stop(() => {
			stopped = true;
		});
		await backend.settle();
		expect(found).toBe(false);
		expect(stopped).toBe(false);
	});

	test("start then stop tears down the session and signals onStopped", async () => {
		const { backend, fake } = makeBackend();
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settle();

		let stopped = false;
		const found = backend.stop(() => {
			stopped = true;
		});
		expect(found).toBe(true);
		await backend.settle();

		expect(stopped).toBe(true);
		expect(fake.calls.map((c) => c.op)).toContain("stop");
		expect(fake.calls.map((c) => c.op)).toContain("close");
	});

	test("onError fans the raw structured error out to registered listeners", () => {
		const { backend } = makeBackend();
		const seen: Array<string> = [];
		backend.onError((raw) => seen.push(raw));

		backend.handleEvent(errorEvent("pipeline_stall", "engine"));
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("pipeline_stall");
	});

	test("getTelemetry exposes the latest snapshot from reserved hook", () => {
		const { backend } = makeBackend();
		expect(backend.getTelemetry()).toBeNull();

		backend.handleEvent({
			type: "srt-stats",
			seq: 0,
			rtt_ms: 12,
			send_buffer: 100,
			pkt_loss: 0.1,
		});
		const telemetry = backend.getTelemetry() as { srt: { rtt_ms: number } };
		expect(telemetry.srt.rtt_ms).toBe(12);
	});
});

// ---------------------------------------------------------------------------
// Structured error mapping (the Task-7 table swap — no stderr regex).
// ---------------------------------------------------------------------------

describe("CerastreamBackend error mapping", () => {
	test("maps an engine error code to the Task-7 user message", () => {
		const { backend, bridgeH } = makeBackend();
		backend.handleEvent(errorEvent("pipeline_stall", "engine"));

		expect(bridgeH.notifications).toHaveLength(1);
		expect(bridgeH.notifications[0]).toEqual({
			name: "cerastream",
			msg: "The input source has stalled. No automatic restart is scheduled.",
		});
	});

	test("routes an srtla-sourced error onto the srtla channel", () => {
		const { backend, bridgeH } = makeBackend();
		backend.handleEvent(errorEvent("srtla_no_connections", "srtla"));

		expect(bridgeH.notifications[0]).toEqual({
			name: "srtla",
			msg: "All SRTLA links are down. The sender is reconnecting its links.",
		});
	});

	test("folds the structured reason into the srt-connect message", () => {
		const { backend, bridgeH } = makeBackend();
		backend.handleEvent({
			type: "error",
			seq: 0,
			code: "srt_connect_failed",
			source: "engine",
			reason: "Connection timed out",
		});

		expect(bridgeH.notifications[0]?.msg).toBe(
			"Failed to connect to the SRT server (Connection timed out). No automatic retry is scheduled.",
		);
	});

	test("suppresses the SRT error when an srtla error is already on screen", () => {
		const { backend, bridgeH } = makeBackend();
		bridgeH.srtlaNotified.value = true;

		backend.handleEvent(errorEvent("srt_connect_failed", "engine"));
		expect(bridgeH.notifications).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Telemetry / device events bridged to status broadcasts.
// ---------------------------------------------------------------------------

describe("CerastreamBackend status bridge", () => {
	test("telemetry, device, and status events each nudge a status broadcast", () => {
		const { backend, bridgeH } = makeBackend();

		backend.handleEvent({
			type: "srt-stats",
			seq: 0,
			rtt_ms: 5,
			send_buffer: 10,
			pkt_loss: 0,
		});
		backend.handleEvent({
			type: "device",
			seq: 1,
			change: "added",
			device: CAPTURE_DEVICE,
		});
		backend.handleEvent({
			type: "status",
			seq: 2,
			state: "streaming",
			streaming: true,
		});

		expect(bridgeH.broadcasts.count).toBe(3);
	});

	test("a preview event is not bridged to status", () => {
		const { backend, bridgeH } = makeBackend();
		backend.handleEvent({
			type: "preview",
			seq: 0,
			session_id: "p1",
			phase: "active",
		});
		expect(bridgeH.broadcasts.count).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Additive cerastream-only RPC passthroughs (switchInput / listDevices).
// ---------------------------------------------------------------------------

describe("CerastreamBackend RPC passthroughs", () => {
	test("switchInput and listDevices proxy to the control client", async () => {
		const { backend, fake } = makeBackend();
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settle();

		const switched = await backend.switchInput({
			input_id: "cam2",
			mode: "manual",
		});
		expect(switched.active_input).toBe("cam2");
		expect(fake.calls.some((c) => c.op === "switch-input")).toBe(true);

		const devices = await backend.listDevices();
		expect(devices.devices).toHaveLength(1);
	});

	test("a passthrough without an active connection rejects", async () => {
		const { backend } = makeBackend();
		await expect(backend.listDevices()).rejects.toThrow();
	});

	test("switchAudio dispatches switch-audio and returns the active audio input", async () => {
		const { backend, fake } = makeBackend();
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settle();

		const result = await backend.switchAudio({
			audio_input_id: "audio:mic1",
			mode: "manual",
		});
		expect(result.active_audio_input).toBe("audio:mic1");
		expect(fake.calls.some((c) => c.op === "switch-audio")).toBe(true);
	});

	test("reloadAudioDelay applies the audio delay via reload-config", async () => {
		const { backend, fake } = makeBackend();
		await backend.start(STREAM_CONFIG, RUN_OPTS);
		await backend.settle();

		const applied = await backend.reloadAudioDelay(120);
		expect(applied.applied.audio?.delay_ms).toBe(120);
		expect(
			fake.calls.some(
				(c) =>
					c.op === "reload-config" &&
					(c.params as { audio?: { delay_ms?: number } }).audio?.delay_ms ===
						120,
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Engine crash — a failed control connection notifies, then leaves no session.
// ---------------------------------------------------------------------------

describe("CerastreamBackend engine crash", () => {
	test("successful start resolves only after the engine confirms streaming", async () => {
		const { backend, fake } = makeBackend();
		let confirmStart: (() => void) | undefined;
		let markStartEntered: (() => void) | undefined;
		const startEntered = new Promise<void>((resolve) => {
			markStartEntered = resolve;
		});
		let settled = false;
		fake.client.start = (params) => {
			fake.calls.push({ op: "start", params });
			markStartEntered?.();
			return new Promise((resolve) => {
				confirmStart = () => resolve({ session_id: "s1", state: "streaming" });
			});
		};
		const starting = backend.start(STREAM_CONFIG, RUN_OPTS).then(() => {
			settled = true;
		});
		await startEntered;

		expect(settled).toBe(false);
		confirmStart?.();
		await starting;
		expect(settled).toBe(true);
	});

	test("a close between hello and start RPC returns one failure and closes the client", async () => {
		const { backend, fake } = makeBackend();
		fake.client.subscribeEvents = async () => {
			throw new CerastreamConnectionError(
				"connection lost before subscription",
				undefined,
				"lost",
			);
		};

		await expect(backend.start(STREAM_CONFIG, RUN_OPTS)).rejects.toMatchObject({
			failure: { phase: "subscribe", class: "engine_unavailable" },
		});
		await backend.settle();

		expect(fake.calls.map((call) => call.op)).not.toContain("start");
		expect(fake.calls.filter((call) => call.op === "close")).toHaveLength(1);
	});

	test("a post-subscribe start failure closes the subscription and client", async () => {
		// Given the current backend has connected and subscribed before start fails.
		const { backend, fake } = makeBackend();
		fake.client.start = async (params) => {
			fake.calls.push({ op: "start", params });
			throw new Error("engine refused start after subscribe");
		};

		// When the engine rejects the start RPC.
		await expect(backend.start(STREAM_CONFIG, RUN_OPTS)).rejects.toMatchObject({
			failure: { phase: "start-rpc", class: "engine_internal" },
		});
		await backend.settle();

		// Then rollback releases both acquired IPC resources.
		expect(fake.calls.map((call) => call.op)).toContain("unsubscribe");
		expect(fake.calls.map((call) => call.op)).toContain("close");
		expect(backend.stop(() => {})).toBe(false);
	});

	test("a connect failure defers notification policy to the session orchestrator", async () => {
		const { backend, bridgeH } = makeBackend({
			connect: async () => {
				throw new CerastreamConnectionError(
					"cerastream control socket unreachable",
					undefined,
					"refused",
				);
			},
		});

		await expect(backend.start(STREAM_CONFIG, RUN_OPTS)).rejects.toMatchObject({
			failure: { phase: "connect", class: "engine_unavailable" },
		});
		await backend.settle();

		expect(bridgeH.notifications).toEqual([]);

		const found = backend.stop(() => {});
		expect(found).toBe(false);
	});

	test("combined binding errors classify transport as connect and handshake as hello", () => {
		expect(
			classifyConnectHandshakePhase(
				new CerastreamConnectionError("refused", undefined, "refused"),
			),
		).toBe("connect");
		expect(
			classifyConnectHandshakePhase(
				new CerastreamRpcError(
					-32000,
					"unsupported",
					"cerastream.protocol.unsupported_version",
					null,
				),
			),
		).toBe("hello");
		expect(
			classifyConnectHandshakePhase(
				new CerastreamTimeoutError("hello", 10_000),
			),
		).toBe("hello");
	});
});

function errorEvent(
	code: RuntimeErrorCode,
	source: "srtla" | "engine",
): EventParams {
	return { type: "error", seq: 0, code, source };
}

type RuntimeErrorCode = Extract<EventParams, { type: "error" }>["code"];
