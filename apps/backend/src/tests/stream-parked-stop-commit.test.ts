import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusEventSchema } from "@ceralive/cerastream";
import {
	defaultArmedStreamMarkerDeps,
	noteStreamStopped,
} from "../modules/streaming/armed-stream-marker.ts";
import {
	armStreamRestoration,
	runStreamRestoration,
} from "../modules/streaming/stream-restoration.ts";
import { flushEvidence } from "./helpers/stream-engine-evidence.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

let directory = "";
let sentinel = "";
let previous: string | undefined;
let h: ReturnType<typeof idleProductionHarness> | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-b2c-parked-"));
	sentinel = join(directory, "streaming");
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = sentinel;
});
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});

function markerPorts(root = directory) {
	return {
		...defaultArmedStreamMarkerDeps,
		markerPath: join(root, "armed.json"),
		readBootId: () => "11111111-1111-4111-8111-111111111111",
	};
}
function captureStatus(transition: boolean) {
	return statusEventSchema.parse({
		type: "status",
		seq: transition ? 1 : 2,
		state: "streaming",
		streaming: true,
		active_encode: {
			codec: "h264",
			resolution: "1920x1080",
			framerate: 30,
			capture: {
				state: "normal",
				live_inputs: ["hdmi"],
				degraded_inputs: [],
				failover_rate_policy: "retime",
				...(transition ? { transition: { kind: "adapt", since_ms: 1 } } : {}),
			},
		},
	});
}
function parkedHarness(onArmed?: (current: () => boolean) => void) {
	const marker = markerPorts();
	const timers = new Map<number, () => void>();
	let timerId = 0;
	let commits = 0;
	const harness = idleProductionHarness(directory, {
		onStreamCommitted: (current) => {
			if (current()) commits++;
		},
		onStreamArmed:
			onArmed ??
			((current) => {
				if (current())
					armStreamRestoration({
						marker,
						captureConfig: () => ({ pipeline: "hdmi" }),
						now: () => 1,
					});
			}),
		onStreamStopped: (cause) => noteStreamStopped(cause, marker),
		scheduleTimeout: (callback) => {
			const id = ++timerId;
			timers.set(id, callback);
			return id;
		},
		cancelTimeout: (id) => {
			if (typeof id === "number") timers.delete(id);
		},
	});
	h = harness;
	return { harness, marker, commits: () => commits };
}

for (const joiningLoss of [false, true]) {
	test(
		joiningLoss
			? "operator joining a transition-parked machine Stop cancels pending commitment"
			: "engine-transition parked Stop cannot rearm a pending Start",
		async () => {
			// Given a real Start dispatched, with acknowledgement held and adapt latched.
			const { harness, marker, commits } = parkedHarness();
			const ack = Promise.withResolvers<void>();
			harness.engine.holdStart(ack.promise);
			const starting = harness.start();
			await harness.engine.started;
			harness.engine.clients[0]?.emit(captureStatus(true));
			const loss = joiningLoss
				? harness.session.stop("engine_loss")
				: undefined;
			// When operator intent precedes the acknowledgement but Stop remains parked.
			const stopping = harness.session.stop("operator");
			ack.resolve();
			await harness.engine.backend.settle();
			await flushEvidence();
			const beforeRelease = {
				armed: existsSync(marker.markerPath),
				sentinel: existsSync(sentinel),
				commits: commits(),
				calls: harness.calls(),
				state: harness.session.snapshot().state,
			};
			// Release through the real current subscription, not an owner-only callback.
			harness.engine.clients[0]?.emit(captureStatus(false));
			const result = await starting;
			await loss;
			expect(await stopping).toEqual({ result: "stopped" });
			// Then commitment is revoked, cleanup stays deferred, and protection clears last.
			expect(beforeRelease).toEqual({
				armed: false,
				sentinel: true,
				commits: 0,
				calls: ["subscribe", "start"],
				state: "starting",
			});
			expect(result).toEqual({ result: "cancelled", attemptId: "idle-1" });
			expect(harness.calls().filter((call) => call === "stop")).toEqual([
				"stop",
			]);
			expect(harness.engine.view().engine).toBe("idle");
			expect(existsSync(marker.markerPath)).toBe(false);
			expect(existsSync(sentinel)).toBe(false);
			expect(harness.session.streamLiveness()).toBe("idle");
		},
	);
}

test("a fresh factory over the files left by a parked Stop does not restore", async () => {
	// Given the filesystem at the pre-release restart/crash point, not old latches.
	const { harness, marker } = parkedHarness();
	const ack = Promise.withResolvers<void>();
	harness.engine.holdStart(ack.promise);
	const starting = harness.start();
	await harness.engine.started;
	harness.engine.clients[0]?.emit(captureStatus(true));
	const stopping = harness.session.stop("operator");
	ack.resolve();
	await harness.engine.backend.settle();
	await flushEvidence();
	const restartRoot = join(directory, "restart");
	mkdirSync(restartRoot);
	copyFileSync(sentinel, join(restartRoot, "streaming"));
	if (existsSync(marker.markerPath))
		copyFileSync(marker.markerPath, join(restartRoot, "armed.json"));
	// Retire the old fixture after freezing exactly the files it left at that point.
	harness.engine.clients[0]?.emit(captureStatus(false));
	await Promise.all([starting, stopping]);
	await harness.dispose();
	h = undefined;
	process.env.CERALIVE_STREAMING_MARKER = join(restartRoot, "streaming");
	const fresh = idleProductionHarness(restartRoot);
	h = fresh;
	// When a fresh real owner/engine parser observes affirmative idle and restores.
	const restored = await runStreamRestoration({
		marker: markerPorts(restartRoot),
		awaitRecovery: async () => undefined,
		runtimeState: async () => {
			const observing = fresh.session.reconcile();
			await flushEvidence();
			fresh.engine.status(0, false);
			await observing;
			return "idle";
		},
		lifecycleState: () => fresh.session.snapshot().state,
		launch: async () => {
			await fresh.start();
			return { ok: true };
		},
		publish: () => undefined,
		now: () => 100,
	});
	// Then no armed file, launch, media effect or automatic Stop survives intent.
	expect(restored).toEqual({ result: "blocked", reason: "no_marker" });
	expect(fresh.view().launches).toBe(0);
	expect(fresh.engine.view().engine).toBe("idle");
	expect(fresh.calls()).toEqual(["subscribe", "unsubscribe", "close"]);
	expect(existsSync(join(restartRoot, "armed.json"))).toBe(false);
	expect(existsSync(join(restartRoot, "streaming"))).toBe(false);
});

test("a delayed arming hook loses authority when operator Stop parks", async () => {
	// Given a committed Start whose production-style lazy hook has not run yet.
	let current: (() => boolean) | undefined;
	const { harness, marker } = parkedHarness((predicate) => {
		current = predicate;
	});
	await harness.start();
	harness.engine.clients[0]?.emit(captureStatus(true));
	// When Stop parks before lazy import/arming completes.
	const stopping = harness.session.stop("operator");
	if (current?.())
		armStreamRestoration({
			marker,
			captureConfig: () => ({ pipeline: "hdmi" }),
		});
	const rearmed = existsSync(marker.markerPath);
	harness.engine.clients[0]?.emit(captureStatus(false));
	await stopping;
	// Then the hook's final predicate cannot resurrect restoration intent.
	expect(rearmed).toBe(false);
	expect(existsSync(sentinel)).toBe(false);
});
