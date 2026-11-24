import { afterEach, describe, expect, test } from "bun:test";
import {
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
	RPC_ERROR_NUMERIC,
	rpcErrorCodeSchema,
	SCHEMA_VERSION,
	statusEventSchema,
} from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { ENGINE_STATE_RECONCILE_TIMEOUT } from "../helpers/timing-constants.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import { extractEngineBitrate } from "../modules/streaming/engine-bitrate-status.ts";
import {
	ENGINE_TRANSITION_STOP_DEADLINE_MS,
	START_PHASE_DEADLINES_MS,
} from "../modules/streaming/start-lifecycle-timing.ts";
import { evidenceHarness } from "./helpers/stream-engine-evidence.ts";

const codes = rpcErrorCodeSchema.enum;
const busy = codes["cerastream.state.already_streaming"];
const invalid = codes["cerastream.params.invalid"];
const audioMissing = codes["cerastream.audio.device_not_found"];
const internal = codes["cerastream.internal"];
const numeric = RPC_ERROR_NUMERIC;

const fixtures: ReturnType<typeof evidenceHarness>[] = [];
const harness = (schemaVersion?: string) => {
	const h = evidenceHarness(false, { schemaVersion });
	fixtures.push(h);
	return h;
};
afterEach(() => {
	for (const h of fixtures.splice(0)) h.dispose();
	clearCapabilitiesCache();
});

const engineCalls = (h: ReturnType<typeof evidenceHarness>, call: string) =>
	h.clients.flatMap(({ calls }) => calls).filter((made) => made === call);

describe("a Start refused because another session is running", () => {
	for (const [label, dataCode, code, schemaVersion, startCall] of [
		["typed", busy, numeric[busy], undefined, "start"],
		["numeric only", undefined, numeric[busy], undefined, "start"],
		["typed overrides number", busy, numeric[internal], undefined, "start"],
		// Schema 0.6 and later send Start as a raw request.
		["raw request", busy, numeric[busy], "0.6.0", "raw:start"],
	] as const) {
		test(`${label}: the rollback leaves the running session alone`, async () => {
			const h = harness(schemaVersion);
			h.beforeStartDispatch(() => {
				// Admitted idle, then another client starts a session first.
				h.setEngine("streaming");
				h.refuseStart(code, dataCode);
			});

			expect(await h.start()).toMatchObject({
				result: "failed",
				failure: { phase: "start-rpc", code },
			});

			expect(engineCalls(h, startCall)).toHaveLength(1);
			expect(engineCalls(h, "stop")).toHaveLength(0);
			expect(h.view()).toMatchObject({
				engine: "streaming",
				state: "reconciling",
			});
			// The orchestrator's own verdict, not the harness's OTA mark.
			expect(h.session.streamLiveness()).toBe("unknown");
			// The Start's own connection is still released.
			expect(h.clients[0]?.calls).toContain("close");
		});
	}

	test("the operator's Stop still ends it", async () => {
		const h = harness();
		refuseAgainstForeignStream(h);
		expect(await h.start()).toMatchObject({ result: "failed" });
		expect(h.view().engine).toBe("streaming");
		expect(engineCalls(h, "stop")).toHaveLength(0);

		expect(await h.session.stop("operator")).toEqual({ result: "stopped" });

		expect(engineCalls(h, "stop")).toHaveLength(1);
		expect(h.view()).toMatchObject({
			engine: "idle",
			state: "idle",
			marked: false,
		});
	});
});

const foreignBitrate = 6_000;
function refuseAgainstForeignStream(
	h: ReturnType<typeof evidenceHarness>,
	code: number = numeric[busy],
	dataCode: string = busy,
) {
	h.beforeStartDispatch(() => {
		h.startExternal(foreignBitrate);
		h.refuseStart(code, dataCode);
	});
}

