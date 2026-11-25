import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcRequestSchema, SCHEMA_VERSION } from "@ceralive/cerastream";
import { setup } from "../modules/setup.ts";
import {
	AUDIO_METER_FRAME_ABSENCE_MS,
	initAudioMeterBridge,
	settleAudioMeterBridge,
	stopAudioMeterBridge,
} from "../modules/streaming/audio-meter-bridge.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
	MINIMAL_SAFE_CAPABILITIES,
} from "../modules/streaming/capabilities.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	initEngineConnection,
	stopEngineReconnect,
} from "../modules/streaming/engine-reconnect.ts";
import {
	refreshAndBroadcastSources,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import * as compat from "../rpc/compat.ts";

const reads = {
	sources: "list-devices",
	active: "list-devices",
	capabilities: "get-capabilities",
	runtime: "subscribe-events",
	meter: "subscribe-events",
	"meter-preference": "subscribe-events",
	"meter-reassert": "subscribe-events",
} as const;

test.each([
	{ consumer: "sources", reply: "lost", offline: [true] },
	{ consumer: "active", reply: "lost", offline: [true] },
	{ consumer: "active", reply: "refusal", offline: [] },
	{ consumer: "capabilities", reply: "lost", offline: [true] },
	{ consumer: "runtime", reply: "lost", offline: [true] },
	{ consumer: "meter", reply: "lost", offline: [true] },
	{ consumer: "meter", reply: "refusal", offline: [] },
	{ consumer: "meter", reply: "close", offline: [] },
	{ consumer: "meter-preference", reply: "lost", offline: [true] },
	{ consumer: "meter-preference", reply: "refusal", offline: [] },
	{ consumer: "meter-reassert", reply: "lost", offline: [true] },
	{ consumer: "meter-reassert", reply: "refusal", offline: [] },
] as const)(
	"$consumer $reply affects the shared availability owner only for transport loss",
	async ({ consumer, reply, offline }) => {
		const work = await mkdtemp(join(tmpdir(), "cs"));
		const socketPath = join(work, "s");
		const previous = setup.cerastream_socket;
		setup.cerastream_socket = socketPath;
		const requested = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const absenceArmed = Promise.withResolvers<() => void>();
		const reassertFailed = Promise.withResolvers<void>();
		const sends = spyOn(compat, "broadcastMsg");
		const wire: string[] = [];
		const reloads: unknown[] = [];
		const active = consumer === "active";
		const reassert = consumer === "meter-reassert";
		const acceptMeterSubscription =
			reply === "close" || consumer === "meter-preference" || reassert;
		const server = Bun.listen<{ pending: string }>({
			unix: socketPath,
			socket: {
				close() {
					closed.resolve();
				},
				open(peer) {
					peer.data = { pending: "" };
				},
				data(peer, chunk) {
					const lines = (peer.data.pending + chunk.toString()).split("\n");
					peer.data.pending = lines.pop() ?? "";
					for (const line of lines) {
						const request = rpcRequestSchema.parse(JSON.parse(line));
						wire.push(request.method);
						if (request.method === "hello") {
							peer.write(
								`${JSON.stringify({
									jsonrpc: "2.0",
									id: request.id,
									result: {
										protocol: "cerastream-ipc/1",
										schema_version: SCHEMA_VERSION,
										engine_version: "fixture",
									},
								})}\n`,
							);
							continue;
						}
						if (active && request.method === "start") {
							peer.write(
								`${JSON.stringify({
									jsonrpc: "2.0",
									id: request.id,
									result: { session_id: "cs-fixture", state: "streaming" },
								})}\n`,
							);
							continue;
						}
						if (
							(consumer === "runtime" || active) &&
							request.method === "get-capabilities"
						) {
							peer.write(
								`${JSON.stringify({
									jsonrpc: "2.0",
									id: request.id,
									result: MINIMAL_SAFE_CAPABILITIES,
								})}\n`,
							);
							continue;
						}
						if (
							(acceptMeterSubscription || active) &&
							request.method === "subscribe-events"
						) {
							peer.write(
								`${JSON.stringify({
									jsonrpc: "2.0",
									id: request.id,
									result: { subscribed: active ? ["status"] : ["audio-level"] },
								})}\n`,
							);
							continue;
						}
						if (request.method === "reload-config") {
							reloads.push(request.params);
							if (reassert && reloads.length === 1) {
								peer.write(
									`${JSON.stringify({
										jsonrpc: "2.0",
										id: request.id,
										result: {},
									})}\n${JSON.stringify({
										jsonrpc: "2.0",
										method: "event",
										params: {
											type: "audio-level",
											seq: 1,
											source: { identity: "card:usb", owner: "sidecar" },
											channels: 1,
											rms_db: [-18],
											peak_db: [-6],
											floor_db: -1e6,
										},
									})}\n`,
								);
								continue;
							}
						}
						requested.resolve();
						if (reply === "lost") peer.end();
						if (reply === "refusal")
							peer.write(
								`${JSON.stringify({
									jsonrpc: "2.0",
									id: request.id,
									error: { code: -32601, message: "Not supported" },
								})}\n`,
							);
					}
				},
			},
		});
		clearCapabilitiesCache();
		try {
			await initEngineConnection({
				capabilities: {
					fetchEngineCapabilities: async () => ({
						caps: MINIMAL_SAFE_CAPABILITIES,
						schemaVersion: SCHEMA_VERSION,
					}),
					fetchEngineDevices: async () => ({ devices: [] }),
				},
				sources: { fetchEngineDevices: async () => ({ devices: [] }) },
			});
			switch (consumer) {
				case "sources":
					await refreshAndBroadcastSources();
					break;
				case "active": {
					const backend = new CerastreamBackend({
						onSessionConnectionLost: () => {},
					});
					await backend.start(
						{ max_br: 8_000, srt_latency: 2_000, balancer: "adaptive" },
						{
							pipeline: "hdmi",
							host: "127.0.0.1",
							port: 9000,
							streamid: "fixture",
						},
					);
					await backend.settle();
					expect(await backend.listDevicesIfActive()).toBeNull();
					break;
				}
				case "capabilities":
					await getCapabilities();
					break;
				case "runtime":
					await new CerastreamBackend().reconcileRuntimeState();
					break;
				case "meter":
				case "meter-preference":
				case "meter-reassert": {
					initAudioMeterBridge({
						connectOptions: { socketPath, autoReconnect: false },
						...(reassert
							? {
									meterPreference: () => "hw:CARD=usb",
									meterSilenced: () => false,
									meterEmbedded: () => false,
									launchInFlight: () => false,
									setTimer: (callback, delay) => {
										if (delay === AUDIO_METER_FRAME_ABSENCE_MS)
											absenceArmed.resolve(callback);
										const handle = setTimeout(callback, 0);
										clearTimeout(handle);
										return handle;
									},
									clearTimer: () => {},
									logger: {
										info: () => {},
										debug: () => {},
										warn: () => {
											if (reloads.length === 2) reassertFailed.resolve();
										},
									},
								}
							: {}),
					});
					const done = settleAudioMeterBridge();
					if (reassert) {
						await done;
						(await absenceArmed.promise)();
					}
					await requested.promise;
					if (reply === "close") {
						stopAudioMeterBridge();
						await closed.promise;
					}
					await done;
					if (reassert) await reassertFailed.promise;
					break;
				}
			}
			expect(wire).toEqual([
				"hello",
				...(consumer === "runtime" ? ["get-capabilities"] : []),
				...(active ? ["get-capabilities", "subscribe-events", "start"] : []),
				reads[consumer],
				...(acceptMeterSubscription ? ["reload-config"] : []),
				...(reassert ? ["reload-config"] : []),
			]);
			if (reassert)
				expect(reloads).toEqual([
					{ audio: { meter_device: "hw:CARD=usb" } },
					{ audio: { meter_device: null } },
				]);
			expect(
				sends.mock.calls.flatMap(([topic, payload]) =>
					topic === "capabilities" &&
					payload &&
					typeof payload === "object" &&
					"engineUnavailable" in payload
						? [payload.engineUnavailable]
						: [],
				),
			).toEqual([...offline]);
		} finally {
			stopEngineReconnect();
			stopAudioMeterBridge();
			server.stop(true);
			if (previous === undefined) delete setup.cerastream_socket;
			else setup.cerastream_socket = previous;
			sends.mockRestore();
			clearCapabilitiesCache();
			resetEngineDeviceCache();
			await rm(work, { recursive: true, force: true });
		}
	},
);
