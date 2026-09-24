/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The orchestrator's effects layer (Todo 36): the ONLY place in this feature
 * that performs I/O. Owns the in-memory singleton state, persistence, the
 * scheduler tick, and every privileged action the pure reducer/schedule
 * modules only ever *describe*.
 *
 * D7/D12/idle gating, the schedule cadence and the D8 admission matrix are
 * NOT re-implemented here — this module calls the pure functions in
 * `schedule.ts`/`admission.ts` with real, observed inputs and dispatches
 * whatever event they imply. The one exception, unavoidably, is I/O sequencing
 * (what to call, in what order, on a failure) — a property tests in this file
 * cover with an injected fake `OrchestratorRuntimeDeps`, never the real OS.
 */

import type {
	UpdateCapabilities,
	UpdateOrchestratorWireState,
	UpdateSettings,
	UpdateState,
} from "@ceraui/rpc/schemas";
import { logger } from "../../../helpers/logger.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { isRealDevice } from "../device-detection.ts";
import { getIdleStatus } from "../idle-activity.ts";
import {
	getAvailableUpdates,
	getUpdateState,
	recoverSoftwareUpdateIfRunning,
	runUpdateDiscoveryAndReport,
	type SoftwareUpdateError,
	startSoftwareUpdate,
} from "../software-updates.ts";
import { readUpdateCapabilities } from "../update-capabilities.ts";
import { loadUpdateSettings } from "../update-settings.ts";
import { discoverCandidates } from "../update-transport/core.ts";
import { defaultUpdateTransportDeps } from "../update-transport/executor.ts";
import { admitStreamStart, onStreamStart } from "./admission.ts";
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
	readBootId,
	readStagedReceipt,
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
	readonly getAvailablePackageCount: () => number;
	readonly startPackageInstall: () => { started: boolean };
	readonly getPackageInstallWireState: () => UpdateState;
	/**
	 * D8 abort-network I/O (Todo 37): stop the in-flight detached apt unit /
	 * kill+restart RAUC. Both are separate deps (not folded into one) so a test
	 * can assert exactly which one fired, or neither.
	 */
	readonly stopPackageInstallUnit: () => Promise<void>;
	readonly killAndRestartRaucForStream: () => Promise<void>;
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
	readonly readBootId: typeof readBootId;
	readonly readBootedVersion: typeof readBootedOsReleaseVersion;
	readonly inspectOsOperation: typeof inspectOsOperation;
	readonly startSlotSync: () => Promise<void>;
	readonly inspectSlotSync: () => Promise<SlotSyncProbeState>;
	readonly resetSlotSyncFailure: () => Promise<void>;
	readonly recoverSoftwareUpdateIfRunning: () => Promise<boolean>;
	readonly persist: (state: OrchestratorState) => void;
	readonly quarantine: UpdateQuarantine;
	readonly restartStale: (
		isIdle: () => Promise<boolean>,
		transactionRunning: () => boolean,
	) => Promise<boolean>;
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
	getAvailablePackageCount: () => {
		const available = getAvailableUpdates();
		return available ? available.package_count : 0;
	},
	startPackageInstall: () => {
		const outcome = startSoftwareUpdate();
		return { started: outcome.started };
	},
	getPackageInstallWireState: getUpdateState,
	stopPackageInstallUnit: stopPackageInstallUnitForStream,
	killAndRestartRaucForStream,
	checkOsManifest: async (channel) => {
		try {
			const manifest = await checkOsChannel(
				channel ?? (await loadUpdateSettings()).channel,
				new UpdateQuarantine(),
			);
			return {
				available: true,
				rateLimited: false,
				failed: false,
				reason: "",
				manifest,
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
	},
	stageOs: async (manifest, onProgress) => {
		await stageOsBundle(manifest, onProgress);
	},
	armOs: armOsActivation,
	readOsReceipt: readStagedReceipt,
	readBootId,
	readBootedVersion: readBootedOsReleaseVersion,
	inspectOsOperation,
	startSlotSync,
	inspectSlotSync,
	resetSlotSyncFailure,
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
};

let deps: OrchestratorRuntimeDeps = defaultOrchestratorRuntimeDeps;
let state: OrchestratorState = initialOrchestratorState(Date.now());
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let osCandidate: OsChannelManifest | undefined;
let osStageInProcess = false;
let osForceActivated = false;

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
	osForceActivated = false;
}

export function getOrchestratorState(): OrchestratorState {
	return state;
}

/** Test-only direct state injection (the `set*ForTest` convention). Never
 * called from production code — every real transition goes through
 * `dispatch()`/`reduceOrchestrator`. */
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

