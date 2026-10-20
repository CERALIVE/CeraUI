import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import {
	clearOtaStreamingMarker,
	setOtaStreamingMarker,
} from "../modules/streaming/ota-streaming-marker.ts";
import {
	flush,
	launchLive,
	modelHarness,
} from "./helpers/stream-session-model.ts";

let directory = "";
let previous: string | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "f15-ota-"));
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "streaming");
});
afterEach(async () => {
	resetLifecycleInterlock();
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});
const harness = () =>
	modelHarness({
		mark: setOtaStreamingMarker,
		unmark: clearOtaStreamingMarker,
	});

test("reconciliation cannot admit a launch while a Stop owns cleanup", async () => {
	// Given unknown runtime and a held cleanup acknowledgement.
	const h = harness();
	h.setEngine("unknown");
	await h.session.reconcile();
	const stopping = h.stop();
	// When idle observation races that cleanup and a new Start.
	h.setEngine("idle");
	await h.session.reconcile();
	const starting = h.start();
	await flush();
	const before = h.view();
	h.admissions.shift()?.resolve({ allowed: true });
	await flush();
	h.setEngine("streaming");
	h.launchGates.shift()?.resolve();
	h.stops.shift()?.resolve();
	await flush();
	h.setEngine("idle");
	await Promise.all([starting, stopping]);
	// Then no newer launch overlaps old cleanup (I1/I3/I5).
	expect(before.launches).toBe(0);
	expect(before.state).toBe("reconciling");
	expect(h.view().launches).toBe(0);
	expect(h.view().held).toBe(false);
});

test("unknown timed-out launch cleanup retains protection and refuses Start", async () => {
	// Given a real lease and launch that may already be live.
	const h = harness();
	const starting = h.start();
	h.admissions.shift()?.resolve({ allowed: true });
	await flush();
	// When deadline cleanup rejects with no idle proof.
	const deadline = h.timers.values().next().value;
	deadline?.();
	await flush();
	h.stops.shift()?.reject(new Error("stop-ack-unavailable"));
	const result = await starting;
	const after = h.view();
	const next = h.start();
	await flush();
	h.admissions.shift()?.resolve({
		allowed: false,
		reason: "update_in_progress",
		phase: "committing",
		percent: 63,
		etaSeconds: 41,
	});
	h.launchGates.shift()?.resolve();
	await next;
	// Then unknown is not idle (I2/I4).
	expect(result).toMatchObject({
		result: "failed",
		failure: { code: "start_cleanup_timeout" },
	});
	expect(after.marked).toBe(true);
	expect(existsSync(join(directory, "streaming"))).toBe(true);
	expect(after.state).toBe("reconciling");
	expect(after.held).toBe(false);
});

test("synthetic config connection loss preserves last live status and protection", async () => {
	// Given a committed stream.
	const h = harness();
	await launchLive(h);
	h.setEngine("unknown");
	const changing = h.session.changeConfig({ resolution: "1280x720" });
	// When dispatch loses the socket rather than proving rollback idle.
	h.changes.shift()?.reject(new Error("dead socket"));
	await changing;
	await flush();
	// Then no false idle projection or marker clear (I2/I5).
	expect(h.view()).toMatchObject({
		marked: true,
		reportedLive: true,
		state: "reconciling",
		held: false,
	});
	expect(existsSync(join(directory, "streaming"))).toBe(true);
});

test("duplicate Stops join one held cleanup flight", async () => {
	// Given a committed stream.
	const h = harness();
	await launchLive(h);
	// When two operator Stops arrive before acknowledgement.
	const first = h.stop();
	const second = h.stop();
	const calls = h.view().stopCalls;
	h.setEngine("idle");
	for (const gate of h.stops) gate.resolve();
	const outcomes = await Promise.all([first, second]);
	// Then both callers receive the same outcome with one cleanup (I6).
	expect(calls).toBe(1);
	expect(outcomes).toEqual([{ result: "stopped" }, { result: "stopped" }]);
});
