import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CerastreamConnectionError } from "@ceralive/cerastream";
import {
	getStreamLifecycleState,
	updateStreamLifecycleState,
} from "../modules/streaming/stream-lifecycle-status.ts";
import { flushEvidence } from "./helpers/stream-engine-evidence.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

let directory = "";
let marker = "";
let previous: string | undefined;
let h: ReturnType<typeof idleProductionHarness> | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-b2b-epoch-"));
	marker = join(directory, "streaming");
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = marker;
	updateStreamLifecycleState("idle");
});
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	updateStreamLifecycleState("idle");
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});

test("old idle from a previous client never satisfies a new session's reconcile", async () => {
	// Given gen1 idle evidence and a successful gen2 Start without a status event.
	const harness = idleProductionHarness(directory);
	h = harness;
	await harness.start();
	harness.engine.setEngine("idle");
	harness.engine.status(0, false);
	expect(existsSync(marker)).toBe(false);
	expect(await harness.start()).toMatchObject({ result: "started" });
	expect(existsSync(marker)).toBe(true);
	// When passive reconciliation hears no current status.
	const observing = harness.session.reconcile();
	await harness.expireProbe();
	await observing;
	// Then the independently live engine is protected; no Stop was submitted.
	expect(harness.engine.view().engine).toBe("streaming");
	expect(harness.calls().filter((call) => call === "stop")).toEqual([]);
	expect(harness.session.streamLiveness()).toBe("unknown");
	expect(existsSync(marker)).toBe(true);
});

test("oracle protected boot publishes reconciling for Stop escape", async () => {
	// Given a backend restart with physical protection and a silent engine.
	writeFileSync(marker, "");
	const harness = idleProductionHarness(directory, {
		setLifecycleState: updateStreamLifecycleState,
	});
	h = harness;
	expect(getStreamLifecycleState()).toBe("reconciling");
	// When reconciliation starts, publish the already-seeded protected state.
	const observing = harness.session.reconcile();
	await harness.expireProbe();
	await observing;
	// Then the existing wire projection exposes Stop escape without new evidence.
	expect(getStreamLifecycleState()).toBe("reconciling");
	expect(harness.session.streamLiveness()).toBe("unknown");
	expect(existsSync(marker)).toBe(true);
	expect(harness.calls().filter((call) => call === "stop")).toEqual([]);
});

test("pre-Start subscription idle replay cannot become post-Start evidence", async () => {
	// Given a client that reports idle before its held Start acknowledgement.
	const harness = idleProductionHarness(directory);
	h = harness;
	const reply = Promise.withResolvers<void>();
	harness.engine.holdStart(reply.promise);
	const starting = harness.start();
	await harness.engine.started;
	harness.engine.status(0, false);
	reply.resolve();
	expect(await starting).toMatchObject({ result: "started" });
	// When the owner observes after commitment but no new status has arrived.
	const observing = harness.session.reconcile();
	await harness.expireProbe();
	await observing;
	// Then subscribe-time evidence cannot clear a subsequently live session.
	expect(harness.engine.view().engine).toBe("streaming");
	expect(harness.session.streamLiveness()).toBe("unknown");
	expect(existsSync(marker)).toBe(true);
});

test("late previous-client idle cannot affect the new launch", async () => {
	// Given a new session on a different client.
	const harness = idleProductionHarness(directory);
	h = harness;
	await harness.start();
	harness.engine.setEngine("idle");
	harness.engine.status(0, false);
	await harness.start();
	// When an old subscription delivers a late idle frame.
	harness.engine.status(0, false);
	await flushEvidence();
	// Then only the new session's subscription may settle it.
	expect(harness.session.streamLiveness()).toBe("streaming");
	expect(existsSync(marker)).toBe(true);
});

test("queued RPC failure cannot retire a newly adopted client", async () => {
	// Given a pending RPC on the previous client and a newly adopted subscription.
	const harness = idleProductionHarness(directory);
	h = harness;
	await harness.start();
	const old = harness.engine.clients[0];
	if (old === undefined) throw new Error("missing initial test client");
	const failed = Promise.withResolvers<void>();
	const losses: string[] = [];
	const loss = spyOn(
		harness.engine.backend["deps"],
		"onSessionConnectionLost",
	).mockImplementation((site) => {
		losses.push(site);
	});
	try {
		const queued = harness.engine.backend["enqueue"](
			() => failed.promise,
			"reload-config",
			old.client,
		).catch(() => undefined);
		const observing = harness.engine.backend.reconcileRuntimeState();
		await flushEvidence();
		harness.engine.status(1, true);
		expect(await observing).toBe("streaming");
		// When the old RPC fails after the new client has been adopted.
		failed.reject(
			new CerastreamConnectionError("control connection is not open"),
		);
		await queued;
		await harness.engine.backend.settle();
		// Then the failure is attributed to its producing client, not the replacement.
		expect(losses).toEqual([]);
		expect(harness.engine.clients[1]?.calls).toEqual(["subscribe"]);
		expect(existsSync(marker)).toBe(true);
	} finally {
		loss.mockRestore();
	}
});
