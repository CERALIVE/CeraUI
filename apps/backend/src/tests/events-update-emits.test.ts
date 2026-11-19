import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventCode } from "@ceraui/rpc/events";
import {
	resetEventEmitterForTest,
	setEventSink,
} from "../modules/events/emit.ts";
import { appendEvent, readEvents, tailSeq } from "../modules/events/store.ts";
import {
	notifyUpdate,
	type UpdateNotice,
} from "../modules/system/update-orchestrator/notifications.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	recordNotificationDismissal,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationRemove,
	notificationSend,
} from "../modules/ui/notifications.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import { setup } from "./helpers/os-agent-runtime-harness.ts";

useSessionOwnerForFile();

let root: string;
let previousDismissals: string | undefined;
const pushed: string[] = [];
const journal: string[] = [];
const warnings: string[] = [];

function clearNotices(): void {
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
}

function resetEmitter(): void {
	resetEventEmitterForTest({
		bootId: () => "66d8d1808694489b8c3a3fb4795cab24",
		tailSeq: () => tailSeq({ baseDir: root }),
		appendEvent: (event, options) =>
			appendEvent(event, { ...options, baseDir: root }),
		log: (_level, _message, meta) => journal.push(String(meta.code)),
		warn: (message) => warnings.push(message),
	});
	setEventSink((event) => pushed.push(event.code));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ceraui-update-events-"));
	previousDismissals = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(root, "dismissals.json");
	resetDismissalStoreForTests();
	clearNotices();
	pushed.length = 0;
	journal.length = 0;
	warnings.length = 0;
	resetEmitter();
});

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	resetEventEmitterForTest();
	clearNotices();
	resetDismissalStoreForTests();
	if (previousDismissals === undefined)
		delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = previousDismissals;
	rmSync(root, { recursive: true, force: true });
});

function testQuarantine(): UpdateQuarantine {
	return new UpdateQuarantine(join(root, "quarantine.json"), async (text) => {
		await Bun.write(join(root, "pins"), text);
	});
}

function events() {
	expect(warnings).toEqual([]);
	const stored = readEvents({ baseDir: root });
	expect(journal).toEqual(stored.map((event) => event.code));
	expect(pushed).toEqual(journal);
	return stored.map(({ code, params }) => ({ code, params }));
}

const notices: readonly (readonly [EventCode, UpdateNotice])[] = [
	["update_packages_recovered", { kind: "packages-recovered", id: "p" }],
	["update_slot_sync_recovered", { kind: "slot-sync-recovered", id: "s" }],
	["update_updates_available", { kind: "updates-available", id: "a" }],
	[
		"update_installed",
		{ kind: "installed", id: "i", packages: ["ceraui", "cerastream"] },
	],
	[
		"update_refused",
		{ kind: "refused", id: "r", reason: "booted_version_unknown" },
	],
	["update_download_paused", { kind: "download-paused", id: "d" }],
	["update_os_staged", { kind: "os-staged", id: "os", version: "2026.10.0" }],
	[
		"update_os_activation_requested",
		{ kind: "os-activation-requested", id: "oa", version: "2026.10.1" },
	],
	[
		"update_os_activated",
		{ kind: "os-activated", id: "ok", version: "2026.10.2" },
	],
	[
		"update_os_rollback",
		{ kind: "os-rollback", id: "or", version: "2026.10.3" },
	],
	["update_slots_current", { kind: "slots-current", id: "sc" }],
	[
		"update_restart_recommended",
		{ kind: "restart-recommended", id: "rr", unit: "example.service" },
	],
	[
		"update_cellular_approval",
		{ kind: "cellular-approval", id: "ca", size: "100 MB" },
	],
	[
		"update_credentials_expiring",
		{ kind: "credentials-expiring", id: "ce", days: 30 },
	],
	["update_credentials_expired", { kind: "credentials-expired", id: "cx" }],
	[
		"update_transport_unhealthy",
		{ kind: "transport-unhealthy", id: "tu", reasons: ["ipv4", "ipv6"] },
	],
	["update_kernel_staged", { kind: "kernel-staged", id: "ks", version: "6.1" }],
	[
		"update_kernel_succeeded",
		{ kind: "kernel-succeeded", id: "kg", version: "6.2" },
	],
	[
		"update_kernel_rolled_back",
		{ kind: "kernel-rolled-back", id: "kr", version: "6.3" },
	],
	[
		"update_os_stage_retry",
		{ kind: "os-stage-retry", id: "sr", version: "2026.10.4" },
	],
	[
		"update_os_stage_operator",
		{ kind: "os-stage-operator", id: "so", version: "2026.10.5" },
	],
	[
		"update_os_stage_unresolved",
		{ kind: "os-stage-unresolved", id: "su", version: "2026.10.6" },
	],
];

