import { describe, expect, test } from "bun:test";

import type {
	CerastreamClient,
	EventParams,
	SwitchInputResult,
} from "@ceralive/cerastream";
import {
	CerastreamConnectionError,
	CerastreamRpcError,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";

// Wave H, live device: `cerastream.service` restarted WHILE CeraUI believed a
// session was active. The published client is dialled with autoReconnect off and
// exposes no close event, so `this.client` stayed in place, permanently dead —
// three consecutive `switchInput` calls rejected with "control connection is not
// open", `reconcileRuntimeState()` kept re-affirming "streaming" off stale
// telemetry (it trusts `client !== undefined`), and only a full
// `systemctl restart ceralive.service` recovered the board.
//
// These cases pin the seam that fixes it: a CerastreamConnectionError from the
// CURRENT session's client retires the session exactly once, and the NEXT start
// dials a brand-new connection and succeeds.

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "stream-1",
};

const STREAM_CONFIG: RuntimeConfig = {
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
	pipeline: "h264_hdmi_1080p",
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

const DEAD_CONNECTION = (): CerastreamConnectionError =>
	new CerastreamConnectionError(
		"control connection is not open",
		undefined,
		"closed",
	);

interface FakeClient {
	client: CerastreamClient;
	calls: string[];
	emit(event: EventParams): void;
	/** Every later RPC on this instance rejects, as a dropped socket really does. */
	killConnection(): void;
	subscriptionClosed(): boolean;
}

function makeFakeClient(): FakeClient {
	const calls: string[] = [];
	let listener: ((event: EventParams) => void) | undefined;
	let dead = false;
	let subClosed = false;

	const guard = <Result>(op: string, result: Result): Promise<Result> => {
		calls.push(op);
		if (dead) return Promise.reject(DEAD_CONNECTION());
		return Promise.resolve(result);
	};

	const client: CerastreamClient = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.9.0",
			engine_version: "test",
		},
		start: async () => guard("start", { session_id: "s1", state: "streaming" }),
		stop: async () => guard("stop", { state: "idle" }),
		reloadConfig: async (params) => guard("reload-config", { applied: params }),
		setBitrate: async (params) =>
			guard("set-bitrate", { applied: { max_bitrate: params.max_bitrate } }),
		switchInput: async (params) =>
			guard<SwitchInputResult>("switch-input", {
				active_input: params.input_id,
				mode: params.mode,
			}),
		listDevices: async () => guard("list-devices", { devices: [] }),
		getCapabilities: async () =>
			guard("get-capabilities", {
				platform: {
					supports_h265: true,
					hardware_accelerated: true,
					max_resolution: "1920x1080",
				},
				encoder: {
					codecs: ["h264"],
					bitrate_range: { min: 500, max: 50_000, unit: "kbps" as const },
				},
				sources: [],
			}),
		subscribeEvents: async (_params, eventListener) => {
			calls.push("subscribe-events");
			listener = eventListener;
			return {
				result: { subscribed: ["status"] },
				close: () => {
					subClosed = true;
				},
			};
		},
		previewSession: async () =>
			guard("preview-session", {
				session_id: "p1",
				tier: "webcodecs" as const,
				transport: {
					kind: "uds-binary" as const,
					socket: "/run/cerastream/preview.sock",
				},
			}),
		close: async () => {
			calls.push("close");
		},
	};
	// The backend dispatches `start` (and `switch-audio`) over the raw JSON-RPC
	// primitive whenever the engine advertises the additive fields, so the fake
	// has to answer a real start result here too.
	(client as unknown as Record<string, unknown>).rawRequest = async (
		method: string,
	) =>
		guard(
			method,
			method === "start" ? { session_id: "s1", state: "streaming" } : {},
		);

	return {
		client,
		calls,
		emit: (event) => listener?.(event),
		killConnection: () => {
			dead = true;
		},
		subscriptionClosed: () => subClosed,
	};
}

interface Harness {
	backend: CerastreamBackend;
	clients: FakeClient[];
	connectCount: () => number;
	lostSites: string[];
	broadcasts: () => number;
}

function makeHarness(): Harness {
	const clients: FakeClient[] = [];
	const lostSites: string[] = [];
	let connects = 0;
	let broadcasts = 0;
	const backend = new CerastreamBackend({
		connect: async () => {
			connects += 1;
			const next = makeFakeClient();
			clients.push(next);
			return next.client;
		},
		connectOptions: {},
		getConfig: () => STREAM_CONFIG,
		saveConfig: () => undefined,
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => {
				broadcasts += 1;
			},
			broadcastBuffering: () => undefined,
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-connection-loss.json",
		logger: silentLogger,
		onSessionConnectionLost: (site) => {
			lostSites.push(site);
		},
	});
	return {
		backend,
		clients,
		connectCount: () => connects,
		lostSites,
		broadcasts: () => broadcasts,
	};
}

function liveSession(h: Harness): FakeClient {
	const session = h.clients[0];
	if (session === undefined) throw new Error("no session client was connected");
	return session;
}

