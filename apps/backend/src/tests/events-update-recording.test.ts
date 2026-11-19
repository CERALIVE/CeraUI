import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventCode } from "@ceraui/rpc/events";
import type { UpdateOrchestratorWireState } from "@ceraui/rpc/schemas";
import * as eventEmitter from "../modules/events/emit.ts";
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
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
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
import { candidate, setup } from "./helpers/os-agent-runtime-harness.ts";

useSessionOwnerForFile();

const calls: { readonly code: EventCode; readonly params: unknown }[] = [];
let root: string;
let previousDismissals: string | undefined;
let restoreEmitter: () => void;
let emitterFault: Error | undefined;

function clearNotices(): void {
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ceraui-update-recording-"));
	previousDismissals = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(root, "dismissals.json");
	resetDismissalStoreForTests();
	clearNotices();
	calls.length = 0;
	emitterFault = undefined;
	// Record at the producer boundary so downstream deduplication cannot hide a second call.
	const emitter = spyOn(eventEmitter, "emitEvent").mockImplementation(
		(code, params) => {
			calls.push({ code, params: structuredClone(params) });
			if (emitterFault) throw emitterFault;
		},
	);
	restoreEmitter = () => emitter.mockRestore();
});

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	restoreEmitter();
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
	"%s calls the recording emitter exactly once with the notice params",
	(code, notice) => {
		const { kind: _kind, ...params } = notice;
		expect(notifyUpdate(notice)).toBe(true);
		expect(calls).toEqual([{ code, params }]);
	},
);

test("an already showing notice still reaches the emitter exactly once", () => {
	notificationSend(undefined, "update:installed:shown", "success", "", 0, true);
	expect(
		notifyUpdate({ kind: "installed", id: "shown", packages: ["ceraui"] }),
	).toBe(false);
	expect(calls).toEqual([
		{ code: "update_installed", params: { id: "shown", packages: ["ceraui"] } },
	]);
});

test("an installed notice ignores unrelated reasons without a second emitter call", () => {
	const notice = {
		kind: "installed",
		id: "with-metadata",
		packages: ["ceraui"],
		reasons: ["unrelated"],
	} as const;
	expect(notifyUpdate(notice)).toBe(true);
	expect(calls).toEqual([
		{
			code: "update_installed",
			params: { id: "with-metadata", packages: ["ceraui"] },
		},
	]);
});

test("a dismissed refusal still reaches the emitter exactly once", () => {
	recordNotificationDismissal("update:refused:dismissed");
	expect(
		notifyUpdate({ kind: "refused", id: "dismissed", reason: "metered_only" }),
	).toBe(false);
	expect(calls).toEqual([
		{
			code: "update_refused",
			params: { id: "dismissed", reason: "metered_only" },
		},
	]);
});

test.each(["downloading", "committing"] as const)(
	"%s records the failure before its optional refusal notice",
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
		expect(calls).toEqual([
			{
				code: "update_failed",
				params: {
					stage: phase === "downloading" ? "download" : "commit",
					reason: "apt_failed",
				},
			},
			...(phase === "committing"
				? [
						{
							code: "update_refused" as const,
							params: { id: "commit:1000000", reason: "apt_failed" },
						},
					]
				: []),
		]);
	},
);

test("a sync failure makes one exact failure call", async () => {
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
	expect(calls).toEqual([
		{
			code: "update_failed",
			params: { stage: "sync", reason: "slot-sync failed (exit 2)" },
		},
	]);
});

test("an OS staging failure precedes its refusal with no duplicate failure call", async () => {
	setup({ stageOs: () => Promise.reject(new Error("rauc failed")) });
	await installUpdatesNow();
	expect(calls).toEqual([
		{
			code: "update_updates_available",
			params: { id: `os:${candidate.version}` },
		},
		{
			code: "update_failed",
			params: { stage: "os-staging", reason: "rauc failed" },
		},
		{
			code: "update_refused",
			params: { id: `os:${candidate.version}`, reason: "rauc failed" },
		},
	]);
});

test("a non-terminal phase change never calls the emitter", async () => {
	setOrchestratorRuntimeDepsForTest(fakeDeps());
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "settled",
	});
	await runOrchestratorTick();
	expect(calls).toEqual([]);
});

