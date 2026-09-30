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

import type {
	UpdateCapabilities,
	UpdateOrchestratorWireState,
	UpdateSettings,
	UpdateState,
} from "@ceraui/rpc/schemas";
import { logger } from "../../../helpers/logger.ts";
import { shouldUseMocks } from "../../../mocks/mock-service.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import { cleanAptCache } from "../apt-cache-clean.ts";
import { isRealDevice } from "../device-detection.ts";
import { getIdleStatus } from "../idle-activity.ts";
import {
	getUpdateState,
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
import { notifyUpdate } from "./notifications.ts";
import {
	armOsActivation,
	checkOsChannel,
	inspectOsOperation,
	type OsStageReceipt,
	readBootId,
	readStagedReceipt,
	rebindStagedReceipt,
	stageOsBundle,
} from "./os-agent.ts";
import type { OsChannelManifest } from "./os-manifest.ts";
import { readBootedOsReleaseVersion } from "./os-manifest.ts";
import { loadOrchestratorState, saveOrchestratorState } from "./persistence.ts";
import { UpdateQuarantine } from "./quarantine.ts";
import { reduceOrchestrator } from "./reducer.ts";
import { resumeOrchestratorState } from "./resume.ts";
import {
	canStartManualCheck,
	canStartManualInstall,
	computeNextCheckDelayMs,
	decideCellularGate,
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
	slotSyncGate,
} from "./slot-sync-gate.ts";
import { readSlotSyncEvidence } from "./slot-sync-state.ts";
import {
	defaultStaleServiceDeps,
	reconcileStaleUnits,
} from "./stale-services.ts";
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

export interface OrchestratorRuntimeDeps {
	readonly now: () => number;
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
	) => Promise<void>;
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
	readonly readRootSlots: () => Promise<readonly RootSlotStatus[]>;
	readonly cleanSlotSyncArchives: () => Promise<boolean>;
	readonly removeRaucDownloads: () => Promise<void>;
	readonly dropSupersededQuarantine: (
		quarantine: UpdateQuarantine,
	) => Promise<void>;
	readonly refreshSlots: () => Promise<unknown>;
	readonly recoverSoftwareUpdateIfRunning: () => Promise<boolean>;
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
	stageOs: async (manifest, onProgress) => {
		await stageOsBundle(manifest, onProgress);
	},
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
	readRootSlots,
	cleanSlotSyncArchives: cleanAptCache,
	removeRaucDownloads,
	dropSupersededQuarantine,
	refreshSlots: readBothSlotStatus,
	recoverSoftwareUpdateIfRunning,
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
let osCandidate: OsChannelManifest | undefined;
let osStageInProcess = false;
let raucStreamAbortInProcess = false;
let packageInstallStarting = false;
let osForceActivated = false;
let slotSyncUndecidedReason: string | null = null;
let pendingCellularApproval:
	| { readonly id: string; readonly sizeBytes: number }
	| undefined;

const IDLE_TICK_MS = 60_000;
const ACTIVE_TICK_MS = 3_000;

export function setOrchestratorRuntimeDepsForTest(
	overrides: Partial<OrchestratorRuntimeDeps> | null,
): void {
	deps = overrides
		? { ...defaultOrchestratorRuntimeDeps, ...overrides }
		: defaultOrchestratorRuntimeDeps;
}

export function resetOrchestratorRuntimeForTest(): void {
	if (tickTimer) clearTimeout(tickTimer);
	tickTimer = undefined;
	started = false;
	state = initialOrchestratorState(Date.now());
	deps = defaultOrchestratorRuntimeDeps;
	osCandidate = undefined;
	osStageInProcess = false;
	raucStreamAbortInProcess = false;
	packageInstallStarting = false;
	osForceActivated = false;
	slotSyncUndecidedReason = null;
	pendingCellularApproval = undefined;
}

export function getOrchestratorState(): OrchestratorState {
	return state;
}

export function setOrchestratorStateForTest(next: OrchestratorState): void {
	state = next;
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

function dispatch(event: OrchestratorEvent): OrchestratorState {
	const next = reduceOrchestrator(state, event);
	if (next !== state) {
		state = next;
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

export async function checkUpdatesNow(): Promise<ManualCheckOutcome> {
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
		await deps.stopPackageInstallUnit();
		dispatch({ type: "DOWNLOAD_ABORTED_FOR_STREAM", now: deps.now() });
		return { allowed: true };
	}

	if (state.phase === "os-staging") {
		// RAUC targets the inactive slot, unlike apt's live-root transaction.
		// Leave os-staging BEFORE the kill: the SIGTERM fails the in-flight
		// install at once, and its catch must see the abort, not a failure.
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

function progressFromWire(progress: {
	readonly total: number;
	readonly downloading: number;
	readonly unpacking: number;
	readonly setting_up: number;
}): { readonly percent: number; readonly etaSeconds: number } {
	const { total, downloading, unpacking, setting_up: settingUp } = progress;
	const percent =
		total > 0
			? Math.min(
					100,
					Math.round(
						((downloading + unpacking + settingUp) / (3 * total)) * 100,
					),
				)
			: 0;
	return { percent, etaSeconds: 0 };
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

async function maybeFindSlotSyncCandidate(): Promise<void> {
	if (state.phase !== "idle") return;
	try {
		const gate = await checkSlotSyncGate();
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
 * Requires=/After= ceralive-healthcheck.service, whose own budget is
 * HEALTHCHECK_TIMEOUT=60 s plus 5 s probe timeouts; until that finishes the
 * --no-block job has not started and the unit reads the previous run's shape.
 * 90 s is that budget with margin, 30 polls at ACTIVE_TICK_MS.
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
		case "absent":
			dispatch({ type: "SYNC_FAILED", now, reason: "slot-sync-unit-absent" });
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
		state.phase !== "os-available" ||
		deps.isStreamLive() ||
		osStageInProcess ||
		raucStreamAbortInProcess
	);
}

async function maybeStartOsStage(bypassIdle: boolean): Promise<void> {
	if (osStageBlocked()) return;
	if (!osCandidate) {
		await runOsCheckAfterCellularGate(await deps.loadSettings());
		if (state.phase !== "os-available" || !osCandidate) return;
	}
	const candidate = osCandidate;
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
	const gate = decideCellularGate({
		onlyMeteredCandidateExists: await deps.onlyMeteredCandidateExists(),
		kind: "os",
		stage: "install",
		allowPackagesOverCellular: settings.allowPackagesOverCellular,
		allowSystemOverCellular: settings.allowSystemOverCellular,
		cellularOverrideId: state.cellularOverrideId,
		candidateId: candidate.version,
	});
	// Every await above can let a manual install, a stream abort or a new
	// check run; the entry fences are only true again if re-read here, and
	// nothing may await between this re-read and taking the stage.
	if (osStageBlocked() || osCandidate !== candidate) return;
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
	dispatch({ type: "OS_STAGING_STARTED", now: deps.now() });
	osStageInProcess = true;
	scheduleNextTick();
	try {
		await deps.stageOs(manifest, (percent) => {
			if (state.phase === "os-staging")
				dispatch({
					type: "OS_STAGING_PROGRESS",
					now: deps.now(),
					progress: { percent, etaSeconds: 0 },
				});
		});
		if (getOrchestratorState().phase !== "os-staging") return; // D8 stream admission aborted RAUC meanwhile
		dispatch({ type: "OS_STAGED", now: deps.now() });
		osCandidate = undefined;
		notifyUpdate({
			kind: "os-staged",
			id: manifest.version,
			version: manifest.version,
		});
	} catch (error) {
		if (getOrchestratorState().phase !== "os-staging") return;
		const reason = error instanceof Error ? error.message : "rauc_stage_failed";
		dispatch({ type: "OS_STAGING_FAILED", now: deps.now(), reason });
		notifyUpdate({ kind: "refused", id: `os:${manifest.version}`, reason });
	} finally {
		osStageInProcess = false;
	}
}

async function reconcileOsActivation(): Promise<void> {
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
	if (booted === receipt.version) {
		dispatch({ type: "OS_VERIFIED", now: deps.now() });
		notifyUpdate({
			kind: "os-activated",
			id: receipt.version,
			version: receipt.version,
		});
	} else {
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
	}
}

// ─── settle/sync acknowledgement ───────────────────────────────────────────

function acknowledgeTerminalRestPhases(): void {
	const now = deps.now();
	if (state.phase === "settled") dispatch({ type: "SETTLE_ACKNOWLEDGED", now });
	if (state.phase === "synced") dispatch({ type: "SYNC_SETTLED", now });
}

// ─── the scheduler tick ─────────────────────────────────────────────────────

export async function runOrchestratorTick(): Promise<void> {
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
				clock: state.osCheck,
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
		await pollPackageInstallProgress();
	} else if (state.phase === "restarting-services") {
		const settings = await deps.loadSettings();
		const done = await deps.restartStale(
			() => deps.isIdle(settings.schedule),
			() =>
				["downloading", "installing"].includes(
					deps.getPackageInstallWireState().kind,
				),
		);
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
	} else if (state.phase === "os-staging" && !osStageInProcess) {
		if ((await deps.inspectOsOperation()) === "idle")
			dispatch({
				type: "OS_STAGING_FAILED",
				now: deps.now(),
				reason: "os_stage_outcome_unknown_after_restart",
			});
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
	dispatch(
		result.available
			? { type: "CHECK_SUCCEEDED_OS", now: outcomeNow, nextAttemptAt }
			: {
					type: "CHECK_SUCCEEDED_NONE",
					now: outcomeNow,
					kind: "os",
					nextAttemptAt,
				},
	);
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

export async function startUpdateOrchestrator(
	runtimeDeps: OrchestratorRuntimeDeps = defaultOrchestratorRuntimeDeps,
): Promise<void> {
	deps = runtimeDeps;
	const now = deps.now();
	const persisted = await loadOrchestratorState();
	const baseline = persisted ?? initialOrchestratorState(now);
	state = await resumeOrchestratorState(baseline, {
		recoverSoftwareUpdateIfRunning: deps.recoverSoftwareUpdateIfRunning,
		getUpdateState: deps.getPackageInstallWireState,
		now: deps.now,
	});
	if (state.phase === "os-activation-armed" || state.phase === "os-verifying")
		await reconcileOsActivation();
	if (state.phase === "os-verifying") await verifyOsBoot();
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
	deps.persist(state);
	started = true;
	scheduleNextTick();
}
