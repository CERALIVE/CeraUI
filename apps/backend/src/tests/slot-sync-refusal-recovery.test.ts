import { expect, test } from "bun:test";
import {
	type FailedRecoveryPort,
	recoverFailedUpdate,
} from "../modules/system/update-orchestrator/failed-recovery.ts";
import type { SlotSyncProbeState } from "../modules/system/update-orchestrator/lock.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

function recoveryFixture() {
	const before: OrchestratorState = {
		...initialOrchestratorState(1_000),
		phase: "failed",
		failureReason: "slot-sync refused (exit 75)",
	};
	let snapshot = before;
	const effects: OrchestratorState[] = [];
	const unexpected = async (): Promise<never> => {
		throw new Error("refusal release must not require a successful mirror");
	};
	const port: FailedRecoveryPort = {
		snapshot: () => snapshot,
		current: () => true,
		acquireControl: acquireTestOsStageControl,
		acquireUpdateLock: acquireTestOsStageControl,
		readPersisted: async () => before,
		readPackageEvidence: unexpected,
		clearPending: unexpected,
		persist: (next) => effects.push(next),
		adopt: (next) => {
			snapshot = next;
		},
		now: () => 2_000,
		inspectSync: async () => ({ kind: "inactive-clean" }),
		readSyncEvidence: unexpected,
		readSlots: unexpected,
		readVersion: unexpected,
	};
	return { before, port, effects };
}

test("an exact historical refusal releases without a later receipt or a recovery notice", async () => {
	const h = recoveryFixture();
	expect(await recoverFailedUpdate(h.port)).toBe(true);
	expect(h.effects).toHaveLength(1);
	expect(h.port.snapshot()).toMatchObject({
		phase: "idle",
		failureReason: null,
		progress: null,
		slotSync: { nextAttemptAt: 2_000, consecutiveRefusals: 0 },
	});
	expect(h.port.snapshot().recoveredNotice).toBeUndefined();
});

const unclean: readonly SlotSyncProbeState[] = [
	{ kind: "running" },
	{ kind: "failed", exitCode: 1 },
	{ kind: "refused", exitCode: 75 },
	{ kind: "absent" },
];
for (const probe of unclean) {
	for (const at of ["first", "confirmation"] as const) {
		test(`historical refusal stays failed when the ${at} probe is ${probe.kind}`, async () => {
			const h = recoveryFixture();
			let reads = 0;
			expect(
				await recoverFailedUpdate({
					...h.port,
					inspectSync: async () => {
						reads++;
						return at === "first" || reads === 2
							? probe
							: { kind: "inactive-clean" };
					},
				}),
			).toBe(false);
			expect(h.effects).toEqual([]);
			expect(h.port.snapshot()).toBe(h.before);
		});
	}
}

test.each([
	"persisted drift",
	"control loss",
	"update lock loss",
	"generation drift",
	"snapshot drift",
] as const)(
	"historical refusal release preserves failure after %s",
	async (change) => {
		const h = recoveryFixture();
		let probes = 0;
		const port: FailedRecoveryPort = {
			...h.port,
			readPersisted: async () =>
				change === "persisted drift"
					? { ...h.before, enteredAt: 1_001 }
					: h.before,
			acquireControl: async () => ({
				held: () => change !== "control loss" || probes < 2,
				[Symbol.asyncDispose]: async () => {},
			}),
			acquireUpdateLock: async () => ({
				held: () => change !== "update lock loss" || probes < 2,
				[Symbol.asyncDispose]: async () => {},
			}),
			current: () => change !== "generation drift" || probes < 2,
			snapshot: () =>
				change === "snapshot drift" && probes === 2
					? { ...h.before }
					: h.before,
			inspectSync: async () => {
				probes++;
				return { kind: "inactive-clean" };
			},
		};
		expect(await recoverFailedUpdate(port)).toBe(false);
		expect(h.effects).toEqual([]);
	},
);

test.each([
	"slot-sync failed (exit 1)",
	"slot-sync-incomplete",
	"slot-sync refused (exit 74)",
	"slot-sync refused (exit 75)\n",
])("refusal-release event cannot clear %s", (failureReason) => {
	const state = {
		...initialOrchestratorState(0),
		phase: "failed" as const,
		failureReason,
	};
	expect(
		reduceOrchestrator(state, {
			type: "SYNC_REFUSAL_RELEASED",
			now: 2_000,
		}),
	).toBe(state);
});
