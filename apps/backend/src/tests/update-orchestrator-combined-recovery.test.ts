import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import { checkOsChannel } from "../modules/system/update-orchestrator/os-agent.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkOsManifestResult,
	checkUpdatesNow,
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
import { resetDismissalStoreForTests } from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import {
	bytes,
	context,
	manifest,
	signature,
	deps as verification,
} from "./helpers/os-manifest-fixture.ts";
import { raucSlots } from "./helpers/slot-sync-rauc.ts";
import { evidence } from "./helpers/slot-sync-runtime-harness.ts";

const originalDismissalsPath = process.env.CERALIVE_DISMISSALS_FILE;
let root: string | undefined;

function clearNotices() {
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
}

beforeEach(() => {
	resetOrchestratorRuntimeForTest();
	clearNotices();
	resetDismissalStoreForTests();
});
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	clearNotices();
	resetDismissalStoreForTests();
	if (originalDismissalsPath === undefined)
		delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = originalDismissalsPath;
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function fixture(initial: OrchestratorState) {
	const dir = await mkdtemp(join(tmpdir(), "combined-recovery-"));
	root = dir;
	process.env.CERALIVE_DISMISSALS_FILE = join(dir, "dismissals.json");
	setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
	saveOrchestratorState(initial);
	const quarantine = new UpdateQuarantine(join(dir, "quarantine.json"));
	let mirrors = 0;
	const deps = fakeDeps({
		quarantine,
		persist: saveOrchestratorState,
		readPersistedState: loadOrchestratorState,
		startupRetryClock: { wait: async () => {} },
		readOsReceipt: async () => undefined,
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "slot-sync", "rauc-verity-streaming"],
		}),
		loadSettings: async () => ({
			packagesAuto: false,
			systemAuto: false,
			channel: "stable",
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		readSlotSyncEvidence: async () => ({
			...evidence,
			receiptStateSha256: evidence.statusSha256,
		}),
		readRootSlots: async () => raucSlots("A", "bad"),
		startSlotSync: async () => {
			mirrors++;
		},
		readPackageRecoveryEvidence: async () => ({
			unitAbsent: true,
			packagesIdle: true,
			locksIdle: true,
			auditClean: true,
			updatesEmpty: true,
			bootId: "boot-new",
			slot: "rootfs.0",
		}),
		checkOsManifest: (channel) =>
			checkOsManifestResult(channel ?? "stable", (settingsChannel) =>
				checkOsChannel(settingsChannel, quarantine, async () => ({
					data: bytes(manifest),
					signature,
					context: { ...context, serial: manifest.serial },
					verification: {
						...verification,
						compare: async (left, right) =>
							left.localeCompare(right, "en", { numeric: true }) > 0,
						isQuarantined: (version) =>
							quarantine.isOsVersionQuarantined(version),
					},
				})),
			),
	});
	return { deps, quarantine, mirrors: () => mirrors };
}

test("rollback history keeps its notice and quiet replay while a stale receipt dispatches the bad-slot mirror", async () => {
	// Given recorded rollback, a matching old receipt and a bad inactive slot.
	const initial = initialOrchestratorState(0);
	const f = await fixture(initial);
	await f.quarantine.recordOsRollback(manifest.version, context.bootedVersion);
	setOrchestratorRuntimeDepsForTest(f.deps);
	setOrchestratorStateForTest(initial);
	const warn = spyOn(logger, "warn");
	try {
		// When trusted replay is checked and only durable state survives restart.
		await checkUpdatesNow();
		expect(getOrchestratorState()).toMatchObject({
			failureReason: "serial_replayed",
			osCheck: { consecutiveFailures: 1 },
		});
		expect(
			getPersistentNotifications(true).show.map((n) => n.name),
		).not.toContain("update:refused:os-check:serial_replayed");
		resetOrchestratorRuntimeForTest();
		clearNotices();
		await startUpdateOrchestrator(f.deps);
		// Then mirror recovery and notice recovery coexist without noisy replay.
		expect(f.mirrors()).toBe(1);
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(getPersistentNotifications(true).show).toContainEqual(
			expect.objectContaining({
				name: `update:os-rollback:${manifest.version}`,
			}),
		);
		expect(warn.mock.calls).toHaveLength(0);
	} finally {
		warn.mockRestore();
	}
});

const failed: OrchestratorState = {
	...initialOrchestratorState(100),
	phase: "failed",
	failureReason: "commit_unit_absent_on_resume",
};

test("proven interrupted commit recovers idle and its notice before the stale-receipt mirror runs", async () => {
	// Given a consistent previous-boot attempt and a bad inactive mirror target.
	const f = await fixture({
		...failed,
		packageAttempt: { bootId: "boot-old", slot: "rootfs.0" },
	});
	await f.quarantine.savePending([{ name: "cerastream", version: "2026.9.6" }]);
	// When startup recovers the failure and the next idle tick evaluates mirroring.
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		recoveredNotice: { kind: "packages-recovered" },
	});
	expect(f.mirrors()).toBe(0);
	await runOrchestratorTick();
	// Then clearance never disables the independent mirror or loses its notice.
	expect(getOrchestratorState().phase).toBe("syncing");
	expect(f.mirrors()).toBe(1);
	expect(await f.quarantine.readPending()).toEqual([]);
	expect(getPersistentNotifications(true).show).toContainEqual(
		expect.objectContaining({ key: "notifications.updatePackagesRecovered" }),
	);
});

test("consistent dpkg without attempt provenance stays failed and cannot dispatch the mirror", async () => {
	// Given the same positive current evidence but no recorded old boot or slot.
	const f = await fixture(failed);
	await f.quarantine.savePending([{ name: "cerastream", version: "2026.9.6" }]);
	// When startup and its next tick attempt recovery.
	await startUpdateOrchestrator(f.deps);
	await runOrchestratorTick();
	// Then neither the notice nor mirror can turn unknown history into permission.
	expect(getOrchestratorState()).toEqual(failed);
	expect(f.mirrors()).toBe(0);
	expect(await f.quarantine.readPending()).toHaveLength(1);
	expect(getPersistentNotifications(true).show).not.toContainEqual(
		expect.objectContaining({ key: "notifications.updatePackagesRecovered" }),
	);
});
