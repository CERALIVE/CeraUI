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
	clearStreamProcessExit,
	collectLivenessSources,
	deriveStreamHealth,
	FRAMES_FRESHNESS_MS,
	reportStreamProcessExit,
	setHealthClockForTest,
} from "../modules/streaming/health.ts";
import {
	type LinkTelemetryMessage,
	setMockLinkTelemetryProvider,
} from "../modules/streaming/link-telemetry.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
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
