import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import type { Pipeline } from "../modules/streaming/pipelines.ts";
import { setPreviewEncodeReplayTransport } from "../modules/streaming/preview-encode-replay.ts";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import {
	setStartStreamDepsForTest,
	startStream,
} from "../modules/streaming/streamloop/start-stream.ts";
import {
	evidenceHarness,
	flushEvidence,
} from "./helpers/stream-engine-evidence.ts";

let directory = "";
let marker = "";
let previous: string | undefined;
let savedIps: string | undefined;
let savedPreview: ReturnType<typeof getConfig>["previewEncode"];
const engines: ReturnType<typeof evidenceHarness>[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-boot-"));
	marker = join(directory, "streaming");
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = marker;
	savedIps = setup.ips_file;
	setup.ips_file = join(directory, "ips");
	writeFileSync(setup.ips_file, "192.0.2.1\n");
	savedPreview = getConfig().previewEncode;
	getConfig().previewEncode = undefined;
	setPreviewEncodeReplayTransport(async () => undefined);
});
afterEach(async () => {
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	setup.ips_file = savedIps;
	getConfig().previewEncode = savedPreview;
	setPreviewEncodeReplayTransport(null);
	setStartStreamDepsForTest(null);
	for (const engine of engines.splice(0)) engine.dispose();
	await Promise.all(children.splice(0).map((child) => child.exited));
	await rm(directory, { recursive: true, force: true });
});

function bootHarness(realProbe = false) {
	let launches = 0;
	let stops = 0;
	const engine = evidenceHarness();
	engines.push(engine);
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
	const observation = Promise.withResolvers<"unknown">();
	const session = createStreamSessionOrchestrator({
		...streamSessionProductionDeps,
		createAttemptId: () => "fresh-boot",
		setStreamingStatus: () => undefined,
		getStreamingStatus: () => false,
		setLifecycleState: () => undefined,
		queryRuntime: () =>
			realProbe ? engine.backend.reconcileRuntimeState() : observation.promise,
		stopRuntime: async () => {
			stops++;
			await engine.backend.confirmStop();
		},
		awaitRecovery: async () => undefined,
		recoveryPending: () => false,
		blockingMutation: () => undefined,
		admitUpdate: async () => ({ allowed: true }),
		onStreamCommitted: () => undefined,
		onStreamArmed: () => undefined,
		onStreamStopped: () => undefined,
	});
	return {
		session,
		observation,
		engine,
		start: () =>
			session.start({
				origin: "ui",
				launch: async () => {
					const pipeline = {
						source: "hdmi",
						name: "Host test",
						hardware: "generic",
						description: "Host test",
						supportsAudio: false,
						supportsResolutionOverride: false,
						supportsFramerateOverride: false,
						audio_kind: "none",
					} satisfies Pipeline;
					const result = await startStream(
						pipeline,
						"192.0.2.2",
						5000,
						"test",
						{},
						"fresh-boot",
						{
							pipeline: "hdmi",
							max_br: 8000,
							balancer: "adaptive",
							srt_latency: 2000,
						},
					);
					if (!result.success) throw new Error(result.error);
				},
			}),
		view: () => ({ launches, stops, liveness: session.streamLiveness() }),
	};
}

test("fresh boot without a sentinel admits Start even when the engine is silent", async () => {
	// Given the real production sentinel/initialization ports and no surviving session.
	const h = bootHarness();
	expect(h.view().liveness).toBe("idle");
	// When Start is requested without any engine status event or reply.
	const result = await h.start();
	// Then no passive probe or automatic Stop is needed to admit the first effect.
	expect(result).toMatchObject({ result: "started" });
	expect(h.view()).toMatchObject({ launches: 1, stops: 0 });
	expect(h.engine.clients.flatMap((client) => client.calls)).toContain("start");
	expect(existsSync(marker)).toBe(true);
});

