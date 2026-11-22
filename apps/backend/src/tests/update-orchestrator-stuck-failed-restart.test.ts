import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

const dirs: string[] = [];
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	for (const n of getPersistentNotifications(true).show)
		if (
			n.name.startsWith("update:packages-recovered:") ||
			n.name.startsWith("update:slot-sync-recovered:")
		)
			notificationRemove(n.name);
});

async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "stuck-failed-"));
	dirs.push(dir);
	setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
	const quarantine = new UpdateQuarantine(join(dir, "quarantine.json"));
	await quarantine.savePending([{ name: "cerastream", version: "2026.9.6" }]);
	let probes = 0;
	let installs = 0;
	const deps = fakeDeps({
		quarantine,
		persist: saveOrchestratorState,
		readPersistedState: loadOrchestratorState,
		startupRetryClock: { wait: async () => {} },
		readPackageRecoveryEvidence: async () => {
			probes++;
			return {
				unitAbsent: true,
				packagesIdle: true,
				locksIdle: true,
				auditClean: true,
				updatesEmpty: true,
				bootId: "new-boot",
				slot: "rootfs.0",
			};
		},
		getPackageInstallWireState: () => ({ kind: "idle" }),
		startPackageInstall: () => {
			installs++;
			return { started: true };
		},
		readOsReceipt: async () => undefined,
	});
	const committing: OrchestratorState = {
		...initialOrchestratorState(100),
		phase: "committing",
		packageAttempt: { bootId: "old-boot", slot: "rootfs.0" },
	};
	return {
		deps,
		quarantine,
		committing,
		probes: () => probes,
		installs: () => installs,
	};
}

test("committing resume reaches consistency recovery before exposing a stuck failure", async () => {
	// Given a durable committing record and a positively absent unit after reboot.
	const f = await fixture();
	saveOrchestratorState(f.committing);
	// When startup resumes without a retained terminal outcome.
	await startUpdateOrchestrator(f.deps);
	// Then it proves consistency, clears the pending plan and never runs an install.
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		failureReason: null,
	});
	expect(await f.quarantine.readPending()).toEqual([]);
	expect(f.installs()).toBe(0);
});

test("two restarts retain the recovered notice and do not recover or install twice", async () => {
	// Given a recorded missing-unit failure on disk.
	const f = await fixture();
	saveOrchestratorState({
		...f.committing,
		phase: "failed",
		failureReason: "commit_unit_absent_on_resume",
	});
	// When recovery and two fresh runtime starts read the same disk.
	await startUpdateOrchestrator(f.deps);
	for (let restart = 0; restart < 2; restart++) {
		for (const n of getPersistentNotifications(true).show)
			if (n.name.startsWith("update:packages-recovered:"))
				notificationRemove(n.name);
		resetOrchestratorRuntimeForTest();
		await startUpdateOrchestrator(f.deps);
	}
	// Then recovery is idempotent and the single notice is rehydratable.
	expect(getOrchestratorState().phase).toBe("idle");
	expect(f.probes()).toBe(1);
	expect(f.installs()).toBe(0);
	expect(
		getPersistentNotifications(true).show.filter((n) =>
			n.name.startsWith("update:packages-recovered:"),
		),
	).toHaveLength(1);
});

for (const renamed of [false, true]) {
	test(`second crash ${renamed ? "after" : "before"} recovery state rename remains safe`, async () => {
		// Given recovery interrupted between plan clearance and durable acknowledgement.
		const f = await fixture();
		const failed = {
			...f.committing,
			phase: "failed" as const,
			failureReason: "commit_unit_absent_on_resume",
		};
		saveOrchestratorState(failed);
		setOrchestratorRuntimeDepsForTest({
			...f.deps,
			persist: (next) => {
				if (renamed) saveOrchestratorState(next);
				throw new Error("simulated crash at state acknowledgement");
			},
		});
		setOrchestratorStateForTest(failed);
		// When the interrupted tick is followed by a new process using only disk.
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		resetOrchestratorRuntimeForTest();
		await startUpdateOrchestrator(f.deps);
		// Then no old plan is replayed and the recovered state/notice survive.
		expect(getOrchestratorState().phase).toBe("idle");
		expect(await f.quarantine.readPending()).toEqual([]);
		expect(f.installs()).toBe(0);
		expect(
			getPersistentNotifications(true).show.some((n) =>
				n.name.startsWith("update:packages-recovered:"),
			),
		).toBe(true);
	});
}

test("legacy persisted state without new optional metadata still loads exactly", async () => {
	// Given the pre-fix persisted schema.
	await fixture();
	const legacy = {
		...initialOrchestratorState(100),
		phase: "failed" as const,
		failureReason: "commit_unit_absent_on_resume",
	};
	saveOrchestratorState(legacy);
	// When the strict production loader reads it.
	const loaded = await loadOrchestratorState();
	// Then no fabricated provenance or default success is added.
	expect(loaded).toEqual(legacy);
});

test("startup supersedes a recorded mirror failure using a later receipt and both good slots", async () => {
	// Given the previous failed run and independent later mirror evidence.
	const f = await fixture();
	saveOrchestratorState({
		...initialOrchestratorState(100),
		phase: "failed",
		failureReason: "slot-sync-incomplete",
	});
	let reads = 0;
	// When startup rechecks that failure.
	await startUpdateOrchestrator({
		...f.deps,
		inspectSlotSync: async () => {
			reads++;
			return { kind: "inactive-clean" };
		},
		readBootedVersion: async () => "2026.10.69",
		readRootSlots: async () => [
			{
				name: "rootfs.1",
				bootname: "B",
				state: "booted",
				bootStatus: "good",
				version: "2026.10.69",
				lastSyncedAt: null,
			},
			{
				name: "rootfs.0",
				bootname: "A",
				state: "inactive",
				bootStatus: "good",
				version: "2026.10.69",
				lastSyncedAt: null,
			},
		],
		readSlotSyncEvidence: async () => ({
			healthyState: {
				boot_id: "boot",
				slot: "rootfs.1",
				build_id: "build",
				dpkg_status_sha256: "a".repeat(64),
				recorded_at: "1970-01-01T00:00:00Z",
			},
			bootId: "boot",
			buildId: "build",
			statusSha256: "a".repeat(64),
			receiptStateSha256: "a".repeat(64),
			receiptTarget: "other",
			receiptTargetSlot: "rootfs.0",
			receiptCompletedAt: "1970-01-01T00:00:01Z",
			receiptBuildId: "build",
			receiptImageVersion: "2026.10.69",
		}),
	});
	// Then startup publishes recovered idle without clearing package evidence.
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		failureReason: null,
		recoveredNotice: { kind: "slot-sync-recovered" },
	});
	expect(reads).toBe(2);
	expect(await f.quarantine.readPending()).toHaveLength(1);
});
