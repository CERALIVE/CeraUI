import { expect, test } from "bun:test";
import { RPC_ERROR_NUMERIC } from "@ceralive/cerastream";
import { launchHarness } from "./helpers/scoped-start-harness.ts";
import {
	attempt,
	busy,
	cancelled,
	capacity,
} from "./helpers/scoped-start-peer.ts";

test("an outer deadline before capability negotiation completes cannot stop a foreign stream", async () => {
	const h = await launchHarness("negotiation-deadline");
	const starting = h.start();
	await h.negotiating;
	(await h.deadline)();
	expect(await starting).toMatchObject({ result: "failed" });
	expect({
		prepare: h.prepares(),
		start: h.starts(),
		cancel: h.cancels(),
		stop: h.stops(),
		physical: h.view().physical,
	}).toEqual({
		prepare: [],
		start: [],
		cancel: [],
		stop: [],
		physical: "foreign",
	});
	await h.launchClosed;
	expect(await h.observed).toBe("streaming");
});

test.each(["malformed", "unknown"] as const)(
	"%s capabilities cannot authorize legacy Start or Stop",
	async (scenario) => {
		const h = await launchHarness(scenario);
		const result = await h.start();
		expect({
			prepare: h.prepares(),
			start: h.starts(),
			cancel: h.cancels(),
			stop: h.stops(),
			physical: h.view().physical,
		}).toEqual({
			prepare: [],
			start: [],
			cancel: [],
			stop: [],
			physical: "foreign",
		});
		expect(result).toMatchObject({
			result: "failed",
			failure: {
				class: "engine_unavailable",
				phase: "start-rpc",
				retriable: false,
			},
		});
		expect(h.capabilityReads()).toHaveLength(1);
		expect(await h.observed).toBe("streaming");
	},
);

test("a successful scoped Start filters foreign status only until its acknowledgement", async () => {
	const h = await launchHarness("success");
	const starting = h.start();
	await h.entered;
	const emit = await h.sendLaunchStatus;
	emit({
		type: "status",
		seq: 1,
		state: "streaming",
		streaming: true,
		attempt_id: "50cc1000-7013-42ca-8994-6808596684eb",
	});
	await h.wireReceived;
	expect(h.statusFrames).toEqual([]);

	const ours = {
		type: "status",
		seq: 2,
		state: "streaming",
		streaming: true,
		attempt_id: attempt,
	} as const;
	emit(ours);
	await h.firstStatus;
	expect(h.statusFrames).toEqual([ours]);
	(await h.replyStart)();
	expect(await starting).toMatchObject({ result: "started" });

	const idle = {
		type: "status",
		seq: 3,
		state: "idle",
		streaming: false,
	} as const;
	emit(idle);
	await h.thirdWireFrame;
	expect(h.statusFrames.at(-1)).toEqual(idle);
	expect(h.cancels()).toEqual([]);
	expect(h.stops()).toEqual([]);
});

test.each(["lost", "deadline", "not-owner"] as const)(
	"an ambiguous scoped Start (%s) cancels just its attempt before observing the device",
	async (scenario) => {
		const h = await launchHarness(scenario);
		const starting = h.start();
		if (scenario === "deadline") {
			await h.entered;
			(await h.deadline)();
		}
		expect(await starting).toMatchObject({ result: "failed" });
		expect(h.stops()).toEqual([]);
		expect(h.cancels()).toEqual([
			{ method: "cancel-start", peer: 2, attemptId: attempt },
		]);
		expect(h.starts()).toEqual([
			{ method: "start", peer: 1, attemptId: attempt },
		]);
		expect(await h.observed).toBe(
			scenario === "not-owner" ? "streaming" : "idle",
		);
		expect(h.view()).toEqual(
			scenario === "not-owner"
				? { physical: "foreign", state: "streaming", marked: true }
				: { physical: "idle", state: "idle", marked: false },
		);
	},
);

test.each([
	{
		scenario: "foreign",
		code: busy,
		state: "streaming",
		physical: "foreign",
		marked: true,
	},
	{
		scenario: "cancelled",
		code: cancelled,
		state: "idle",
		physical: "idle",
		marked: false,
	},
	{
		scenario: "capacity",
		code: capacity,
		state: "idle",
		physical: "idle",
		marked: false,
	},
] as const)(
	"a timely $scenario refusal is observed without stopping or retrying",
	async ({ scenario, code, state, physical, marked }) => {
		const h = await launchHarness(scenario);
		expect(await h.start()).toMatchObject({
			result: "failed",
			failure: {
				code: RPC_ERROR_NUMERIC[code],
				retriable: false,
				...(scenario === "capacity" ? { class: "attempt_capacity" } : {}),
			},
		});
		expect(h.stops()).toEqual([]);
		expect(h.cancels()).toEqual([]);
		expect(h.starts()).toEqual(
			scenario === "capacity"
				? []
				: [{ method: "start", peer: 1, attemptId: attempt }],
		);
		expect(await h.observed).toBe(state);
		expect(h.view()).toEqual({ physical, state, marked });
	},
);

test.each(["legacy", "old"] as const)(
	"an ambiguous unscoped Start (%s) keeps its legacy rollback",
	async (scenario) => {
		const h = await launchHarness(scenario);
		expect(await h.start()).toMatchObject({ result: "failed" });
		expect(h.cancels()).toEqual([]);
		expect(h.starts()).toEqual([{ method: "start", peer: 1 }]);
		expect(h.stops()).toEqual([{ method: "stop", peer: 1 }]);
		expect(h.view()).toEqual({
			physical: "idle",
			state: "idle",
			marked: false,
		});
	},
);

test("an outer deadline after a confirmed legacy Start dispatch still sends Stop", async () => {
	const h = await launchHarness("legacy-deadline");
	const starting = h.start();
	await h.entered;
	(await h.deadline)();
	expect(await starting).toMatchObject({
		result: "failed",
		failure: { code: "start_attempt_deadline", retriable: true },
	});
	expect(h.starts()).toEqual([{ method: "start", peer: 1 }]);
	expect(h.stops()).toHaveLength(1);
	expect(h.cancels()).toEqual([]);
	expect(h.view().physical).toBe("idle");
});