describe("engine restart mid-session — the session control connection is the session", () => {
	test("a switchInput onto a dead connection retires the session exactly once", async () => {
		const h = makeHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		const session = liveSession(h);

		session.killConnection();

		await expect(
			h.backend.switchInput({ input_id: "cam2", mode: "manual" }),
		).rejects.toThrow("control connection is not open");

		expect(h.lostSites).toEqual(["switch-input"]);
		expect(session.subscriptionClosed()).toBe(true);
		expect(h.backend.getTelemetry()).toBeNull();

		// The dead client is gone, so the next call fails fast at the seam instead
		// of re-dispatching onto a socket that will never answer — and the session
		// is NOT retired a second time.
		await expect(
			h.backend.switchInput({ input_id: "cam3", mode: "manual" }),
		).rejects.toThrow("no active control connection");
		expect(h.lostSites).toEqual(["switch-input"]);
	});

	test("the device-registry poll detects the loss without any operator action", async () => {
		const h = makeHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		liveSession(h).killConnection();

		// listDevicesIfActive is the registry's every-few-seconds poll; it degrades
		// to null by contract, but it must still report the loss.
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();
		expect(h.lostSites).toEqual(["list-devices-poll"]);
	});

	test("a fresh start after the loss dials a NEW connection and succeeds", async () => {
		const h = makeHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		liveSession(h).killConnection();
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();

		// The operator's recovery path: stop, then start. Both must work against an
		// engine CeraUI can no longer reach through the retired client.
		await new Promise<void>((resolve) => {
			h.backend.stop(resolve);
		});
		await h.backend.settle();

		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();

		expect(h.connectCount()).toBe(2);
		const revived = h.clients[1];
		expect(revived?.calls).toContain("start");
		await expect(
			h.backend.switchInput({ input_id: "cam2", mode: "manual" }),
		).resolves.toMatchObject({ active_input: "cam2" });
	});

	test("reconciliation stops re-affirming a phantom session from stale telemetry", async () => {
		const h = makeHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		const session = liveSession(h);

		// A real streaming heartbeat lands, so telemetry says "streaming"…
		session.emit({
			type: "status",
			seq: 1,
			state: "streaming",
			streaming: true,
		} as EventParams);
		expect(await h.backend.reconcileRuntimeState()).toBe("streaming");

		// …then the engine goes away. The stale snapshot must no longer be able to
		// re-affirm itself: reconciliation has to go back to the engine.
		session.killConnection();
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();

		const reconciled = await h.backend.reconcileRuntimeState();
		expect(reconciled).not.toBe("streaming");
		expect(h.connectCount()).toBe(2);
	});

	test("the retired session leaves the orchestrator able to admit a new start", async () => {
		const h = makeHarness();
		let streaming = false;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => "att_reconnect",
			setStreamingStatus: (next) => {
				streaming = next;
			},
			getStreamingStatus: () => streaming,
			stopRuntime: async () => {
				await new Promise<void>((resolve) => {
					h.backend.stop(resolve);
				});
			},
			queryRuntime: () => h.backend.reconcileRuntimeState(),
		});

		const first = await orchestrator.start({
			origin: "ui",
			launch: async () => {
				await h.backend.start(STREAM_CONFIG, RUN_OPTS);
				await h.backend.settle();
			},
		});
		expect(first.result).toBe("started");
		expect(streaming).toBe(true);

		liveSession(h).killConnection();
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();
		expect(h.lostSites).toHaveLength(1);

		// The production hook routes into exactly this stop; drive it here so the
		// assertion is on the orchestrator's own recovery, not on the wiring.
		await orchestrator.stop("engine_loss");
		expect(streaming).toBe(false);
		expect(orchestrator.snapshot().state).toBe("idle");

		const second = await orchestrator.start({
			origin: "ui",
			launch: async () => {
				await h.backend.start(STREAM_CONFIG, RUN_OPTS);
				await h.backend.settle();
			},
		});
		expect(second.result).toBe("started");
	});
});

describe("what is NOT proof that the connection died", () => {
	test("an engine RPC error leaves the session and its client intact", async () => {
		const h = makeHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		const session = liveSession(h);
		const original = session.client.switchInput;
		session.client.switchInput = async () => {
			throw new CerastreamRpcError(
				-32003,
				"device not found",
				"cerastream.device.not_found",
				1,
			);
		};

		await expect(
			h.backend.switchInput({ input_id: "gone", mode: "manual" }),
		).rejects.toThrow("device not found");
		expect(h.lostSites).toEqual([]);
		expect(session.subscriptionClosed()).toBe(false);

		session.client.switchInput = original;
		await expect(
			h.backend.switchInput({ input_id: "cam2", mode: "manual" }),
		).resolves.toMatchObject({ active_input: "cam2" });
	});

	test("an operator stop is never reported as an unexpected connection loss", async () => {
		const h = makeHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		// A real client rejects every pending request with a connection error when
		// it is closed on purpose; that must stay invisible to this seam.
		liveSession(h).killConnection();

		await new Promise<void>((resolve) => {
			h.backend.stop(resolve);
		});
		await h.backend.settle();
		expect(h.lostSites).toEqual([]);
	});
});