test.each([
	["dispatch cannot decode the u32 bitrate", invalid, { max_br: 2 ** 32 }],
	[
		"custom composition missing a rectangle",
		invalid,
		{
			max_br: 9_000,
			composition: { layout: "custom", secondary_input_id: "second-camera" },
		},
	],
	[
		"preset composition supplied with a rectangle",
		invalid,
		{
			max_br: 9_500,
			composition: {
				layout: "pip-top-right",
				secondary_input_id: "second-camera",
				rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
			},
		},
	],
	[
		"unavailable audio device",
		audioMissing,
		{
			max_br: 10_000,
			audio_inputs: [
				{
					id: "missing-mic",
					tracks: [1],
					gain_db: 0,
					mute: false,
					delay_ms: 0,
				},
			],
		},
	],
] satisfies [
	string,
	typeof invalid | typeof audioMissing,
	Partial<RuntimeConfig>,
][])(
	"%s leaves a different configuration live and preserves its refusal",
	async (_label, dataCode, config) => {
		if (dataCode === audioMissing) {
			await getCapabilities({
				fetchEngineCapabilities: async () => ({
					schemaVersion: SCHEMA_VERSION,
					caps: {
						platform: {
							supports_h265: false,
							hardware_accelerated: false,
							max_resolution: "1080p",
						},
						encoder: {
							codecs: ["h264"],
							bitrate_range: { min: 500, max: 20_000, unit: "kbps" },
						},
						sources: [],
						audio_mix: {
							max_inputs: 4,
							max_tracks: 4,
							gain_db_min: -60,
							gain_db_max: 12,
							delay_ms_max: 2_000,
						},
					},
				}),
				fetchEngineDevices: async () => ({ devices: [] }),
			});
		}
		const h = harness(SCHEMA_VERSION);
		refuseAgainstForeignStream(h, numeric[dataCode], dataCode);

		expect(await h.start(config)).toMatchObject({
			result: "failed",
			failure: {
				phase: "start-rpc",
				code: numeric[dataCode],
				message: "refused",
			},
		});
		expect(
			h.startRequests.map((request) => request.bitrate.max_bitrate),
		).toEqual([config.max_br]);
		if (dataCode === audioMissing)
			expect(
				h.startRequests[0]?.audio?.inputs?.map((input) => input.input_id),
			).toEqual(["hw:CARD=missing-mic"]);
		if ("composition" in config)
			expect(h.startRequests[0]?.composition).toEqual(config.composition);
		expect(h.externalMaxBitrate()).toBe(foreignBitrate);
		expect(engineCalls(h, "stop")).toHaveLength(0);
	},
);

test("closed launch socket: only fresh idle evidence settles the refusal", async () => {
	const h = harness();
	const encode = {
		codec: "h264",
		resolution: "1920x1080",
		framerate: 30,
	};
	const preview = { realized_element: "x264enc", mode: "software" };
	h.beforeStartDispatch(() => {
		h.startExternal(foreignBitrate);
		const launch = h.clients[0];
		if (launch === undefined) throw new Error("missing launch subscription");
		launch.emit(
			statusEventSchema.parse({
				type: "status",
				seq: 1,
				state: "streaming",
				streaming: true,
				active_encode: encode,
				preview_encoder_realized: preview,
			}),
		);
		launch.emit({
			type: "bitrate",
			seq: 2,
			current_bitrate: 4_500,
			max_bitrate: foreignBitrate,
		});
		h.refuseStart(numeric[busy], busy);
	});
	expect(await h.start()).toMatchObject({ result: "failed" });
	expect(h.clients[0]?.calls).toContain("close");
	expect(h.view()).toMatchObject({ engine: "streaming", state: "reconciling" });
	expect(extractEngineBitrate(h.backend.getTelemetry())).toEqual({
		applied_kbps: 4_500,
		ceiling_kbps: foreignBitrate,
	});
	expect(h.backend.getTelemetry()).toMatchObject({
		active_encode: encode,
		preview_encoder_realized: preview,
	});

	h.status(0, false);
	expect(h.session.streamLiveness()).toBe("unknown");
	await h.probeSubscribed;
	const probe = h.clients[1];
	if (probe === undefined) throw new Error("missing refusal observation");
	h.setEngine("idle");
	h.status(1, false);
	await probe.closed;
	await h.settledIdle;

	expect(h.view()).toMatchObject({
		engine: "idle",
		state: "idle",
		marked: false,
	});
	expect(engineCalls(h, "stop")).toHaveLength(0);
	const telemetry = h.backend.getTelemetry();
	expect(extractEngineBitrate(telemetry)).toBeNull();
	expect(telemetry?.active_encode).toBeUndefined();
	expect(telemetry?.preview_encoder_realized).toBeUndefined();
});

test("the refusal observer cannot clear protection or admit Start from an earlier status in the socket batch", async () => {
	const h = harness();
	refuseAgainstForeignStream(h);
	h.setStatusSink((event, current) => {
		void import("../modules/streaming/stream-session-orchestrator.ts").then(
			() => {
				if (current()) h.session.noteEngineStatus(event);
			},
		);
	});
	expect(await h.start()).toMatchObject({ result: "failed" });
	await h.probeSubscribed;
	const probe = h.clients[1];
	if (probe === undefined) throw new Error("missing refusal observation");

	h.setEngine("idle");
	probe.emit({ type: "status", seq: 1, state: "idle", streaming: false });
	probe.emit({ type: "status", seq: 2, state: "starting", streaming: false });
	h.setEngine("streaming");
	probe.emit({ type: "status", seq: 3, state: "streaming", streaming: true });
	await Promise.race([h.adopted, h.settledIdle]);
	const observed = h.view();

	const retry = await h.start();
	expect({
		engine: observed.engine,
		state: observed.state,
		marked: observed.marked,
		retry: retry.result,
		starts: h.startRequests.length,
		stops: engineCalls(h, "stop").length,
	}).toEqual({
		engine: "streaming",
		state: "streaming",
		marked: true,
		retry: "busy",
		starts: 1,
		stops: 0,
	});
	expect(h.lifecycle).not.toContain("idle");
});

