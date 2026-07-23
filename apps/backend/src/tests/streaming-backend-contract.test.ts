import { describe, expect, test } from "bun:test";

import type {
	CaptureDevice,
	CerastreamClient,
	EventParams,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
	cerastreamBackend,
} from "../modules/streaming/cerastream-backend.ts";
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
	emit(event: EventParams): void;
}

function makeFakeClient(): FakeClientHarness {
	const calls: Array<{ op: string; params?: unknown }> = [];
	let listener: ((event: EventParams) => void) | undefined;
	let resolveSubscribed: (() => void) | undefined;
	const subscribed = new Promise<void>((resolve) => {
		resolveSubscribed = resolve;
	});
	const client: CerastreamClient = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "test",
			engine_version: "test",
		},
		start: async (params) => {
			calls.push({ op: "start", params });
			return { session_id: "s1", state: "streaming" };
		},
		stop: async (params) => {
			calls.push({ op: "stop", params });
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
		emit: (event) => listener?.(event),
	};
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
	} = {},
): BackendHarness {
	const fake = makeFakeClient();
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
	test("reconciliation adopts an engine-held stream", async () => {
		// Given a fresh backend connected to an engine whose session survived it.
		const { backend, fake } = makeBackend();
		const reconciliation = backend.reconcileRuntimeState();
		await fake.subscribed;

		// When the subscribed engine reports its actual streaming state.
		fake.emit({ type: "status", seq: 1, state: "streaming", streaming: true });

		// Then the backend adopts the client and can stop the existing runtime.
		expect(await reconciliation).toBe(true);
		let stopped = false;
		expect(backend.stop(() => (stopped = true))).toBe(true);
		await backend.settle();
		expect(stopped).toBe(true);
		expect(fake.calls.map((call) => call.op)).toContain("stop");
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
			msg: "The input source has stalled. Trying to restart...",
		});
	});

	test("routes an srtla-sourced error onto the srtla channel", () => {
		const { backend, bridgeH } = makeBackend();
		backend.handleEvent(errorEvent("srtla_no_connections", "srtla"));

		expect(bridgeH.notifications[0]).toEqual({
			name: "srtla",
			msg: "All SRTLA connections failed. Trying to reconnect...",
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
			"Failed to connect to the SRT server (Connection timed out). Retrying...",
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
	test("a connect failure on start surfaces a notification and clears the session", async () => {
		const { backend, bridgeH } = makeBackend({
			connect: async () => {
				throw new Error("cerastream control socket unreachable");
			},
		});

		await expect(backend.start(STREAM_CONFIG, RUN_OPTS)).rejects.toThrow(
			"cerastream control socket unreachable",
		);
		await backend.settle();

		expect(
			bridgeH.notifications.some(
				(n) => n.name === "cerastream" && n.msg.includes("failed to start"),
			),
		).toBe(true);

		const found = backend.stop(() => {});
		expect(found).toBe(false);
	});
});

function errorEvent(
	code: RuntimeErrorCode,
	source: "srtla" | "engine",
): EventParams {
	return { type: "error", seq: 0, code, source };
}

type RuntimeErrorCode = Extract<EventParams, { type: "error" }>["code"];
