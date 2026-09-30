import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { notificationExists } from "../modules/ui/notifications.ts";

const statusSha256 = "a".repeat(64);
const evidence: SlotSyncEvidence = {
	healthyState: {
		boot_id: "boot-new",
		slot: "A",
		build_id: "build-new",
		dpkg_status_sha256: statusSha256,
		recorded_at: "2026-09-24T00:00:00Z",
	},
	bootId: "boot-new",
	statusSha256,
	buildId: "build-new",
	receiptStateSha256: "b".repeat(64),
};
let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

function fixture(
	overrides: Partial<typeof defaultOrchestratorRuntimeDeps> = {},
) {
	const commands: string[][] = [];
	const cleanup: string[] = [];
	let probe: "running" | "succeeded" | "absent" | "inactive-clean" = "running";
	let observed = evidence;
	const deps = {
		...defaultOrchestratorRuntimeDeps,
		now: () => 2_000,
		loadCapabilities: async () => ({
			mode: "capable" as const,
			features: ["apt-all-packages", "slot-sync"] as (
				| "apt-all-packages"
				| "slot-sync"
			)[],
		}),
		loadSettings: async () => ({
			packagesAuto: false,
			systemAuto: false,
			schedule: { mode: "any-idle" as const, start: "03:00", end: "05:00" },
			channel: "stable" as const,
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		isStreamLive: () => true, // a local-only mirror is permitted mid-stream
		readSlotSyncEvidence: async () => observed,
		startSlotSync: async () => {
			commands.push([
				"systemctl",
				"start",
				"--no-block",
				"ceralive-slot-sync.service",
			]);
		},
		inspectSlotSync: async () => ({ kind: probe }),
		inspectOsOperation: async () => "running" as const,
		cleanSlotSyncArchives: async () => {
			cleanup.push("apt");
			return true;
		},
		removeRaucDownloads: async () => {
			cleanup.push("downloads");
		},
		dropSupersededQuarantine: async () => {
			cleanup.push("quarantine");
		},
		refreshSlots: async () => {
			cleanup.push("slots");
		},
		persist: () => {},
		...overrides,
	};
	setOrchestratorRuntimeDepsForTest(deps);
	return {
		deps,
		commands,
		cleanup,
		setEvidence: (value: SlotSyncEvidence) => {
			observed = value;
		},
		setProbe: (
			value: "running" | "succeeded" | "absent" | "inactive-clean",
		) => {
			probe = value;
		},
	};
}

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
		const h = fixture({ now: () => 4_500 });
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
		expect(notificationExists("update:slots-current:4500")).toBeUndefined();
	});

	test("an inactive-clean unit without this run's receipt still fails as absent", async () => {
		const receipts: ReadonlyArray<SlotSyncEvidence["receiptStateSha256"]> = [
			"b".repeat(64),
			null,
		];
		for (const receiptStateSha256 of receipts) {
			resetOrchestratorRuntimeForTest();
			const h = fixture({ now: () => 5_500 });
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
			now: () => 6_500,
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
			const h = fixture({ now: () => 5_000 });
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
		expect(notificationExists("update:slots-current:5000")).toBeUndefined();
	});

	test("an absent unit whose receipt cannot be read fails rather than succeeding", async () => {
		const h = fixture({
			now: () => 6_000,
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
		expect(notificationExists("update:slots-current:6000")).toBeUndefined();
	});

	test("startup rechecks persisted idle and fires the healthy lagged candidate immediately", async () => {
		root = await mkdtemp(join(tmpdir(), "ceraui-slot-sync-"));
		setOrchestratorStateFilePathForTest(join(root, "agent.json"));
		const h = fixture();
		await startUpdateOrchestrator(h.deps);
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(h.commands).toHaveLength(1);
	});

	test("OS verification still transitions unconditionally and attempts the mirror immediately", async () => {
		const h = fixture({
			readOsReceipt: async () => ({
				schema: 1,
				version: "2026.10.0",
				channel: "stable",
				stagedAt: 1000,
				bootId: "boot-old",
			}),
			readBootedVersion: async () => "2026.10.0",
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
