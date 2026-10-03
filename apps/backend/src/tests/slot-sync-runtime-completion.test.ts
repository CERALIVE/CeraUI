import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { notificationExists } from "../modules/ui/notifications.ts";
import {
	evidence,
	fixture,
	pastGrace,
	statusSha256,
} from "./helpers/slot-sync-runtime-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("reboot-proven slot mirror orchestration", () => {
	test("success settles synced, cleans exactly once, then notifies", async () => {
		const h = fixture();
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await runOrchestratorTick();
		h.setProbe("succeeded");
		// The unit's own receipt is the confirmation for this invocation.
		h.setEvidence({ ...evidence, receiptStateSha256: statusSha256 });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
		await runOrchestratorTick();
		expect(h.cleanup).toHaveLength(4);
		expect(h.commands).toHaveLength(1);
	});

	test("cleanup failures cannot reverse success or suppress the remaining cleanup", async () => {
		const h = fixture({
			cleanSlotSyncArchives: async () => false,
			removeRaucDownloads: async () => {
				throw new Error("unavailable");
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		h.setProbe("succeeded");
		h.setEvidence({ ...evidence, receiptStateSha256: statusSha256 });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		expect(h.cleanup).toEqual(["quarantine", "slots"]);
	});

	test("a queued unit's stale previous exit 0 cannot settle without this run's receipt", async () => {
		const h = fixture();
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		h.setProbe("succeeded");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(h.cleanup).toEqual([]);
		h.setEvidence({ ...evidence, receiptStateSha256: statusSha256 });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
	});

	test("an unloaded finished unit settles synced when this run's receipt matches", async () => {
		const h = fixture({ now: () => 4_000 });
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		h.setProbe("inactive-clean");
		h.setEvidence({ ...evidence, receiptStateSha256: statusSha256 });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		expect(getOrchestratorState().failureReason).toBeNull();
		expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
		expect(notificationExists("update:slots-current:4000")).toBeDefined();
	});

	test("a probe that could not positively read the unit never settles from a matching receipt", async () => {
		// The unit publishes its receipt before `rauc status mark-good other`,
		// so a matching receipt alone does not prove the run finished cleanly.
		const h = fixture({ now: () => pastGrace(4_500) });
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		h.setProbe("absent");
		h.setEvidence({ ...evidence, receiptStateSha256: statusSha256 });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
		expect(h.cleanup).toEqual([]);
		expect(
			notificationExists(`update:slots-current:${pastGrace(4_500)}`),
		).toBeUndefined();
	});
});