test.each(notices)(
	"%s retains the notice's own params in history",
	(code, notice) => {
		const { kind: _kind, ...params } = notice;
		expect(notifyUpdate(notice)).toBe(true);
		expect<unknown>(events()).toEqual([{ code, params }]);
	},
);

test("an already showing installed notice is recorded once per boot", () => {
	const notice = {
		kind: "installed",
		id: "shown",
		packages: ["ceraui"],
	} as const;
	notificationSend(undefined, "update:installed:shown", "success", "", 0, true);
	expect(notifyUpdate(notice)).toBe(false);
	expect(notifyUpdate(notice)).toBe(false);
	expect(events()).toEqual([
		{ code: "update_installed", params: { id: "shown", packages: ["ceraui"] } },
	]);
});

test("a dismissed refusal is recorded without claiming an installation", () => {
	recordNotificationDismissal("update:refused:dismissed");
	expect(
		notifyUpdate({ kind: "refused", id: "dismissed", reason: "metered_only" }),
	).toBe(false);
	expect(events()).toEqual([
		{
			code: "update_refused",
			params: { id: "dismissed", reason: "metered_only" },
		},
	]);
});

test.each(["downloading", "committing"] as const)(
	"%s terminal failure records the accepted stage and exact reason",
	async (phase) => {
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				getPackageInstallWireState: () => ({
					kind: "failed",
					reason: "apt_failed",
				}),
			}),
		);
		setOrchestratorStateForTest({ ...initialOrchestratorState(0), phase });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe(
			phase === "downloading" ? "failed" : "quarantined",
		);
		expect(events().filter(({ code }) => code === "update_failed")).toEqual([
			{
				code: "update_failed",
				params: {
					stage: phase === "downloading" ? "download" : "commit",
					reason: "apt_failed",
				},
			},
		]);
	},
);

test("a slot-sync hard failure records its existing reason", async () => {
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			inspectSlotSync: async () => ({ kind: "failed", exitCode: 2 }),
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("failed");
	expect(events()).toEqual([
		{
			code: "update_failed",
			params: { stage: "sync", reason: "slot-sync failed (exit 2)" },
		},
	]);
});

test("a terminal OS staging failure records its existing reason", async () => {
	setup({
		stageOs: async () => {
			throw new Error("rauc failed");
		},
	});
	await installUpdatesNow();
	expect(getOrchestratorState().phase).toBe("failed");
	expect(events().filter(({ code }) => code === "update_failed")).toEqual([
		{
			code: "update_failed",
			params: { stage: "os-staging", reason: "rauc failed" },
		},
	]);
});

test("a non-terminal phase change emits no failure", async () => {
	setOrchestratorRuntimeDepsForTest(fakeDeps());
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "settled",
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("idle");
	expect(events()).toEqual([]);
});

test("a failure rejected after concurrent state replacement emits nothing", async () => {
	const quarantine = testQuarantine();
	const record = quarantine.recordPackageFailure.bind(quarantine);
	quarantine.recordPackageFailure = async (...args) => {
		await record(...args);
		setOrchestratorStateForTest(initialOrchestratorState(0));
	};
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			getPackageInstallWireState: () => ({
				kind: "failed",
				reason: "stale_commit",
			}),
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "committing",
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("idle");
	expect(events().filter(({ code }) => code === "update_failed")).toEqual([]);
});
