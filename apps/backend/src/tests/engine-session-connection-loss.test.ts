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
import {
	initEngineConnection,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";
import { manualReconciliationDeadline } from "./helpers/reconciliation-deadline.ts";

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
	const unused = async (): Promise<never> => {
		throw new Error("Unexpected RPC in connection-loss fixture");
	};

	const client: CerastreamClient = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.9.0",
			engine_version: "test",
		},
		start: async () => guard("start", { session_id: "s1", state: "streaming" }),
		prepareStart: unused,
		cancelStart: unused,
		stop: async () => guard("stop", { state: "idle" }),
		reloadConfig: async (params) => guard("reload-config", { applied: params }),
		setBitrate: async (params) =>
			guard("set-bitrate", { applied: { max_bitrate: params.max_bitrate } }),
		requestKeyframe: unused,
		setAudioMix: unused,
		setEdidProfile: unused,
		listSwitchTargets: unused,
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
		changeConfig: async () =>
			guard("change-config", {
				attempt_id: "change-1",
				phase: "applied" as const,
				state: "streaming" as const,
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

function makeHarness(
	scheduleTimeout?: CerastreamBackendDeps["scheduleTimeout"],
): Harness {
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
		...(scheduleTimeout ? { scheduleTimeout } : {}),
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
		const session = liveSession(h);
		session.killConnection();

		// listDevicesIfActive is the registry's every-few-seconds poll; it degrades
		// to null by contract, but it must still report the loss.
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();
		expect(h.lostSites).toEqual(["list-devices-poll"]);
		expect(session.calls.filter((call) => call === "close")).toEqual(["close"]);
	});

	test("a fresh start after the loss dials a NEW connection and succeeds", async () => {
		const h = makeHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		liveSession(h).killConnection();
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();

		// The operator's recovery path: stop on an independent connection, then
		// start on another. Neither may reuse the retired session client.
		await h.backend.confirmStop();
		await h.backend.settle();

		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();

		expect(h.connectCount()).toBe(3);
		const stopClient = h.clients[1];
		expect(stopClient?.calls).toContain("stop");
		expect(stopClient?.calls).not.toContain("start");
		const revived = h.clients[2];
		expect(revived?.calls).toContain("start");
		await expect(
			h.backend.switchInput({ input_id: "cam2", mode: "manual" }),
		).resolves.toMatchObject({ active_input: "cam2" });
	});

	test("reconciliation stops re-affirming a phantom session from stale telemetry", async () => {
		const deadline = manualReconciliationDeadline();
		const h = makeHarness(deadline.scheduleTimeout);
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

		const reconciled = await deadline.expireDuring(() =>
			h.backend.reconcileRuntimeState(),
		);
		expect(reconciled).not.toBe("streaming");
		expect(h.connectCount()).toBe(2);
	});

	test("the retired session leaves the orchestrator able to admit a new start", async () => {
		const deadline = manualReconciliationDeadline();
		const h = makeHarness(deadline.scheduleTimeout);
		let streaming = false;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => "att_reconnect",
			setStreamingStatus: (next) => {
				streaming = next;
			},
			getStreamingStatus: () => streaming,
			queryRuntime: () => h.backend.reconcileRuntimeState(),
			stopRuntime: () => h.backend.confirmStop(),
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

		const retire: unknown = Reflect.get(orchestrator, "retireLostSession");
		if (typeof retire === "function") await retire();
		expect(orchestrator.streamLiveness()).toBe("unknown");
		expect(await deadline.expireDuring(() => orchestrator.reconcile())).toBe(
			"reconciling",
		);
		expect(streaming).toBe(true);
		expect(await orchestrator.stop("operator")).toEqual({ result: "stopped" });
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

test.each(["operator Stop", "runtime observation"] as const)(
	"%s waits for local control-loss retirement",
	async (contender) => {
		const cleanup = Promise.withResolvers<void>();
		const dispatched: string[] = [];
		let streaming = false;
		const retirement = { retireRuntime: () => cleanup.promise };
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "att_retirement_overlap",
			setStreamingStatus: (value) => {
				streaming = value;
			},
			getStreamingStatus: () => streaming,
			...retirement,
			stopRuntime: async () => {
				dispatched.push("stop");
			},
			queryRuntime: async () => {
				dispatched.push("read");
				return "idle";
			},
		});
		expect(
			(await session.start({ origin: "ui", launch: async () => {} })).result,
		).toBe("started");
		dispatched.length = 0;

		// Pinned main drives loss through the old automatic Stop.
		const retiring =
			"retireLostSession" in session &&
			typeof session.retireLostSession === "function"
				? session.retireLostSession()
				: session.stop("engine_loss");
		let stopping: ReturnType<typeof session.stop> | undefined;
		try {
			if (contender === "operator Stop") stopping = session.stop("operator");
			else {
				expect(await session.reconcile()).toBe("reconciling");
				expect(session.streamLiveness()).toBe("unknown");
			}
			expect(dispatched).toEqual([]);
		} finally {
			cleanup.resolve();
			await retiring;
			await stopping;
		}

		if (stopping !== undefined)
			expect(await stopping).toEqual({ result: "stopped" });
		else expect(await session.reconcile()).toBe("idle");
		expect(dispatched).toEqual([
			contender === "operator Stop" ? "stop" : "read",
		]);
		expect(session.streamLiveness()).toBe("idle");
	},
);

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

describe("a proven loss re-arms the engine reconnect", () => {
	function lossHarness() {
		const events: string[] = [];
		const clients: FakeClient[] = [];
		const backend = new CerastreamBackend({
			connect: async () => {
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
				broadcastStatus: () => {},
				broadcastBuffering: () => undefined,
			},
			execPath: "cerastream",
			configPath: "/tmp/cerastream-connection-loss.json",
			logger: silentLogger,
			onSessionConnectionLost: (site) => {
				events.push(`lost:${site}`);
			},
			...{
				onEngineUnreachable: (site: string) => {
					events.push(`unreachable:${site}`);
				},
			},
		});
		return { backend, events, clients };
	}

	test("a dead control connection retires the session, then re-arms, once", async () => {
		const h = lossHarness();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		h.clients[0]?.killConnection();
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();
		await expect(h.backend.listDevicesIfActive()).resolves.toBeNull();
		expect(h.events).toEqual([
			"lost:list-devices-poll",
			"unreachable:list-devices-poll",
		]);
	});

	test("without an injected hook, the loss re-arms the real reconnect loop", async () => {
		// The production binding: no `onEngineUnreachable` in the deps.
		const timers: Array<() => void> = [];
		let reachable = true;
		await initEngineConnection({
			refreshCapabilities: async () => {},
			isEngineReachable: () => reachable,
			broadcastEngineState: () => {},
			...{
				publishEngineAvailability: () => {},
				broadcastEngineOffline: () => {},
			},
			reportEngineState: () => {},
			logger: silentLogger,
			setTimer: (fn) => {
				timers.push(fn);
				return timers.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {},
		});
		try {
			expect(timers).toHaveLength(0);
			const lostSites: string[] = [];
			const fake = makeFakeClient();
			const backend = new CerastreamBackend({
				connect: async () => fake.client,
				connectOptions: {},
				getConfig: () => STREAM_CONFIG,
				saveConfig: () => undefined,
				bridge: {
					notify: () => undefined,
					notificationExists: () => false,
					removeNotification: () => {},
					broadcastStatus: () => {},
					broadcastBuffering: () => undefined,
				},
				execPath: "cerastream",
				configPath: "/tmp/cerastream-connection-loss.json",
				logger: silentLogger,
				onSessionConnectionLost: (site) => {
					lostSites.push(site);
				},
			});
			await backend.start(STREAM_CONFIG, RUN_OPTS);
			await backend.settle();
			reachable = false;
			fake.killConnection();
			await expect(backend.listDevicesIfActive()).resolves.toBeNull();
			expect(lostSites).toEqual(["list-devices-poll"]);
			expect(timers).toHaveLength(1);
		} finally {
			stopEngineReconnect();
		}
	});
});
