import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	getDismissalStore,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

const noticeName = "update:os-rollback:2026.10.91";
const originalDismissalsPath = process.env.CERALIVE_DISMISSALS_FILE;
let root: string | undefined;

function updateNotices() {
	return getPersistentNotifications(true).show.filter((notice) =>
		notice.name.startsWith("update:"),
	);
}

beforeEach(() => {
	for (const notice of updateNotices()) notificationRemove(notice.name);
	resetOrchestratorRuntimeForTest();
	resetDismissalStoreForTests();
});

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	for (const notice of updateNotices()) notificationRemove(notice.name);
	resetDismissalStoreForTests();
	setOrchestratorStateFilePathForTest(null);
	if (originalDismissalsPath === undefined)
		delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = originalDismissalsPath;
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "notice-storage-"));
	root = dir;
	const agent = join(dir, "agent.json");
	const dismissals = join(dir, "dismissals.json");
	process.env.CERALIVE_DISMISSALS_FILE = dismissals;
	setOrchestratorStateFilePathForTest(agent);
	saveOrchestratorState(initialOrchestratorState(0));
	const quarantine = new UpdateQuarantine(join(dir, "quarantine.json"));
	await quarantine.recordOsRollback("2026.10.91", "2026.10.76");
	const waits: number[] = [];
	const deps = fakeDeps({
		quarantine,
		persist: saveOrchestratorState,
		readPersistedState: loadOrchestratorState,
		readOsReceipt: async () => undefined,
		isUpdateAdmissionReady: async () => true,
		startupRetryClock: {
			wait: async (delay) => {
				waits.push(delay);
			},
		},
	});
	return { agent, dismissals, deps, waits };
}

test("failed dismissal load retries from disk after storage is repaired", async () => {
	// Given an unreadable store hiding an existing operator acknowledgement.
	const f = await fixture();
	getDismissalStore().recordDismissal(noticeName);
	resetDismissalStoreForTests();
	await rename(f.dismissals, `${f.dismissals}.saved`);
	await mkdir(f.dismissals);
	expect(() => getDismissalStore()).toThrow();
	await rm(f.dismissals, { recursive: true });
	await rename(`${f.dismissals}.saved`, f.dismissals);
	// When the same process reads again without resetting the singleton.
	const recovered = getDismissalStore();
	// Then it reloads the acknowledgement instead of using an empty failed cache.
	expect(recovered.isDismissed(noticeName)).toBe(true);
});

test("unreadable dismissals defer both startup notices without retry or resurrection", async () => {
	// Given a recovered package notice and a dismissed rollback behind failed I/O.
	const f = await fixture();
	saveOrchestratorState({
		...initialOrchestratorState(0),
		recoveredNotice: { kind: "packages-recovered", id: "previous-boot" },
	});
	getDismissalStore().recordDismissal(noticeName);
	resetDismissalStoreForTests();
	await rename(f.dismissals, `${f.dismissals}.saved`);
	await mkdir(f.dismissals);
	// When startup attempts each independent notice producer against unreadable storage.
	await startUpdateOrchestrator(f.deps);
	// Then neither failed read is cached as empty, and notice I/O cannot fail startup.
	expect(f.waits).toEqual([]);
	expect(getOrchestratorState().phase).toBe("idle");
	expect(updateNotices()).toEqual([]);
});

test("recovered notice read failure cannot skip readable rollback hydration", async () => {
	// Given a real non-file store which is repaired before rollback history is read.
	const f = await fixture();
	saveOrchestratorState({
		...initialOrchestratorState(0),
		recoveredNotice: { kind: "packages-recovered", id: "previous-boot" },
	});
	await mkdir(f.dismissals);
	const read = f.deps.quarantine.read.bind(f.deps.quarantine);
	f.deps.quarantine.read = async () => {
		await rm(f.dismissals, { recursive: true, force: true });
		return read();
	};
	// When recovered-notice publication fails but the next producer can read storage.
	await startUpdateOrchestrator(f.deps);
	// Then no startup retry was needed to restore the undismissed rollback.
	expect(f.waits).toEqual([]);
	expect(updateNotices().map((notice) => notice.name)).toEqual([noticeName]);
});

test.each([false, true])(
	"invalid agent still hydrates independent rollback history (dismissed: %s)",
	async (dismissed) => {
		// Given invalid agent authority but valid, independently recorded OS history.
		const f = await fixture();
		if (dismissed) getDismissalStore().recordDismissal(noticeName);
		resetDismissalStoreForTests();
		await Bun.write(f.agent, "{");
		// When the typed recovery-load failure takes the terminal startup path.
		await startUpdateOrchestrator(f.deps);
		// Then history is displayed only if undismissed; invalid authority stays closed.
		expect(updateNotices().map((notice) => notice.name)).toEqual(
			dismissed ? [] : [noticeName],
		);
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: "os_stage_recovery_invalid",
		});
		expect(await Bun.file(f.agent).text()).toBe("{");
		await expect(checkUpdatesNow()).rejects.toMatchObject({
			code: "UPDATE_ORCHESTRATOR_INITIALIZING",
		});
	},
);
