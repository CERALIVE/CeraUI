import { afterEach, expect, test } from "bun:test";
import { withOsStageRunControl } from "../modules/system/update-orchestrator/os-stage-run-control.ts";
import {
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { settleOsUnlaunchedWitness } from "../modules/system/update-orchestrator/os-unlaunched-adapter.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	installUpdatesNow,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { input } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	GOOD_SLOTS,
	identifiedState,
	KEY,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test.each(["attempt", "candidate", "failure"] as const)(
	"does not overwrite authoritative %s drift during the evidence await",
	async (drift) => {
		// Given backend A's unchanged memory and a real persisted unsafe record.
		const f = runtimeFixture();
		fixtures.push(f);
		const before = identifiedState();
		saveOrchestratorState(before, f.file);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = false;
		let observedLease = false;
		let writes = 0;
		const settlement = settleOsUnlaunchedWitness({
			acquireControl: async () => {
				held = true;
				return {
					held: () => held,
					async [Symbol.asyncDispose]() {
						held = false;
					},
				};
			},
			snapshot: () => ({
				state: before,
				generation: 1,
				candidate: undefined,
				producer: undefined,
			}),
			readWitness: () => {
				observedLease = held;
				return {
					attemptId: input.attemptId,
					candidateKey: KEY,
					bootId: input.bootId,
					baselineInstance: input.baselineInstance,
					disposition: "unlaunched-unchanged",
				};
			},
			readEvidence: async () => {
				entered.resolve();
				await release.promise;
				return {
					raucOperation: "idle",
					writerQuiescent: true,
					rootSlots: GOOD_SLOTS,
					healthyBootId: input.bootId,
					bootId: input.bootId,
					stagedReceiptPresent: false,
					activationArmed: false,
				};
			},
			readPersisted: () => loadOrchestratorState(f.file),
			dispatch: () => {
				writes++;
				return before;
			},
			persist: () => {
				writes++;
			},
			consume: () => {
				writes++;
			},
			now: () => 1,
		});
		await entered.promise;
		const record = before.osStageRecovery;
		if (!record) throw new Error("fixture record missing");
		const newer = {
			...before,
			failureReason:
				drift === "failure"
					? "os_stage_outcome_unknown_after_restart"
					: before.failureReason,
			osStageRecovery: {
				...record,
				attemptId:
					drift === "attempt"
						? "00000000-0000-4000-8000-000000000099"
						: record.attemptId,
				candidateKey:
					drift === "candidate" ? `${KEY}-new` : record.candidateKey,
				reason:
					drift === "failure"
						? "os_stage_outcome_unknown_after_restart"
						: record.reason,
			},
		};
		// When another backend replaces disk only while A is awaiting readiness.
		saveOrchestratorState(newer, f.file);
		release.resolve();
		// Then A never adopts, persists or consumes the old witness.
		await expect(settlement).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		expect(writes).toBe(0);
		expect(observedLease).toBe(true);
		expect(await loadOrchestratorState(f.file)).toEqual(newer);
	},
);

test("holds one borrowed lease from witness retirement through the runner's guard write", async () => {
	// Given a leftover witness and a lease whose second acquisition is refused.
	const f = runtimeFixture();
	fixtures.push(f);
	let held = false;
	let acquisitions = 0;
	const acquire = async () => {
		if (held) throw new Error("duplicate acquisition");
		held = true;
		acquisitions++;
		return {
			held: () => held,
			async [Symbol.asyncDispose]() {
				held = false;
			},
		};
	};
	setOrchestratorRuntimeDepsForTest(f.deps);
	await checkUpdatesNow();
	f.writeWitness();
	let guardWrote = false;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		acquireOsStageControl: acquire,
		consumeOsUnlaunchedWitness: (id) => {
			expect(held).toBe(true);
			f.deps.consumeOsUnlaunchedWitness?.(id);
		},
		stageOs: async (_manifest, _progress, control) => {
			if (!control) throw new Error("missing control");
			await withOsStageRunControl(control, acquire, async (_guarded, lease) => {
				expect(lease.held()).toBe(true);
				writeOsUnlaunchedWitness(
					{ ...input, attemptId: control.attemptId },
					f.witnessDeps,
				);
				guardWrote = true;
			});
			expect(held).toBe(true);
		},
	});
	// When runtime admits and the real run-control wrapper borrows its lease.
	await installUpdatesNow();
	// Then the conflicting leftover cannot break the guard write; borrowing never releases ownership.
	expect(guardWrote).toBe(true);
	expect(acquisitions).toBe(1);
	expect(held).toBe(false);
	expect(readOsUnlaunchedWitness(f.witnessDeps)?.attemptId).toBe(
		"00000000-0000-4000-8000-000000000003",
	);
});
