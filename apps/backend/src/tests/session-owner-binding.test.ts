import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bindStreamLiveness,
	streamLiveness,
} from "../modules/streaming/stream-liveness.ts";
import { bindSessionOwnerForTest } from "./helpers/bind-session-owner.ts";

const savedMarker = process.env.CERALIVE_STREAMING_MARKER;
afterEach(() => {
	if (savedMarker === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = savedMarker;
});

test("the test binding follows the physical sentinel and restores the unbound default", () => {
	// Given a private sentinel path and a harness binding of the session owner.
	const directory = mkdtempSync(join(tmpdir(), "session-owner-"));
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "streaming");
	const restoreOwner = bindStreamLiveness(() => "unknown");
	try {
		const restore = bindSessionOwnerForTest();
		// When the sentinel is absent, then present, then the binding is restored.
		const absent = streamLiveness();
		writeFileSync(process.env.CERALIVE_STREAMING_MARKER, "");
		const present = streamLiveness();
		restore();
		const restored = streamLiveness();
		// Then only physical absence is idle and no binding outlives the suite.
		expect([absent, present, restored]).toEqual(["idle", "unknown", "unknown"]);
	} finally {
		restoreOwner();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("tearing down a test binding restores the previous session owner", () => {
	const directory = mkdtempSync(join(tmpdir(), "session-owner-"));
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "streaming");
	const restoreOuter = bindStreamLiveness(() => "streaming");
	try {
		const restoreInner = bindSessionOwnerForTest();
		try {
			expect(streamLiveness()).toBe("idle");
		} finally {
			restoreInner();
		}
		expect(streamLiveness()).toBe("streaming");
	} finally {
		restoreOuter();
		rmSync(directory, { recursive: true, force: true });
	}
});
