import type { UpdateCapabilities, UpdateSettings } from "@ceraui/rpc/schemas";
import { osChannelManifestSchema } from "../../modules/system/update-orchestrator/os-manifest.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../../modules/ui/notifications.ts";
import { withMemoryPersistence } from "./orchestrator-memory-persistence.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export const T0 = 10_000_000;
export const RETRY_DELAY = 15 * 60_000;
export const capabilities: UpdateCapabilities = {
	mode: "capable",
	features: ["apt-all-packages", "rauc-verity-streaming"],
};
export const settings: UpdateSettings = {
	packagesAuto: true,
	systemAuto: true,
	schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
	channel: "stable",
	allowPackagesOverCellular: true,
	allowSystemOverCellular: true,
};
export const manifest = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/test/bundle.raucb",
		size: 100,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/test/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url: "https://images.ceralive.tv/releases/test/packages.lock.json",
});

export function deferred<T>() {
	return Promise.withResolvers<T>();
}

export function cleanupRecovery(): void {
	resetOrchestratorRuntimeForTest();
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
}

export async function recoveryHarness(
	overrides: Partial<OrchestratorRuntimeDeps> = {},
) {
	// Mutable observations belong to this fixture, never to a wall-clock timer.
	const clock = { now: T0 };
	const calls = { stages: 0, checks: 0 };
	setOrchestratorRuntimeDepsForTest(
		withMemoryPersistence({
			acquireOsStageControl: acquireTestOsStageControl,
			now: () => clock.now,
			random: () => 0.5,
			loadSettings: async () => settings,
			loadCapabilities: async () => capabilities,
			isIdle: async () => true,
			isStreamLive: () => false,
			onlyMeteredCandidateExists: async () => false,
			runPackageCheck: async () => null,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			killAndRestartRaucForStream: async () => undefined,
			persist: () => undefined,
			...overrides,
			checkOsManifest: async (channel) => {
				calls.checks++;
				return overrides.checkOsManifest
					? overrides.checkOsManifest(channel)
					: {
							available: true,
							rateLimited: false,
							failed: false,
							reason: "",
							manifest,
						};
			},
			newOsAttemptId: () =>
				`00000000-0000-4000-8000-${String(calls.stages + 1).padStart(12, "0")}`,
			stageOs: async (candidate, progress, control) => {
				calls.stages++;
				await overrides.stageOs?.(candidate, progress, control);
			},
		}),
	);
	setOrchestratorStateForTest(initialOrchestratorState(T0));
	await checkUpdatesNow();
	setOrchestratorStateForTest({
		...getOrchestratorState(),
		packageCheck: {
			...getOrchestratorState().packageCheck,
			nextAttemptAt: T0 + 24 * 60 * 60_000,
		},
	});
	return { clock, calls };
}
