import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	admitAndPrepareStreamStart,
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { resetDismissalStoreForTests } from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";

const originalDismissalsPath = process.env.CERALIVE_DISMISSALS_FILE;
let root: string | undefined;

function clearNotices() {
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
}

beforeEach(async () => {
	resetOrchestratorRuntimeForTest();
	resetDismissalStoreForTests();
	clearNotices();
	root = await mkdtemp(join(tmpdir(), "update-notice-storage-"));
	const path = join(root, "notification_dismissals.json");
	process.env.CERALIVE_DISMISSALS_FILE = path;
	await mkdir(path);
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine: new UpdateQuarantine(join(root, "quarantine.json")),
			isUpdateAdmissionReady: async () => true,
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			restartStale: async () => true,
			checkOsManifest: async () => ({
				available: false,
				rateLimited: false,
				failed: true,
				reason: "serial_replayed",
			}),
		}),
	);
});

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	resetDismissalStoreForTests();
	clearNotices();
	if (originalDismissalsPath === undefined)
		delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = originalDismissalsPath;
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

test("completed service restarts settle and admit Go Live when dismissals are unreadable", async () => {
	// Given completed restart work and a dismissal path that raises EISDIR.
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "restarting-services",
		enteredAt: 5,
	});
	// When the completion tick tries to publish its installed notice.
	await runOrchestratorTick();
	// Then SERVICES_RESTARTED settles the phase instead of wedging Go Live.
	expect(getOrchestratorState().phase).toBe("settled");
	expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
	expect(
		getPersistentNotifications(true).show.filter((notice) =>
			notice.name.startsWith("update:"),
		),
	).toEqual([]);
});

test("refused OS Check leaves checking when dismissals are unreadable", async () => {
	// Given an OS check refusal and the same unreadable preference file.
	setOrchestratorStateForTest(initialOrchestratorState(0));
	// When the operator checks and the refusal tries to publish its notice.
	await checkUpdatesNow();
	// Then CHECK_FAILED records refusal/backoff without publishing or throwing.
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		failureReason: "serial_replayed",
		osCheck: { consecutiveFailures: 1, nextAttemptAt: 1_060_000 },
	});
	expect(
		getPersistentNotifications(true).show.filter((notice) =>
			notice.name.startsWith("update:"),
		),
	).toEqual([]);
});
