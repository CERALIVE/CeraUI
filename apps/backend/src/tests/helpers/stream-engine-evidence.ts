import type { CerastreamClient, EventParams } from "@ceralive/cerastream";
import { CerastreamTimeoutError } from "@ceralive/cerastream";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { CerastreamBackend } from "../../modules/streaming/cerastream-backend.ts";
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
export function evidenceHarness() {
	let engine: "idle" | "streaming" = "idle";
	let live = false;
	let marked = false;
	let id = 0;
	let connection = 0;
	let failedStart = false;
	let failedStop = false;
	let connectGate: Promise<void> | undefined;
	let subscribeGate: Promise<void> | undefined;
	let beforeDispatch: (() => void) | undefined;
	const clients: Array<{
		client: CerastreamClient;
		emit: (event: EventParams) => void;
		calls: string[];
	}> = [];
	const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
	const schedule = (callback: () => void) => {
		const timer = setTimeout(() => undefined, 60_000);
		timer.unref();
		timers.set(timer, callback);
		return timer;
	};
	const cancel = (timer: ReturnType<typeof setTimeout> | number) => {
		if (typeof timer !== "number") timers.delete(timer);
		clearTimeout(timer);
	};
	const connect = async () => {
		const index = connection++;
		let listener: ((event: EventParams) => void) | undefined;
		const calls: string[] = [];
		const client: CerastreamClient = {
			hello: {
				protocol: "cerastream-ipc/1",
				schema_version: "0.1.0",
				engine_version: "fake",
			},
			start: async () => {
				calls.push("start");
				engine = "streaming";
				if (failedStart) throw new CerastreamTimeoutError("start", 10_000);
				return { state: "streaming", session_id: `session-${index}` };
			},
			stop: async () => {
				calls.push("stop");
				if (failedStop) throw new Error("stop-ack-unavailable");
				engine = "idle";
				return { state: "idle" };
			},
			subscribeEvents: async (_params, callback) => {
				calls.push("subscribe");
				listener = callback;
				if (index === 0) await subscribeGate;
				return {
					result: { subscribed: ["status"] },
					close: () => {
						calls.push("unsubscribe");
					},
				};
			},
			close: async () => {
				calls.push("close");
			},
			reloadConfig: unused,
			setBitrate: unused,
			requestKeyframe: unused,
			setEdidProfile: unused,
			listSwitchTargets: unused,
			switchInput: unused,
			listDevices: unused,
			getCapabilities: unused,
			changeConfig: unused,
			previewSession: unused,
		};
		clients.push({ client, calls, emit: (event) => listener?.(event) });
		if (index === 0) await connectGate;
		return client;
	};
	const deps = {
		connect,
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
		onEngineStatus: (event: Extract<EventParams, { type: "status" }>) =>
			session.noteEngineStatus(event),
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
		createAttemptId: () => `evidence-${++id}`,
		setStreamingStatus: (value) => {
			live = value;
		},
		getStreamingStatus: () => live,
		markStreamingForOta: () => {
			marked = true;
		},
		unmarkStreamingForOta: () => {
			marked = false;
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
		session,
		clients,
		timers,
		start: () => {
			const transaction = createLaunchTransaction("evidence", {
				timers: { schedule, cancel },
			});
			return session.start({
				origin: "ui",
				launch: () =>
					backend.start(config, options, {
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
		setEngine: (value: typeof engine) => {
			engine = value;
		},
		failStart: () => {
			failedStart = true;
		},
		failStop: () => {
			failedStop = true;
		},
		holdConnect: (gate: Promise<void>) => {
			connectGate = gate;
		},
		holdSubscribe: (gate: Promise<void>) => {
			subscribeGate = gate;
		},
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
