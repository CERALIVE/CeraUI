import { expect, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import { createSessionOwnership } from "../modules/streaming/stream-session-ownership.ts";
import { flush, modelHarness } from "./helpers/stream-session-model.ts";

type Event =
	| "Start"
	| "Stop"
	| "idle"
	| "streaming"
	| "unknown"
	| "allowed"
	| "refuse"
	| "throw"
	| "launch-ok"
	| "launch-fail"
	| "launch-timeout"
	| "ack"
	| "reject"
	| "stop-timeout"
	| "late-ack"
	| "config-ok"
	| "rollback-ok"
	| "connection-lost";
type Harness = ReturnType<typeof modelHarness>;

function enabled(h: Harness): Event[] {
	const events: Event[] = ["Start", "Stop", "idle", "streaming", "unknown"];
	if (h.admissions.length) events.push("allowed", "refuse", "throw");
	if (h.launchGates.length)
		events.push("launch-ok", "launch-fail", "launch-timeout");
	if (h.stops.length) events.push("ack", "reject", "stop-timeout", "late-ack");
	if (h.view().state === "streaming")
		events.push("config-ok", "rollback-ok", "connection-lost");
	return events;
}

async function event(
	h: Harness,
	action: Event,
	oracle: { protected: boolean; timedOut: boolean; launchExpired: boolean },
): Promise<void> {
	const before = h.view();
	switch (action) {
		case "Start": {
			const result = h.start();
			if (
				before.state !== "idle" ||
				before.stopOutstanding ||
				before.outstandingLaunches
			) {
				await result;
				expect(h.view()).toEqual(before); // I5
			}
			break;
		}
		case "Stop":
			if (!before.stopOutstanding) oracle.timedOut = false;
			h.stop();
			if (before.stopOutstanding)
				expect(h.view().stopCalls).toBe(before.stopCalls); // I6
			break;
		case "idle":
		case "streaming":
		case "unknown": {
			h.setEngine(action);
			await h.session.reconcile();
			const accepted =
				!before.stopOutstanding &&
				!before.outstandingLaunches &&
				["idle", "streaming", "reconciling", "stop_failed"].includes(
					before.state,
				);
			if (accepted) oracle.protected = action !== "idle";
			break;
		}
		case "allowed":
			h.admissions.shift()?.resolve({ allowed: true });
			await flush();
			if (h.view().outstandingLaunches) {
				oracle.protected = true;
				oracle.launchExpired = false;
			}
			break;
		case "refuse":
			h.admissions.shift()?.resolve({
				allowed: false,
				reason: "update_in_progress",
				phase: "committing",
				percent: 63,
				etaSeconds: 41,
			});
			break;
		case "throw":
			h.admissions.shift()?.reject(new Error("admission unavailable"));
			break;
		case "launch-ok":
			h.setEngine("streaming");
			h.launchGates.shift()?.resolve();
			break;
		case "launch-fail":
			h.setEngine("idle");
			h.launchGates.shift()?.reject(new Error("launch failed after rollback"));
			oracle.protected =
				before.state === "stopping" ||
				before.state === "stop_failed" ||
				before.stopOutstanding > 0 ||
				oracle.launchExpired;
			break;
		case "launch-timeout":
			oracle.launchExpired = true;
			h.timers.values().next().value?.();
			break;
		case "ack":
		case "late-ack":
			h.setEngine("idle");
			h.stops.shift()?.resolve();
			if (!oracle.timedOut && !before.outstandingLaunches)
				oracle.protected = false;
			break;
		case "reject":
			h.stops.shift()?.reject(new Error("stop rejected"));
			break;
		case "stop-timeout":
			oracle.timedOut = true;
			h.timers.values().next().value?.();
			break;
		case "config-ok":
		case "rollback-ok":
		case "connection-lost": {
			const changing = h.session.changeConfig({ resolution: "1280x720" });
			if (action === "connection-lost") {
				h.setEngine("unknown");
				h.changes.shift()?.reject(new Error("socket unavailable"));
			} else
				h.changes
					.shift()
					?.resolve({ phase: action === "config-ok" ? "applied" : "reverted" });
			await changing;
			break;
		}
	}
	await flush();
	if (
		h.view().state === "idle" &&
		(action === "launch-ok" || action === "launch-fail")
	)
		oracle.protected = false;
	h.assert();
	expect(h.view().marked).toBe(oracle.protected); // I2 after EVERY event
}

async function quiesce(h: Harness): Promise<void> {
	for (let round = 0; round < 8; round++) {
		for (const gate of h.admissions.splice(0))
			gate.resolve({
				allowed: false,
				reason: "update_in_progress",
				phase: "committing",
				percent: 63,
				etaSeconds: 41,
			});
		for (const gate of h.launchGates.splice(0)) gate.resolve();
		for (const gate of h.stops.splice(0)) gate.resolve();
		for (const gate of h.changes.splice(0)) gate.resolve({ phase: "reverted" });
		await flush();
	}
	await Promise.all(h.results);
	h.assert();
	expect(h.view().held).toBe(false); // I4 at quiescence
	const before = h.view();
	for (const callback of h.timers.values()) callback();
	await flush();
	expect(h.view()).toEqual(before); // I3: obsolete timers cannot mutate newer state
}

test("exhaustive enabled interleavings through five events preserve I1-I6", async () => {
	// Given the real factory, real lifecycle lease and dependency-boundary gates.
	const queue: Event[][] = [[]];
	let explored = 0;
	const previousSilent = logger.silent;
	logger.silent = true;
	try {
		// When every enabled event ordering is replayed, with no wall-clock sleeps.
		while (queue.length) {
			const trace = queue.pop();
			if (trace === undefined) break;
			resetLifecycleInterlock();
			const h = modelHarness();
			const oracle = {
				protected: false,
				timedOut: false,
				launchExpired: false,
			};
			try {
				for (const action of trace) await event(h, action, oracle);
				if (trace.length < 5)
					for (const next of enabled(h)) queue.push([...trace, next]);
				await quiesce(h);
				explored += 1;
			} catch (error) {
				throw new Error(`interleaving ${JSON.stringify(trace)}`, {
					cause: error,
				});
			}
		}
		// Then every prefix and its quiescence satisfied the safety assertions.
		expect(explored).toBeGreaterThan(3906);
		process.stdout.write(
			`F15-C interleavings=${explored} bound=5 invariants=I1-I6\n`,
		);
	} finally {
		logger.silent = previousSilent;
		resetLifecycleInterlock();
	}
}, 120_000);

test("illegal and stale state-machine commits execute no projection side effects", () => {
	// Given a newer streaming owner and a saved older owner.
	const effects: unknown[] = [];
	const machine = createSessionOwnership({
		createAttemptId: () => "guard",
		setStreamingStatus: (value) => effects.push(value),
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		markStreamingForOta: () => effects.push("mark"),
		unmarkStreamingForOta: () => effects.push("unmark"),
	});
	const old = machine.begin();
	machine.transition("starting");
	machine.commit(old, "streaming", "streaming");
	const current = machine.invalidate();
	const before = [...effects];
	// When stale and illegal idle completions attempt to mutate it.
	expect(machine.commit(old, "reconciling", "unknown")).toBe(false);
	expect(machine.commit(current, "idle", "idle")).toBe(false);
	// Then no status/marker/lifecycle projection runs (I3/I5).
	expect(effects).toEqual(before);
	expect(machine.state).toBe("streaming");
});
