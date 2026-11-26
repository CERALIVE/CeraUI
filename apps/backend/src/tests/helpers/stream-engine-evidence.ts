import type {
	CerastreamClient,
	EventParams,
	StartParams,
} from "@ceralive/cerastream";
import {
	CerastreamRpcError,
	CerastreamTimeoutError,
} from "@ceralive/cerastream";
import type { LifecycleState } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { ENGINE_STATE_RECONCILE_TIMEOUT } from "../../helpers/timing-constants.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../../modules/streaming/cerastream-backend.ts";
import { createLaunchTransaction } from "../../modules/streaming/launch-transaction.ts";
import { createStreamSessionOrchestrator } from "../../modules/streaming/stream-session-orchestrator.ts";

const config = {
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
	pipeline: "test",
} satisfies RuntimeConfig;
const options = {
	pipeline: "test",
	host: "127.0.0.1",
	port: 9000,
	streamid: "test",
};
const unused = async (): Promise<never> => {
	throw new Error("unexpected fake engine operation");
};

/** Engine truth changes at effect submission/ack, never from a production guard. */
export function evidenceHarness(
	protectedAtBoot = false,
	{
		schemaVersion = "0.1.0",
		connectPeer,
	}: {
		readonly schemaVersion?: string;
		readonly connectPeer?: CerastreamBackendDeps["connect"];
	} = {},
) {
	let engine: "idle" | "streaming" = "idle";
	let live = false;
	let marked = protectedAtBoot;
	let id = 0;
	let connection = 0;
	let failedStart = false;
	let startRefusal: Error | undefined;
	let lostStartReply: Error | undefined;
	let failedStop = false;
	let connectGate: Promise<void> | undefined;
	let startGate: Promise<void> | undefined;
	const started = Promise.withResolvers<void>();
	let subscribeGate: Promise<void> | undefined;
	let beforeDispatch: (() => void) | undefined;
	let failNextConnect = false;
	let statusSink:
		| ((
				event: Extract<EventParams, { type: "status" }>,
				current: () => boolean,
		  ) => void)
		| undefined;
	const connected = Promise.withResolvers<void>();
	const firstSubscription = Promise.withResolvers<void>();
	const clients: Array<{
		client: CerastreamClient;
		emit: (event: EventParams) => void;
		calls: string[];
		closed: Promise<void>;
	}> = [];
	const startRequests: StartParams[] = [];
	const lifecycle: LifecycleState[] = [];
	const adopted = Promise.withResolvers<void>();
	const settledIdle = Promise.withResolvers<void>();
	const probeSubscribed = Promise.withResolvers<void>();
	const probeDeadline = Promise.withResolvers<() => void>();
	const startDispatched = Promise.withResolvers<void>();
	const startSettled = Promise.withResolvers<void>();
	let externalMaxBitrate: number | undefined;
	const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
	const deadlines = new Map<ReturnType<typeof setTimeout>, number>();
	const schedule = (callback: () => void, ms: number) => {
		const timer = setTimeout(() => undefined, 60_000);
		timer.unref();
		timers.set(timer, callback);
		deadlines.set(timer, ms);
		if (ms === ENGINE_STATE_RECONCILE_TIMEOUT) probeDeadline.resolve(callback);
		return timer;
	};
	const cancel = (timer: ReturnType<typeof setTimeout> | number) => {
		if (typeof timer !== "number") {
			timers.delete(timer);
			deadlines.delete(timer);
		}
		clearTimeout(timer);
	};
	const connect = async () => {
		if (failNextConnect) {
			failNextConnect = false;
			throw new Error("fake engine connect failed");
		}
		const index = connection++;
		let listener: ((event: EventParams) => void) | undefined;
		const calls: string[] = [];
		const closed = Promise.withResolvers<void>();
		const start = async (params: StartParams) => {
			try {
				calls.push("start");
				startRequests.push(params);
				startDispatched.resolve();
				// A refusal changes nothing in the engine.
				if (startRefusal !== undefined) {
					if (index === 0) await startGate;
					throw startRefusal;
				}
				engine = "streaming";
				started.resolve();
				if (index === 0) await startGate;
				if (lostStartReply !== undefined) throw lostStartReply;
				if (failedStart) throw new CerastreamTimeoutError("start", 10_000);
				return { state: "streaming" as const, session_id: `session-${index}` };
			} finally {
				startSettled.resolve();
			}
		};
		const client: CerastreamClient = {
			hello: {
				protocol: "cerastream-ipc/1",
				schema_version: schemaVersion,
				engine_version: "fake",
			},
			start,
			prepareStart: unused,
			cancelStart: unused,
			// Newer schemas send Start through the raw request path.
			...(schemaVersion === "0.1.0"
				? {}
				: {
						rawRequest: async (method: string, params: StartParams) => {
							calls.push(`raw:${method}`);
							if (method !== "start") return unused();
							return start(params);
						},
					}),
			stop: async () => {
				calls.push("stop");
				if (failedStop) throw new Error("stop-ack-unavailable");
				engine = "idle";
				return { state: "idle" };
			},
			subscribeEvents: async (params, callback) => {
				calls.push("subscribe");
				listener = callback;
				if (index === 0) firstSubscription.resolve();
				if (index === 0) await subscribeGate;
				if (params?.topics?.includes("status")) probeSubscribed.resolve();
				return {
					result: { subscribed: ["status"] },
					close: () => {
						calls.push("unsubscribe");
					},
				};
			},
			close: async () => {
				calls.push("close");
				closed.resolve();
			},
			reloadConfig: unused,
			setBitrate: unused,
			setAudioMix: unused,
			requestKeyframe: unused,
			setEdidProfile: unused,
			listSwitchTargets: unused,
			switchInput: unused,
			listDevices: unused,
			getCapabilities: async () => ({
				platform: {
					supports_h265: false,
					hardware_accelerated: true,
					max_resolution: "1920x1080",
				},
				encoder: {
					codecs: ["h264"],
					bitrate_range: { min: 1, max: 8000, unit: "kbps" },
				},
				sources: [],
			}),
			changeConfig: unused,
			previewSession: unused,
		};
		clients.push({
			client,
			calls,
			closed: closed.promise,
			emit: (event) => listener?.(event),
		});
		connected.resolve();
		if (index === 0) await connectGate;
		return client;
	};
	const deps = {
		connect: connectPeer ?? connect,
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => undefined,
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => undefined,
			broadcastStatus: () => undefined,
			broadcastBuffering: () => undefined,
		},
		onEngineStatus: (
			event: Extract<EventParams, { type: "status" }>,
			current: () => boolean,
		) =>
			statusSink === undefined
				? session.noteEngineStatus(event)
				: statusSink(event, current),
		scheduleTimeout: schedule,
		cancelTimeout: cancel,
	};
	const backend = new CerastreamBackend(deps);
	const stopRuntime = () =>
		new Promise<void>((resolve, reject) => {
			if (!backend.stop(resolve, reject)) {
				// Operator Stop must work even when the backend owns no active client.
				void backend.confirmStop().then(resolve, reject);
			}
		});
	const session = createStreamSessionOrchestrator({
		initialLiveness: () => (marked ? "unknown" : "idle"),
		createAttemptId: () => `evidence-${++id}`,
		setStreamingStatus: (value) => {
			live = value;
			if (value) adopted.resolve();
		},
		setLifecycleState: (state) => {
			lifecycle.push(state);
		},
		getStreamingStatus: () => live,
		markStreamingForOta: () => {
			marked = true;
		},
		unmarkStreamingForOta: () => {
			marked = false;
			settledIdle.resolve();
		},
		queryRuntime: () => backend.reconcileRuntimeState(),
		stopRuntime,
		retryPolicy: {
			maxAttempts: 1,
			totalBudgetMs: 60_000,
			baseDelayMs: 1,
			maxDelayMs: 1,
			attemptTimeoutMs: 30_000,
		},
		scheduleTimeout: schedule,
		cancelTimeout: cancel,
		scheduleLaunchDeadline: schedule,
		cancelLaunchDeadline: cancel,
	});
	return {
		backend,
		connected: connected.promise,
		started: started.promise,
		startDispatched: startDispatched.promise,
		startSettled: startSettled.promise,
		adopted: adopted.promise,
		settledIdle: settledIdle.promise,
		probeSubscribed: probeSubscribed.promise,
		probeDeadline: probeDeadline.promise,
		session,
		clients,
		startRequests,
		lifecycle,
		timers,
		deadline: (ms: number) => {
			for (const [timer, delay] of deadlines)
				if (delay === ms) return timers.get(timer);
			return undefined;
		},
		start: (override: Partial<RuntimeConfig> = {}) => {
			const transaction = createLaunchTransaction("evidence", {
				timers: { schedule, cancel },
			});
			return session.start({
				origin: "ui",
				launch: () =>
					backend.start({ ...config, ...override }, options, {
						...transaction,
						runPhase: (phase, operation, errorPhase) => {
							if (phase === "start-rpc") beforeDispatch?.();
							return transaction.runPhase(phase, operation, errorPhase);
						},
					}),
			});
		},
		beforeStartDispatch: (action: () => void) => {
			beforeDispatch = action;
		},
		setStatusSink: (sink: typeof statusSink) => {
			statusSink = sink;
		},
		failNextConnect: () => {
			failNextConnect = true;
		},
		setEngine: (value: typeof engine) => {
			engine = value;
			if (value === "streaming") marked = true;
		},
		startExternal: (maxBitrate: number) => {
			engine = "streaming";
			externalMaxBitrate = maxBitrate;
		},
		externalMaxBitrate: () =>
			engine === "streaming" ? externalMaxBitrate : undefined,
		failStart: () => {
			failedStart = true;
		},
		refuseStart: (code: number, dataCode?: string) => {
			startRefusal = new CerastreamRpcError(code, "refused", dataCode, 1);
		},
		loseStartReply: (error: Error) => {
			lostStartReply = error;
		},
		failStop: () => {
			failedStop = true;
		},
		holdConnect: (gate: Promise<void>) => {
			connectGate = gate;
		},
		holdStart: (gate: Promise<void>) => {
			startGate = gate;
		},
		holdSubscribe: (gate: Promise<void>) => {
			subscribeGate = gate;
		},
		firstSubscription: firstSubscription.promise,
		status: (index: number, streaming: boolean) =>
			clients[index]?.emit({
				type: "status",
				seq: 1,
				state: streaming ? "streaming" : "idle",
				streaming,
			}),
		view: () => ({ engine, live, marked, ...session.snapshot() }),
		dispose: () => {
			for (const timer of timers.keys()) cancel(timer);
		},
	};
}

export async function flushEvidence(): Promise<void> {
	for (let step = 0; step < 100; step++) await Promise.resolve();
}
