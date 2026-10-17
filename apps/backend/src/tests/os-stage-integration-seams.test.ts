import { afterEach, expect, test } from "bun:test";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
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
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { withMemoryPersistence } from "./helpers/orchestrator-memory-persistence.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const candidate = osChannelManifestSchema.parse({
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
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 100,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
});

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
});

function setup(stage: Parameters<typeof setOrchestratorRuntimeDepsForTest>[0]) {
	setOrchestratorRuntimeDepsForTest(
		withMemoryPersistence({
			acquireOsStageControl: acquireTestOsStageControl,
			now: () => 2_000,
			persist: () => {},
			isStreamLive: () => false,
			isIdle: async () => true,
			isUpdateAdmissionReady: async () => true,
			isOsStageReady: async () => true,
			loadSettings: async () => ({
				packagesAuto: false,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: true,
				allowSystemOverCellular: true,
			}),
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			onlyMeteredCandidateExists: async () => false,
			checkOsManifest: async () => ({
				available: true,
				failed: false,
				rateLimited: false,
				reason: "",
				manifest: candidate,
			}),
			...stage,
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-available",
	});
}

test.each([
	["os_transport_failed", "os-available", "automatic", 1],
	["os_origin_unavailable", "os-available", "automatic", 1],
	["os_update_lock_held", "os-available", "automatic", 1],
	["os_cellular_approval_required", "os-available", "operator", 1],
	["os_stage_cancelled_for_stream", "os-available", "automatic", 0],
	["rauc_install_failed", "os-available", "operator", 1],
	["rauc_recovery_unproven", "failed", "unsafe", 1],
	["os_stage_outcome_unknown_after_restart", "failed", "unsafe", 1],
] as const)(
	"integrated stage settlement maps %s",
	async (reason, phase, mode, rounds) => {
		// Given the producer's closed typed failure vocabulary.
		setup({
			stageOs: async () => {
				throw new OsStageError(reason);
			},
		});
		// When the real runtime settles the attempt it persisted.
		await installUpdatesNow();
		// Then every reason reaches the policy without a string/prefix guess.
		expect(getOrchestratorState()).toMatchObject({
			phase,
			failureReason: rounds === 0 ? null : reason,
			osStageRecovery: { activeAttemptId: null, mode, failedRounds: rounds },
		});
	},
);

test("an untyped producer error still reaches terminal failed", async () => {
	// Given an error carrying no safe-cleanup classification.
	setup({
		stageOs: async () => {
			throw new Error("rauc failed");
		},
	});
	// When the merged runtime catches it.
	await installUpdatesNow();
	// Then no automatic/operator policy is invented.
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		failureReason: "rauc failed",
	});
});

test("restart settlement cannot use idle Operation as writer quiescence", async () => {
	// Given a persisted interrupted attempt and independent negative resource proof.
	let proofs = 0;
	setup({
		inspectOsOperation: async () => "idle",
		proveOsWriterQuiescent: async () => {
			proofs++;
			return false;
		},
	});
	const interrupted = {
		...initialOrchestratorState(0),
		phase: "os-staging",
		osStageRecovery: {
			candidateKey: osStageCandidateKey(candidate),
			activeAttemptId: "interrupted",
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic",
			reason: null,
		},
	} as const;
	setOrchestratorStateForTest(interrupted);
	// When restart settlement probes the writer.
	await runOrchestratorTick();
	// Then the phase/attempt remain unsettled, never success or guessed failure.
	expect(proofs).toBe(1);
	expect(getOrchestratorState()).toEqual(interrupted);
});

test("C's persisted attempt and B's synchronous commit eligibility share one identity", async () => {
	// Given a producer invoking its under-lock callback before its promise resolves.
	const phases: string[] = [];
	setup({
		stageOs: async (_manifest, _progress, control) => {
			if (!control?.commit || !control.canCommit)
				throw new Error("missing commit control");
			expect(getOrchestratorState().osStageRecovery?.activeAttemptId).toBe(
				control.attemptId,
			);
			expect(control.canCommit()).toBe(true);
			control.commit({
				schema: 1,
				version: candidate.version,
				channel: "stable",
				stagedAt: 2_000,
				bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			});
			phases.push(getOrchestratorState().phase);
			expect(control.canCommit()).toBe(false);
		},
	});
	// When staging completes through the real runtime.
	await installUpdatesNow();
	// Then metadata cleared once at the callback, with no later transition.
	expect(phases).toEqual(["os-staged"]);
	expect(getOrchestratorState().osStageRecovery).toBeUndefined();
});
