import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIFECYCLE_STATES, type LifecycleState } from "@ceraui/rpc/schemas";
import { initialOtaStreamLiveness } from "../modules/streaming/ota-streaming-marker.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { bindStreamLiveness } from "../modules/streaming/stream-liveness.ts";
import { createSessionOwnership } from "../modules/streaming/stream-session-ownership.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import {
	getStreamLiveness,
	isStreamConfirmedIdle,
	setStreamLivenessSourceForTest,
} from "../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

const savedMarker = process.env.CERALIVE_STREAMING_MARKER;
let directory = "";
let live: ReturnType<typeof spyOn<typeof streaming, "getIsStreaming">>;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "stream-leaf-adapter-"));
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "streaming");
	live = spyOn(streaming, "getIsStreaming").mockReturnValue(false);
	setStreamReconciliationCompletedForTest(true);
	setStreamLivenessSourceForTest(null);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	live.mockRestore();
	bindStreamLiveness(() => "unknown");
	setStreamReconciliationCompletedForTest(true);
	setStreamLivenessSourceForTest(null);
	updateStreamLifecycleState("idle");
	if (savedMarker === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = savedMarker;
	rmSync(directory, { recursive: true, force: true });
});

for (const evidence of ["idle", "streaming", "unknown"] as const) {
	test(`adapter passes current leaf ${evidence} without an independent idle grant`, () => {
		// Given current owner evidence beside the legacy false projection.
		bindStreamLiveness(() => evidence);
		// When the system admission adapter reads it synchronously.
		const actual = getStreamLiveness();
		// Then the owner, not that projection, owns the answer.
		expect(actual).toBe(evidence);
	});
}

test("initial reconciliation latch refuses even an idle leaf", () => {
	// Given an unprotected owner before boot reconciliation finishes.
	bindStreamLiveness(() => "idle");
	setStreamReconciliationCompletedForTest(false);
	// When update/disruptive consumers ask for permission.
	const confirmed = isStreamConfirmedIdle();
	// Then the initial latch cannot be bypassed by the idle baseline.
	expect(confirmed).toBe(false);
	expect(getStreamLiveness()).toBe("unknown");
});

const nonIdleProjections = {
	starting: "unknown",
	streaming: "unknown",
	reconfiguring: "unknown",
	stopping: "unknown",
	stop_failed: "unknown",
	reconciling: "unknown",
} as const satisfies Record<Exclude<LifecycleState, "idle">, "unknown">;

for (const lifecycle of LIFECYCLE_STATES) {
	if (lifecycle === "idle") continue;
	test(`owner projection ${lifecycle} withholds an idle leaf`, () => {
		// Given an idle leaf beside a literal non-idle owner publication.
		bindStreamLiveness(() => "idle");
		updateStreamLifecycleState(lifecycle);
		// When update admission reads both owner surfaces.
		const actual = getStreamLiveness();
		// Then every non-idle publication withholds idle permission.
		expect(actual).toBe(nonIdleProjections[lifecycle]);
	});
}

test("an idle owner projection never grants idle against an unknown leaf", () => {
	// Given the owner's idle publication but no affirmative leaf evidence.
	bindStreamLiveness(() => "unknown");
	updateStreamLifecycleState("idle");
	// When the restrictive composition reads that disagreement.
	const actual = getStreamLiveness();
	// Then publication alone cannot create permission.
	expect(actual).toBe("unknown");
});

test("legacy confirmed live can only narrow an idle leaf", () => {
	// Given inconsistent owner and positive legacy live evidence.
	bindStreamLiveness(() => "idle");
	live.mockReturnValue(true);
	// When the adapter composes the refusal-only input.
	const actual = getStreamLiveness();
	// Then it withholds permission rather than granting idle.
	expect(actual).toBe("streaming");
});

test("retained sentinel beside an idle owner projection remains unknown", () => {
	// Given a real initially empty sentinel path and a real idle owner.
	const marker = join(directory, "streaming");
	const owner = createSessionOwnership({
		createAttemptId: () => "adapter-test",
		queryRuntime: async () => "unknown",
		stopRuntime: async () => undefined,
		initialLiveness: initialOtaStreamLiveness,
		setStreamingStatus: () => undefined,
	});
	bindStreamLiveness(owner.streamLiveness);
	mkdirSync(marker);
	writeFileSync(join(marker, "retained"), "evidence");
	// When the adapter reads the owner's current physical evidence.
	const actual = getStreamLiveness();
	// Then idle projection does not defeat the retained sentinel.
	expect(actual).toBe("unknown");
});

test("fresh silent boot grants idle after first reconciliation without a sentinel", async () => {
	// Given the production factory/backend paths with host engine/sender ports.
	const harness = idleProductionHarness(directory);
	bindStreamLiveness(harness.session.streamLiveness);
	setStreamReconciliationCompletedForTest(false);
	try {
		const observing = harness.session.reconcile();
		await harness.expireProbe();
		await observing;
		setStreamReconciliationCompletedForTest(true);
		// When update admission and Go Live read that reconciled baseline.
		const confirmed = isStreamConfirmedIdle();
		const starting = await harness.start();
		// Then the normal empty boot is usable, without an automatic Stop.
		expect(confirmed).toBe(true);
		expect(starting).toMatchObject({ result: "started" });
		expect(harness.calls()).not.toContain("stop");
	} finally {
		await harness.dispose();
	}
});
