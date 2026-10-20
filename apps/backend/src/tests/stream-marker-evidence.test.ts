import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setOtaStreamingMarker } from "../modules/streaming/ota-streaming-marker.ts";
import { createSessionOwnership } from "../modules/streaming/stream-session-ownership.ts";

let directory = "";
let previous: string | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-marker-"));
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = join(
		directory,
		"unavailable",
		"streaming",
	);
});
afterEach(async () => {
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});

test("sweep B2: failed sentinel writes retry rather than latch protection", () => {
	// Given real filesystem ENOENT, not a marker whose implementation always succeeds.
	let attempts = 0;
	const owner = createSessionOwnership({
		createAttemptId: () => "marker",
		setStreamingStatus: () => undefined,
		stopRuntime: async () => undefined,
		queryRuntime: async () => "unknown",
		markStreamingForOta: () => {
			attempts++;
			return setOtaStreamingMarker();
		},
	});
	owner.protect();
	// When the next protection call follows storage repair.
	mkdirSync(join(directory, "unavailable"));
	owner.protect();
	// Then successful protection is on disk, not only in a process-local latch.
	expect(attempts).toBe(2);
	expect(existsSync(join(directory, "unavailable", "streaming"))).toBe(true);
});

test("failed streaming protection is UNKNOWN until a successful retry", () => {
	// Given an admitted session with missing sentinel storage.
	const owner = createSessionOwnership({
		createAttemptId: () => "marker",
		setStreamingStatus: () => undefined,
		stopRuntime: async () => undefined,
		queryRuntime: async () => "unknown",
		markStreamingForOta: setOtaStreamingMarker,
	});
	const generation = owner.begin();
	owner.transition("starting");
	// When the engine confirms streaming before the write succeeds.
	owner.commit(generation, "streaming", "streaming");
	expect(owner.streamLiveness()).toBe("unknown");
	mkdirSync(join(directory, "unavailable"));
	owner.protect();
	// Then repaired protection restores confirmed streaming, not idle.
	expect(owner.streamLiveness()).toBe("streaming");
});
