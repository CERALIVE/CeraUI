import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { notificationExists } from "../modules/ui/notifications.ts";
import {
	evidence,
	fixture,
	pastGrace,
} from "./helpers/slot-sync-runtime-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("reboot-proven slot mirror orchestration", () => {
	test("an inactive-clean unit without this run's receipt still fails as absent", async () => {
		const receipts: ReadonlyArray<SlotSyncEvidence["receiptStateSha256"]> = [
			"b".repeat(64),
			null,
		];
		for (const receiptStateSha256 of receipts) {
			resetOrchestratorRuntimeForTest();
			const h = fixture({ now: () => pastGrace(5_500) });
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "syncing",
			});
			h.setProbe("inactive-clean");
			h.setEvidence({ ...evidence, receiptStateSha256 });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(
				"slot-sync-unit-absent",
			);
			expect(h.cleanup).toEqual([]);
		}
	});

	test("an inactive-clean unit whose receipt cannot be read fails rather than succeeding", async () => {
		const h = fixture({
			now: () => pastGrace(6_500),
			readSlotSyncEvidence: async () => {
				throw new Error("receipt unreadable");
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		h.setProbe("inactive-clean");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
		expect(h.cleanup).toEqual([]);
	});

	test("an absent unit without this run's receipt still fails as absent", async () => {
		const receipts: ReadonlyArray<SlotSyncEvidence["receiptStateSha256"]> = [
			"b".repeat(64),
			null,
		];
		for (const receiptStateSha256 of receipts) {
			resetOrchestratorRuntimeForTest();
			const h = fixture({ now: () => pastGrace(5_000) });
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "syncing",
			});
			h.setProbe("absent");
			h.setEvidence({ ...evidence, receiptStateSha256 });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(
				"slot-sync-unit-absent",
			);
			expect(h.cleanup).toEqual([]);
		}
		expect(
			notificationExists(`update:slots-current:${pastGrace(5_000)}`),
		).toBeUndefined();
	});

	test("an absent unit whose receipt cannot be read fails rather than succeeding", async () => {
		const h = fixture({
			now: () => pastGrace(6_000),
			readSlotSyncEvidence: async () => {
				throw new Error("receipt unreadable");
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		h.setProbe("absent");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
		expect(h.cleanup).toEqual([]);
		expect(
			notificationExists(`update:slots-current:${pastGrace(6_000)}`),
		).toBeUndefined();
	});
});