test("boot recovery cannot displace the current refusal observer", async () => {
	const h = harness();
	refuseAgainstForeignStream(h);
	expect(await h.start()).toMatchObject({ result: "failed" });
	await h.probeSubscribed;
	const refusal = h.clients[1];
	if (refusal === undefined) throw new Error("Expected refusal observer");

	const boot = h.session.reconcile();
	refusal.emit({ type: "status", seq: 1, state: "streaming", streaming: true });

	expect(h.clients).toHaveLength(2);
	await boot;
	await h.adopted;
	expect(h.view()).toMatchObject({ engine: "streaming", state: "streaming" });
	expect(engineCalls(h, "start")).toHaveLength(1);
	expect(engineCalls(h, "stop")).toHaveLength(0);
});

test("a fresh subscription adopts a foreign live session without restarting it", async () => {
	const h = harness();
	refuseAgainstForeignStream(h);
	expect(await h.start()).toMatchObject({ result: "failed" });
	expect(h.externalMaxBitrate()).toBe(foreignBitrate);
	await h.probeSubscribed;
	h.status(1, true);
	await h.adopted;

	expect(h.view()).toMatchObject({
		engine: "streaming",
		state: "streaming",
		live: true,
		marked: true,
	});
	expect(h.session.streamLiveness()).toBe("streaming");
	expect(engineCalls(h, "start")).toHaveLength(1);
	expect(engineCalls(h, "stop")).toHaveLength(0);
	h.setEngine("idle");
	h.status(1, false);
	expect(h.session.streamLiveness()).toBe("idle");
});

test("an operator Stop supersedes a pending probe and its late live evidence", async () => {
	const h = harness();
	refuseAgainstForeignStream(h);
	expect(await h.start()).toMatchObject({ result: "failed" });
	expect(h.view().engine).toBe("streaming");
	expect(engineCalls(h, "stop")).toHaveLength(0);
	await h.probeSubscribed;
	const probe = h.clients[1];
	if (probe === undefined) throw new Error("missing refusal observation");

	const stop = h.session.stop("operator");
	h.status(1, true);
	expect(await stop).toEqual({ result: "stopped" });
	h.deadline(ENGINE_STATE_RECONCILE_TIMEOUT)?.();
	await probe.closed;

	expect(h.lifecycle).not.toContain("streaming");
	expect(h.view()).toMatchObject({
		engine: "idle",
		state: "idle",
		live: false,
		marked: false,
	});
	expect(probe.calls).not.toContain("stop");
	expect(engineCalls(h, "stop")).toHaveLength(1);
});

test("a parked operator Stop also supersedes the refusal observer", async () => {
	const h = harness();
	h.beforeStartDispatch(() => {
		h.startExternal(foreignBitrate);
		h.clients[0]?.emit(
			statusEventSchema.parse({
				type: "status",
				seq: 1,
				state: "streaming",
				streaming: true,
				active_encode: {
					codec: "h264",
					resolution: "1920x1080",
					framerate: 30,
					capture: {
						state: "degraded",
						live_inputs: ["camera-a"],
						degraded_inputs: [],
						failover_rate_policy: "retime",
						transition: { kind: "resume", since_ms: 1 },
					},
				},
			}),
		);
		h.refuseStart(numeric[busy], busy);
	});
	expect(await h.start()).toMatchObject({ result: "failed" });
	expect(h.view().engine).toBe("streaming");
	await h.probeSubscribed;
	const probe = h.clients[1];
	if (probe === undefined) throw new Error("missing refusal observation");
	const stop = h.session.stop("operator");
	expect(engineCalls(h, "stop")).toHaveLength(0);

	h.status(1, true);
	h.deadline(ENGINE_STATE_RECONCILE_TIMEOUT)?.();
	const probeOutcome = await Promise.race([
		probe.closed.then(() => "closed"),
		h.adopted.then(() => "adopted"),
	]);
	expect(probeOutcome).toBe("closed");
	expect(h.lifecycle).not.toContain("streaming");
	h.deadline(ENGINE_TRANSITION_STOP_DEADLINE_MS)?.();
	expect(await stop).toEqual({ result: "stopped" });
	expect(engineCalls(h, "stop")).toHaveLength(1);
	expect(h.view()).toMatchObject({ engine: "idle", state: "idle" });
});