test("a rejected failure dispatch records only the existing refusal notice", async () => {
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
	expect(calls).toEqual([
		{
			code: "update_refused",
			params: { id: "commit:0", reason: "stale_commit" },
		},
	]);
});

test("the failure reaches the emitter before persistence can reject", async () => {
	const failure = new Error("fixture persistence failure");
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			persist: () => {
				throw failure;
			},
			getPackageInstallWireState: () => ({
				kind: "failed",
				reason: "apt_failed",
			}),
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "downloading",
	});
	const result = await runOrchestratorTick().then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(result).toBe(failure);
	expect(calls).toEqual([
		{
			code: "update_failed",
			params: { stage: "download", reason: "apt_failed" },
		},
	]);
});

test.each(notices)(
	"a throwing emitter preserves the %s notification",
	(_code, notice) => {
		expect(notifyUpdate(notice)).toBe(true);
		const name = `update:${notice.kind}:${notice.id}`;
		// Revisions identify deliveries. Compare every other field of the named notice.
		const snapshot = () =>
			getPersistentNotifications(true)
				.show.filter((message) => message.name === name)
				.map(({ revision: _revision, ...message }) => message);
		const expected = snapshot();
		expect(expected).toHaveLength(1);
		clearNotices();
		calls.length = 0;
		emitterFault = new Error("recording-emitter-fault");
		expect(() => notifyUpdate(notice)).not.toThrow();
		expect(snapshot()).toEqual(expected);
	},
);

const faultStages = [
	{
		stage: "download",
		phase: "downloading",
		terminal: "failed",
		reason: "apt_failed",
	},
	{
		stage: "commit",
		phase: "committing",
		terminal: "quarantined",
		reason: "apt_failed",
	},
	{
		stage: "sync",
		phase: "syncing",
		terminal: "failed",
		reason: "slot-sync failed (exit 2)",
	},
	{
		stage: "os-staging",
		phase: "os-available",
		terminal: "failed",
		reason: "rauc failed",
	},
] as const;

test.each(faultStages)(
	"a throwing emitter preserves $stage persistence and publication",
	async ({ stage, phase, terminal, reason }) => {
		const persisted: OrchestratorState[] = [];
		const published: UpdateOrchestratorWireState[] = [];
		const effects: {
			readonly kind: "persist" | "publish";
			readonly phase: string;
		}[] = [];
		const outputs = {
			persist: (state: OrchestratorState) => {
				persisted.push(structuredClone(state));
				effects.push({ kind: "persist", phase: state.phase });
			},
			publishWireState: (state: UpdateOrchestratorWireState) => {
				published.push(structuredClone(state));
				effects.push({ kind: "publish", phase: state.phase });
			},
		};
		if (stage === "os-staging") {
			setup({ ...outputs, stageOs: () => Promise.reject(new Error(reason)) });
		} else {
			setOrchestratorRuntimeDepsForTest(
				fakeDeps({
					...outputs,
					quarantine: testQuarantine(),
					getPackageInstallWireState: () => ({ kind: "failed", reason }),
					inspectSlotSync: async () => ({ kind: "failed", exitCode: 2 }),
				}),
			);
		}
		setOrchestratorStateForTest({ ...initialOrchestratorState(0), phase });
		emitterFault = new Error("recording-emitter-fault");
		const failure = await (stage === "os-staging"
			? installUpdatesNow()
			: runOrchestratorTick()
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeUndefined();
		expect(getOrchestratorState()).toMatchObject({
			phase: terminal,
			progress: null,
			failureReason: reason,
		});
		expect(persisted.filter((state) => state.phase === terminal)).toEqual([
			getOrchestratorState(),
		]);
		expect(published.filter((state) => state.phase === terminal)).toEqual([
			{
				schema: 1,
				phase: terminal,
				progress: null,
				failure_reason: reason,
				cellular_override_id: null,
			},
		]);
		expect(
			effects
				.filter((effect) => effect.phase === terminal)
				.map((effect) => effect.kind),
		).toEqual(["persist", "publish"]);
	},
);
