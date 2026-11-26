/**
 * A dropped BRIDGE socket is not a stopped STREAM.
 *
 * Found live during Wave H hardware QA (HDMI mid-stream unplug drill): with the
 * cable pulled, health correctly reported `degraded` against a real, frozen
 * frame counter (30415, unchanging) for several seconds — then flipped to
 * `state: "healthy"`, `frames: {advancing: true, count: null}` while a local SRT
 * receiver had already errored out ("Error during demuxing: Input/output error")
 * and the kernel reported `power_present: 0`.
 *
 * The flip was the raw `active_encode` bridge reconnecting. Its `close`/`error`
 * handlers wiped `cachedLiveness`, `collectRealLiveness()` read the resulting
 * `undefined` as the genuine cold-start case, and fell back to `processAlive` —
 * which only says the supervised OS process has not crashed, never that frames
 * are flowing. The wipe also bypassed `FRAMES_FRESHNESS_MS`, the mechanism that
 * exists precisely to age a stale reading into `advancing: false`.
 *
 * These tests pin the corrected boundary: a SESSION boundary (engine-authored
 * stop, or a fresh start) clears the caches; a CONNECTION blip does not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SenderStats } from "@ceraui/srtla-send/control";
import { z } from "zod";

import { getConfig } from "../modules/config.ts";
import {
	getActiveEncodeLiveness,
	getActivePassthrough,
	ingestLivenessForTest,
	resetActiveEncodeLiveness,
	resetActivePassthrough,
	startActivePassthroughBridge,
	stopActivePassthroughBridge,
} from "../modules/streaming/active-passthrough.ts";
import { AudioProbeTimeoutError } from "../modules/streaming/audio.ts";
import {
	broadcastHealthIfChanged,
	clearStreamProcessExit,
	collectLivenessSources,
	deriveStreamHealth,
	FRAMES_FRESHNESS_MS,
	reportStreamProcessExit,
	resetHealthBroadcastState,
	setHealthClockForTest,
} from "../modules/streaming/health.ts";
import {
	type LinkTelemetryMessage,
	setIfaceResolverForTest,
	setMockLinkTelemetryProvider,
	setTelemetryClockForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import { acceptStartAudio } from "../modules/streaming/start-audio.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	AUDIO_SOURCE_PROBE_FAILED,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";

type SocketHandlers = {
	data: (socket: unknown, chunk: Buffer) => void;
	close: () => void;
	error: () => void;
};

type Bridge = {
	/** Deliver one raw NDJSON frame exactly as the control socket would. */
	deliver: (frame: unknown) => void;
	/** The bridge's own socket closes (transient reconnect blip). */
	drop: () => void;
	/** The bridge's own socket errors (transient reconnect blip). */
	fail: () => void;
};

/**
 * Drive the REAL bridge over an injected socket, so the fix is exercised through
 * the production `onLine`/`close`/`error` handlers rather than a reimplementation.
 */
async function startBridgeWithFakeSocket(): Promise<Bridge> {
	let handlers: SocketHandlers | undefined;
	const socket = { write: () => {}, flush: () => {}, end: () => {} };
	const connect = ((options: { socket: SocketHandlers }) => {
		handlers = options.socket;
		return Promise.resolve(socket);
	}) as unknown as typeof Bun.connect;

	startActivePassthroughBridge({
		socketPath: "/nonexistent/ceralive-test/control.sock",
		connect,
		warn: () => {},
		onEngineReachable: () => {},
	});
	// connectOnce awaits the injected connect; let its microtasks settle.
	await Promise.resolve();
	await Promise.resolve();

	if (handlers === undefined) throw new Error("bridge never connected");
	const live = handlers;
	return {
		deliver: (frame) =>
			live.data(socket, Buffer.from(`${JSON.stringify(frame)}\n`, "utf8")),
		drop: () => live.close(),
		fail: () => live.error(),
	};
}

function statusFrame(activeEncode: unknown, streaming = true) {
	return {
		jsonrpc: "2.0",
		method: "event",
		params: {
			type: "status",
			seq: 1,
			state: streaming ? "streaming" : "idle",
			streaming,
			active_encode: activeEncode,
		},
	};
}

