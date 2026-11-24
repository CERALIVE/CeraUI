import { expect, onTestFinished } from "bun:test";
import {
	CAPTURE_SELECTION_CLEAR_FEATURE,
	type ChangeConfigParams,
	type ConnectOptions,
	changeConfigParamsSchema,
	connect,
	listDevicesResultSchema,
	rpcRequestSchema,
} from "@ceralive/cerastream";
import { getConfig } from "../../modules/config.ts";
import {
	CerastreamBackend,
	cerastreamBackend,
} from "../../modules/streaming/cerastream-backend.ts";
import {
	changeEngineRuntimeConfig,
	createApplyNowGate,
	setApplyNowGateForTest,
} from "../../modules/streaming/config-change-bridge.ts";
import { initPipelines } from "../../modules/streaming/pipelines.ts";
import { createStreamSessionOrchestrator } from "../../modules/streaming/stream-session-orchestrator.ts";
import { sourceSelectionFixture } from "./applied-source-selection.ts";

type Engine = {
	readonly features: readonly string[] | undefined;
	readonly wire: ChangeConfigParams[];
	capabilityReads: number;
};

type PeerConnection = {
	pending: string;
	readonly engine: Engine;
	readonly end: () => void;
	readonly closed: Promise<void>;
	readonly noteClosed: () => void;
};

/** Real SDK/UDS, backend lifecycle, procedure, bridge, admission and file writer.
 * Only the engine protocol peer is supplied. */
export async function captureEngineLifecycle(
	initialFeatures: readonly string[] | undefined = [
		CAPTURE_SELECTION_CLEAR_FEATURE,
	],
) {
	const f = await sourceSelectionFixture(changeEngineRuntimeConfig);
	const socketPath = `${f.dir}/engine.sock`;
	const clients: Awaited<ReturnType<typeof connect>>[] = [];
	const connections = new Set<PeerConnection>();
	const failures: unknown[] = [];
	const makeEngine = (features: readonly string[] | undefined): Engine => ({
		features,
		wire: [],
		capabilityReads: 0,
	});
	let engine = makeEngine(initialFeatures);
	let heldChange:
		| {
				readonly asked: ReturnType<typeof Promise.withResolvers<void>>;
				readonly answer: ReturnType<typeof Promise.withResolvers<void>>;
		  }
		| undefined;
	const respond = async (
		request: ReturnType<typeof rpcRequestSchema.parse>,
		current: Engine,
	): Promise<unknown> => {
		switch (request.method) {
			case "hello":
				return {
					protocol: "cerastream-ipc/1",
					schema_version: current.features?.includes(
						CAPTURE_SELECTION_CLEAR_FEATURE,
					)
						? "0.24.0"
						: "0.23.0",
					engine_version: "lifecycle-fixture",
				};
			case "get-capabilities":
				current.capabilityReads += 1;
				return { ...f.capabilities.caps, features: current.features };
			case "subscribe-events":
				return { subscribed: ["status"] };
			case "start":
				return { session_id: "lifecycle", state: "streaming" };
			case "stop":
				return { state: "idle" };
			case "list-devices":
				return listDevicesResultSchema.parse({ devices: f.devices });
			case "change-config": {
				const params = changeConfigParamsSchema.parse(request.params);
				expect(request.params).toEqual(params);
				current.wire.push(params);
				const held = heldChange;
				if (held !== undefined) {
					heldChange = undefined;
					held.asked.resolve();
					await held.answer.promise;
				}
				return {
					attempt_id: "lifecycle-change",
					phase: "applied",
					state: "streaming",
				};
			}
			default:
				throw new Error(`unexpected lifecycle method ${request.method}`);
		}
	};
	const server = Bun.listen<PeerConnection>({
		unix: socketPath,
		socket: {
			open(socket) {
				const closed = Promise.withResolvers<void>();
				socket.data = {
					pending: "",
					engine,
					end: () => socket.end(),
					closed: closed.promise,
					noteClosed: () => closed.resolve(),
				};
				connections.add(socket.data);
			},
			data(socket, bytes) {
				socket.data.pending += bytes.toString();
				const lines = socket.data.pending.split("\n");
				socket.data.pending = lines.pop() ?? "";
				for (const line of lines) {
					const request = rpcRequestSchema.parse(JSON.parse(line));
					void respond(request, socket.data.engine).then(
						(result) => {
							socket.write(
								`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
							);
						},
						(error: unknown) => {
							failures.push(error);
							if (!(error instanceof Error)) throw error;
							socket.write(
								`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } })}\n`,
							);
						},
					);
				}
			},
			close(socket) {
				connections.delete(socket.data);
				socket.data.noteClosed();
			},
		},
	});
	const dial = async (options: ConnectOptions = {}) => {
		const client = await connect({
			...options,
			socketPath,
			autoReconnect: false,
		});
		clients.push(client);
		return client;
	};
	let retired = Promise.resolve();
	const backend = new CerastreamBackend({
		connect: dial,
		getConfig,
		getActiveInput: () => getConfig().selected_video_input,
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => undefined,
			broadcastStatus: () => undefined,
			broadcastBuffering: () => undefined,
		},
		onSessionConnectionLost: () => {
			retired = session.stop("engine_loss").then(() => undefined);
		},
	});
	let attempt = 0;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => `lifecycle-${++attempt}`,
		setStreamingStatus: () => undefined,
		setLifecycleState: () => undefined,
		stopRuntime: async () => {
			await new Promise<void>((resolve, reject) => {
				if (!backend.stop(resolve, reject)) resolve();
			});
			await backend.settle();
		},
		queryRuntime: () => backend.reconcileRuntimeState(),
		changeRuntimeConfig: changeEngineRuntimeConfig,
	});
	const original = cerastreamBackend.changeConfig;
	cerastreamBackend.changeConfig = backend.changeConfig.bind(backend);
	setApplyNowGateForTest(
		createApplyNowGate(session, () => backend.refreshCapabilities()),
	);
	onTestFinished(async () => {
		cerastreamBackend.changeConfig = original;
		for (const client of clients) await client.close();
		server.stop();
		expect(failures).toEqual([]);
	});
	await initPipelines({
		fetchEngineCapabilities: async () => {
			const probe = await dial();
			try {
				return {
					caps: await probe.getCapabilities(),
					schemaVersion: probe.hello.schema_version,
				};
			} finally {
				await probe.close();
			}
		},
		fetchEngineDevices: async () =>
			listDevicesResultSchema.parse({ devices: f.devices }),
	});
	await f.write({ input_mode: "mjpeg" });
	return {
		...f,
		backend,
		dial,
		currentClient: () => clients.at(-1),
		session,
		current: () => engine,
		start: () =>
			session.start({
				origin: "ui",
				launch: () =>
					backend.start(getConfig(), {
						pipeline: getConfig().pipeline ?? "usb_mjpeg",
						host: "127.0.0.1",
						port: 9000,
						streamid: "lifecycle",
					}),
			}),
		replace: async (features: readonly string[] | undefined) => {
			engine = makeEngine(features);
			const previous = [...connections];
			for (const connection of previous) connection.end();
			await Promise.all(previous.map((connection) => connection.closed));
			expect(await backend.listDevicesIfActive()).toBeNull();
			await retired;
			expect(session.snapshot().state).toBe("idle");
		},
		holdNextChange: () => {
			const held = {
				asked: Promise.withResolvers<void>(),
				answer: Promise.withResolvers<void>(),
			};
			heldChange = held;
			return held;
		},
		bytes: () => Bun.file(`${f.dir}/config.json`).text(),
	};
}