function dispatch(event: OrchestratorEvent): OrchestratorState {
	const next = reduceOrchestrator(state, event);
	if (next !== state) {
		state = next;
		deps.persist(state);
	}
	return state;
}

// ─── operator RPC actions (system.checkUpdatesNow / installUpdatesNow /
// allowCellularOnce) — see rpc/procedures/system.procedure.ts. All three
// bypass IDLE; NONE bypasses the D8 stream-admission block, which is enforced
// structurally: none of these ever drives the phase INTO `committing` or
// `restarting-services` directly — only the scheduler's own
// awaiting-idle -> downloading step does that, and it always re-checks
// isStreamLive() immediately beforehand (see maybeStartPackageInstall below).

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
	if (!canStartManualInstall(state.phase, "packages")) {
		return {
			started: false,
			reason: PACKAGE_PIPELINE_BUSY_PHASES.includes(state.phase)
				? "busy"
				: "not_available",
		};
	}
	// The stream-admission block is never bypassed, even for a manual,
	// idle-bypassing operator action (Todo-36 MUST NOT DO). Checked HERE,
	// before the state even leaves `available`, so an active stream refuses the
	// whole attempt rather than parking it in `awaiting-idle` forever.
	if (deps.isStreamLive()) return { started: false, reason: "stream_active" };
	dispatch({ type: "AWAIT_IDLE_FOR_INSTALL", now: deps.now() });
	await maybeStartPackageInstall({ bypassIdle: true });
	return { started: true };
}

export function allowCellularOnce(id: string): void {
	dispatch({ type: "CELLULAR_OVERRIDE_GRANTED", now: deps.now(), id });
}

// ─── stream-start admission (Todo 37) ──────────────────────────────────────
//
// Wires D8 (admission.ts) into a real stream-start attempt. The refusal arm
// (committing/restarting-services) is a straight read of the cached `state` —
// no I/O, no staleness risk in the DANGEROUS direction (a phase that has
// already moved past committing only ever gets MORE refusing, never less).
//
// The abort-network arm is where the documented TOCTOU race lives: Todo 36's
// `getPackageInstallWireState()` wire read is only re-consulted by the
// orchestrator's own tick, which runs at most every ACTIVE_TICK_MS (3s) while
// a package install is active. If a stream-admission `kill`/`stop` fires on a
// STALE cached `state.phase === "downloading"` that has, in reality, already
// crossed into dpkg committing, the kill could interrupt dpkg mid-write.
//
// ACCEPTED, BOUNDED, RECOVERABLE RISK — do not "fix" this by re-architecting
// Todo 35's single-unit/single-flock design into two units. image-building-
// pipeline's `ceralive-dpkg-recover.service` (Todo 27, already shipped) runs
// on every boot, checks `/var/lib/dpkg/updates/` + `dpkg --audit`, and runs
// `dpkg --configure -a` (600s budget) whenever dpkg was left interrupted —
// regardless of cause (power loss, crash, or this kill are indistinguishable
// to it). That is what makes an occasional interrupted-dpkg outcome from this
// path recoverable rather than corrupting. See the matching AGENTS.md note in
// this repo's "SOFTWARE-UPDATE START CONTRACT" section.
//
// What THIS function does is narrow the exposure window from "up to one
// scheduler tick" (3s) to "one wire-state read round trip": immediately
// before dispatching any kill/stop, it calls `deps.getPackageInstallWireState()`
// DIRECTLY — bypassing the cached `state.phase` — for a forced-fresh read. If
// that fresh read shows dpkg has actually started (`installing`) or already
// finished (`success`), this REFUSES the start instead of killing anything:
// zero kill/stop calls are dispatched. This is the same correctness D8's
// admission table already has for the `committing` phase — just re-confirmed
// at the latest possible instant before an irreversible action.
export type StreamStartUpdateAdmission =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason: "update_in_progress";
			readonly phase: OrchestratorPhase;
			readonly percent: number;
			readonly etaSeconds: number;
	  };

