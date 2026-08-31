import { describe, expect, test } from "bun:test";

import type { CerastreamClient } from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import { ENGINE_CLOSE_DEADLINE_MS } from "../modules/streaming/start-lifecycle-timing.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";

// device-quality-wave3: a stop that never settles used to POISON the session.
//
// Board symptom: after a successful stream, `streaming.stop` never completed,
// the board kept reporting `healthy`/streaming, and every later start was
// refused — recoverable only with `systemctl restart cerastream`.
//
// Two independent defects compose into that wedge:
//   (1) the engine `client.close()` on the stop path had no bound, so
//       `stopGeneration` never resolved; and
//   (2) once the 12 s stop deadline fired, `stop_failed` was UNESCAPABLE —
//       `start()` only leaves it when the streaming status already reads
//       false (the failed stop never cleared it) and `reconcile()` refused to
//       run at all in that state, so the `stop_failed → idle` recovery the
//       lifecycle table declares was unreachable.

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "sid",
};

function makeConfig(): RuntimeConfig {
	return {
		pipeline: "hdmi",
		max_br: 8000,
		srt_latency: 2000,
		balancer: "adaptive",
		selected_video_input: "/dev/video0",
		acodec: "opus",
		delay: 0,
	};
}

/**
 * A client whose `close()` NEVER settles — the board's wedged libuvc release,
 * where the engine stops answering while it hands `/dev/videoN` back to
 * `uvcvideo`.
 */
function makeHangingCloseClient(closeHangs: boolean): CerastreamClient {
	return {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.4.0",
			engine_version: "test",
		},
		start: async () => ({ session_id: "s1", state: "streaming" as const }),
		stop: async () => ({ state: "idle" as const }),
		reloadConfig: async (params: unknown) => ({ applied: params }),
		setBitrate: async (params: { max_bitrate: number }) => ({
			applied: { max_bitrate: params.max_bitrate },
		}),
		switchInput: async (params: { input_id: string; mode: string }) => ({
			active_input: params.input_id,
			mode: params.mode as "manual" | "auto",
		}),
		listDevices: async () => ({ devices: [] }),
		subscribeEvents: async () => ({
			result: { subscribed: [] as never[] },
			close: () => {},
		}),
		// The defect under test: the session connection never closes.
		close: () => (closeHangs ? new Promise<void>(() => {}) : Promise.resolve()),
	} as unknown as CerastreamClient;
}

describe("a stop that never settles must not poison the session", () => {
	test("the session close is bounded, so an acknowledged stop still reports completion", async () => {
		// Given a started session whose control socket will never answer close,
		// while the independent stop connection remains usable.
		const deadlines: Array<{ callback: () => void; delayMs: number }> = [];
		let connections = 0;
		const backend = new CerastreamBackend({
			connect: async () => {
				connections += 1;
				return makeHangingCloseClient(connections === 1);
			},
			connectOptions: {},
			getConfig: makeConfig,
			saveConfig: () => {},
			bridge: {
				notify: () => {},
				notificationExists: () => false,
				removeNotification: () => {},
				broadcastStatus: () => {},
				broadcastBuffering: () => {},
			},
			execPath: "cerastream",
			configPath: "/tmp/stop-wedge-recovery.json",
			logger: silentLogger,
			getActiveInput: () => undefined,
			isEmbeddedAudioActive: () => false,
			scheduleTimeout: (callback, delayMs) => {
				deadlines.push({ callback, delayMs });
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancelTimeout: () => {},
		});
		await backend.start(makeConfig(), RUN_OPTS);
		await backend.settle();

		// When the session is stopped and the engine never closes the socket.
		let stopped = false;
		expect(
			backend.stop(() => {
				stopped = true;
			}),
		).toBe(true);
		for (let i = 0; i < 10; i += 1) {
			if (
				deadlines.some(({ delayMs }) => delayMs === ENGINE_CLOSE_DEADLINE_MS)
			) {
				break;
			}
			await Promise.resolve();
		}

		// Then a bound was armed for the close...
		const closeDeadline = deadlines.find(
			({ delayMs }) => delayMs === ENGINE_CLOSE_DEADLINE_MS,
		);
		expect(closeDeadline).toBeDefined();
		closeDeadline?.callback();
		await backend.settle();

		// ...and the stop completes rather than hanging forever.
		expect(stopped).toBe(true);
	});

	test("a stop that missed its deadline is recoverable, not terminal", async () => {
		// Given a runtime stop that never settles (defect 1 above), so the
		// orchestrator's own 12 s bound is what answers the RPC.
		let streamingStatus = false;
		let deadlineCallback: (() => void) | undefined;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: (() => {
				let n = 0;
				return () => `attempt-${++n}`;
			})(),
			setStreamingStatus: (value) => {
				streamingStatus = value;
			},
			getStreamingStatus: () => streamingStatus,
			stopRuntime: () => new Promise<void>(() => {}),
			// The engine, asked directly, reports it is NOT streaming.
			queryRuntime: async () => "idle",
			stopDeadlineMs: 12_000,
			scheduleTimeout: (callback) => {
				deadlineCallback = callback;
				return 1;
			},
			cancelTimeout: () => {},
		});
		await orchestrator.start({ origin: "ui", launch: async () => {} });
		expect(streamingStatus).toBe(true);

		const stopping = orchestrator.stop("operator");
		deadlineCallback?.();
		expect(await stopping).toEqual({
			result: "stop_failed",
			reason: "stop_timeout",
		});
		expect(orchestrator.snapshot().state).toBe("stop_failed");

		// When the session reconciles against the engine's actual truth.
		const reconciled = await orchestrator.reconcile();

		// Then `stop_failed` is escaped rather than latched forever.
		expect(reconciled).toBe("idle");
		expect(streamingStatus).toBe(false);

		// And the next start is admissible — one wedged stop no longer costs
		// the operator every subsequent cycle.
		expect(
			await orchestrator.start({ origin: "ui", launch: async () => {} }),
		).toMatchObject({ result: "started" });
	});
});
