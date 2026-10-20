import { expect, test } from "bun:test";
import type { OsStageSettlementEvidence } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	type OsUnlaunchedSnapshot,
	settleOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-unlaunched-adapter.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	GOOD_SLOTS,
	identifiedState,
	KEY,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const proof: OsStageSettlementEvidence = {
	raucOperation: "idle",
	writerQuiescent: true,
	rootSlots: GOOD_SLOTS,
	healthyBootId: input.bootId,
	bootId: input.bootId,
	stagedReceiptPresent: false,
	activationArmed: false,
};

test.each([
	{ ...proof, raucOperation: "running" as const },
	{ ...proof, writerQuiescent: false },
	{ ...proof, healthyBootId: null },
	{ ...proof, stagedReceiptPresent: true },
	{ ...proof, activationArmed: true },
	{ ...proof, rootSlots: [] },
	{
		...proof,
		rootSlots: GOOD_SLOTS.map((slot) =>
			slot.state === "booted" ? { ...slot, bootStatus: "bad" } : slot,
		),
	},
])(
	"refuses matching witness when current readiness is contradictory %#",
	async (evidence) => {
		// Given matching provenance but failed fresh readiness.
		const state = identifiedState();
		let writes = 0;
		// When the real adapter observes the injected boundary evidence.
		const result = await settleOsUnlaunchedWitness({
			acquireControl: async () => ({
				held: () => true,
				async [Symbol.asyncDispose]() {},
			}),
			readPersisted: async () => state,
			snapshot: () => ({
				state,
				generation: 1,
				candidate: undefined,
				producer: undefined,
			}),
			readWitness: () => ({
				attemptId: input.attemptId,
				candidateKey: KEY,
				bootId: input.bootId,
				baselineInstance: input.baselineInstance,
				disposition: "unlaunched-unchanged",
			}),
			readEvidence: async () => evidence,
			dispatch: () => {
				writes++;
				return state;
			},
			persist: () => {
				writes++;
			},
			consume: () => {
				writes++;
			},
			now: () => 10,
		});
		// Then neither persistence nor consumption is reached.
		expect(result).toBe(false);
		expect(writes).toBe(0);
	},
);

test.each([
	"generation",
	"phase",
	"candidate",
	"recovery",
	"producer",
] as const)(
	"fences settlement when %s moves across the controlled await",
	async (change) => {
		// Given a read held at a promise barrier.
		let snapshot: OsUnlaunchedSnapshot = {
			state: identifiedState(),
			generation: 1,
			candidate: manifest,
			producer: undefined,
		};
		const gate = Promise.withResolvers<OsStageSettlementEvidence>();
		let writes = 0;
		const pending = settleOsUnlaunchedWitness({
			acquireControl: async () => ({
				held: () => true,
				async [Symbol.asyncDispose]() {},
			}),
			readPersisted: async () => snapshot.state,
			snapshot: () => snapshot,
			readWitness: () => ({
				attemptId: input.attemptId,
				candidateKey: KEY,
				bootId: input.bootId,
				baselineInstance: input.baselineInstance,
				disposition: "unlaunched-unchanged",
			}),
			readEvidence: () => gate.promise,
			dispatch: () => {
				writes++;
				return snapshot.state;
			},
			persist: () => {
				writes++;
			},
			consume: () => {
				writes++;
			},
			now: () => 10,
		});
		// When just one independent fence component changes before the read answers.
		switch (change) {
			case "generation":
				snapshot = { ...snapshot, generation: 2 };
				break;
			case "phase":
				snapshot = {
					...snapshot,
					state: { ...snapshot.state, phase: "committing" },
				};
				break;
			case "candidate":
				snapshot = { ...snapshot, candidate: { ...manifest } };
				break;
			case "recovery":
				snapshot = { ...snapshot, state: identifiedState() };
				break;
			case "producer":
				snapshot = { ...snapshot, producer: {} };
				break;
		}
		gate.resolve(proof);
		// Then every individual fence refuses, independently of the generation fence.
		expect(await pending).toBe(false);
		expect(writes).toBe(0);
	},
);