export async function admitAndPrepareStreamStart(): Promise<StreamStartUpdateAdmission> {
	const cached = admitStreamStart(state);
	if (!cached.allowed) return cached;

	const action = onStreamStart(state);
	if (action === "none" || action === "continue-local") {
		return { allowed: true };
	}

	// action === "abort-network"
	if (state.phase === "downloading") {
		// Forced fresh read — bypasses the cached `state.phase`. See the
		// module comment above.
		const freshWire = deps.getPackageInstallWireState();
		if (freshWire.kind === "installing" || freshWire.kind === "success") {
			// dpkg has ALREADY started (or finished) since our cached read —
			// refuse instead of sending a kill signal. Correct the cached
			// state too, so a subsequent admission check reads fresh.
			dispatch({ type: "COMMIT_PHASE_ENTERED", now: deps.now() });
			const refreshed = admitStreamStart(state);
			if (!refreshed.allowed) return refreshed;
			// Unreachable in practice (COMMIT_PHASE_ENTERED always produces a
			// refusing "committing" phase) — kept as a defensive, total
			// fallback rather than an assertion.
			return {
				allowed: false,
				reason: "update_in_progress",
				phase: "committing",
				percent: 0,
				etaSeconds: 0,
			};
		}
		// Genuinely still downloading — safe to abort.
		await deps.stopPackageInstallUnit();
		dispatch({ type: "DOWNLOAD_ABORTED_FOR_STREAM", now: deps.now() });
		return { allowed: true };
	}

	if (state.phase === "os-staging") {
		// No forced-fresh-read equivalent is needed here: RAUC only ever
		// writes to the INACTIVE (target) slot, never the booted one, so a
		// kill mid-write cannot corrupt anything the device is running from —
		// unlike apt/dpkg, which mutates the live root in place. See
		// stream-abort.ts.
		await deps.killAndRestartRaucForStream();
		dispatch({ type: "OS_STAGING_ABORTED_FOR_STREAM", now: deps.now() });
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
		const packageCount = deps.getAvailablePackageCount();
		const wire = deps.getPackageInstallWireState();
		if (wire.kind === "available") {
			await deps.quarantine.reconcileCandidates(
				wire.packages?.flatMap((item) =>
					item.version ? [{ name: item.name, version: item.version }] : [],
				) ?? [],
			);
			if (packageCount > 0)
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
			packageCount > 0
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

// SoftwareUpdateError's typed cases don't carry an HTTP status directly, but
// `refresh_failed`/an ExecException surfaces apt's own exit code and message,
// which includes the HTTP status apt itself printed for a mirror-level 4xx/5xx.
// A best-effort classification: apt renders "429" / "5xx"-family text on a
// throttled or overloaded mirror. False negatives are safe (they fall back to
// the standard, still-capped backoff curve, only slower to widen).
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
}): Promise<void> {
	if (state.phase !== "awaiting-idle") return;
	if (deps.isStreamLive()) return; // stays awaiting-idle; retried next tick
	if (!opts.bypassIdle) {
		const settings = await deps.loadSettings();
		const idle = await deps.isIdle(settings.schedule);
		if (!idle) return;
	}
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
		return; // stays awaiting-idle; retried next tick
	}
	dispatch({ type: "INSTALL_UNIT_STARTED", now: deps.now() });
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

async function maybeStartSlotSync(): Promise<void> {
	if (state.phase !== "sync-eligible") return;
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

async function pollSlotSync(): Promise<void> {
	if (state.phase !== "syncing") return;
	const probe = await deps.inspectSlotSync();
	const now = deps.now();
	if (probe.kind === "running") return;
	if (probe.kind === "succeeded") {
		dispatch({ type: "SYNC_SUCCEEDED", now });
		notifyUpdate({ kind: "slots-current", id: String(now) });
		return;
	}
	if (probe.kind === "refused" || probe.kind === "failed") {
		await deps.resetSlotSyncFailure().catch((error) => {
			logger.warn(
				"update-orchestrator: slot-sync reset-failed cleanup failed",
				{
					error,
				},
			);
		});
		dispatch({
			type: "SYNC_FAILED",
			now,
			reason:
				probe.kind === "refused"
					? `slot-sync refused (exit ${probe.exitCode})`
					: `slot-sync failed (exit ${probe.exitCode})`,
		});
		return;
	}
	// "absent" while phase says "syncing" means the unit vanished without a
	// trace we can read (e.g. a transient probe error) — treat as inconclusive
	// failure rather than spin forever.
	dispatch({ type: "SYNC_FAILED", now, reason: "slot-sync-unit-absent" });
}

const OS_FORCE_ACTIVATION_MS = 7 * 24 * 60 * 60_000;

async function maybeStartOsStage(bypassIdle: boolean): Promise<void> {
	if (state.phase !== "os-available" || deps.isStreamLive()) return;
	if (!osCandidate) {
		await runOsCheckAfterCellularGate(await deps.loadSettings());
		if (state.phase !== "os-available" || !osCandidate) return;
	}
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
		candidateId: osCandidate.version,
	});
	if (!gate.allowed) {
		if (gate.needsOverride)
			notifyUpdate({
				kind: "cellular-approval",
				id: osCandidate.version,
				size: String(osCandidate.bundle.size),
			});
		return;
	}
	const manifest = osCandidate;
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
	if (receipt.bootId !== (await deps.readBootId())) {
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
	} else if (state.phase === "os-verifying") {
		await verifyOsBoot();
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