test("production silent backend probe preserves empty boot admission for Start and updates", async () => {
	// Given production initialization and the real CerastreamBackend, with no sentinel.
	const h = bootHarness(true);
	const probe = h.session.reconcile();
	await flushEvidence();
	expect(h.session.streamLiveness()).toBe("unknown");
	// When the real probe expires with no status event or reply.
	for (const callback of [...h.engine.timers.values()]) callback();
	await probe;
	// Then tri-state consumers see no stream veto and the production launch dispatches.
	expect(h.session.streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(false);
	expect(await h.start()).toMatchObject({ result: "started" });
	expect(
		h.engine.clients
			.flatMap((client) => client.calls)
			.filter((call) => call === "start"),
	).toHaveLength(1);
});

test("uncertain fresh-boot Start cannot restore the empty baseline after silence", async () => {
	// Given the real empty-boot factory with a Start whose effect/rollback is unknown.
	const h = bootHarness();
	h.observation.resolve("unknown");
	// When the dispatched attempt fails without positive rollback evidence.
	await h.session.start({
		origin: "ui",
		launch: async () => {
			throw new StreamStartFailure({
				attemptId: "fresh-boot",
				phase: "start-rpc",
				class: "start_timeout",
				retriable: false,
			});
		},
	});
	await h.session.reconcile();
	// Then the prior empty boot is no longer authority to admit replacement.
	expect(h.view().liveness).toBe("unknown");
	expect(await h.start()).toMatchObject({ result: "busy" });
	expect(existsSync(marker)).toBe(true);
});

test("silent unprotected boot probe gates only while observation is in flight", async () => {
	// Given empty /run evidence and a held runtime observation.
	const h = bootHarness();
	const probe = h.session.reconcile();
	expect(h.view().liveness).toBe("unknown");
	expect(await h.start()).toMatchObject({ result: "busy" });
	// When the current probe settles without engine evidence.
	h.observation.resolve("unknown");
	await probe;
	// Then the empty baseline remains actionable without fabricating a sentinel.
	expect(h.view()).toEqual({ launches: 0, stops: 0, liveness: "idle" });
	expect(existsSync(marker)).toBe(false);
	expect(await h.start()).toMatchObject({ result: "started" });
});

test("sentinel-backed silence refuses Start until acknowledged operator Stop", async () => {
	// Given surviving physical protection at the real production factory seam.
	writeFileSync(marker, "");
	const h = bootHarness();
	h.observation.resolve("unknown");
	// When silence cannot confirm the protected engine idle.
	expect(await h.start()).toMatchObject({ result: "busy" });
	expect(h.view()).toEqual({ launches: 0, stops: 0, liveness: "unknown" });
	expect(existsSync(marker)).toBe(true);
	// Then an acknowledged operator Stop clears protection and enables a new Start.
	expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
	expect(existsSync(marker)).toBe(false);
	expect(h.view().liveness).toBe("idle");
	expect(await h.start()).toMatchObject({ result: "started" });
	expect(h.view()).toMatchObject({ launches: 1, stops: 1 });
});

for (const evidence of ["dangling-symlink", "unreadable-ancestor"] as const) {
	test(`boot evidence ${evidence} cannot grant an unprotected baseline`, () => {
		// Given a dangling sentinel or a non-directory ancestor, not ENOENT absence.
		if (evidence === "dangling-symlink") symlinkSync("missing", marker);
		else {
			writeFileSync(marker, "not-a-directory");
			process.env.CERALIVE_STREAMING_MARKER = join(marker, "child");
		}
		// When production initialization observes the real filesystem evidence.
		const h = bootHarness();
		// Then broken/unreadable authority stays UNKNOWN, not an idle grant.
		expect(h.view().liveness).toBe("unknown");
	});
}

test("a sentinel appearing during an empty-boot probe keeps admission closed", async () => {
	// Given an empty baseline and an outstanding current observation.
	const h = bootHarness();
	const probe = h.session.reconcile();
	// When protection appears before the silent observation settles.
	writeFileSync(marker, "");
	h.observation.resolve("unknown");
	await probe;
	// Then absence sampled before the await cannot release newer protection.
	expect(h.view().liveness).toBe("unknown");
	expect(await h.start()).toMatchObject({ result: "busy" });
	expect(existsSync(marker)).toBe(true);
});
