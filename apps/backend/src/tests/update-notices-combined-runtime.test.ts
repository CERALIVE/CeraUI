import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import { startOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	isNotificationDismissed,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationDismiss,
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { credentialObserverFixture } from "./helpers/credential-observer-fixture.ts";
import { downloadNoticeFixture } from "./helpers/download-paused-fixture.ts";
import {
	fakeDeps,
	quarantineDirs,
} from "./helpers/orchestrator-runtime-harness.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const notice of getPersistentNotifications(true).show)
		notificationRemove(notice.name);
	for (const root of quarantineDirs.splice(0))
		rmSync(root, { recursive: true });
});

for (const phase of ["downloading", "os-staging"] as const) {
	for (const reader of ["held", "throws", "rejects"] as const) {
		for (const worker of ["held", "throws"] as const) {
			test(`${phase}: ${reader} credentials and ${worker} hold worker preserve tick/admission`, async () => {
				// Given both real observers with independently broken advisory readers.
				const credentialEntered = Promise.withResolvers<void>();
				const holdEntered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const credentials = await credentialObserverFixture({
					read: () => {
						credentialEntered.resolve();
						switch (reader) {
							case "held":
								return release.promise.then(
									() => ({ kind: "unavailable", reason: "missing" }) as const,
								);
							case "throws":
								throw new Error("combined-reader-fixture");
							case "rejects":
								return Promise.reject(new Error("combined-reader-fixture"));
							default: {
								const exhaustive: never = reader;
								return exhaustive;
							}
						}
					},
				});
				const holds = downloadNoticeFixture({
					ledger: {
						read: () => {
							holdEntered.resolve();
							switch (worker) {
								case "held":
									return release.promise.then(() => []);
								case "throws":
									throw new Error("combined-worker-fixture");
								default: {
									const exhaustive: never = worker;
									return exhaustive;
								}
							}
						},
						write: () => undefined,
						acknowledge: () => undefined,
					},
				});
				const trace: string[] = [];
				let observation = Promise.resolve();
				const initial = {
					...initialOrchestratorState(0),
					phase,
					...(phase === "os-staging"
						? {
								osStageRecovery: startOsStageAttempt(
									undefined,
									"candidate",
									"11111111-1111-4111-8111-111111111111",
								),
							}
						: {}),
				};
				setOrchestratorRuntimeDepsForTest(
					fakeDeps({
						now: () => 1234,
						isUpdateAdmissionReady: async () => false,
						observeCredentials: () => {
							observation = credentials.observer.refresh(true);
							return observation;
						},
						downloadNotices: holds.worker,
						getPackageInstallWireState: () => ({
							kind: "downloading",
							progress: {
								downloading: 1,
								unpacking: 0,
								setting_up: 0,
								total: 5,
							},
						}),
						isCommitStageRunning: async () => {
							trace.push("probe");
							return false;
						},
						stopPackageInstallUnit: async () => {
							trace.push("stop");
						},
						killAndRestartRaucForStream: async () => {
							trace.push("kill");
						},
						persist: (state) => {
							trace.push(`persist:${state.phase}`);
						},
						publishWireState: (wire) => {
							trace.push(`wire:${wire.phase}`);
						},
					}),
				);
				setOrchestratorStateForTest(initial);
				try {
					// When tick runs while the two advisory ports are held/failing, then D8 runs.
					await runOrchestratorTick();
					await Promise.all([credentialEntered.promise, holdEntered.promise]);
					expect(getOrchestratorState()).toEqual(initial);
					const result = await admitAndPrepareStreamStart();
					// Then the base reducer transition and complete effect order are unchanged.
					expect(result).toEqual({ allowed: true });
					expect(getOrchestratorState()).toEqual(
						reduceOrchestrator(initial, {
							type:
								phase === "downloading"
									? "DOWNLOAD_ABORTED_FOR_STREAM"
									: "OS_STAGING_ABORTED_FOR_STREAM",
							now: 1234,
						}),
					);
					expect(trace).toEqual(
						phase === "downloading"
							? ["probe", "stop", "persist:available", "wire:available"]
							: ["persist:os-available", "wire:os-available", "kill"],
					);
				} finally {
					release.resolve();
					await observation;
					await holds.worker.settled();
					credentials.observer.stop();
					await credentials.cleanup();
				}
			});
		}
	}
}

test("both notice families keep separate names and durable acknowledgements for the same opaque id", async () => {
	// Given actual credential publication and a hold notice sharing its opaque suffix.
	const credentials = await credentialObserverFixture();
	const oldPath = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(
		credentials.root,
		"dismissals.json",
	);
	resetDismissalStoreForTests();
	const holds = downloadNoticeFixture({
		publish: (fact, onDismiss) => {
			notifyUpdate({ kind: "download-paused", id: fact.id }, { onDismiss });
		},
	});
	try {
		await credentials.observer.refresh(true);
		const notice = credentials.published[0];
		if (!notice) throw new Error("credential fixture did not publish");
		holds.worker.interrupted({ id: notice.id, candidate: "a".repeat(64) });
		await holds.worker.settled();
		const credentialName = `update:${notice.kind}:${notice.id}`;
		const holdName = `update:download-paused:${notice.id}`;
		expect(notificationExists(credentialName)?.dismissalKey).toBe(
			credentialName,
		);
		expect(notificationExists(holdName)?.dismissalKey).toBe(holdName);
		// When dismissing credentials, then the independent hold remains unacknowledged.
		notificationDismiss(credentialName);
		expect(notificationExists(holdName)).toBeDefined();
		expect(holds.entries()[0]?.status).toBe("active");
		expect(isNotificationDismissed(holdName)).toBe(false);
		notificationDismiss(holdName);
		expect(holds.entries()[0]?.status).toBe("acknowledged");
		expect(isNotificationDismissed(holdName)).toBe(true);
		await credentials.observer.refresh(true);
		expect(notificationExists(credentialName)).toBeUndefined();
	} finally {
		holds.worker.dispose();
		credentials.observer.stop();
		await credentials.cleanup();
		if (oldPath === undefined) delete process.env.CERALIVE_DISMISSALS_FILE;
		else process.env.CERALIVE_DISMISSALS_FILE = oldPath;
		resetDismissalStoreForTests();
	}
});

test("both notice families resolve keys in all ten catalogs", async () => {
	// Given shipped catalogs; when resolving producer keys; then none is missing.
	const catalogs = [
		...new Glob("*.json").scanSync("../../packages/i18n/messages"),
	];
	const keys = [
		"notifications.updateCredentialsExpiring",
		"notifications.updateCredentialsExpired",
		"notifications.updatePausedForStream",
	];
	expect(catalogs).toHaveLength(10);
	for (const catalog of catalogs) {
		const messages: unknown = await Bun.file(
			`../../packages/i18n/messages/${catalog}`,
		).json();
		for (const key of keys)
			expect(messages).toHaveProperty([key], expect.any(String));
	}
});
