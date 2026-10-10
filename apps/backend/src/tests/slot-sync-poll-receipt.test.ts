import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
	classifySlotSyncProbe,
	type SlotSyncProbeState,
} from "../modules/system/update-orchestrator/lock.ts";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	SLOT_SYNC_QUEUED_START_GRACE_MS,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	deps,
	inactiveClean,
	matching,
	show,
	stillRunning,
	succeededExit0,
	syncing,
	unitFailed,
} from "./helpers/slot-sync-poll-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("B2: a matching receipt settles only after a fresh finished-and-clean probe", () => {
	type Show = ReturnType<typeof show>;

	const previousRunFinished: ReadonlyArray<
		readonly ["succeeded" | "inactive-clean", Show]
	> = [
		["succeeded", succeededExit0],
		["inactive-clean", inactiveClean],
	];

	for (const [label, finished] of previousRunFinished) {
		test(`a receipt published by a still-running run cannot settle from the previous run's ${label} probe`, async () => {
			let current: Show = finished;
			let reads = 0;
			let release: ((value: SlotSyncEvidence) => void) | undefined;
			const deferred = new Promise<SlotSyncEvidence>((resolve) => {
				release = resolve;
			});
			const probes: SlotSyncProbeState["kind"][] = [];
			const h = deps({
				inspectSlotSync: async () => {
					const probe = classifySlotSyncProbe(current);
					probes.push(probe.kind);
					return probe;
				},
				readSlotSyncEvidence: () => {
					reads++;
					return reads === 1 ? deferred : Promise.resolve(matching);
				},
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			const tick = runOrchestratorTick();
			while (reads === 0) await Bun.sleep(0);
			// The new run starts and publishes its receipt before mark-good.
			current = stillRunning;
			release?.(matching);
			await tick;
			expect(getOrchestratorState().phase).toBe("syncing");
			expect(h.cleanup).toEqual([]);
			expect(probes).toEqual([label, "running"]);

			current = finished;
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("synced");
			expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
		});
	}

	test("a run that fails between the receipt and the re-probe keeps its failure verdict", async () => {
		const refused = show({
			LoadState: "loaded",
			ActiveState: "failed",
			SubState: "failed",
			ExecMainCode: "1",
			ExecMainStatus: "75",
		});
		const cases: ReadonlyArray<readonly [Show, Show, string]> = [
			[succeededExit0, unitFailed, "slot-sync failed (exit 1)"],
			[inactiveClean, unitFailed, "slot-sync failed (exit 1)"],
			[inactiveClean, refused, "slot-sync refused (exit 75)"],
			[
				succeededExit0,
				show({ LoadState: "not-found" }),
				"slot-sync-unit-absent",
			],
		];
		for (const [first, second, reason] of cases) {
			resetOrchestratorRuntimeForTest();
			const sequence = [first, second];
			let resets = 0;
			const h = deps({
				inspectSlotSync: async () =>
					classifySlotSyncProbe(sequence.shift() ?? second),
				resetSlotSyncFailure: async () => {
					resets++;
				},
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			await runOrchestratorTick();
			if (reason === "slot-sync-unit-absent") {
				// An unreadable confirmation is waited out once; the next poll's
				// first probe reads it again and fails once past the queued-start
				// grace (round 15, item 1).
				expect(getOrchestratorState().phase).toBe("syncing");
				setOrchestratorRuntimeDepsForTest({
					...h.value,
					now: () => SLOT_SYNC_QUEUED_START_GRACE_MS + 9_000,
				});
				await runOrchestratorTick();
			}
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(reason);
			expect(h.cleanup).toEqual([]);
			expect(resets).toBe(reason === "slot-sync-unit-absent" ? 0 : 1);
		}
	});

	test("a receipt that cannot be read leaves a succeeded probe waiting and fails an inactive-clean one", async () => {
		// Past the queued-start grace, the inactive-clean failure is concluded
		// only from a second, fresh probe (N1).
		for (const [finished, phase, expectedProbes] of [
			[succeededExit0, "syncing", 1],
			[inactiveClean, "failed", 2],
		] as const) {
			resetOrchestratorRuntimeForTest();
			let probes = 0;
			const h = deps({
				now: () => SLOT_SYNC_QUEUED_START_GRACE_MS + 9_000,
				inspectSlotSync: async () => {
					probes++;
					return classifySlotSyncProbe(finished);
				},
				readSlotSyncEvidence: async () => {
					throw new Error("receipt unreadable");
				},
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe(phase);
			expect(probes).toBe(expectedProbes);
			expect(h.cleanup).toEqual([]);
		}
	});
});