/** One healthy bonded link, so the bond can never be what makes health degraded. */
function healthyBond(): LinkTelemetryMessage {
	return {
		active_links: 1,
		links: [
			{
				conn_id: "0",
				iface: "eth0",
				rtt_ms: 12,
				nak_count: 0,
				weight_percent: 100,
				stale: false,
			},
		],
		lastReadMs: Date.now(),
	};
}

const senderRequestSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.number(),
	method: z.enum(["get_capabilities", "subscribe", "unsubscribe"]),
});

async function withSenderStats(
	check: (sender: {
		emit: (fullyActive: boolean) => Promise<void>;
		setOffset: (offset: number) => void;
	}) => Promise<void>,
) {
	setMockLinkTelemetryProvider(null);
	setIfaceResolverForTest(() => undefined);
	const epoch = Date.now() - 60_000;
	let now = epoch;
	setTelemetryClockForTest(() => now);
	resetHealthBroadcastState();
	const dir = mkdtempSync(join(tmpdir(), "link-health-"));
	const unix = join(dir, "control.sock");
	const subscription = Promise.withResolvers<{
		write(data: string): unknown;
	}>();
	const server = Bun.listen<{ buffer: string }>({
		unix,
		socket: {
			open(socket) {
				socket.data = { buffer: "" };
			},
			data(socket, bytes) {
				socket.data.buffer += bytes.toString();
				const lines = socket.data.buffer.split("\n");
				socket.data.buffer = lines.pop() ?? "";
				for (const line of lines) {
					const request: unknown = JSON.parse(line);
					const { method, id } = senderRequestSchema.parse(request);
					let result: Record<string, unknown>;
					switch (method) {
						case "get_capabilities":
							result = {
								schema_version: 1,
								binary: "srtla_send",
								version: "4.1.0",
								methods: ["subscribe", "unsubscribe"],
								capabilities: {
									bind_map: true,
									stats_file: true,
									dry_run: true,
									control_socket_jsonrpc: true,
									conn_timeout_ms: true,
									modes: ["classic"],
								},
							};
							break;
						case "subscribe":
							result = { subscription_id: "health-test" };
							break;
						case "unsubscribe":
							result = {};
							break;
						default:
							throw new Error(method satisfies never);
					}
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
					if (method === "subscribe") subscription.resolve(socket);
				}
			},
		},
	});
	try {
		startLinkTelemetry(join(dir, "stats.json"), ["192.0.2.1", "192.0.2.2"], {
			controlSocket: unix,
		});
		const socket = await subscription.promise;
		const emit = async (recovered: boolean) => {
			const data: SenderStats = {
				mode: "classic",
				links: [0, 1].map((conn_id) => ({
					conn_id,
					ip: `192.0.2.${conn_id + 1}`,
					iface: `eth${conn_id}`,
					connected: recovered || conn_id === 0,
					timed_out: !recovered && conn_id === 0,
					window: 8,
					in_flight: 0,
					rtt_ms: 40,
					nak_count: 0,
					bitrate_bytes_per_sec: 0,
					base_score: 8,
					quality_multiplier: 1,
				})),
			};
			const delivered = Promise.withResolvers<void>();
			const timeout = setTimeout(
				() =>
					delivered.reject(new Error("Sender stats.update was not ingested")),
				1000,
			);
			// The watcher stamps an observation only after it has ingested it.
			setTelemetryClockForTest(() => {
				delivered.resolve();
				return now;
			});
			try {
				socket.write(
					`${JSON.stringify({ jsonrpc: "2.0", method: "stats.update", params: { subscription_id: "health-test", data } })}\n`,
				);
				await delivered.promise;
			} finally {
				clearTimeout(timeout);
				setTelemetryClockForTest(() => now);
			}
		};
		await check({
			emit,
			setOffset: (offset) => {
				now = epoch + offset;
			},
		});
	} finally {
		stopLinkTelemetry();
		setTelemetryClockForTest(null);
		resetHealthBroadcastState();
		setIfaceResolverForTest(null);
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("sender connection flags reach real health through the control subscription", async () => {
	await withSenderStats(async ({ emit, setOffset }) => {
		const health = () => deriveStreamHealth(collectLivenessSources());
		await emit(false);
		expect(health()).toMatchObject({
			state: "degraded",
			bond: { linkCount: 2, activeLinks: 0 },
		});
		expect(health().bond.activity_unknown).toBeUndefined();
		setOffset(5001);
		expect(health().state).toBe("unknown");
		await emit(true);
		expect(health()).toMatchObject({
			state: "healthy",
			bond: { linkCount: 2, activeLinks: 2 },
		});
	});
});

test("sparse healthy reports do not flap health after sender observations expire", async () => {
	await withSenderStats(async ({ emit, setOffset }) => {
		const states = [];
		for (const { sample, delivery } of [
			{ sample: 30000, delivery: 30000 },
			{ sample: 35001 },
			{ sample: 40001, delivery: 35002 },
			{ sample: 45003, delivery: 40002 },
			{ sample: 50003, delivery: 45004 },
			{ sample: 50004, delivery: 50004 },
			{ sample: 51004, delivery: 51004 },
			{ sample: 52004, delivery: 52004 },
		]) {
			if (delivery !== undefined) {
				setOffset(delivery);
				await emit(true);
			}
			setOffset(sample);
			states.push(broadcastHealthIfChanged().state);
		}
		expect(states).toEqual([
			"healthy",
			"unknown",
			"unknown",
			"unknown",
			"unknown",
			"unknown",
			"healthy",
			"healthy",
		]);
	});
});

const audioPipeline = {
	source: "hdmi",
	name: "Test HDMI",
	hardware: "rk3588",
	description: "test pipeline",
	supportsAudio: true,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audio_kind: "selectable",
} as Pipeline;

beforeEach(() => {
	// A sibling test file may have booted the real bridge in this same process;
	// stop it so the injected socket below is the one that connects.
	stopActivePassthroughBridge();
	setMockLinkTelemetryProvider(healthyBond);
	clearStreamProcessExit();
	updateStatus(true);
});

afterEach(() => {
	stopActivePassthroughBridge();
	setMockLinkTelemetryProvider(null);
	setHealthClockForTest(null);
	clearStreamProcessExit();
	resetActiveEncodeLiveness();
	resetActivePassthrough();
	updateStatus(false);
});

describe("a transient bridge disconnect never erases the session's liveness", () => {
	test("a mid-stream drop leaves the last real reading to age out into degraded", async () => {
		const bridge = await startBridgeWithFakeSocket();

		bridge.deliver(
			statusFrame({
				codec: "h265",
				frames_emitted: 30_100,
				pipeline_playing: true,
			}),
		);
		bridge.deliver(
			statusFrame({
				codec: "h265",
				frames_emitted: 30_415,
				pipeline_playing: true,
			}),
		);
		// The counter freezes — the cable is out, the encode has stopped moving.
		bridge.deliver(
			statusFrame({
				codec: "h265",
				frames_emitted: 30_415,
				pipeline_playing: true,
			}),
		);
		const lastHeartbeatAt = Date.now();
		expect(collectLivenessSources().framesAdvancing).toBe(false);

		bridge.drop();

		// The bridge lost ITS socket. The session did not end, so the reading stands.
		expect(getActiveEncodeLiveness()?.framesEmitted).toBe(30_415);

		setHealthClockForTest(() => lastHeartbeatAt + FRAMES_FRESHNESS_MS + 1);
		const sources = collectLivenessSources();
		expect(sources.isStreaming).toBe(true);
		expect(sources.processAlive).toBe(true);
		expect(sources.framesAdvancing).toBe(false);
		expect(sources.frameCount).toBe(30_415);

		const health = deriveStreamHealth(sources);
		expect(health.state).toBe("degraded");
		expect(health.frames).toEqual({ advancing: false, count: 30_415 });
		expect(health.reason).toEqual({
			component: "frames",
			detail: "No frames advancing",
		});
	});

	test("a socket error is the same blip as a close", async () => {
		const bridge = await startBridgeWithFakeSocket();

		bridge.deliver(
			statusFrame({
				codec: "h265",
				frames_emitted: 900,
				pipeline_playing: true,
				passthrough: true,
			}),
		);
		bridge.fail();

		expect(getActiveEncodeLiveness()?.framesEmitted).toBe(900);
		expect(getActivePassthrough()).toBe(true);
	});

	test("telemetry still fresh at the moment of the drop keeps its own verdict", async () => {
		const bridge = await startBridgeWithFakeSocket();

		bridge.deliver(
			statusFrame({
				codec: "h265",
				frames_emitted: 10,
				pipeline_playing: true,
			}),
		);
		bridge.deliver(
			statusFrame({
				codec: "h265",
				frames_emitted: 70,
				pipeline_playing: true,
			}),
		);
		const lastHeartbeatAt = Date.now();
		bridge.drop();

		// Inside the freshness window a single dropped heartbeat must not flap the
		// verdict — that is what the window is sized for.
		setHealthClockForTest(() => lastHeartbeatAt + FRAMES_FRESHNESS_MS - 1);
		const sources = collectLivenessSources();
		expect(sources.framesAdvancing).toBe(true);
		expect(sources.frameCount).toBe(70);
		expect(deriveStreamHealth(sources).state).toBe("healthy");
	});
});

describe("a genuine session boundary still clears the caches", () => {
	test("an engine-authored streaming:false clears both caches immediately", async () => {
		const bridge = await startBridgeWithFakeSocket();

		bridge.deliver(
			statusFrame({
				codec: "h265",
				frames_emitted: 500,
				pipeline_playing: true,
				passthrough: true,
			}),
		);
		expect(getActiveEncodeLiveness()).toBeDefined();
		expect(getActivePassthrough()).toBe(true);

		bridge.deliver(statusFrame(undefined, false));

		expect(getActiveEncodeLiveness()).toBeUndefined();
		expect(getActivePassthrough()).toBeUndefined();
	});

	test("a fresh stream start drops the previous session's counter", async () => {
		ingestLivenessForTest(
			statusFrame({
				codec: "h265",
				frames_emitted: 30_415,
				pipeline_playing: true,
			}),
			1000,
		);
		expect(getActiveEncodeLiveness()?.framesEmitted).toBe(30_415);

		const config = getConfig();
		const savedAsrc = config.asrc;
		config.asrc = "HDMI";
		try {
			// The reset runs ahead of the audio probe, so even an aborted start
			// proves the seam without spawning a sender or touching the engine.
			const result = await startStream(
				audioPipeline,
				"192.0.2.10",
				5000,
				"sid",
				{
					probe: () => Promise.reject(new AudioProbeTimeoutError("HDMI")),
				},
				undefined,
				{ ...getConfig() },
				acceptStartAudio(),
			);
			expect(result).toMatchObject({
				success: false,
				error: AUDIO_SOURCE_PROBE_FAILED,
			});
		} finally {
			config.asrc = savedAsrc;
		}

		expect(getActiveEncodeLiveness()).toBeUndefined();
		expect(getActivePassthrough()).toBeUndefined();
	});
});

describe("a genuine cold start still falls back to process liveness", () => {
	test("no telemetry ever received reports the process verdict, with no frame count", () => {
		resetActiveEncodeLiveness();

		const sources = collectLivenessSources();
		expect(sources.framesAdvancing).toBe(true);
		expect(sources.frameCount).toBeNull();
		expect(deriveStreamHealth(sources).state).toBe("healthy");
	});

	test("a cold start whose process has exited reports dead, not advancing", () => {
		resetActiveEncodeLiveness();
		reportStreamProcessExit();

		const sources = collectLivenessSources();
		expect(sources.processAlive).toBe(false);
		expect(sources.framesAdvancing).toBe(false);
		expect(deriveStreamHealth(sources).state).toBe("dead");
	});
});
