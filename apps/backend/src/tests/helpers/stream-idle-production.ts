import { spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../../modules/config.ts";
import { setup } from "../../modules/setup.ts";
import * as runtime from "../../modules/streaming/engine-runtime-state.ts";
import { setPreviewEncodeReplayTransport } from "../../modules/streaming/preview-encode-replay.ts";
import {
	classifyStartFailure,
	StreamStartFailure,
} from "../../modules/streaming/start-failure-taxonomy.ts";
import {
	createStreamSessionOrchestrator,
	type StreamSessionOrchestratorDeps,
} from "../../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../../modules/streaming/stream-session-production.ts";
import * as registry from "../../modules/streaming/streaming-engine.ts";
import {
	setStartStreamDepsForTest,
	startStream,
} from "../../modules/streaming/streamloop/start-stream.ts";
import { evidenceHarness, flushEvidence } from "./stream-engine-evidence.ts";

/** Real factory, ownership, filesystem sentinel, startStream and stopGeneration.
 * Only the engine wire and sender process/telemetry are host ports. */
export function idleProductionHarness(
	directory: string,
	ports: Partial<StreamSessionOrchestratorDeps> = {},
) {
	const engine = evidenceHarness();
	const selector = spyOn(registry, "getStreamingBackend").mockReturnValue(
		engine.backend,
	);
	const query = spyOn(
		runtime,
		"queryEngineRuntimeStreaming",
	).mockImplementation(() => engine.backend.reconcileRuntimeState());
	const savedIps = setup.ips_file;
	const savedPreview = getConfig().previewEncode;
	setup.ips_file = join(directory, "ips");
	writeFileSync(setup.ips_file, "192.0.2.1\n");
	getConfig().previewEncode = undefined;
	setPreviewEncodeReplayTransport(async () => undefined);
	const children: ReturnType<typeof Bun.spawn>[] = [];
	let live = false;
	let launches = 0;
	let id = 0;
	setStartStreamDepsForTest({
		getStreamingBackend: () => engine.backend,
		spawnStreamingLoop: () => {
			launches++;
			const proc = Bun.spawn(["/usr/bin/true"], {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "pipe",
			});
			children.push(proc);
			return { proc, spawnfile: "srtla_send", exitListeners: [] };
		},
		startLinkTelemetry: () => undefined,
		stopLinkTelemetry: () => undefined,
		stopProcessAndWait: async (sender) => {
			await sender.proc.exited;
		},
	});
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		createAttemptId: () => `idle-${++id}`,
		setStreamingStatus: (value) => {
			live = value;
		},
		getStreamingStatus: () => live,
		setLifecycleState: () => undefined,
		awaitRecovery: async () => undefined,
		recoveryPending: () => false,
		blockingMutation: () => undefined,
		admitUpdate: async () => ({ allowed: true }),
		onStreamCommitted: () => undefined,
		onStreamArmed: () => undefined,
		onStreamStopped: () => undefined,
		...ports,
	});
	engine.setStatusSink(session.noteEngineStatus);
	const start = () =>
		session.start({
			origin: "ui",
			launch: async (context) => {
				const result = await startStream(
					{
						source: "hdmi",
						name: "Host",
						hardware: "generic",
						description: "Host",
						supportsAudio: false,
						supportsResolutionOverride: false,
						supportsFramerateOverride: false,
						audio_kind: "none",
					},
					"192.0.2.2",
					5000,
					"host",
					{},
					context.attemptId,
					{
						pipeline: "hdmi",
						max_br: 8000,
						balancer: "adaptive",
						srt_latency: 2000,
					},
				);
				if (!result.success)
					throw new StreamStartFailure(
						classifyStartFailure(result.phase, result.error, context.attemptId),
					);
			},
		});
	const expireProbe = async () => {
		await Promise.all(children.map((child) => child.exited));
		await flushEvidence();
		for (const callback of [...engine.timers.values()]) callback();
		await flushEvidence();
	};
	return {
		engine,
		session,
		start,
		expireProbe,
		calls: () => engine.clients.flatMap((client) => client.calls),
		view: () => ({
			live,
			launches,
			liveness: session.streamLiveness(),
			state: session.snapshot().state,
		}),
		dispose: async () => {
			selector.mockRestore();
			query.mockRestore();
			setup.ips_file = savedIps;
			getConfig().previewEncode = savedPreview;
			setPreviewEncodeReplayTransport(null);
			setStartStreamDepsForTest(null);
			engine.dispose();
			await Promise.all(children.map((child) => child.exited));
		},
	};
}
