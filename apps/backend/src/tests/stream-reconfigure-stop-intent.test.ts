import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configureSetProfile,
	handleSetProfile,
	resetSetProfile,
} from "../modules/remote-control/set-profile.ts";
import { wireSetProfile } from "../modules/remote-control/set-profile-wiring.ts";
import {
	defaultArmedStreamMarkerDeps,
	noteStreamStopped,
} from "../modules/streaming/armed-stream-marker.ts";
import { armStreamRestoration } from "../modules/streaming/stream-restoration.ts";
import * as owner from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

afterEach(resetSetProfile);

test("operator Stop cancels a reconfigure flight before its replacement Start", async () => {
	// Given production profile reconnect with real Start/Stop and held cleanup.
	const directory = await mkdtemp(join(tmpdir(), "fix16-b2c-reconfigure-"));
	const previous = process.env.CERALIVE_STREAMING_MARKER;
	const sentinel = join(directory, "streaming");
	process.env.CERALIVE_STREAMING_MARKER = sentinel;
	const marker = {
		...defaultArmedStreamMarkerDeps,
		markerPath: join(directory, "armed.json"),
		readBootId: () => "11111111-1111-4111-8111-111111111111",
	};
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = idleProductionHarness(directory, {
		onStreamArmed: (current) => {
			if (current())
				armStreamRestoration({
					marker,
					captureConfig: () => ({ pipeline: "hdmi" }),
				});
		},
		onStreamStopped: (cause) => noteStreamStopped(cause, marker),
		stopRuntime: async (generation, confirmUnknown) => {
			entered.resolve();
			await release.promise;
			await streamSessionProductionDeps.stopRuntime(generation, confirmUnknown);
		},
	});
	let submissions = 0;
	const live = spyOn(streaming, "getIsStreaming").mockImplementation(
		() => harness.view().live,
	);
	const stop = spyOn(owner, "stopStreamSession").mockImplementation(
		harness.session.stop,
	);
	const start = spyOn(owner, "startStreamSession").mockImplementation(() => {
		submissions++;
		return harness.start();
	});
	try {
		await harness.start();
		wireSetProfile();
		configureSetProfile({ persist: () => undefined });
		const configuring = handleSetProfile({
			commandId: "11111111-1111-4111-8111-111111111112",
			config: {
				presetId: "balanced",
				latencyMs: 2000,
				fecEnabled: false,
				recoveryMode: "standard",
			},
		});
		await entered.promise;
		// When operator Stop supersedes the reconfigure flight during its Stop await.
		const stopping = harness.session.stop("operator");
		release.resolve();
		await configuring;
		expect(await stopping).toEqual({ result: "stopped" });
		// Then no replacement Start is submitted and physical/intent files stay absent.
		expect(submissions).toBe(0);
		expect(harness.view().launches).toBe(1);
		expect(harness.calls().filter((call) => call === "stop")).toEqual(["stop"]);
		expect(harness.engine.view().engine).toBe("idle");
		expect(existsSync(marker.markerPath)).toBe(false);
		expect(existsSync(sentinel)).toBe(false);
	} finally {
		release.resolve();
		start.mockRestore();
		stop.mockRestore();
		live.mockRestore();
		await harness.dispose();
		if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
		else process.env.CERALIVE_STREAMING_MARKER = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
