/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Update effects and scheduler. Admission detail lives in docs/DEVICE-UPDATES.md.
 */

// allow: SIZE_OK — Existing process-global scheduler composition root; this repair preserves its shared admission/state owners and changes only receipt wiring.
import { randomUUID } from "node:crypto";
import type {
	UpdateCapabilities,
	UpdateOrchestratorWireState,
	UpdateSettings,
	UpdateState,
} from "@ceraui/rpc/schemas";
import { OS_STAGE_CONFIRMABLE_UNSAFE_REASONS } from "@ceraui/rpc/schemas";
import { awaitUpdatePhysicalReconciliation } from "../../../helpers/boot-guard.ts";
import { logger } from "../../../helpers/logger.ts";
import { shouldUseMocks } from "../../../mocks/mock-service.ts";
import { currentLifecycleHolder } from "../../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import { cleanAptCache } from "../apt-cache-clean.ts";
import { isRealDevice } from "../device-detection.ts";
import { getIdleStatus } from "../idle-activity.ts";
import {
	getLastInstallUnitVerdict,
	getUpdateState,
	type InstallUnitVerdict,
	recoverSoftwareUpdateIfRunning,
	runUpdateDiscoveryAndReport,
	type SoftwareUpdateError,
	startSoftwareUpdate,
	type UpdateStartOutcome,
} from "../software-updates.ts";
import { readUpdateCapabilities } from "../update-capabilities.ts";
import { loadUpdateSettings } from "../update-settings.ts";
import { discoverCandidates } from "../update-transport/core.ts";
import { defaultUpdateTransportDeps } from "../update-transport/executor.ts";
import { admitStreamStart, onStreamStart } from "./admission.ts";
import { isCommitStageRunning } from "./commit-stage-probe.ts";
import {
	inspectSlotSync,
	resetSlotSyncFailure,
	type SlotSyncProbeState,
	startSlotSync,
} from "./lock.ts";
import { clearOsStageNotices, notifyUpdate } from "./notifications.ts";
import { readActivationArmed } from "./os-activation-marker.ts";
import {
	armOsActivation,
	checkOsChannel,
	inspectOsOperation,
	OsAgentError,
	type OsStageBundleControl,
	type OsStageReceipt,
	readBootId,
	readStagedReceipt,
	rebindStagedReceipt,
	stageOsBundle,
} from "./os-agent.ts";
import {
	awaitPublishingIntentForStream,
	publishingIntentPending,
} from "./os-attempt-intent-admission.ts";
import {
	finishOsAttemptIntent,
	recoverOsAttemptLifecycle,
} from "./os-attempt-intent-cleanup.ts";
import type { OsAttemptIntentStore } from "./os-attempt-intent-store.ts";
import {
	OsAttemptPublicationError,
	publishOsAttempt,
} from "./os-attempt-publication.ts";
import {
	beginOsRecoverySettlement,
	saveAuthoritativeStartupState,
} from "./os-authoritative-settlement.ts";
import { readInstalledImage } from "./os-installed-image.ts";
import type { OsChannelManifest } from "./os-manifest.ts";
import { readBootedOsReleaseVersion } from "./os-manifest.ts";
import {
	acknowledgeRetiredReceipt,
	ReceiptRetirementDurabilityError,
	retiredReceiptPresent,
} from "./os-receipt-retirement-store.ts";
import { sameOsRecoveryIdentity } from "./os-recovery-identity.ts";
import {
	hydrateOsStageRecoveryNotice,
	replaceOsStageRecoveryNotice,
} from "./os-recovery-notice.ts";
import {
	acquireRuntimeOsStageControl as acquireRuntimeControl,
	proveRuntimeOsWriterQuiescent,
} from "./os-runtime-control.ts";
import { readRuntimeOsSettlementEvidence } from "./os-runtime-evidence.ts";
import { OsSettlementPersistence } from "./os-settlement-persistence.ts";
import type {
	acquireOsStageControlLease,
	OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { isOsStageError, OsStageError } from "./os-stage-error.ts";
import { readOsStageJob } from "./os-stage-job-files.ts";
import {
	OS_STAGE_FIRST_RETRY_DELAY_MS,
	type OsStageSettlementEvidence,
	osStageCandidateKey,
	osStageFailureSettledSafely,
	osStageNoticeId,
	osStagePermission,
} from "./os-stage-retry.ts";
import {
	ensureOsUpdateAdmissionReady,
	isOsStageReady,
	type OsStartupDeps,
	setOsStageLiveProducerProbe,
} from "./os-stage-startup.ts";
import {
	consumeOsUnlaunchedWitness,
	readOsUnlaunchedWitness,
} from "./os-stage-unlaunched-witness.ts";
import {
	retireConsumedStagedReceipt,
	retireStagedReceipt,
} from "./os-staged-receipt-retirement.ts";
import { settleOsUnlaunchedWitness } from "./os-unlaunched-adapter.ts";
import { progressFromWire } from "./package-progress.ts";
import { pendingPackageSuccess } from "./pending-success-fence.ts";
import { fencePackageSuccessEffects } from "./pending-success-runtime.ts";
import {
	loadOrchestratorState,
	OrchestratorRecoveryLoadError,
	saveOrchestratorState,
} from "./persistence.ts";
import { UpdateQuarantine } from "./quarantine.ts";
import {
	persistRecoveredCommitSuccess,
	reserveRecoveredUpdateExit,
	resetRecoveredUpdateExitForTest,
} from "./recovery-exit-gate.ts";
import { reduceOrchestrator } from "./reducer.ts";
import {
	adjudicateInterruptedDownload,
	type DownloadResumeDecision,
	type OrchestratorResumeDeps,
	resumeOrchestratorState,
} from "./resume.ts";
import {
	canStartManualCheck,
	canStartManualInstall,
	computeNextCheckDelayMs,
	decideCellularGate,
	scheduledCheckDue,
	shouldAttemptScheduledCheck,
} from "./schedule.ts";
import {
	type RootSlotStatus,
	readBothSlotStatus,
	readRootSlots,
	readStagedActivation,
	type StagedActivation,
} from "./slot-status.ts";
import {
	dropSupersededQuarantine,
	removeRaucDownloads,
} from "./slot-sync-cleanup.ts";
import {
	judgeMirrorTarget,
	type SlotSyncEvidence,
	type SlotSyncGate,
	slotSyncGate,
} from "./slot-sync-gate.ts";
import { readHealthyState, readSlotSyncEvidence } from "./slot-sync-state.ts";
import {
	defaultStaleServiceDeps,
	reconcileStaleUnits,
} from "./stale-services.ts";
import { UpdateStartupCadence } from "./startup-cadence.ts";
import { normalizeStartupDiscovery } from "./startup-discovery.ts";
import { OrchestratorStartupFlight } from "./startup-flight.ts";
import { UpdateStartupReadiness } from "./startup-readiness.ts";
import type { StartupRetryClock } from "./startup-retry.ts";
import {
	killAndRestartRaucForStream,
	stopPackageInstallUnitForStream,
} from "./stream-abort.ts";
import {
	initialOrchestratorState,
	type OrchestratorEvent,
	type OrchestratorPhase,
	type OrchestratorState,
} from "./types.ts";
import { armUpdateAdmissionDeadline } from "./update-admission-deadline.ts";

/** Identity and cancellation of one staging attempt, owned by the runtime. */
export type OsStageControl = OsStageBundleControl & {
	readonly controlLease?: OsStageControlLease;
};

export interface OrchestratorRuntimeDeps {
	readonly now: () => number;
	readonly startupRetryClock?: StartupRetryClock;
	readonly random: () => number;
	readonly loadSettings: () => Promise<UpdateSettings>;
	readonly loadCapabilities: () => Promise<UpdateCapabilities>;
	readonly isIdle: (schedule: UpdateSettings["schedule"]) => Promise<boolean>;
	readonly isStreamLive: () => boolean;
	readonly onlyMeteredCandidateExists: () => Promise<boolean>;
	readonly runPackageCheck: () => Promise<SoftwareUpdateError>;
	readonly startPackageInstall: () => UpdateStartOutcome;
	readonly getPackageInstallWireState: () => UpdateState;
	readonly stopPackageInstallUnit: () => Promise<void>;
	readonly killAndRestartRaucForStream: () => Promise<void>;
	readonly isCommitStageRunning: () => Promise<boolean>;
	readonly checkOsManifest: (channel?: "stable" | "beta") => Promise<{
		readonly available: boolean;
		readonly rateLimited: boolean;
		readonly failed: boolean;
		readonly reason: string;
		readonly manifest?: OsChannelManifest;
	}>;
	readonly stageOs: (
		manifest: OsChannelManifest,
		onProgress: (percent: number) => void,
		control?: OsStageControl,
	) => Promise<void>;
	readonly newOsAttemptId: () => string;
	readonly acquireOsStageControl?: typeof acquireOsStageControlLease;
	readonly readPersistedState?: typeof loadOrchestratorState;
	readonly osAttemptIntentStore?: OsAttemptIntentStore;
	readonly readOsUnlaunchedWitness?: typeof readOsUnlaunchedWitness;
	readonly retireOsReceipt?: typeof retireStagedReceipt;
	readonly readBootedImage?: () => ReturnType<typeof readInstalledImage>;
	readonly acknowledgeOsReceipt?: () => void;
	readonly isReceiptAckPending?: () => boolean;
	readonly consumeOsUnlaunchedWitness?: typeof consumeOsUnlaunchedWitness;
	/**
	 * Positive proof that no RAUC writer or attempt-owned resource survives a
	 * failed stage, supplied by the guarded RAUC recovery adapter.
	 */
	readonly proveOsWriterQuiescent: (
		lease?: OsStageControlLease,
	) => Promise<boolean>;
	readonly readActivationArmed: () => Promise<boolean>;
	readonly isOsStageReady?: () => Promise<boolean>;
	readonly isUpdateAdmissionReady?: () => Promise<boolean>;
	readonly readOsStageJob?: typeof readOsStageJob;
	readonly osStageStartupDeps?: Partial<OsStartupDeps>;
	readonly armOs: (now: boolean) => Promise<void>;
	readonly readOsReceipt: typeof readStagedReceipt;
	readonly rebindOsReceipt: (
		receipt: OsStageReceipt,
		bootId: string,
	) => Promise<void>;
	readonly readStagedActivation: () => Promise<StagedActivation>;
	readonly readBootId: typeof readBootId;
	readonly readBootedVersion: typeof readBootedOsReleaseVersion;
	readonly inspectOsOperation: typeof inspectOsOperation;
	readonly startSlotSync: () => Promise<void>;
	readonly inspectSlotSync: () => Promise<SlotSyncProbeState>;
	readonly resetSlotSyncFailure: () => Promise<void>;
	readonly readSlotSyncEvidence: () => Promise<SlotSyncEvidence>;
	readonly readHealthyState: typeof readHealthyState;
	readonly readRootSlots: () => Promise<readonly RootSlotStatus[]>;
	readonly cleanSlotSyncArchives: () => Promise<boolean>;
	readonly removeRaucDownloads: () => Promise<void>;
	readonly dropSupersededQuarantine: (
		quarantine: UpdateQuarantine,
	) => Promise<void>;
	readonly refreshSlots: () => Promise<unknown>;
	readonly recoverSoftwareUpdateIfRunning: () => Promise<boolean>;
	readonly lastInstallUnitVerdict: () => InstallUnitVerdict;
	readonly persist: (state: OrchestratorState) => void;
	readonly quarantine: UpdateQuarantine;
	readonly restartStale: (
		isIdle: () => Promise<boolean>,
		transactionRunning: () => boolean,
	) => Promise<boolean>;
	/**
	 * Publish on transitions so connected operators do not retain login-time state.
	 */
	readonly publishWireState?: (wire: UpdateOrchestratorWireState) => void;
}

async function defaultOnlyMeteredCandidateExists(): Promise<boolean> {
	const deps = defaultUpdateTransportDeps;
	let nmcli: { exitCode: number; stdout: string };
	try {
		nmcli = await deps.run([
			"nmcli",
			"-t",
			"-f",
			"GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.METERED",
			"device",
			"show",
		]);
	} catch {
		return false;
	}
	if (nmcli.exitCode !== 0) return false;
	const candidates = discoverCandidates(
		deps.listIfnames(),
		nmcli.stdout,
		deps.mmIfnames(),
		deps.routerIfnames(),
		deps.dongleIfnames(),
	);
	return candidates.length > 0 && candidates.every((c) => c.metered);
}

export async function checkOsManifestResult(
	channel: "stable" | "beta",
	check: typeof checkOsChannel = checkOsChannel,
): ReturnType<OrchestratorRuntimeDeps["checkOsManifest"]> {
	try {
		const manifest = await check(channel, new UpdateQuarantine());
		return {
			available: manifest !== undefined,
			rateLimited: false,
			failed: false,
			reason: "",
			...(manifest ? { manifest } : {}),
		};
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "manifest_check_failed";
		return {
			available: false,
			rateLimited: reason === "rate_limited",
			failed: true,
			reason,
		};
	}
}

export const defaultOrchestratorRuntimeDeps: OrchestratorRuntimeDeps = {
	now: () => Date.now(),
	random: () => Math.random(),
	loadSettings: () => loadUpdateSettings(),
	loadCapabilities: () => readUpdateCapabilities(),
	isIdle: async (schedule) =>
		(await getIdleStatus({ now: Date.now(), schedule })).idle,
	isStreamLive: getIsStreaming,
	onlyMeteredCandidateExists: defaultOnlyMeteredCandidateExists,
	runPackageCheck: runUpdateDiscoveryAndReport,
	startPackageInstall: () => startSoftwareUpdate(notePackageCommitSucceeded),
	getPackageInstallWireState: getUpdateState,
	stopPackageInstallUnit: stopPackageInstallUnitForStream,
	killAndRestartRaucForStream,
	isCommitStageRunning: async () =>
		shouldUseMocks() ? false : isCommitStageRunning(),
	checkOsManifest: async (channel) =>
		checkOsManifestResult(channel ?? (await loadUpdateSettings()).channel),
	stageOs: async (manifest, onProgress, control) => {
		await stageOsBundle(manifest, onProgress, control);
	},
	readActivationArmed,
	isOsStageReady: async () =>
		!(await isRealDevice()) || (await isOsStageReady()),
	isUpdateAdmissionReady: async () => {
		if (!(await isRealDevice())) return true;
		try {
			const job = await (deps.readOsStageJob ?? readOsStageJob)();
			if (osStageInProcess || activeOsStage)
				return job === null || job.attemptId === activeOsStage?.attemptId;
			return ensureOsUpdateAdmissionReady(
				job !== null,
				deps.osStageStartupDeps,
			);
		} catch (error) {
			logger.warn("update-orchestrator: OS job ownership unreadable", {
				error,
			});
			return false;
		}
	},
	newOsAttemptId: () => randomUUID(),
	proveOsWriterQuiescent: proveRuntimeOsWriterQuiescent,
	armOs: armOsActivation,
	readOsReceipt: readStagedReceipt,
	rebindOsReceipt: rebindStagedReceipt,
	readStagedActivation,
	readBootId,
	readBootedVersion: readBootedOsReleaseVersion,
	inspectOsOperation,
	startSlotSync,
	inspectSlotSync,
	resetSlotSyncFailure,
	readSlotSyncEvidence,
	readHealthyState,
	readRootSlots,
	cleanSlotSyncArchives: cleanAptCache,
	removeRaucDownloads,
	dropSupersededQuarantine,
	refreshSlots: readBothSlotStatus,
	recoverSoftwareUpdateIfRunning,
	lastInstallUnitVerdict: getLastInstallUnitVerdict,
	persist: saveOrchestratorState,
	quarantine: new UpdateQuarantine(),
	restartStale: async (isIdle, transactionRunning) => {
		if (!(await isRealDevice())) return true;
		return reconcileStaleUnits({
			...defaultStaleServiceDeps,
			isIdle,
			transactionRunning,
		});
	},
	publishWireState: (wire) =>
		broadcastMsg("status", { update_orchestrator: wire }),
};

let deps: OrchestratorRuntimeDeps = defaultOrchestratorRuntimeDeps;
let state: OrchestratorState = initialOrchestratorState(Date.now());
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;
const startupFlight = new OrchestratorStartupFlight();
const startupCadence = new UpdateStartupCadence();
const startupReadiness = new UpdateStartupReadiness(
	() => !pendingPackageSuccess.pending,
);
let osCandidate: OsChannelManifest | undefined;
let osStageInProcess = false;
let activeOsStage:
	| { readonly attemptId: string; readonly controller: AbortController }
	| undefined;
setOsStageLiveProducerProbe(() => activeOsStage?.attemptId ?? null);
let raucStreamAbortInProcess = false;
let packageInstallStarting = false;
let updateAdmissionProbe: Promise<boolean> | undefined;
let osForceActivated = false;
let slotSyncUndecidedReason: string | null = null;
let slotIdentityUnknownWarned = false;
let legacyOsFailureWarned = false;
let consumedReceiptWarned = false;
let recoveryPersistenceValid = true;
const osSettlementPersistence = new OsSettlementPersistence(() =>
	publishingIntentPending(deps.osAttemptIntentStore),
);
let pendingCellularApproval:
	| { readonly id: string; readonly sizeBytes: number }
	| undefined;
// Bumped on every state change. A wall-clock `enteredAt` is not an identity
// (an abort and a replacement install can share a millisecond), so "is this
// still the download we deferred / did anything move while we awaited" is
// answered by the generation instead.
let stateGeneration = 0;
// Generation at which a resumed download's unit probe was inconclusive. Any
// later state change clears it: the download was left, or the poll path is
// already reading its unit (DOWNLOAD_PROGRESS is the only in-phase change).
let deferredDownloadGeneration: number | null = null;

function acquireRuntimeOsStageControl(): Promise<OsStageControlLease> {
	return acquireRuntimeControl(deps.acquireOsStageControl);
}

function osRecoverySettlementPort() {
	return {
		snapshot: () => state,
		pending: () => osSettlementPersistence.pending,
		acquireControl: acquireRuntimeOsStageControl,
		readPersisted: deps.readPersistedState ?? loadOrchestratorState,
		persist: deps.persist,
		persistSnapshot: (
			baseline: OrchestratorState | null,
			settled: OrchestratorState,
		) =>
			osSettlementPersistence.save(baseline, settled, () =>
				deps.persist(settled),
			),
	};
}

function dispatchOsSettlement(event: OrchestratorEvent): OrchestratorState {
	return osSettlementPersistence.settle(
		{ snapshot: () => state, dispatch },
		event,
	);
}

function replayPendingOsSettlement(): Promise<boolean> {
	return osSettlementPersistence.replay({
		...osRecoverySettlementPort(),
		publish: publishWireState,
	});
}

const IDLE_TICK_MS = 60_000;
const ACTIVE_TICK_MS = 3_000;

export function setOrchestratorRuntimeDepsForTest(
	overrides: Partial<OrchestratorRuntimeDeps> | null,
): void {
	deps = overrides
		? { ...defaultOrchestratorRuntimeDeps, ...overrides }
		: defaultOrchestratorRuntimeDeps;
	startupReadiness.setReady(overrides !== null);
}

export function resetOrchestratorRuntimeForTest(): void {
	if (tickTimer) clearTimeout(tickTimer);
	tickTimer = undefined;
	started = false;
	startupReadiness.setReady(false);
	startupFlight.resetForTest();
	startupCadence.resetForTest();
	resetRecoveredUpdateExitForTest();
	pendingPackageSuccess.resetForTest();
	state = initialOrchestratorState(Date.now());
	deps = defaultOrchestratorRuntimeDeps;
	osCandidate = undefined;
	activeOsStage?.controller.abort();
	activeOsStage = undefined;
	osStageInProcess = false;
	raucStreamAbortInProcess = false;
	packageInstallStarting = false;
	updateAdmissionProbe = undefined;
	osForceActivated = false;
	slotSyncUndecidedReason = null;
	slotIdentityUnknownWarned = false;
	legacyOsFailureWarned = false;
	recoveryPersistenceValid = true;
	osSettlementPersistence.resetForTest();
	pendingCellularApproval = undefined;
	stateGeneration = 0;
	deferredDownloadGeneration = null;
}

export function getOrchestratorState(): OrchestratorState {
	return state;
}

export function setOrchestratorStateForTest(next: OrchestratorState): void {
	adoptState(next);
}

export function getOrchestratorWireState(): UpdateOrchestratorWireState {
	return {
		schema: 1,
		phase: state.phase,
		progress: state.progress,
		failure_reason: state.failureReason,
		cellular_override_id: state.cellularOverrideId,
	};
}

export type OsUpdateSummary = {
	readonly candidate: {
		readonly version: string;
		readonly sizeBytes: number;
	} | null;
	readonly pendingCellular: {
		readonly id: string;
		readonly sizeBytes: number;
	} | null;
};

export function getOsUpdateSummary(): OsUpdateSummary {
	return {
		candidate: osCandidate
			? { version: osCandidate.version, sizeBytes: osCandidate.bundle.size }
			: null,
		pendingCellular:
			pendingCellularApproval &&
			osCandidate?.version === pendingCellularApproval.id
				? pendingCellularApproval
				: null,
	};
}

// A failed broadcast must not undo the persisted transition.
function publishWireState(): void {
	try {
		deps.publishWireState?.(getOrchestratorWireState());
	} catch (error) {
		logger.warn("update-orchestrator: wire-state publish failed", { error });
	}
}

function adoptState(next: OrchestratorState): void {
	if (next === state) return;
	state = next;
	stateGeneration++;
}

function dispatch(event: OrchestratorEvent): OrchestratorState {
	const next = reduceOrchestrator(state, event);
	if (next !== state) {
		adoptState(next);
		deps.persist(state);
		publishWireState();
	}
	return state;
}

function notePackageCommitSucceeded(): void {
	const now = deps.now();
	if (state.phase === "downloading")
		dispatch({ type: "COMMIT_PHASE_ENTERED", now });
	if (state.phase === "committing") dispatch({ type: "COMMIT_SUCCEEDED", now });
	if (state.phase !== "restarting-services" && state.phase !== "settled")
		throw new Error("package commit success could not be persisted");
}

// ─── operator RPC actions ──────────────────────────────────────────────────
// Launch windows: root AGENTS.md D8 Known gaps (f)-(g).

export type ManualCheckOutcome =
	| { readonly started: true }
	| { readonly started: false; readonly reason: "busy" };

function updateAdmissionReady(): Promise<boolean> {
	if (osSettlementPersistence.pending)
		return maybeSettleOsUnlaunchedWitness().then(() =>
			osSettlementPersistence.pending ? false : updateAdmissionReady(),
		);
	if (updateAdmissionProbe) return updateAdmissionProbe;
	// Join only the in-flight read: independent filesystem completions must not
	// reorder callers, and a settled verdict must never become cached permission.
	const read = deps.isUpdateAdmissionReady?.() ?? Promise.resolve(true);
	const deadline = Promise.withResolvers<boolean>();
	const cancelDeadline = armUpdateAdmissionDeadline(() =>
		deadline.resolve(false),
	);
	const probe = Promise.race([read, deadline.promise])
		.then((ready) => ready && !osSettlementPersistence.pending)
		.finally(() => {
			cancelDeadline();
			if (updateAdmissionProbe === probe) updateAdmissionProbe = undefined;
		});
	updateAdmissionProbe = probe;
	return probe;
}

export async function checkUpdatesNow(): Promise<ManualCheckOutcome> {
	startupReadiness.assertReady(
		!osSettlementPersistence.replayPending &&
			!publishingIntentPending(deps.osAttemptIntentStore),
	);
	if (!(await updateAdmissionReady()))
		return { started: false, reason: "busy" };
	await maybeRetireConsumedOsReceipt();
	await maybeSettleOsUnlaunchedWitness();
	if (osSettlementPersistence.pending)
		return { started: false, reason: "busy" };
	if (state.phase === "failed") {
		await maybeMigrateLegacyOsFailure();
		await maybeConfirmOsStageRecovery();
	}
	if (!canStartManualCheck(state.phase))
		return { started: false, reason: "busy" };
	await runPackageCheckCycle();
	if (state.phase === "idle") {
		const capabilities = await deps.loadCapabilities();
		if (
			capabilities.mode === "capable" &&
			capabilities.features.includes("rauc-verity-streaming")
		)
			await runOsCheckAfterCellularGate(await deps.loadSettings());
	}
	return { started: true };
}

export type ManualInstallOutcome =
	| { readonly started: true }
	| {
			readonly started: false;
			readonly reason:
				| "busy"
				| "not_available"
				| "stream_active"
				| "booted_version_unknown";
	  };

const PACKAGE_PIPELINE_BUSY_PHASES: readonly OrchestratorState["phase"][] = [
	"awaiting-idle",
	"downloading",
	"committing",
	"restarting-services",
	"settled",
];

export async function installUpdatesNow(): Promise<ManualInstallOutcome> {
	startupReadiness.assertReady(
		!osSettlementPersistence.replayPending &&
			!publishingIntentPending(deps.osAttemptIntentStore),
	);
	if (!(await updateAdmissionReady()))
		return { started: false, reason: "busy" };
	await maybeRetireConsumedOsReceipt();
	await maybeSettleOsUnlaunchedWitness();
	if (osSettlementPersistence.pending)
		return { started: false, reason: "busy" };
	if (
		state.phase === "idle" &&
		state.failureReason === "booted_version_unknown"
	)
		return { started: false, reason: "booted_version_unknown" };
	if (state.phase === "os-available") {
		if (deps.isStreamLive()) return { started: false, reason: "stream_active" };
		const capabilities = await deps.loadCapabilities();
		if (
			capabilities.mode !== "capable" ||
			!capabilities.features.includes("rauc-verity-streaming")
		)
			return { started: false, reason: "not_available" };
		await maybeStartOsStage(true);
		return ["os-staging", "os-staged", "os-activation-armed"].includes(
			getOrchestratorState().phase,
		)
			? { started: true }
			: { started: false, reason: "not_available" };
	}
	if (packageInstallStarting) return { started: false, reason: "busy" };
	if (!canStartManualInstall(state.phase, "packages")) {
		return {
			started: false,
			reason: PACKAGE_PIPELINE_BUSY_PHASES.includes(state.phase)
				? "busy"
				: "not_available",
		};
	}
	// Starting-stream window: root AGENTS.md D8 Known gaps (f).
	if (deps.isStreamLive()) return { started: false, reason: "stream_active" };
	if (state.phase === "available")
		dispatch({ type: "AWAIT_IDLE_FOR_INSTALL", now: deps.now() });
	const launch = await maybeStartPackageInstall({ bypassIdle: true });
	if (launch?.started) return { started: true };
	const reason = launch?.reason;
	switch (reason) {
		case "streaming":
			return { started: false, reason: "stream_active" };
		case "check_unavailable":
			return { started: false, reason: "not_available" };
		case "already_updating":
		case "updates_disabled":
		case undefined:
			return { started: false, reason: "busy" };
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}

export function allowCellularOnce(id: string): void {
	startupReadiness.assertReady(!osSettlementPersistence.pending);
	dispatch({ type: "CELLULAR_OVERRIDE_GRANTED", now: deps.now(), id });
}

// ─── stream-start admission (Todo 37) ──────────────────────────────────────
//
// Cached download progress can lag dpkg; interrupting dpkg risks a half-installed
// package. Keep the fresh read and probe ahead of the stop. See "D8
// stream/update admission: what it does NOT cover" under Known gaps in the
// root AGENTS.md and docs/DEVICE-UPDATES.md's D8 section. Preserve the
// single-unit/flock design and exact ExecStart identity.
export type StreamStartUpdateAdmission =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason: "update_in_progress";
			readonly phase: OrchestratorPhase;
			readonly percent: number;
			readonly etaSeconds: number;
	  };

const COMMIT_STAGE_REFUSAL: StreamStartUpdateAdmission = {
	allowed: false,
	reason: "update_in_progress",
	phase: "committing",
	percent: 0,
	etaSeconds: 0,
};

async function commitStageRunning(): Promise<boolean> {
	try {
		return await deps.isCommitStageRunning();
	} catch (error) {
		logger.warn(
			"update-orchestrator: commit-stage probe failed; refusing the stream start rather than stopping the install",
			{ error },
		);
		return true;
	}
}

export async function admitAndPrepareStreamStart(): Promise<StreamStartUpdateAdmission> {
	if (publishingIntentPending(deps.osAttemptIntentStore))
		await awaitPublishingIntentForStream({
			...(deps.osAttemptIntentStore
				? { store: deps.osAttemptIntentStore }
				: {}),
			recover: maybeSettleOsUnlaunchedWitness,
			readJob: deps.readOsStageJob ?? readOsStageJob,
		});
	if (pendingPackageSuccess.pending) return COMMIT_STAGE_REFUSAL;
	const cached = admitStreamStart(state);
	if (!cached.allowed) return cached;

	const action = onStreamStart(state);
	if (action === "none" || action === "continue-local") {
		return { allowed: true };
	}

	if (state.phase === "downloading") {
		const freshWire = deps.getPackageInstallWireState();
		if (freshWire.kind === "installing" || freshWire.kind === "success") {
			dispatch({ type: "COMMIT_PHASE_ENTERED", now: deps.now() });
			const refreshed = admitStreamStart(state);
			if (!refreshed.allowed) return refreshed;
			return COMMIT_STAGE_REFUSAL;
		}
		if (await commitStageRunning()) {
			// Probe-only: refuse, but dispatch nothing. A running second stage
			// or a thrown probe is not proof that dpkg ran, and latching
			// `committing` here would turn a later pre-dpkg failure into a
			// quarantining COMMIT_FAILED. The next start probes again.
			return COMMIT_STAGE_REFUSAL;
		}
		if (pendingPackageSuccess.pending) return COMMIT_STAGE_REFUSAL;
		await deps.stopPackageInstallUnit();
		if (pendingPackageSuccess.pending) return COMMIT_STAGE_REFUSAL;
		dispatch({ type: "DOWNLOAD_ABORTED_FOR_STREAM", now: deps.now() });
		return { allowed: true };
	}

	if (state.phase === "os-staging") {
		// RAUC targets the inactive slot, unlike apt's live-root transaction.
		// Leave os-staging BEFORE the kill: the SIGTERM fails the in-flight
		// install at once, and its catch must see the abort, not a failure.
		activeOsStage?.controller.abort();
		dispatch({ type: "OS_STAGING_ABORTED_FOR_STREAM", now: deps.now() });
		raucStreamAbortInProcess = true;
		try {
			await deps.killAndRestartRaucForStream();
		} finally {
			raucStreamAbortInProcess = false;
		}
		return { allowed: true };
	}

	return { allowed: true };
}

// ─── package check cycle ───────────────────────────────────────────────────

async function runPackageCheckCycle(): Promise<void> {
	if (osSettlementPersistence.pending) return;
	const now = deps.now();
	dispatch({ type: "PACKAGE_CHECK_STARTED", now });
	const error = await deps.runPackageCheck();
	const outcomeNow = deps.now();
	if (error === null) {
		const wire = deps.getPackageInstallWireState();
		const actionableCount =
			wire.kind === "available" ? (wire.actionable_count ?? 0) : 0;
		if (wire.kind === "available") {
			await deps.quarantine.reconcileCandidates(
				wire.packages?.flatMap((item) =>
					item.version ? [{ name: item.name, version: item.version }] : [],
				) ?? [],
			);
			if (actionableCount > 0)
				notifyUpdate({
					kind: "updates-available",
					id:
						wire.packages
							?.map((item) => `${item.name}=${item.version ?? "unknown"}`)
							.sort()
							.join(",") ?? wire.identity.version,
				});
		}
		const nextAttemptAt =
			outcomeNow +
			computeNextCheckDelayMs({
				outcome: "success",
				consecutiveFailuresAfter: 0,
				rateLimited: false,
				kind: "packages",
				randomUnit: deps.random(),
			});
		dispatch(
			actionableCount > 0
				? {
						type: "CHECK_SUCCEEDED_PACKAGES",
						now: outcomeNow,
						nextAttemptAt,
					}
				: {
						type: "CHECK_SUCCEEDED_NONE",
						now: outcomeNow,
						kind: "packages",
						nextAttemptAt,
					},
		);
		return;
	}
	const rateLimited =
		error === "captive_portal" ? false : isRateLimitedError(error);
	const consecutiveFailuresAfter = state.packageCheck.consecutiveFailures + 1;
	const nextAttemptAt =
		outcomeNow +
		computeNextCheckDelayMs({
			outcome: "failure",
			consecutiveFailuresAfter,
			rateLimited,
			kind: "packages",
			randomUnit: deps.random(),
		});
	dispatch({
		type: "CHECK_FAILED",
		now: outcomeNow,
		kind: "packages",
		rateLimited,
		reason:
			typeof error === "string"
				? error
				: String((error as Error)?.message ?? error),
		nextAttemptAt,
	});
	notifyUpdate({
		kind: "refused",
		id: `packages:${String(error)}`,
		reason: String(error),
	});
}

// Best-effort mirror-status detection affects cadence, not the update verdict.
function isRateLimitedError(error: SoftwareUpdateError): boolean {
	if (
		error === true ||
		error === "captive_portal" ||
		error === "repos_unreachable"
	)
		return false;
	const message =
		typeof error === "string"
			? error
			: ((error as Error)?.message ?? String(error));
	return /\b(429|5\d\d)\b/.test(message);
}

// ─── package install (awaiting-idle -> downloading -> committing) ─────────

async function maybeStartPackageInstall(opts: {
	readonly bypassIdle: boolean;
}): Promise<UpdateStartOutcome | undefined> {
	if (state.phase !== "awaiting-idle") return;
	if (deps.isStreamLive()) return { started: false, reason: "streaming" };
	if (!opts.bypassIdle) {
		const settings = await deps.loadSettings();
		const idle = await deps.isIdle(settings.schedule);
		if (!idle) return;
	}
	if (state.phase !== "awaiting-idle" || packageInstallStarting) return;
	packageInstallStarting = true;
	try {
		const available = deps.getPackageInstallWireState();
		if (available.kind === "available") {
			await deps.quarantine.savePending(
				available.packages
					?.filter((item) => item.actionable)
					.map((item) => ({
						name: item.name,
						...(item.version ? { version: item.version } : {}),
					})) ?? available.identity.packages.map((name) => ({ name })),
			);
		}
		const result = deps.startPackageInstall();
		if (!result.started) {
			await deps.quarantine.clearPending();
			return result; // stays awaiting-idle; retried next tick
		}
		dispatch({ type: "INSTALL_UNIT_STARTED", now: deps.now() });
		return result;
	} finally {
		packageInstallStarting = false;
	}
}

async function pollPackageInstallProgress(): Promise<void> {
	if (state.phase !== "downloading" && state.phase !== "committing") return;
	const wire = deps.getPackageInstallWireState();
	const now = deps.now();
	if (wire.kind === "downloading") {
		if (state.phase === "committing") return; // never regress commit->download
		dispatch({
			type: "DOWNLOAD_PROGRESS",
			now,
			progress: progressFromWire(wire.progress),
		});
		return;
	}
	if (wire.kind === "installing") {
		if (state.phase === "downloading") {
			dispatch({ type: "COMMIT_PHASE_ENTERED", now });
		}
		dispatch({
			type: "COMMIT_PROGRESS",
			now,
			progress: progressFromWire(wire.progress),
		});
		return;
	}
	if (wire.kind === "success") {
		if (state.phase === "downloading")
			dispatch({ type: "COMMIT_PHASE_ENTERED", now });
		dispatch({ type: "COMMIT_SUCCEEDED", now });
		return;
	}
	if (wire.kind === "failed") {
		if (state.phase === "downloading") {
			dispatch({ type: "DOWNLOAD_FAILED", now, reason: wire.reason });
		} else {
			const pending = await deps.quarantine.readPending();
			await deps.quarantine.recordPackageFailure(
				pending.flatMap((item) =>
					item.version ? [{ name: item.name, version: item.version }] : [],
				),
				String(state.enteredAt),
				wire.reason,
			);
			await deps.quarantine.clearPending();
			dispatch({ type: "COMMIT_FAILED", now, reason: wire.reason });
			notifyUpdate({
				kind: "refused",
				id: `commit:${state.enteredAt}`,
				reason: wire.reason,
			});
		}
	}
}

// ─── slot-sync (sync-eligible -> syncing -> synced) ────────────────────────

async function checkSlotSyncGate() {
	const capabilities = await deps.loadCapabilities();
	// On a legacy image the capability refusal is already decisive; do not
	// probe paths that image never installed on every idle scheduling tick.
	const evidence: SlotSyncEvidence =
		capabilities.mode === "capable" &&
		capabilities.features.includes("slot-sync")
			? await deps.readSlotSyncEvidence()
			: {
					healthyState: null,
					bootId: "",
					statusSha256: "",
					buildId: "",
					receiptStateSha256: null,
					receiptTarget: "not-other",
					receiptTargetSlot: null,
				};
	return slotSyncGate({
		...evidence,
		capabilities,
		phase: state.phase,
	});
}

// The gate runs on every tick and this skip never resolves on its own, so a
// debug line would leave a mirror that never runs invisible on a device.
function noteSlotIdentityGate(gate: SlotSyncGate): void {
	const unknown = !gate.allowed && gate.reason === "slot-identity-unknown";
	if (unknown && !slotIdentityUnknownWarned)
		logger.warn(
			"update-orchestrator: slot-sync skipped, receipt slot identity unknown",
			{ reason: "slot-identity-unknown" },
		);
	slotIdentityUnknownWarned = unknown;
}

async function maybeFindSlotSyncCandidate(): Promise<void> {
	if (state.phase !== "idle") return;
	try {
		const gate = await checkSlotSyncGate();
		noteSlotIdentityGate(gate);
		if (gate.allowed && state.phase === "idle")
			dispatch({ type: "SYNC_ELIGIBILITY_CONFIRMED", now: deps.now() });
	} catch (error) {
		logger.warn("update-orchestrator: slot-sync eligibility read deferred", {
			error,
		});
	}
}

async function maybeStartSlotSync(): Promise<void> {
	if (state.phase !== "sync-eligible") return;
	try {
		const gate = await checkSlotSyncGate();
		noteSlotIdentityGate(gate);
		if (state.phase !== "sync-eligible") return;
		if (!gate.allowed) {
			logger.debug("update-orchestrator: slot-sync preflight skipped", {
				reason: gate.reason,
			});
			dispatch({ type: "SYNC_SKIPPED", now: deps.now() });
			return;
		}
	} catch (error) {
		logger.warn("update-orchestrator: slot-sync preflight deferred", { error });
		dispatch({ type: "SYNC_SKIPPED", now: deps.now() });
		return;
	}
	dispatch({ type: "SYNC_STARTED", now: deps.now() });
	try {
		await deps.startSlotSync();
	} catch (error) {
		dispatch({
			type: "SYNC_FAILED",
			now: deps.now(),
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

async function settleSlotSyncSucceeded(now: number): Promise<void> {
	dispatch({ type: "SYNC_SUCCEEDED", now });
	// The mirror is already committed. Each cleanup is independent and cannot
	// change its verdict; a later tick sees synced, never a second cleanup.
	const cleanups: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
		["apt archives", deps.cleanSlotSyncArchives],
		["RAUC downloads", deps.removeRaucDownloads],
		["quarantine", () => deps.dropSupersededQuarantine(deps.quarantine)],
		["slot status", deps.refreshSlots],
	];
	for (const [name, cleanup] of cleanups) {
		try {
			const result = await cleanup();
			if (result === false)
				logger.warn("update-orchestrator: slot-sync cleanup failed", {
					name,
				});
		} catch (error) {
			logger.warn("update-orchestrator: slot-sync cleanup failed", {
				name,
				error,
			});
		}
	}
	notifyUpdate({ kind: "slots-current", id: String(now) });
}

function noteSlotSyncUndecided(reason: string, error?: unknown): void {
	if (slotSyncUndecidedReason === reason) return;
	slotSyncUndecidedReason = reason;
	logger.warn("update-orchestrator: slot-sync verdict deferred", {
		reason,
		error,
	});
}

// Two clean unit reads and a matching receipt cannot tell a finished run from
// one whose power was cut between the receipt and `mark-good other`: after the
// reboot the unit reads as never run. Only RAUC says whether the target slot
// was confirmed, so success waits for it and an unreadable answer is no answer.
async function settleIfMirrorTargetGood(
	evidence: SlotSyncEvidence,
	now: number,
): Promise<void> {
	let slots: readonly RootSlotStatus[];
	try {
		slots = await deps.readRootSlots();
	} catch (error) {
		noteSlotSyncUndecided("rauc-unreadable", error);
		return;
	}
	const verdict = judgeMirrorTarget(slots, evidence.receiptTargetSlot);
	switch (verdict) {
		case "good":
			slotSyncUndecidedReason = null;
			await settleSlotSyncSucceeded(now);
			return;
		case "bad":
			slotSyncUndecidedReason = null;
			await failIncompleteUnlessRerunning(now);
			return;
		// RAUC shows the receipt is not this boot's other slot: it is not
		// evidence for this run, whatever the healthy record said.
		case "not-target":
			slotSyncUndecidedReason = null;
			await concludeWithoutMatchingReceipt(now, evidence);
			return;
		case "undecidable":
			noteSlotSyncUndecided(verdict);
			return;
		default: {
			const unreachable: never = verdict;
			return unreachable;
		}
	}
}

// A target read bad right after two clean probes is an interrupted mark-good,
// unless a new run of the unit (which un-marks its target while copying) began
// in between.
async function failIncompleteUnlessRerunning(now: number): Promise<void> {
	const recheck = await deps.inspectSlotSync();
	switch (recheck.kind) {
		case "running":
			return;
		case "refused":
		case "failed":
			await failSlotSyncFromUnit(recheck, now);
			return;
		case "absent":
		case "succeeded":
		case "inactive-clean":
			dispatch({ type: "SYNC_FAILED", now, reason: "slot-sync-incomplete" });
			return;
		default: {
			const unreachable: never = recheck;
			return unreachable;
		}
	}
}

async function failSlotSyncFromUnit(
	probe: Extract<SlotSyncProbeState, { kind: "refused" | "failed" }>,
	now: number,
): Promise<void> {
	// Persist the verdict before clearing systemd's failure record: once the
	// record is gone the unit reads inactive-clean, and a matching receipt
	// (published before mark-good) would turn a restart into a false success.
	dispatch({
		type: "SYNC_FAILED",
		now,
		reason:
			probe.kind === "refused"
				? `slot-sync refused (exit ${probe.exitCode})`
				: `slot-sync failed (exit ${probe.exitCode})`,
	});
	await deps.resetSlotSyncFailure().catch((error) => {
		logger.warn("update-orchestrator: slot-sync reset-failed cleanup failed", {
			error,
		});
	});
}

/**
 * How long an unloaded or unreadable unit without this run's receipt is read
 * as a job still queued rather than a mirror that vanished. The unit has
 * Requires=/After= ceralive-healthcheck.service, but on the shipped image the
 * gate only dispatches after that healthcheck wrote this boot's healthy record
 * as its last step, the healthcheck is RemainAfterExit=yes, and a re-run is a
 * boot-id no-op (image `mkosi/runtime/ceralive-healthcheck.sh` l.444-456 and
 * l.474-476 at 36d8131), so the queue behind it lasts milliseconds. 90 s
 * (the healthcheck's own 60 s + 5 s budget with margin, 30 polls at
 * ACTIVE_TICK_MS) is a defensive bound for any delayed start job, not a
 * measured wait.
 */
export const SLOT_SYNC_QUEUED_START_GRACE_MS = 90_000;

function withinQueuedStartGrace(now: number): boolean {
	const elapsed = now - state.enteredAt;
	// A clock that stepped behind the start bounds nothing: fail closed.
	return elapsed >= 0 && elapsed < SLOT_SYNC_QUEUED_START_GRACE_MS;
}

async function readSlotSyncEvidenceOrNull(): Promise<SlotSyncEvidence | null> {
	try {
		return await deps.readSlotSyncEvidence();
	} catch (error) {
		logger.warn("update-orchestrator: slot-sync receipt unreadable", {
			error,
		});
		return null;
	}
}

// The poll, unlike the gate, may read the PREVIOUS boot's healthy record: after
// a reboot the new boot's healthcheck rewrites it only once the backend is up.
// A receipt for this dpkg state whose slot identity is therefore unknown stays
// a candidate, because RAUC is read before any success and names this boot's
// booted and inactive slots itself.
function receiptMayConfirmMirror(
	evidence: SlotSyncEvidence | null,
): evidence is SlotSyncEvidence {
	return (
		evidence !== null &&
		evidence.receiptStateSha256 === evidence.statusSha256 &&
		evidence.receiptTarget !== "not-other"
	);
}

function sameReceipt(a: SlotSyncEvidence, b: SlotSyncEvidence): boolean {
	return (
		a.receiptStateSha256 === b.receiptStateSha256 &&
		a.receiptTargetSlot === b.receiptTargetSlot
	);
}

// A terminal-clean unit without this run's receipt. Both reads may be older
// than the job, which can have started (or finished) while they ran, so the
// failure is only concluded from a re-probe and a receipt read after it.
// `rejected` is a receipt RAUC already showed is not this boot's other slot:
// reading the same one again must not defer the verdict forever.
async function concludeWithoutMatchingReceipt(
	now: number,
	rejected?: SlotSyncEvidence,
): Promise<void> {
	if (withinQueuedStartGrace(now)) return;
	const recheck = await deps.inspectSlotSync();
	switch (recheck.kind) {
		case "running":
			return;
		case "refused":
		case "failed":
			await failSlotSyncFromUnit(recheck, now);
			return;
		case "absent":
			dispatch({ type: "SYNC_FAILED", now, reason: "slot-sync-unit-absent" });
			return;
		case "succeeded":
		case "inactive-clean":
			break;
		default: {
			const unreachable: never = recheck;
			return unreachable;
		}
	}
	// A receipt that matches now is judged by the next poll, which re-probes
	// after reading it; a retained exit 0 keeps waiting as before.
	const fresh = await readSlotSyncEvidenceOrNull();
	if (
		receiptMayConfirmMirror(fresh) &&
		!(rejected !== undefined && sameReceipt(fresh, rejected))
	)
		return;
	if (recheck.kind === "succeeded") return;
	dispatch({ type: "SYNC_FAILED", now, reason: "slot-sync-unit-absent" });
}

// Each await below is a point where the process may die (nothing is persisted
// until a verdict) or where a read may still describe the PREVIOUS run.
// A Type=oneshot unit without RemainAfterExit reads inactive/dead once
// finished, and systemd 257 unloads it within about a second, resetting
// ExecMainCode, so a success reads "succeeded" or "inactive-clean". Either can
// also be the previous run's record while --no-block's job is still queued,
// which is why an unloaded or unreadable unit without this run's receipt is
// only failed after SLOT_SYNC_QUEUED_START_GRACE_MS and a fresh re-probe.
// The receipt for THIS dpkg state and the current other slot ties the verdict
// to this run, but the unit publishes it before its last step (mark-good), so
// it proves only that the run got that far: a fresh probe taken after the
// receipt must again read finished-and-clean. An unreadable probe ("absent")
// never consults the receipt.
async function pollSlotSync(): Promise<void> {
	if (state.phase !== "syncing") return;
	const probe = await deps.inspectSlotSync();
	const now = deps.now();
	switch (probe.kind) {
		case "running":
			return;
		case "refused":
		case "failed":
			await failSlotSyncFromUnit(probe, now);
			return;
		case "absent":
			if (withinQueuedStartGrace(now)) return;
			dispatch({ type: "SYNC_FAILED", now, reason: "slot-sync-unit-absent" });
			return;
		case "succeeded":
		case "inactive-clean":
			break;
		default: {
			const unreachable: never = probe;
			return unreachable;
		}
	}
	const evidence = await readSlotSyncEvidenceOrNull();
	if (!receiptMayConfirmMirror(evidence)) {
		// A retained exit 0 can be the previous run's while this one is queued.
		if (probe.kind === "succeeded") return;
		await concludeWithoutMatchingReceipt(now);
		return;
	}
	const confirmation = await deps.inspectSlotSync();
	switch (confirmation.kind) {
		case "running":
			return;
		case "refused":
		case "failed":
			await failSlotSyncFromUnit(confirmation, now);
			return;
		// One unreadable read right after a clean one is more likely a
		// transient `systemctl show` failure than a vanished unit. A later
		// poll's first probe still fails a persistent `absent` once the
		// queued-start grace has passed, so waiting never hides a real one.
		case "absent":
			return;
		case "succeeded":
		case "inactive-clean":
			await settleIfMirrorTargetGood(evidence, now);
			return;
		default: {
			const unreachable: never = confirmation;
			return unreachable;
		}
	}
}

const OS_FORCE_ACTIVATION_MS = 7 * 24 * 60 * 60_000;

// os-available is entered before a stream abort finishes restarting RAUC and
// before the aborted stage settles; a new stage in that window would race
// both, and the old stage's catch would fail the new one.
function osStageBlocked(): boolean {
	return (
		osSettlementPersistence.pending ||
		state.phase !== "os-available" ||
		deps.isStreamLive() ||
		currentLifecycleHolder() === "streaming" ||
		osStageInProcess ||
		raucStreamAbortInProcess
	);
}

async function maybeStartOsStage(bypassIdle: boolean): Promise<void> {
	if (osSettlementPersistence.pending) return;
	if (osStageBlocked()) return;
	if (!osCandidate) {
		await runOsCheckAfterCellularGate(await deps.loadSettings());
		if (state.phase !== "os-available" || !osCandidate) return;
	}
	const candidate = osCandidate;
	const candidateKey = osStageCandidateKey(candidate);
	const recovery = state.osStageRecovery;
	const permission = osStagePermission(
		recovery,
		candidateKey,
		deps.now(),
		bypassIdle,
	);
	if (permission === "wait" || permission === "paused") return;
	const capabilities = await deps.loadCapabilities();
	if (
		capabilities.mode !== "capable" ||
		!capabilities.features.includes("rauc-verity-streaming")
	)
		return;
	const settings = await deps.loadSettings();
	if (
		!bypassIdle &&
		(!settings.systemAuto || !(await deps.isIdle(settings.schedule)))
	)
		return;
	// A due automatic restage first re-admits the signed candidate; the round
	// itself starts on a later tick from the refreshed offer.
	if (permission === "retry" && !bypassIdle && osRetryNeedsReadmission()) {
		await runOsCheckAfterCellularGate(settings);
		return;
	}
	const gate = decideCellularGate({
		onlyMeteredCandidateExists: await deps.onlyMeteredCandidateExists(),
		kind: "os",
		stage: "install",
		allowPackagesOverCellular: settings.allowPackagesOverCellular,
		allowSystemOverCellular: settings.allowSystemOverCellular,
		cellularOverrideId: state.cellularOverrideId,
		candidateId: candidate.version,
	});
	if (deps.isOsStageReady && !(await deps.isOsStageReady())) return;
	await using controlLease = await acquireRuntimeOsStageControl();
	if (!controlLease.held()) return;
	const persisted = await (deps.readPersistedState ?? loadOrchestratorState)();
	if (
		!sameOsRecoveryIdentity(state, persisted) &&
		!(persisted === null && !state.osStageRecovery)
	)
		return;
	// Every await above can let a manual install, a stream abort or a new
	// check run; the entry fences are only true again if re-read here, and
	// nothing may await between this re-read and taking the stage.
	if (
		osStageBlocked() ||
		!controlLease.held() ||
		osCandidate !== candidate ||
		state.osStageRecovery !== recovery
	)
		return;
	if (!gate.allowed) {
		if (gate.needsOverride) {
			pendingCellularApproval = {
				id: candidate.version,
				sizeBytes: candidate.bundle.size,
			};
			notifyUpdate({
				kind: "cellular-approval",
				id: candidate.version,
				size: String(candidate.bundle.size),
			});
		}
		return;
	}
	pendingCellularApproval = undefined;
	const manifest = candidate;
	// The new attempt replaces the persisted identity, so no earlier witness can
	// match again; a leftover one would only block the guard's next write.
	const staleWitness = (
		deps.readOsUnlaunchedWitness ?? readOsUnlaunchedWitness
	)();
	if (staleWitness)
		(deps.consumeOsUnlaunchedWitness ?? consumeOsUnlaunchedWitness)(
			staleWitness.attemptId,
		);
	const token = {
		attemptId: deps.newOsAttemptId(),
		controller: new AbortController(),
	};
	const attemptId = token.attemptId;
	activeOsStage = token;
	const control: OsStageControl = {
		controlLease,
		attemptId: token.attemptId,
		signal: token.controller.signal,
		cellularApproved: state.cellularOverrideId === candidate.version,
		canCommit: () =>
			activeOsStage === token &&
			getOrchestratorState().phase === "os-staging" &&
			state.osStageRecovery?.activeAttemptId === attemptId,
		commit: () => {
			if (
				token.controller.signal.aborted ||
				activeOsStage !== token ||
				getOrchestratorState().phase !== "os-staging" ||
				state.osStageRecovery?.activeAttemptId !== attemptId
			)
				throw new OsStageError("os_stage_cancelled_for_stream");
			dispatch({ type: "OS_STAGED", now: deps.now(), attemptId });
		},
	};
	osStageInProcess = true;
	scheduleNextTick();
	try {
		publishOsAttempt(
			{
				manifest,
				lease: controlLease,
				...(deps.osAttemptIntentStore
					? { intentStore: deps.osAttemptIntentStore }
					: {}),
				snapshot: () => state,
				dispatch,
				adopt: adoptState,
				persist: deps.persist,
			},
			{
				type: "OS_STAGING_STARTED",
				now: deps.now(),
				attempt: { candidateKey, attemptId },
			},
			osSettlementPersistence,
		);
		await deps.stageOs(
			manifest,
			(percent) => {
				if (
					activeOsStage === token &&
					!token.controller.signal.aborted &&
					state.phase === "os-staging" &&
					state.osStageRecovery?.activeAttemptId === attemptId
				)
					dispatch({
						type: "OS_STAGING_PROGRESS",
						now: deps.now(),
						progress: { percent, etaSeconds: 0 },
					});
			},
			control,
		);
		if (activeOsStage !== token || token.controller.signal.aborted) return;
		if (getOrchestratorState().phase === "os-staging")
			dispatch({ type: "OS_STAGED", now: deps.now() });
		if (getOrchestratorState().phase !== "os-staged") return;
		dispatch({ type: "OS_STAGE_SETTLED", now: deps.now(), attemptId });
		osCandidate = undefined;
		clearOsStageNotices(osStageNoticeId(candidateKey));
		notifyUpdate({
			kind: "os-staged",
			id: manifest.version,
			version: manifest.version,
		});
	} catch (error) {
		if (error instanceof OsAttemptPublicationError) {
			logger.warn(
				"update-orchestrator: pre-effect publication reverted; no OS stage launched",
				{ error },
			);
			return;
		}
		if (activeOsStage !== token || token.controller.signal.aborted) return;
		if (
			getOrchestratorState().phase === "os-staged" &&
			state.osStageRecovery?.activeAttemptId === attemptId
		) {
			// Publication is not safe release: even a non-unsafe late error cannot retry a receipt.
			settleOsStageFailure(
				isOsStageError(error) && error.mode === "unsafe"
					? error
					: new OsStageError("rauc_recovery_unproven", { cause: error }),
				manifest,
				attemptId,
			);
			return;
		}
		if (getOrchestratorState().phase !== "os-staging") return;
		settleOsStageFailure(error, manifest, attemptId);
	} finally {
		try {
			if (activeOsStage === token)
				await finishOsAttemptIntent(
					{ ...osRecoverySettlementPort(), lease: controlLease, attemptId },
					osSettlementPersistence,
					deps.osAttemptIntentStore,
				);
		} finally {
			if (activeOsStage === token) {
				activeOsStage = undefined;
				osStageInProcess = false;
			}
		}
	}
}

// An automatic restage is preceded by a fresh signed check unless the offer
// was already re-admitted after the retry fell due.
function osRetryNeedsReadmission(): boolean {
	const retryAt = state.osStageRecovery?.nextRetryAt;
	if (retryAt === null || retryAt === undefined) return false;
	return (state.osCheck.lastSuccessAt ?? Number.NEGATIVE_INFINITY) < retryAt;
}

// Only exact pre-write admission markers invalidate an offer; typed OsStageError
// controls recovery. Other errors stay terminal; no staging error writes quarantine, which stays
// reserved for C1's activation-verification evidence.
function settleOsStageFailure(
	error: unknown,
	manifest: OsChannelManifest,
	attemptId: string,
): void {
	const now = deps.now();
	const admissionError =
		error instanceof OsAgentError
			? error
			: isOsStageError(error) &&
					error.reason === "rauc_install_failed" &&
					error.mode === "operator" &&
					error.cause instanceof OsAgentError
				? error.cause
				: undefined;
	if (
		admissionError &&
		[
			"manifest_changed_before_stage",
			"expired",
			"serial_replayed",
			"version_quarantined",
			"downgrade_or_same",
		].includes(admissionError.reason)
	) {
		dispatch({ type: "OS_STAGE_OFFER_INVALIDATED", now, attemptId });
		osCandidate = undefined;
		pendingCellularApproval = undefined;
		clearOsStageNotices(osStageNoticeId(osStageCandidateKey(manifest)));
		return;
	}
	if (!isOsStageError(error)) {
		const reason = error instanceof Error ? error.message : "rauc_stage_failed";
		dispatch({ type: "OS_STAGING_FAILED", now, reason });
		clearOsStageNotices(osStageNoticeId(osStageCandidateKey(manifest)));
		notifyUpdate({ kind: "refused", id: `os:${manifest.version}`, reason });
		return;
	}
	logger.warn("update-orchestrator: OS staging attempt settled", {
		attemptId,
		reason: error.reason,
		mode: error.mode,
		diagnostics: error.diagnostics,
		error: error.cause,
	});
	if (error.mode === "cancelled") {
		dispatch({ type: "OS_STAGING_ABORTED_FOR_STREAM", now });
		return;
	}
	dispatch({
		type: "OS_STAGING_FAILED",
		now,
		reason: error.reason,
		recovery: { attemptId, mode: error.mode },
	});
	replaceOsStageRecoveryNotice(state);
}

// A failed stage waiting for its retry or the operator must not stop the
// package path, so a due package check leaves the OS offer.
async function maybeCheckPackagesWhileOsWaits(): Promise<void> {
	if (state.phase !== "os-available" || !state.osStageRecovery) return;
	const settings = await deps.loadSettings();
	if (state.phase !== "os-available") return;
	if (
		!scheduledCheckDue({
			now: deps.now(),
			clock: state.packageCheck,
			kind: "packages",
			settings,
		})
	)
		return;
	await runPackageCheckAfterCellularGate(settings);
}

async function reconcileOsActivation(): Promise<void> {
	// OS_STAGED is published under the job lock; arming must wait for settlement.
	if (osStageInProcess) return;
	if (state.phase === "os-staged" && state.osStageRecovery?.activeAttemptId) {
		await settleInterruptedOsStage();
		return;
	}
	if (state.phase === "os-staged" && !(await updateAdmissionReady())) return;
	if (state.phase === "os-staged") {
		try {
			await deps.armOs(false);
			dispatch({ type: "OS_ACTIVATION_ARMED", now: deps.now() });
		} catch (error) {
			logger.warn("update-orchestrator: activation arming deferred", { error });
		}
	}
	if (state.phase !== "os-activation-armed") return;
	const receipt = await deps.readOsReceipt();
	if (!receipt) return;
	const bootId = await deps.readBootId();
	if (receipt.bootId !== bootId) {
		if (!(await rebootFollowedActivation(receipt, bootId))) return;
		dispatch({ type: "OS_REBOOT_OBSERVED", now: deps.now() });
		await verifyOsBoot();
		return;
	}
	if (
		!osForceActivated &&
		deps.now() - receipt.stagedAt >= OS_FORCE_ACTIVATION_MS &&
		!deps.isStreamLive()
	) {
		await deps.armOs(true);
		osForceActivated = true;
		notifyUpdate({
			kind: "os-activated",
			id: receipt.version,
			version: receipt.version,
		});
	}
}

// A new boot id alone does not mean the activation reboot happened: a crash,
// watchdog or power loss before the clean-shutdown hook ran `mark-active` boots
// the same slot again. Judging that boot against the staged version would
// quarantine a version that never booted and leave the arming in place.
async function rebootFollowedActivation(
	receipt: OsStageReceipt,
	bootId: string,
): Promise<boolean> {
	if ((await deps.readBootedVersion()) === receipt.version) return true;
	let activation: StagedActivation;
	try {
		activation = await deps.readStagedActivation();
	} catch (error) {
		logger.warn("update-orchestrator: activation state unreadable", {
			error,
		});
		return false;
	}
	switch (activation) {
		case "consumed":
			return true;
		case "pending":
			logger.warn(
				"update-orchestrator: rebooted before the staged slot was activated; still armed",
				{ version: receipt.version },
			);
			try {
				await deps.rebindOsReceipt(receipt, bootId);
			} catch (error) {
				logger.warn("update-orchestrator: staged receipt rebind deferred", {
					error,
				});
			}
			return false;
		case "unknown":
			logger.warn("update-orchestrator: activation state inconclusive");
			return false;
		default: {
			const unreachable: never = activation;
			return unreachable;
		}
	}
}

async function verifyOsBoot(): Promise<void> {
	if (state.phase !== "os-verifying") return;
	const receipt = await deps.readOsReceipt();
	if (!receipt) return;
	const booted = await deps.readBootedVersion();
	if (!booted) return; // no evidence to declare a rollback
	if (booted !== receipt.version) {
		await deps.quarantine.recordOsRollback(receipt.version, booted);
		dispatch({
			type: "OS_ROLLBACK_DETECTED",
			now: deps.now(),
			reason: "os_version_mismatch",
		});
		notifyUpdate({
			kind: "os-rollback",
			id: receipt.version,
			version: receipt.version,
		});
		return;
	}
	// Booting the staged version proves only that the bootloader tried the new
	// slot. A slot that fails its healthcheck boots again until its counter runs
	// out and the old slot comes back, so stay here until this boot's verdict is
	// in; the fallback boot then reaches the rollback branch above.
	if (!(await thisBootPassedHealthcheck())) return;
	dispatch({ type: "OS_VERIFIED", now: deps.now() });
	notifyUpdate({
		kind: "os-activated",
		id: receipt.version,
		version: receipt.version,
	});
}

// The healthcheck writes its record with the boot id only after a passing check
// and `mark-good`; a record from any earlier boot says nothing about this one.
async function thisBootPassedHealthcheck(): Promise<boolean> {
	try {
		const [healthy, bootId] = await Promise.all([
			deps.readHealthyState(),
			deps.readBootId(),
		]);
		return healthy !== null && healthy.boot_id === bootId;
	} catch (error) {
		logger.warn(
			"update-orchestrator: boot health unreadable, OS verification deferred",
			{ error },
		);
		return false;
	}
}

// ─── OS staging recovery after a restart or a manual check ─────────────────

// An attempt the backend did not survive is observed, never replayed. Once
// RAUC is idle nothing proves the outcome either way, so it settles unsafe.
// An unreadable probe throws and the tick retries it later.
async function settleInterruptedOsStage(): Promise<void> {
	const generation = stateGeneration;
	const phase = state.phase;
	const record = state.osStageRecovery;
	const attemptId = record?.activeAttemptId;
	if (await maybeSettleOsUnlaunchedWitness()) return;
	if (stateGeneration !== generation) return;
	await using settlement = await beginOsRecoverySettlement(
		osRecoverySettlementPort(),
	);
	const operation = await deps.inspectOsOperation();
	if (operation !== "idle") return;
	if (!(await deps.proveOsWriterQuiescent(settlement.lease))) return;
	if (!(await settlement.matches())) return;
	if (
		stateGeneration !== generation ||
		state.phase !== phase ||
		osStageInProcess ||
		state.osStageRecovery !== record ||
		state.osStageRecovery?.activeAttemptId !== attemptId
	)
		return;
	dispatchOsSettlement({
		type: "OS_STAGING_FAILED",
		now: deps.now(),
		reason: "os_stage_outcome_unknown_after_restart",
		...(attemptId ? { recovery: { attemptId, mode: "unsafe" as const } } : {}),
	});
	if (record && attemptId) replaceOsStageRecoveryNotice(state);
}

async function readOsStageSettlementEvidence(
	lease?: OsStageControlLease,
): Promise<OsStageSettlementEvidence | undefined> {
	return readRuntimeOsSettlementEvidence(deps, lease);
}

// The receipt of an already-running version blocks every settlement proof.
async function maybeRetireConsumedOsReceipt(): Promise<void> {
	if (!recoveryPersistenceValid) return;
	try {
		await retireConsumedStagedReceipt({
			snapshot: () => ({
				state,
				phase: state.phase,
				activeAttemptId: state.osStageRecovery?.activeAttemptId ?? null,
				generation: stateGeneration,
				producing: osStageInProcess || activeOsStage !== undefined,
			}),
			acquireControl: acquireRuntimeOsStageControl,
			readPersisted: deps.readPersistedState ?? loadOrchestratorState,
			readBootedImage:
				deps.readBootedImage ?? (() => readInstalledImage("booted")),
			readReceipt: deps.readOsReceipt,
			acknowledge: deps.acknowledgeOsReceipt ?? acknowledgeRetiredReceipt,
			acknowledgementPending: deps.isReceiptAckPending ?? retiredReceiptPresent,
			readBootedVersion: () => deps.readBootedVersion(),
			readBootId: () => deps.readBootId(),
			readHealthyBootId: async () =>
				(await deps.readHealthyState())?.boot_id ?? null,
			readActivationArmed: deps.readActivationArmed,
			inspectOperation: deps.inspectOsOperation,
			retire: (receipt) =>
				(deps.retireOsReceipt ?? retireStagedReceipt)(receipt),
		});
	} catch (error) {
		if (!consumedReceiptWarned) {
			if (error instanceof ReceiptRetirementDurabilityError)
				logger.warn(
					"update-orchestrator: staged receipt retirement durability pending",
					{ renamed: error.renamed },
				);
			else
				logger.warn("update-orchestrator: consumed staged receipt kept", {
					error,
				});
		}
		consumedReceiptWarned = true;
	}
}

async function maybeSettleOsUnlaunchedWitness(): Promise<boolean> {
	if (
		!recoveryPersistenceValid ||
		osStageInProcess ||
		osSettlementPersistence.replayPending
	)
		return false;
	const restoredIntent = await recoverOsAttemptLifecycle(
		{
			...osRecoverySettlementPort(),
			...(deps.osAttemptIntentStore
				? { store: deps.osAttemptIntentStore }
				: {}),
			readJob: deps.readOsStageJob ?? readOsStageJob,
			readWitness: deps.readOsUnlaunchedWitness ?? readOsUnlaunchedWitness,
			...(deps.osStageStartupDeps?.run
				? { run: deps.osStageStartupDeps.run }
				: {}),
			readEvidence: readOsStageSettlementEvidence,
			adopt: adoptState,
		},
		osSettlementPersistence,
	);
	if (
		restoredIntent ||
		osSettlementPersistence.intentCleanup.pending ||
		publishingIntentPending(deps.osAttemptIntentStore)
	)
		return true;
	return settleOsUnlaunchedWitness({
		snapshot: () => ({
			state,
			generation: stateGeneration,
			candidate: osCandidate,
			producer: activeOsStage,
		}),
		readWitness: deps.readOsUnlaunchedWitness ?? readOsUnlaunchedWitness,
		readEvidence: readOsStageSettlementEvidence,
		acquireControl: acquireRuntimeOsStageControl,
		readPersisted: deps.readPersistedState ?? loadOrchestratorState,
		dispatch: (event) => {
			const settled = dispatch(event);
			replaceOsStageRecoveryNotice(settled);
			return settled;
		},
		persist: deps.persist,
		persistSettlement: (write) => osSettlementPersistence.persist(write),
		consume: deps.consumeOsUnlaunchedWitness ?? consumeOsUnlaunchedWitness,
		now: deps.now,
	});
}

// Only the exact pre-metadata RAUC failure, and only once the device proves
// the failed stage left nothing behind. It returns through fresh discovery,
// delayed like a first automatic retry.
async function maybeMigrateLegacyOsFailure(): Promise<void> {
	if (
		!recoveryPersistenceValid ||
		state.phase !== "failed" ||
		state.failureReason !== "rauc_install_failed" ||
		state.osStageRecovery
	)
		return;
	await using settlement = await beginOsRecoverySettlement(
		osRecoverySettlementPort(),
	);
	const generation = stateGeneration;
	const evidence = await readOsStageSettlementEvidence(settlement.lease);
	if (stateGeneration !== generation) return;
	if (!evidence || !osStageFailureSettledSafely(evidence)) {
		if (!legacyOsFailureWarned)
			logger.warn(
				"update-orchestrator: earlier OS staging failure not proven settled; staying failed",
			);
		legacyOsFailureWarned = true;
		return;
	}
	if (!(await settlement.matches())) return;
	const now = deps.now();
	dispatchOsSettlement({
		type: "OS_STAGE_LEGACY_FAILURE_MIGRATED",
		now,
		retryAt: now + OS_STAGE_FIRST_RETRY_DELAY_MS,
	});
}

async function maybeConfirmOsStageRecovery(): Promise<void> {
	const record = state.osStageRecovery;
	if (
		state.phase !== "failed" ||
		record?.mode !== "unsafe" ||
		record.activeAttemptId !== null ||
		!OS_STAGE_CONFIRMABLE_UNSAFE_REASONS.some(
			(reason) => reason === record.reason,
		) ||
		state.failureReason !== record.reason
	)
		return;
	await using settlement = await beginOsRecoverySettlement(
		osRecoverySettlementPort(),
	);
	const generation = stateGeneration;
	const evidence = await readOsStageSettlementEvidence(settlement.lease);
	if (
		stateGeneration !== generation ||
		!evidence ||
		!osStageFailureSettledSafely(evidence)
	)
		return;
	if (!(await settlement.matches())) return;
	const beforeConfirmation = state;
	dispatchOsSettlement({
		type: "OS_STAGE_RECOVERY_CONFIRMED",
		now: deps.now(),
		candidateKey: record.candidateKey,
	});
	if (state !== beforeConfirmation)
		clearOsStageNotices(osStageNoticeId(record.candidateKey));
}

// ─── interrupted download (resume, then deferred re-adjudication) ──────────

function resumeDeps(): OrchestratorResumeDeps {
	return {
		recoverSoftwareUpdateIfRunning: deps.recoverSoftwareUpdateIfRunning,
		lastInstallUnitVerdict: deps.lastInstallUnitVerdict,
		getUpdateState: deps.getPackageInstallWireState,
		now: deps.now,
	};
}

// Applies a resume decision taken for the state at `generation`. Nothing here
// awaits, so the generation check and the state change are one synchronous
// step: a stream abort or a replacement install that ran while the probe was
// awaited makes the stale decision a no-op. There is deliberately no pending-
// plan cleanup here. A dropped download goes idle with the package check due
// now; the stale record has no reader before the next install start, which
// normally comes through discovery, and a start from an `available` wire
// rewrites `pending-packages.json` before its unit exists. Discovery does not
// keep the wire `available` until launch (a reset, or a restart while
// `awaiting-idle`): an accepted start from a non-`available` wire keeps the
// record on disk, as at a6b8210c, and its readers then see the earlier plan.
function applyDownloadDecision(
	decision: DownloadResumeDecision,
	generation: number,
	persistNow: boolean,
): void {
	if (stateGeneration !== generation) return;
	switch (decision.kind) {
		case "unit-observed":
			deferredDownloadGeneration = null;
			return;
		case "undecided":
			if (deferredDownloadGeneration !== generation)
				logger.warn(
					"update-orchestrator: cannot tell whether the interrupted download's install unit survived; re-checking each tick",
					{ cause: decision.cause, error: decision.error },
				);
			deferredDownloadGeneration = generation;
			return;
		case "unit-absent":
			logger.warn(
				"update-orchestrator: interrupted download has no install unit; dropping the attempt and re-checking for updates",
				{ enteredAt: state.enteredAt },
			);
			if (persistNow)
				dispatch({ type: "DOWNLOAD_RESUME_UNIT_ABSENT", now: deps.now() });
			else adoptState(decision.state);
			deferredDownloadGeneration = null;
			return;
		default: {
			const unreachable: never = decision;
			throw new Error(`unhandled resume decision: ${String(unreachable)}`);
		}
	}
}

async function readjudicateDeferredDownload(): Promise<void> {
	const deferred = deferredDownloadGeneration;
	if (deferred === null) return;
	if (state.phase !== "downloading" || stateGeneration !== deferred) {
		deferredDownloadGeneration = null;
		return;
	}
	const decision = await adjudicateInterruptedDownload(state, resumeDeps());
	applyDownloadDecision(decision, deferred, true);
}

// ─── settle/sync acknowledgement ───────────────────────────────────────────

function acknowledgeTerminalRestPhases(): void {
	const now = deps.now();
	if (state.phase === "settled") dispatch({ type: "SETTLE_ACKNOWLEDGED", now });
	if (state.phase === "synced") dispatch({ type: "SYNC_SETTLED", now });
}

// ─── the scheduler tick ─────────────────────────────────────────────────────

export async function runOrchestratorTick(): Promise<void> {
	if (pendingPackageSuccess.pending) {
		await replayPendingOsSettlement();
		await maybeSettleOsUnlaunchedWitness();
		await pendingPackageSuccess.retry();
		scheduleNextTick();
		return;
	}
	if (
		osSettlementPersistence.replayPending &&
		(await replayPendingOsSettlement())
	) {
		await maybeSettleOsUnlaunchedWitness();
		scheduleNextTick();
		return;
	}
	if (!(await updateAdmissionReady())) {
		scheduleNextTick();
		return;
	}
	if (pendingPackageSuccess.pending) {
		scheduleNextTick();
		return;
	}
	await maybeRetireConsumedOsReceipt();
	if (await maybeSettleOsUnlaunchedWitness()) {
		scheduleNextTick();
		return;
	}
	if (osSettlementPersistence.pending) {
		scheduleNextTick();
		return;
	}
	acknowledgeTerminalRestPhases();

	if (state.phase === "idle") {
		await maybeFindSlotSyncCandidate();
		if (getOrchestratorState().phase === "sync-eligible") {
			await maybeStartSlotSync();
			scheduleNextTick();
			return;
		}
		const settings = await deps.loadSettings();
		const capabilities = await deps.loadCapabilities();
		const now = deps.now();
		const retryAt =
			state.osStageRecovery?.mode === "automatic"
				? state.osStageRecovery.nextRetryAt
				: null;
		const osClock =
			retryAt !== null &&
			retryAt !== undefined &&
			state.osCheck.consecutiveFailures === 0
				? {
						...state.osCheck,
						nextAttemptAt: Math.min(
							state.osCheck.nextAttemptAt ?? retryAt,
							retryAt,
						),
					}
				: state.osCheck;
		if (
			shouldAttemptScheduledCheck({
				now,
				phase: state.phase,
				clock: state.packageCheck,
				kind: "packages",
				settings,
			})
		) {
			await runPackageCheckAfterCellularGate(settings);
		} else if (
			capabilities.mode === "capable" &&
			capabilities.features.includes("rauc-verity-streaming") &&
			shouldAttemptScheduledCheck({
				now,
				phase: state.phase,
				clock: osClock,
				kind: "os",
				settings,
			})
		) {
			await runOsCheckAfterCellularGate(settings);
		}
	} else if (state.phase === "available") {
		const settings = await deps.loadSettings();
		if (settings.packagesAuto) {
			dispatch({ type: "AWAIT_IDLE_FOR_INSTALL", now: deps.now() });
		}
	} else if (state.phase === "awaiting-idle") {
		await maybeStartPackageInstall({ bypassIdle: false });
	} else if (state.phase === "downloading" || state.phase === "committing") {
		await readjudicateDeferredDownload();
		pendingPackageSuccess.assertEffectsAllowed();
		await pollPackageInstallProgress();
	} else if (state.phase === "restarting-services") {
		const settings = await deps.loadSettings();
		pendingPackageSuccess.assertEffectsAllowed();
		const done = await deps.restartStale(
			() => deps.isIdle(settings.schedule),
			() =>
				["downloading", "installing"].includes(
					deps.getPackageInstallWireState().kind,
				),
		);
		pendingPackageSuccess.assertEffectsAllowed();
		if (done) {
			const pending = await deps.quarantine.readPending();
			notifyUpdate({
				kind: "installed",
				id: String(state.enteredAt),
				packages: pending.map((item) => item.name),
			});
			await deps.quarantine.clearPending();
			dispatch({ type: "SERVICES_RESTARTED", now: deps.now() });
		}
	} else if (state.phase === "os-available") {
		await maybeStartOsStage(false);
		await maybeCheckPackagesWhileOsWaits();
	} else if (state.phase === "os-staging" && !osStageInProcess) {
		await settleInterruptedOsStage();
	} else if (state.phase === "failed") {
		await maybeMigrateLegacyOsFailure();
	} else if (
		state.phase === "os-staged" ||
		state.phase === "os-activation-armed"
	) {
		await reconcileOsActivation();
		if (getOrchestratorState().phase === "sync-eligible")
			await maybeStartSlotSync();
	} else if (state.phase === "os-verifying") {
		await verifyOsBoot();
		if (getOrchestratorState().phase === "sync-eligible")
			await maybeStartSlotSync();
	} else if (state.phase === "sync-eligible") {
		await maybeStartSlotSync();
	} else if (state.phase === "syncing") {
		await pollSlotSync();
	}

	scheduleNextTick();
}

async function runPackageCheckAfterCellularGate(
	settings: UpdateSettings,
): Promise<void> {
	const onlyMetered = await deps.onlyMeteredCandidateExists();
	if (osSettlementPersistence.pending) return;
	const gate = decideCellularGate({
		onlyMeteredCandidateExists: onlyMetered,
		kind: "packages",
		stage: "check",
		allowPackagesOverCellular: settings.allowPackagesOverCellular,
		allowSystemOverCellular: settings.allowSystemOverCellular,
		cellularOverrideId: state.cellularOverrideId,
		candidateId: "",
	});
	if (!gate.allowed) return; // retried next tick once due again; not a failure
	await runPackageCheckCycle();
}

async function runOsCheckAfterCellularGate(
	settings: UpdateSettings,
): Promise<void> {
	const onlyMetered = await deps.onlyMeteredCandidateExists();
	if (osSettlementPersistence.pending) return;
	const gate = decideCellularGate({
		onlyMeteredCandidateExists: onlyMetered,
		kind: "os",
		stage: "check",
		allowPackagesOverCellular: settings.allowPackagesOverCellular,
		allowSystemOverCellular: settings.allowSystemOverCellular,
		cellularOverrideId: state.cellularOverrideId,
		candidateId: "",
	});
	if (!gate.allowed) return;
	const now = deps.now();
	dispatch({ type: "OS_CHECK_STARTED", now });
	const result = await deps.checkOsManifest(settings.channel);
	const outcomeNow = deps.now();
	if (result.failed) {
		notifyUpdate({
			kind: "refused",
			id: `os-check:${result.reason}`,
			reason: result.reason,
		});
		const consecutiveFailuresAfter = state.osCheck.consecutiveFailures + 1;
		const nextAttemptAt =
			outcomeNow +
			computeNextCheckDelayMs({
				outcome: "failure",
				consecutiveFailuresAfter,
				rateLimited: result.rateLimited,
				kind: "os",
				randomUnit: deps.random(),
			});
		dispatch({
			type: "CHECK_FAILED",
			now: outcomeNow,
			kind: "os",
			rateLimited: result.rateLimited,
			reason: result.reason,
			nextAttemptAt,
		});
		return;
	}
	const nextAttemptAt =
		outcomeNow +
		computeNextCheckDelayMs({
			outcome: "success",
			consecutiveFailuresAfter: 0,
			rateLimited: false,
			kind: "os",
			randomUnit: deps.random(),
		});
	osCandidate = result.available ? result.manifest : undefined;
	if (result.manifest)
		notifyUpdate({
			kind: "updates-available",
			id: `os:${result.manifest.version}`,
		});
	const previousRecovery = state.osStageRecovery;
	dispatch(
		result.available
			? {
					type: "CHECK_SUCCEEDED_OS",
					now: outcomeNow,
					nextAttemptAt,
					...(osCandidate
						? { candidateKey: osStageCandidateKey(osCandidate) }
						: {}),
				}
			: {
					type: "CHECK_SUCCEEDED_NONE",
					now: outcomeNow,
					kind: "os",
					nextAttemptAt,
				},
	);
	if (previousRecovery && !state.osStageRecovery)
		clearOsStageNotices(osStageNoticeId(previousRecovery.candidateKey));
}

function isActivePhase(phase: OrchestratorState["phase"]): boolean {
	return (
		phase === "downloading" ||
		phase === "committing" ||
		phase === "restarting-services" ||
		phase === "os-staging" ||
		phase === "syncing"
	);
}

function scheduleNextTick(): void {
	if (!started) return;
	if (tickTimer) clearTimeout(tickTimer);
	const delay = isActivePhase(state.phase) ? ACTIVE_TICK_MS : IDLE_TICK_MS;
	tickTimer = setTimeout(() => {
		void runOrchestratorTick().catch((error) => {
			logger.warn("update-orchestrator: tick failed", { error });
			scheduleNextTick();
		});
	}, delay);
	tickTimer.unref?.();
}

// ─── boot ───────────────────────────────────────────────────────────────────

export function startUpdateOrchestrator(
	runtimeDeps: OrchestratorRuntimeDeps = defaultOrchestratorRuntimeDeps,
): Promise<void> {
	if (started) return Promise.resolve();
	return startupFlight.run(async () => {
		await awaitUpdatePhysicalReconciliation();
		await startupCadence.start(
			() => startOrchestratorRuntime(runtimeDeps),
			runtimeDeps.startupRetryClock,
		);
	});
}

/** A refusal settles the boot chain but never authorizes standalone APT cleanup. */
export async function awaitUpdateStartupAdjudication(): Promise<boolean> {
	return (
		(await startupCadence.waitForAdjudication()) && recoveryPersistenceValid
	);
}

async function startOrchestratorRuntime(
	runtimeDeps: OrchestratorRuntimeDeps,
): Promise<void> {
	startupReadiness.setReady(false);
	deps = fencePackageSuccessEffects(runtimeDeps);
	await replayPendingOsSettlement();
	const now = deps.now();
	let persisted: OrchestratorState | null;
	try {
		persisted = await loadOrchestratorState();
		recoveryPersistenceValid = true;
	} catch (error) {
		if (!(error instanceof OrchestratorRecoveryLoadError)) throw error;
		recoveryPersistenceValid = false;
		adoptState(error.terminalState);
		started = true;
		scheduleNextTick();
		return;
	}
	const baseline = persisted ?? initialOrchestratorState(now);
	pendingPackageSuccess.configure(
		osRecoverySettlementPort(),
		(success) => {
			adoptState(success);
			publishWireState();
		},
		deps.now,
	);
	if (baseline.phase === "committing" || baseline.phase === "downloading") {
		pendingPackageSuccess.trackStartup(baseline);
		reserveRecoveredUpdateExit(async (signal) => {
			if (!(await awaitUpdateStartupAdjudication())) return false;
			if (signal.aborted) return false;
			return persistRecoveredCommitSuccess(
				{ ...osRecoverySettlementPort(), signal },
				(success) => {
					adoptState(success);
					publishWireState();
				},
				deps.now(),
			).catch((error: unknown) => {
				if (signal.aborted) return false;
				throw error;
			});
		});
	}
	if (baseline.phase === "downloading") {
		// Visible to D8 while the probe awaits, so a stream start meanwhile
		// still reaches the commit-stage probe; its abort then wins.
		adoptState(baseline);
		const generation = stateGeneration;
		applyDownloadDecision(
			await adjudicateInterruptedDownload(baseline, resumeDeps()),
			generation,
			false,
		);
	} else {
		adoptState(await resumeOrchestratorState(baseline, resumeDeps()));
	}
	adoptState(normalizeStartupDiscovery(state, deps.now()));
	await maybeRetireConsumedOsReceipt();
	await maybeSettleOsUnlaunchedWitness();
	osSettlementPersistence.intentCleanup.assertAcknowledged();
	if (state.phase === "os-activation-armed" || state.phase === "os-verifying")
		await reconcileOsActivation();
	if (state.phase === "os-verifying") await verifyOsBoot();
	if (state.phase === "failed") await maybeMigrateLegacyOsFailure();
	if (state.phase === "idle") await maybeFindSlotSyncCandidate();
	if (state.phase === "sync-eligible") await maybeStartSlotSync();
	if (state.phase === "quarantined" && baseline.phase === "committing") {
		const pending = await deps.quarantine.readPending();
		await deps.quarantine.recordPackageFailure(
			pending.flatMap((item) =>
				item.version ? [{ name: item.name, version: item.version }] : [],
			),
			String(baseline.enteredAt),
			state.failureReason ?? "apt-exit-nonzero",
		);
		await deps.quarantine.clearPending();
	}
	await saveAuthoritativeStartupState(osRecoverySettlementPort(), persisted);
	pendingPackageSuccess.acknowledge(state);
	pendingPackageSuccess.trackStartup(undefined);
	started = true;
	startupReadiness.setReady(true);
	hydrateOsStageRecoveryNotice(state);
	scheduleNextTick();
}
