import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ArmedStreamMarkerDeps,
	noteStreamStopped,
} from "../modules/streaming/armed-stream-marker.ts";
import { runStreamRestoration } from "../modules/streaming/stream-restoration.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

let directory = "";
let sentinel = "";
let previous: string | undefined;
let h: ReturnType<typeof idleProductionHarness> | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-b2b-intent-"));
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
function markerPorts(): ArmedStreamMarkerDeps {
	return {
		markerPath: join(directory, "armed.json"),
		readBootId: () => "11111111-1111-4111-8111-111111111111",
		readMarker: (path) =>
			existsSync(path) ? readFileSync(path, "utf8") : undefined,
		writeMarker: (path, text) => writeFileSync(path, text),
		removeMarker: (path) => rmSync(path, { force: true }),
	};
}
function arm(marker: ArmedStreamMarkerDeps) {
	writeFileSync(
		marker.markerPath,
		JSON.stringify({
			armedAt: 1,
			bootId: marker.readBootId(),
			config: { pipeline: "hdmi" },
		}),
	);
}

test("oracle operator joining engine_loss Stop must disarm real restoration intent", async () => {
	// Given a real armed live session and an engine-loss Stop held before acknowledgement.
	const marker = markerPorts();
	const causes: string[] = [];
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = idleProductionHarness(directory, {
		onStreamArmed: (current) => {
			if (current()) arm(marker);
		},
		onStreamStopped: (cause) => {
			causes.push(cause);
			noteStreamStopped(cause, marker);
		},
		stopRuntime: async (generation, confirmUnknown) => {
			entered.resolve();
			await release.promise;
			await streamSessionProductionDeps.stopRuntime(generation, confirmUnknown);
		},
	});
	h = harness;
	await harness.start();
	harness.engine.setEngine("idle");
	const lost = harness.session.stop("engine_loss");
	await entered.promise;
	// When the operator joins the same cleanup, intent must be processed immediately.
	const operator = harness.session.stop("operator");
	const disarmedBeforeAck = existsSync(marker.markerPath);
	release.resolve();
	expect(await lost).toEqual({ result: "stopped" });
	expect(await operator).toEqual({ result: "stopped" });
	const restored = await runStreamRestoration({
		marker,
		awaitRecovery: async () => undefined,
		runtimeState: async () => "idle",
		lifecycleState: () => harness.session.snapshot().state,
		launch: async () => {
			await harness.start();
			return { ok: true };
		},
		publish: () => undefined,
	});
	// Then one cleanup settled, but no restoration survives the joining operator's intent.
	expect(disarmedBeforeAck).toBe(false);
	expect(causes).toEqual(["engine_loss", "operator"]);
	expect(restored).toEqual({ result: "blocked", reason: "no_marker" });
	expect(harness.view().launches).toBe(1);
	expect(harness.calls().filter((call) => call === "stop")).toHaveLength(1);
	expect(existsSync(sentinel)).toBe(false);
});

test("operator disarm during restoration observation prevents a stale-marker relaunch", async () => {
	// Given a retained marker captured by a restoration run's held runtime observation.
	const marker = markerPorts();
	const harness = idleProductionHarness(directory, {
		onStreamArmed: (current) => {
			if (current()) arm(marker);
		},
		onStreamStopped: (cause) => noteStreamStopped(cause, marker),
	});
	h = harness;
	await harness.start();
	await harness.session.stop("engine_loss");
	const entered = Promise.withResolvers<void>();
	const query = Promise.withResolvers<"idle">();
	const restoring = runStreamRestoration({
		marker,
		awaitRecovery: async () => undefined,
		runtimeState: async () => {
			entered.resolve();
			return await query.promise;
		},
		lifecycleState: () => harness.session.snapshot().state,
		launch: async () => {
			await harness.start();
			return { ok: true };
		},
		publish: () => undefined,
	});
	await entered.promise;
	// When operator Stop disarms while that observation is outstanding.
	await harness.session.stop("operator");
	query.resolve("idle");
	const outcome = await restoring;
	// Then old intent cannot authorize the next launch.
	expect(outcome).toEqual({ result: "blocked", reason: "no_marker" });
	expect(harness.view().launches).toBe(1);
	expect(existsSync(marker.markerPath)).toBe(false);
	expect(existsSync(sentinel)).toBe(false);
});

test("joining operator cause survives cancelled Start settlement", async () => {
	// Given a dispatched Start and an engine-loss Stop sharing held cleanup.
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	const confirmations: boolean[] = [];
	const harness = idleProductionHarness(directory, {
		stopRuntime: async (generation, confirmUnknown) => {
			confirmations.push(confirmUnknown === true);
			entered.resolve();
			await release.promise;
			await streamSessionProductionDeps.stopRuntime(generation, confirmUnknown);
		},
	});
	h = harness;
	harness.engine.holdStart(reply.promise);
	const starting = harness.start();
	await harness.engine.started;
	const loss = harness.session.stop("engine_loss");
	await entered.promise;
	// When operator joins, later machine callers cannot erase the stronger cause.
	const operator = harness.session.stop("operator");
	const laterLoss = harness.session.stop("engine_loss");
	release.resolve();
	await Promise.all([loss, operator, laterLoss]);
	reply.resolve();
	await harness.expireProbe();
	const result = await starting;
	// Then the final cancellation Stop may affirm UNKNOWN only for that operator.
	expect(result).toMatchObject({ result: "cancelled" });
	expect(confirmations).toEqual([false, true]);
	expect(harness.session.streamLiveness()).toBe("idle");
	expect(existsSync(sentinel)).toBe(false);
});

test("joining operator promotes a parked config-change Stop cause", async () => {
	// Given engine-loss Stop parked behind an effectful configuration transaction.
	const change = Promise.withResolvers<{
		phase: "rollback_failed";
		reason: "engine_connection_lost";
	}>();
	const confirmations: boolean[] = [];
	const harness = idleProductionHarness(directory, {
		changeRuntimeConfig: () => change.promise,
		stopRuntime: async (generation, confirmUnknown) => {
			confirmations.push(confirmUnknown === true);
			await streamSessionProductionDeps.stopRuntime(generation, confirmUnknown);
		},
	});
	h = harness;
	await harness.start();
	const changing = harness.session.changeConfig({ framerate: 30 });
	const loss = harness.session.stop("engine_loss");
	// When operator joins before the transaction releases the parked Stop.
	const operator = harness.session.stop("operator");
	change.resolve({
		phase: "rollback_failed",
		reason: "engine_connection_lost",
	});
	await changing;
	await Promise.all([loss, operator]);
	// Then release retains operator confirmation and sends only one cleanup.
	expect(confirmations).toEqual([true]);
	expect(harness.calls().filter((call) => call === "stop")).toHaveLength(1);
	expect(harness.session.streamLiveness()).toBe("idle");
	expect(existsSync(sentinel)).toBe(false);
});
