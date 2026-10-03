import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { evidence, fixture } from "./helpers/slot-sync-runtime-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("reboot-proven slot mirror orchestration", () => {
	test("an APT commit starts no mirror until a new boot passes healthcheck", async () => {
		const h = fixture();
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "settled",
		});
		h.setEvidence({ ...evidence, bootId: "boot-old" });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
		expect(h.commands).toEqual([]);
		h.setEvidence(evidence); // after reboot + healthcheck-good on this boot
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(h.commands).toEqual([
			["systemctl", "start", "--no-block", "ceralive-slot-sync.service"],
		]);
	});

	test("a not-yet-booted OS-triggered candidate settles idle without firing the unit", async () => {
		const h = fixture({
			readSlotSyncEvidence: async () => ({ ...evidence, healthyState: null }),
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "sync-eligible",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
		expect(h.commands).toEqual([]);
	});

	test("legacy images never read the mirror's absent files or dispatch its unit", async () => {
		let reads = 0;
		const h = fixture({
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
			readSlotSyncEvidence: async () => {
				reads++;
				return evidence;
			},
		});
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await runOrchestratorTick();
		expect(reads).toBe(0);
		expect(h.commands).toEqual([]);
	});

	test("a concurrent OS install or APT commit cannot dispatch a mirror", async () => {
		const h = fixture();
		for (const phase of ["os-staging", "committing"] as const) {
			setOrchestratorStateForTest({ ...initialOrchestratorState(0), phase });
			await runOrchestratorTick();
		}
		expect(h.commands).toEqual([]);
	});

	test("the unit's authoritative exit 75 refusal is distinct from an operational failure", async () => {
		let reset = 0;
		fixture({
			inspectSlotSync: async () => ({ kind: "refused", exitCode: 75 }),
			resetSlotSyncFailure: async () => {
				reset++;
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().failureReason).toBe(
			"slot-sync refused (exit 75)",
		);
		expect(getOrchestratorState().phase).toBe("failed");
		expect(reset).toBe(1);
	});

	test("startup rechecks persisted idle and fires the healthy lagged candidate immediately", async () => {
		root = await mkdtemp(join(tmpdir(), "ceraui-slot-sync-"));
		setOrchestratorStateFilePathForTest(join(root, "agent.json"));
		const h = fixture();
		await startUpdateOrchestrator(h.deps);
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(h.commands).toHaveLength(1);
	});

	test("OS verification on this boot's passing healthcheck attempts the mirror immediately", async () => {
		const h = fixture({
			readOsReceipt: async () => ({
				schema: 1,
				version: "2026.10.0",
				channel: "stable",
				stagedAt: 1000,
				bootId: "boot-old",
			}),
			readBootedVersion: async () => "2026.10.0",
			readBootId: async () => evidence.bootId,
			readHealthyState: async () => evidence.healthyState,
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-verifying",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(h.commands).toHaveLength(1);
	});
});
