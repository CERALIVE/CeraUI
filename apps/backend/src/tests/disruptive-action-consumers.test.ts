import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	getIdleStatus,
	setIdleStateFilePathForTest,
} from "../modules/system/idle-activity.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { defaultOsStageRunEffects } from "../modules/system/update-orchestrator/os-stage-run.ts";

const savedMarker = process.env.CERALIVE_STREAMING_MARKER;
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "disruptive-consumers-"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	setIdleStateFilePathForTest(join(dir, "idle-state.json"));
	setStreamReconciliationCompletedForTest(true);
	updateStatus(false);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	if (savedMarker === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = savedMarker;
	setStreamReconciliationCompletedForTest(true);
	updateStreamLifecycleState("idle");
	rmSync(dir, { recursive: true, force: true });
});

const longAfterBoot = Date.now() + 365 * 24 * 60 * 60 * 1000;
const anyIdle = { mode: "any-idle", start: "03:00", end: "05:00" } as const;

for (const [name, unknown] of [
	[
		"before boot reconciliation returned",
		() => setStreamReconciliationCompletedForTest(false),
	],
	[
		"while the lifecycle is reconciling",
		() => updateStreamLifecycleState("reconciling"),
	],
] as const) {
	test(`idle detection treats unknown liveness ${name} as stream activity`, async () => {
		// Given a false live flag but no confirmed idle evidence.
		unknown();
		// When the scheduler asks whether the device has been idle.
		const status = await getIdleStatus({
			now: longAfterBoot,
			schedule: anyIdle,
		});
		// Then unknown liveness blocks automatic install and activation.
		expect(status.blockers).toContain("stream");
	});
	test(`OS staging is blocked ${name}`, async () => {
		// Given a false live flag and no sentinel file.
		unknown();
		// When the real staging runner asks whether it must stop.
		const blocked = await defaultOsStageRunEffects.blocked();
		// Then staging does not proceed through unknown liveness.
		expect(blocked).toBe(true);
	});
}

test("idle detection and OS staging proceed on confirmed idle", async () => {
	// Given reconciled idle evidence with no sentinel.
	// When both consumers read it.
	const status = await getIdleStatus({ now: longAfterBoot, schedule: anyIdle });
	const blocked = await defaultOsStageRunEffects.blocked();
	// Then neither reports a stream.
	expect(status.blockers).not.toContain("stream");
	expect(blocked).toBe(false);
});
