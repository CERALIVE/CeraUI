import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteStreamStopped } from "../modules/streaming/armed-stream-marker.ts";
import { runStreamRestoration } from "../modules/streaming/stream-restoration.ts";
import * as owner from "../modules/streaming/stream-session-orchestrator.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import * as session from "../modules/streaming/streamloop/session.ts";
import { flushEvidence } from "./helpers/stream-engine-evidence.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

let directory = "";
let previous: string | undefined;
let h: ReturnType<typeof idleProductionHarness> | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-b2b-restore-admission-"));
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "streaming");
});
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});

test("operator Stop cancels internal Start waiting for recovery admission", async () => {
	// Given an internal Start awaiting recovery before acquiring a generation.
	const recovery = Promise.withResolvers<void>();
	const harness = idleProductionHarness(directory, {
		awaitRecovery: () => recovery.promise,
	});
	h = harness;
	let launches = 0;
	const starting = harness.session.start({
		origin: "restoration",
		launch: async () => {
			launches++;
		},
	});
	await flushEvidence();
	// When Stop is requested before that recovery answer arrives.
	await harness.session.stop("operator");
	recovery.resolve();
	const outcome = await starting;
	// Then waiting intent is cancelled, not admitted after Stop.
	expect(outcome).toMatchObject({ result: "cancelled" });
	expect(launches).toBe(0);
	expect(existsSync(join(directory, "streaming"))).toBe(false);
});

test("operator disarm during default restoration preparation prevents Start submission", async () => {
	// Given real restoration intent and the default launch held in IP preparation.
	const marker = {
		markerPath: join(directory, "armed.json"),
		readBootId: () => "11111111-1111-4111-8111-111111111111",
		readMarker: (file: string) =>
			existsSync(file) ? readFileSync(file, "utf8") : undefined,
		writeMarker: (file: string, contents: string) =>
			writeFileSync(file, contents),
		removeMarker: (file: string) => rmSync(file, { force: true }),
	};
	writeFileSync(
		marker.markerPath,
		JSON.stringify({
			armedAt: 1,
			bootId: marker.readBootId(),
			config: { pipeline: "hdmi" },
		}),
	);
	const harness = idleProductionHarness(directory, {
		onStreamStopped: (cause) => noteStreamStopped(cause, marker),
	});
	h = harness;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let submissions = 0;
	const validate = spyOn(streaming, "validateConfig").mockResolvedValue({
		pipeline: {
			source: "hdmi",
			name: "Host",
			hardware: "generic",
			description: "Host",
			supportsAudio: false,
			supportsResolutionOverride: false,
			supportsFramerateOverride: false,
			audio_kind: "none",
		},
		srtlaAddr: "192.0.2.2",
		srtlaPort: 5000,
		streamid: "host",
	});
	const prepare = spyOn(session, "prepareSrtlaIpAddresses").mockImplementation(
		async () => {
			entered.resolve();
			await release.promise;
			return {
				ok: true,
				generation: 1,
				changed: false,
				sidecarPath: join(directory, "bind-map.json"),
			};
		},
	);
	const launch = spyOn(owner, "startStreamSession").mockImplementation(
		async () => {
			submissions++;
			return { result: "started", attemptId: "host" };
		},
	);
	try {
		const restoring = runStreamRestoration({
			marker,
			awaitRecovery: async () => undefined,
			runtimeState: async () => "idle",
			lifecycleState: () => "idle",
			publish: () => undefined,
		});
		await entered.promise;
		// When operator Stop disarms before default preparation resumes.
		await harness.session.stop("operator");
		release.resolve();
		const outcome = await restoring;
		// Then default launch may not submit Start using its captured intent.
		expect(submissions).toBe(0);
		expect(outcome).toEqual({ result: "blocked", reason: "start_cancelled" });
		expect(existsSync(marker.markerPath)).toBe(false);
		expect(existsSync(join(directory, "streaming"))).toBe(false);
	} finally {
		validate.mockRestore();
		prepare.mockRestore();
		launch.mockRestore();
	}
});