test("a silent refusal observation expires without lifting protection or accepting late evidence", async () => {
	const h = harness();
	refuseAgainstForeignStream(h);
	expect(await h.start()).toMatchObject({ result: "failed" });
	expect(h.view().engine).toBe("streaming");
	await h.probeSubscribed;
	const probe = h.clients[1];
	if (probe === undefined) throw new Error("missing refusal observation");
	const deadline = h.deadline(ENGINE_STATE_RECONCILE_TIMEOUT);
	if (deadline === undefined) throw new Error("missing observation deadline");
	deadline();
	await probe.closed;
	h.status(1, false);

	expect(h.view()).toMatchObject({
		engine: "streaming",
		state: "reconciling",
		marked: true,
	});
	expect(h.session.streamLiveness()).toBe("unknown");
	expect(engineCalls(h, "stop")).toHaveLength(0);
});

test.each([
	[
		"internal failure",
		new CerastreamRpcError(
			numeric[internal],
			"failed after Starting",
			internal,
			1,
		),
	],
	[
		"invalid params on valid wire input",
		new CerastreamRpcError(
			numeric[invalid],
			"failed after Starting",
			invalid,
			1,
		),
	],
	[
		"typed internal code with a busy number",
		new CerastreamRpcError(numeric[busy], "already streaming", internal, 1),
	],
	[
		"another numeric refusal",
		new CerastreamRpcError(
			numeric[codes["cerastream.state.not_streaming"]],
			"already streaming",
			undefined,
			1,
		),
	],
	["message only", new Error("already_streaming")],
	[
		"connection lost",
		new CerastreamConnectionError("reply lost", undefined, "lost"),
	],
	["client timeout", new CerastreamTimeoutError("start", 10_000)],
] as const)(
	"%s after effectful Start still sends cleanup",
	async (_label, error) => {
		const h = harness();
		h.loseStartReply(error);
		const gate = Promise.withResolvers<void>();
		h.holdStart(gate.promise);
		const launch = h.start();
		await h.started;
		expect(h.view().engine).toBe("streaming");
		gate.resolve();

		expect(await launch).toMatchObject({ result: "failed" });
		expect(engineCalls(h, "stop")).toHaveLength(1);
		expect(h.view()).toMatchObject({ engine: "idle", state: "idle" });
	},
);

test("an older engine's params.invalid cannot prove when it rejected a request with custom geometry", async () => {
	const h = harness("0.22.0");
	h.loseStartReply(
		new CerastreamRpcError(
			numeric[invalid],
			"failed after Starting",
			invalid,
			1,
		),
	);
	expect(
		await h.start({
			composition: { layout: "custom", secondary_input_id: "second-camera" },
		}),
	).toMatchObject({ result: "failed" });
	expect(engineCalls(h, "stop")).toHaveLength(1);
	expect(h.view()).toMatchObject({ engine: "idle", state: "idle" });
});

test("a geometry number that can round at the producer is not proof of a pre-admission refusal", async () => {
	const h = harness(SCHEMA_VERSION);
	h.loseStartReply(
		new CerastreamRpcError(
			numeric[invalid],
			"failed after Starting",
			invalid,
			1,
		),
	);
	expect(
		await h.start({
			composition: {
				layout: "custom",
				secondary_input_id: "second-camera",
				rect: { x: 0, y: 0, width: 0.12499999999999999, height: 0.25 },
			},
		}),
	).toMatchObject({ result: "failed" });
	expect(engineCalls(h, "stop")).toHaveLength(1);
	expect(h.view()).toMatchObject({ engine: "idle", state: "idle" });
});

test("a Start deadline sends cleanup before a late busy refusal arrives", async () => {
	const h = harness();
	refuseAgainstForeignStream(h);
	const gate = Promise.withResolvers<void>();
	h.holdStart(gate.promise);
	const launch = h.start();
	await h.startDispatched;
	expect(h.externalMaxBitrate()).toBe(foreignBitrate);
	const deadline = h.deadline(START_PHASE_DEADLINES_MS["start-rpc"]);
	if (deadline === undefined) throw new Error("missing Start deadline");
	deadline();

	expect(await launch).toMatchObject({
		result: "failed",
		failure: { phase: "start-rpc", class: "start_timeout" },
	});
	expect(engineCalls(h, "stop")).toHaveLength(1);
	expect(h.view()).toMatchObject({ engine: "idle", state: "idle" });

	gate.resolve();
	await h.startSettled;
	expect(h.clients).toHaveLength(1);
});
