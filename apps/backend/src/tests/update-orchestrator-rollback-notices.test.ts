import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	DEFAULT_MAX_DISMISSALS,
	getDismissalStore,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationDismiss,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { DISMISSAL_CHURN_TIMEOUT_MS } from "./helpers/notification-churn-budget.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import {
	board,
	FALLBACK_BOOT,
} from "./helpers/os-verify-healthcheck-harness.ts";

const badVersion = "2026.10.91";
const bootedVersion = "2026.10.76";
const noticeName = `update:os-rollback:${badVersion}`;
const originalDismissalsPath = process.env.CERALIVE_DISMISSALS_FILE;
let root: string | undefined;

function clearNotices() {
	for (const notice of getPersistentNotifications(true).show) {
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
	}
}

beforeEach(() => {
	clearNotices();
	resetOrchestratorRuntimeForTest();
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

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "rollback-notices-"));
	root = dir;
	process.env.CERALIVE_DISMISSALS_FILE = join(dir, "dismissals.json");
	setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
	saveOrchestratorState(initialOrchestratorState(0));
	const quarantinePath = join(dir, "quarantine.json");
	const quarantine = new UpdateQuarantine(quarantinePath, async () => {});
	const b = board(badVersion, { bootedVersion, bootId: FALLBACK_BOOT });
	const deps = fakeDeps({
		...b.deps,
		persist: saveOrchestratorState,
		readPersistedState: loadOrchestratorState,
		quarantine,
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		isUpdateAdmissionReady: async () => true,
		loadSettings: async () => ({
			packagesAuto: false,
			systemAuto: false,
			channel: "stable",
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
	});
	return {
		deps,
		quarantine,
		quarantinePath,
		restart: async () => {
			resetOrchestratorRuntimeForTest();
			clearNotices();
			resetDismissalStoreForTests();
			await startUpdateOrchestrator(deps);
		},
	};
}

function rollbackNotices() {
	return getPersistentNotifications(true).show.filter(
		(notice) => notice.name === noticeName,
	);
}

test("recorded rollback rehydrates exactly once across two backend restarts", async () => {
	// Given a real rollback that already returned the workflow to idle.
	const f = await fixture();
	setOrchestratorRuntimeDepsForTest(f.deps);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-verifying",
	});
	await runOrchestratorTick();
	expect(rollbackNotices()).toHaveLength(1);
	expect(getOrchestratorState().phase).toBe("idle");
	// When only disk survives two fresh runtime initializations.
	await f.restart();
	expect(rollbackNotices()).toHaveLength(1);
	await f.restart();
	await runOrchestratorTick();
	// Then the same stable notice remains once, with its original wire key.
	expect(rollbackNotices()).toMatchObject([
		{
			name: noticeName,
			key: "notifications.updateRollback",
			params: { version: badVersion },
		},
	]);
});

test(
	"operator dismissal stays gone across restarts and ordinary dismissal churn",
	async () => {
		// Given recorded rollback and its operator-dismissed notice.
		const f = await fixture();
		await f.quarantine.recordOsRollback(badVersion, bootedVersion);
		await f.restart();
		expect(rollbackNotices()).toHaveLength(1);
		notificationDismiss(noticeName);
		expect(rollbackNotices()).toHaveLength(0);
		for (let i = 0; i <= DEFAULT_MAX_DISMISSALS; i++)
			getDismissalStore().recordDismissal(`ordinary:${i}`);
		// When the runtime and dismissal-store singleton are reloaded from disk.
		await f.restart();
		await f.restart();
		await runOrchestratorTick();
		// Then dismissal did not erase protection or resurrect the notice.
		expect(rollbackNotices()).toHaveLength(0);
		expect(getDismissalStore().isDismissed(noticeName)).toBe(true);
		expect(await f.quarantine.isOsVersionQuarantined(badVersion)).toBe(true);
	},
	DISMISSAL_CHURN_TIMEOUT_MS,
);

test("idle startup restores quarantine history even without a staged receipt", async () => {
	// Given durable history, not a pending activation or historical workflow phase.
	const f = await fixture();
	await f.quarantine.recordOsRollback(badVersion, bootedVersion);
	// When startup cannot read any old receipt.
	await startUpdateOrchestrator({
		...f.deps,
		readOsReceipt: async () => undefined,
	});
	// Then the recorded rollback still reaches the operator.
	expect(rollbackNotices()).toHaveLength(1);
});

test.each(["absent", "empty", "package-only", "corrupt", "non-file"] as const)(
	"startup with %s quarantine raises no invented rollback and does not crash",
	async (kind) => {
		// Given no readable OS rollback evidence.
		const f = await fixture();
		if (kind === "empty" || kind === "package-only")
			await Bun.write(
				f.quarantinePath,
				JSON.stringify({
					schema: 1,
					packages:
						kind === "package-only"
							? [{ name: "cerastream", version: badVersion }]
							: [],
					os: [],
					failedCommits: [],
				}),
			);
		if (kind === "corrupt") await Bun.write(f.quarantinePath, "{");
		if (kind === "non-file") {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(f.quarantinePath);
		}
		// When the backend starts, including a later scheduler pass.
		await f.restart();
		await runOrchestratorTick();
		// Then notice damage does not crash the runtime or manufacture an event.
		expect(rollbackNotices()).toHaveLength(0);
		expect(getOrchestratorState().phase).toBe("idle");
	},
);
