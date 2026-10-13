import { afterEach, expect, test } from "bun:test";
import {
	evidenceHarness,
	flushEvidence,
} from "./helpers/stream-engine-evidence.ts";

const fixtures: ReturnType<typeof evidenceHarness>[] = [];
const harness = () => {
	const h = evidenceHarness();
	fixtures.push(h);
	return h;
};
afterEach(() => {
	for (const h of fixtures.splice(0)) h.dispose();
});

test("R3-B1: dispatched Start with failed rollback cannot grant idle or replacement", async () => {
	// Given a fake engine that applies Start but loses both replies.
	const h = harness();
	h.failStart();
	h.failStop();
	// When the real backend/factory settles the original typed failure.
	const result = await h.start();
	// Then physical truth is independent of the factory's claim.
	expect(result).toMatchObject({
		result: "failed",
		failure: { phase: "start-rpc", class: "start_timeout" },
	});
	expect(h.view()).toMatchObject({
		engine: "streaming",
		state: "reconciling",
		marked: true,
		generation: 1,
	});
	expect(await h.start()).toMatchObject({ result: "busy" });
	expect(
		h.clients.flatMap((client) => client.calls).filter((op) => op === "start"),
	).toHaveLength(1);
});

test("R3-B2: silence retains protection until an affirmative operator Stop", async () => {
	// Given a survived stream, not a truth derived from the production lifecycle.
	const h = harness();
	h.setEngine("streaming");
	const query = h.session.reconcile();
	await flushEvidence();
	// When the subscribed observation window expires without any status.
	for (const callback of [...h.timers.values()]) callback();
	await query;
	expect(h.view()).toMatchObject({
		engine: "streaming",
		state: "reconciling",
		marked: true,
	});
	expect(h.clients.flatMap((client) => client.calls)).not.toContain("stop");
	// Then only the explicit affirmative Stop path releases protection.
	expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
	expect(h.view()).toMatchObject({
		engine: "idle",
		state: "idle",
		marked: false,
	});
});

for (const boundary of ["connect", "subscribe"] as const) {
	test(`R3-B3: cancelled ${boundary} continuation retires without Start dispatch`, async () => {
		// Given a held acquisition in the real backend's launch context.
		const h = harness();
		const gate = Promise.withResolvers<void>();
		if (boundary === "connect") h.holdConnect(gate.promise);
		else h.holdSubscribe(gate.promise);
		const launch = h.start();
		await flushEvidence();
		// When operator Stop acknowledges idle before the acquisition resumes.
		expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
		gate.resolve();
		await launch;
		// Then the cancelled generation cannot physically resurrect the stream.
		expect(h.clients[0]?.calls).not.toContain("start");
		if (boundary === "connect")
			expect(h.clients[0]?.calls).not.toContain("subscribe");
		expect(h.clients[0]?.calls).toContain("close");
		expect(h.view()).toMatchObject({
			engine: "idle",
			state: "idle",
			marked: false,
		});
	});
}

test("R3-B4: adopted session delivers later idle despite obsolete probe authority", async () => {
	// Given an adopted surviving stream.
	const h = harness();
	h.setEngine("streaming");
	const query = h.session.reconcile();
	await flushEvidence();
	h.status(0, true);
	await query;
	// When another reconciliation expires the probe owner but not the adopted client.
	await h.session.reconcile();
	h.setEngine("idle");
	h.status(0, false);
	await flushEvidence();
	// Then continuing current-session events release protection and update telemetry.
	expect(h.backend.getTelemetry()).toMatchObject({ streaming: false });
	expect(h.view()).toMatchObject({
		engine: "idle",
		state: "idle",
		marked: false,
	});
});

test("R3-B3: cancellation immediately before Start dispatch cannot resurrect the engine", async () => {
	// Given the real factory/backend and a transaction boundary after acquisition.
	const h = harness();
	let stopped: Promise<unknown> | undefined;
	h.beforeStartDispatch(() => {
		stopped = h.session.stop("operator");
	});
	// When Stop wins at the dispatch boundary, after the subscribe recheck.
	await h.start();
	await stopped;
	// Then engine effects, not the production guard, establish the outcome.
	expect(h.clients[0]?.calls).not.toContain("start");
	expect(h.view()).toMatchObject({
		engine: "idle",
		state: "idle",
		marked: false,
	});
});

test("R3-B4: a superseded adopted client cannot overwrite a replacement session", async () => {
	// Given an adopted stream whose client is superseded by Stop and new Start.
	const h = harness();
	h.setEngine("streaming");
	const query = h.session.reconcile();
	await flushEvidence();
	h.status(0, true);
	await query;
	await h.session.stop("operator");
	await h.start();
	// When the old adopted client delivers a buffered idle event.
	h.status(0, false);
	await flushEvidence();
	// Then independent engine truth and current protection remain streaming.
	expect(h.view()).toMatchObject({
		engine: "streaming",
		state: "streaming",
		marked: true,
	});
	expect(h.backend.getTelemetry()).not.toMatchObject({ streaming: false });
});
