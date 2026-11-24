import { expect, onTestFinished, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	rpcRequestSchema,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { getConfigFilePath, setConfigFilePath } from "../modules/config.ts";
import { defaultArmedStreamMarkerDeps } from "../modules/streaming/armed-stream-marker.ts";
import {
	getPendingAudioFollowAsrc,
	setPendingAudioFollowAsrc,
} from "../modules/streaming/auto-audio.ts";
import {
	clearBindMapReport,
	getNormalizedBindMapReport,
	noteWriterBindMapReport,
} from "../modules/streaming/bind-map-disposition.ts";
import { MINIMAL_SAFE_CAPABILITIES } from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	cerastreamBackend,
} from "../modules/streaming/cerastream-backend.ts";
import * as restoration from "../modules/streaming/stream-restoration.ts";
import {
	getStreamSessionSnapshot,
	reconcileStreamSession,
	startStreamSession,
	stopStreamSession,
	streamLiveness,
} from "../modules/streaming/stream-session-orchestrator.ts";
import {
	getStreamingProcesses,
	spawnStreamingLoop,
	stopProcessAndWait,
} from "../modules/streaming/streamloop/process-runner.ts";

test.each(["replacement", "same engine", "armed and idle"] as const)(
	"control-loss retirement at the Unix RPC boundary: %s",
	async (kind) => {
		const dir = await mkdtemp(join(tmpdir(), "el"));
		const socketPath = join(dir, "s");
		const previousConfig = getConfigFilePath();
		setConfigFilePath(join(dir, "config.json"));
		const mutations: string[] = [];
		const first = { streaming: false };
		let engine = first;
		let breakControl: (() => Promise<void>) | undefined;
		let sendStatus: () => void = () => {};
		let dialCount = 0;
		const server = Bun.listen<{
			buffer: string;
			readonly engine: typeof first;
			readonly closed: () => void;
		}>({
			unix: socketPath,
			socket: {
				open(peer) {
					const closed = Promise.withResolvers<void>();
					peer.data = { buffer: "", engine, closed: closed.resolve };
					sendStatus = () => {
						const { streaming } = peer.data.engine;
						peer.write(
							`${JSON.stringify({
								jsonrpc: "2.0",
								method: "event",
								params: {
									type: "status",
									seq: 1,
									streaming,
									state: streaming ? "streaming" : "idle",
								},
							})}\n`,
						);
					};
					if (breakControl === undefined) {
						breakControl = () => {
							peer.end();
							return closed.promise;
						};
					}
				},
				data(peer, chunk) {
					const lines = (peer.data.buffer + chunk.toString()).split("\n");
					peer.data.buffer = lines.pop() ?? "";
					const current = peer.data.engine;
					for (const line of lines) {
						const request = rpcRequestSchema.parse(JSON.parse(line));
						let result: unknown;
						switch (request.method) {
							case "hello":
								result = {
									protocol: "cerastream-ipc/1",
									schema_version: SCHEMA_VERSION,
									engine_version: "fixture",
								};
								break;
							case "subscribe-events":
								result = { subscribed: ["status"] };
								break;
							case "get-capabilities":
								result = MINIMAL_SAFE_CAPABILITIES;
								break;
							case "list-devices":
								result = { devices: [] };
								break;
							case "start":
								mutations.push("start");
								current.streaming = true;
								result = { session_id: "cs-1", state: "streaming" };
								break;
							case "stop":
								mutations.push("stop");
								current.streaming = false;
								result = { state: "idle" };
								break;
							default:
								throw new Error(`Unexpected RPC: ${request.method}`);
						}
						const reply = { jsonrpc: "2.0", id: request.id, result };
						peer.write(`${JSON.stringify(reply)}\n`);
					}
				},
				close(peer) {
					peer.data.closed();
				},
			},
		});
		const clients: Awaited<ReturnType<typeof connect>>[] = [];
		const backend = new CerastreamBackend({
			connect: async (options) => {
				dialCount++;
				const client = await connect({ ...options, socketPath });
				const status = sendStatus;
				const subscribe = client.subscribeEvents.bind(client);
				client.subscribeEvents = async (params, handler) => {
					const subscription = await subscribe(params, handler);
					status();
					return subscription;
				};
				clients.push(client);
				return client;
			},
		});
		const stop = spyOn(cerastreamBackend, "stop").mockImplementation(
			backend.stop.bind(backend),
		);
		const confirmStop = spyOn(
			cerastreamBackend,
			"confirmStop",
		).mockImplementation(backend.confirmStop.bind(backend));
		const query = spyOn(
			cerastreamBackend,
			"reconcileRuntimeState",
		).mockImplementation(backend.reconcileRuntimeState.bind(backend));
		const observed =
			Promise.withResolvers<
				Awaited<ReturnType<typeof restoration.runStreamRestoration>>
			>();
		const seenBeforeObservation: string[] = [];
		const localResourcesBeforeObservation: Array<{
			bindMap: ReturnType<typeof getNormalizedBindMapReport>;
			pendingAudio: string | null;
		}> = [];
		let sender: ReturnType<typeof spawnStreamingLoop> | undefined;
		let senderRetiredBeforeObservation: boolean | undefined;
		const runRestoration = restoration.runStreamRestoration;
		const restore = spyOn(
			restoration,
			"runStreamRestoration",
		).mockImplementation(() => {
			seenBeforeObservation.push(streamLiveness());
			localResourcesBeforeObservation.push({
				bindMap: getNormalizedBindMapReport(),
				pendingAudio: getPendingAudioFollowAsrc(),
			});
			if (sender !== undefined)
				senderRetiredBeforeObservation =
					sender.proc.signalCode === "SIGTERM" &&
					!getStreamingProcesses().includes(sender);
			const run = runRestoration({
				marker: {
					...defaultArmedStreamMarkerDeps,
					readMarker: () =>
						kind === "armed and idle"
							? JSON.stringify({
									bootId: "test",
									armedAt: 1,
									config: { pipeline: "hdmi" },
								})
							: undefined,
					readBootId: () => "test",
					writeMarker: () => {},
				},
				awaitRecovery: async () => {},
				launch: async () => {
					expect(getStreamSessionSnapshot().state).toBe("idle");
					const launch = await startStreamSession({
						origin: "restoration",
						launch: () =>
							backend.start(
								{ max_br: 8000, srt_latency: 2000, balancer: "adaptive" },
								{
									pipeline: "hdmi",
									host: "127.0.0.1",
									port: 9000,
									streamid: "restored",
								},
							),
					});
					return launch.result === "started"
						? { ok: true }
						: { ok: false, reason: "start_busy" };
				},
			});
			void run.then(observed.resolve, observed.reject);
			return run;
		});
		onTestFinished(async () => {
			if (sender !== undefined) await stopProcessAndWait(sender);
			clearBindMapReport();
			setPendingAudioFollowAsrc(null);
			restore.mockRestore();
			query.mockResolvedValue("idle");
			await reconcileStreamSession();
			query.mockRestore();
			confirmStop.mockRestore();
			stop.mockRestore();
			for (const client of clients) await client.close();
			server.stop(true);
			setConfigFilePath(previousConfig);
			await rm(dir, { recursive: true, force: true });
		});

		expect(
			await startStreamSession({
				origin: "ui",
				launch: () =>
					backend.start(
						{ max_br: 8000, srt_latency: 2000, balancer: "adaptive" },
						{
							pipeline: "hdmi",
							host: "127.0.0.1",
							port: 9000,
							streamid: "fixture",
						},
					),
			}),
		).toMatchObject({ result: "started" });
		noteWriterBindMapReport("bind-map-passed", []);
		setPendingAudioFollowAsrc("USB audio");
		if (kind === "replacement") {
			const ready = Promise.withResolvers<void>();
			sender = spawnStreamingLoop(
				{ command: "/usr/bin/nice", role: "srtla_send" },
				[
					"-n",
					"19",
					process.execPath,
					"-e",
					'process.stderr.write("ready\\n"); setInterval(() => {}, 1000);',
				],
				() => ready.resolve(),
			);
			await ready.promise;
			expect(getStreamingProcesses()).toContain(sender);
		}
		if (breakControl === undefined) throw new Error("Expected a control peer");
		if (kind !== "same engine") {
			first.streaming = false;
			engine = { streaming: kind === "replacement" };
		}
		await breakControl();
		expect(await backend.listDevicesIfActive()).toBeNull();
		const outcome = await observed.promise;

		const starts = kind === "armed and idle" ? ["start", "start"] : ["start"];
		expect(mutations).toEqual(starts);
		expect(localResourcesBeforeObservation).toEqual([
			{ bindMap: undefined, pendingAudio: null },
		]);
		if (kind === "replacement")
			expect(senderRetiredBeforeObservation).toBe(true);
		expect(seenBeforeObservation).toEqual(["unknown"]);
		expect(outcome.result).toBe(
			kind === "armed and idle" ? "recovered" : "adopted",
		);
		expect(engine.streaming).toBe(true);
		expect(getStreamSessionSnapshot().state).toBe("streaming");
		expect(streamLiveness()).toBe("streaming");
		const adoptedDials = dialCount;
		expect(await backend.listDevicesIfActive()).toEqual({ devices: [] });
		expect(dialCount).toBe(adoptedDials);

		noteWriterBindMapReport("bind-map-passed", []);
		expect(getNormalizedBindMapReport()).toBeDefined();
		expect(await stopStreamSession("operator")).toEqual({ result: "stopped" });
		expect(mutations).toEqual([...starts, "stop"]);
		expect(engine.streaming).toBe(false);
		expect(getNormalizedBindMapReport()).toBeUndefined();
	},
);
