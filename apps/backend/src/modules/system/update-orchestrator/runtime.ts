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
import { getIdleStatus } from "../idle-activity.ts";
import { isRealDevice } from "../device-detection.ts";
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
import {
	inspectSlotSync,
	resetSlotSyncFailure,
	type SlotSyncProbeState,
	startSlotSync,
} from "./lock.ts";
import { notifyUpdate } from "./notifications.ts";
import { loadOrchestratorState, saveOrchestratorState } from "./persistence.ts";
import { UpdateQuarantine } from "./quarantine.ts";
import { reduceOrchestrator } from "./reducer.ts";
import { resumeOrchestratorState } from "./resume.ts";
import { defaultStaleServiceDeps, reconcileStaleUnits } from "./stale-services.ts";
import {
	canStartManualCheck,
	canStartManualInstall,
	computeNextCheckDelayMs,
	decideCellularGate,
	shouldAttemptScheduledCheck,
} from "./schedule.ts";
import {
	initialOrchestratorState,
	type OrchestratorEvent,
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
	// Todo-39 seam: no fetch/verify/RAUC mechanism exists yet. The honest
	// default always reports "nothing available" rather than fabricating a
	// manifest — a legacy or not-yet-capable image must never appear to have
	// found an OS update it cannot actually stage.
	readonly checkOsManifest: () => Promise<{
		readonly available: boolean;
		readonly rateLimited: boolean;
		readonly failed: boolean;
		readonly reason: string;
	}>;
	readonly startSlotSync: () => Promise<void>;
	readonly inspectSlotSync: () => Promise<SlotSyncProbeState>;
	readonly resetSlotSyncFailure: () => Promise<void>;
	readonly recoverSoftwareUpdateIfRunning: () => Promise<boolean>;
	readonly persist: (state: OrchestratorState) => void;
	readonly quarantine: UpdateQuarantine;
	readonly restartStale: (isIdle: () => Promise<boolean>, transactionRunning: () => boolean) => Promise<boolean>;
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
	// Honest Todo-39 placeholder — see the interface doc above.
	checkOsManifest: async () => ({
		available: false,
		rateLimited: false,
		failed: false,
		reason: "",
	}),
	startSlotSync,
	inspectSlotSync,
	resetSlotSyncFailure,
	recoverSoftwareUpdateIfRunning,
	persist: saveOrchestratorState,
	quarantine: new UpdateQuarantine(),
	restartStale: async (isIdle, transactionRunning) => {
		if (!(await isRealDevice())) return true;
		return reconcileStaleUnits({ ...defaultStaleServiceDeps, isIdle, transactionRunning });
	},
};

let deps: OrchestratorRuntimeDeps = defaultOrchestratorRuntimeDeps;
let state: OrchestratorState = initialOrchestratorState(Date.now());
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

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
	return { started: true };
}

export type ManualInstallOutcome =
	| { readonly started: true }
	| {
			readonly started: false;
			readonly reason: "busy" | "not_available" | "stream_active";
	  };

const PACKAGE_PIPELINE_BUSY_PHASES: readonly OrchestratorState["phase"][] = [
	"awaiting-idle",
	"downloading",
	"committing",
	"restarting-services",
	"settled",
];

export async function installUpdatesNow(): Promise<ManualInstallOutcome> {
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
			await deps.quarantine.reconcileCandidates(wire.packages?.flatMap((item) =>
				item.version ? [{ name: item.name, version: item.version }] : [],
			) ?? []);
			if (packageCount > 0) notifyUpdate({
				kind: "updates-available",
				id: wire.packages?.map((item) => `${item.name}=${item.version ?? "unknown"}`).sort().join(",") ?? wire.identity.version,
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
	notifyUpdate({ kind: "refused", id: `packages:${String(error)}`, reason: String(error) });
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
		await deps.quarantine.savePending(available.packages?.filter((item) => item.actionable).map((item) => ({
			name: item.name,
			...(item.version ? { version: item.version } : {}),
		})) ?? available.identity.packages.map((name) => ({ name })));
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
			await deps.quarantine.recordPackageFailure(pending.flatMap((item) => item.version ? [{ name: item.name, version: item.version }] : []), String(state.enteredAt), wire.reason);
			await deps.quarantine.clearPending();
			dispatch({ type: "COMMIT_FAILED", now, reason: wire.reason });
			notifyUpdate({ kind: "refused", id: `commit:${state.enteredAt}`, reason: wire.reason });
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
			() => ["downloading", "installing"].includes(deps.getPackageInstallWireState().kind),
		);
		if (done) {
			const pending = await deps.quarantine.readPending();
			notifyUpdate({ kind: "installed", id: String(state.enteredAt), packages: pending.map((item) => item.name) });
			await deps.quarantine.clearPending();
			dispatch({ type: "SERVICES_RESTARTED", now: deps.now() });
		}
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
	const result = await deps.checkOsManifest();
	const outcomeNow = deps.now();
	if (result.failed) {
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
	if (state.phase === "quarantined" && baseline.phase === "committing") {
		const pending = await deps.quarantine.readPending();
		await deps.quarantine.recordPackageFailure(
			pending.flatMap((item) => item.version ? [{ name: item.name, version: item.version }] : []),
			String(baseline.enteredAt),
			state.failureReason ?? "apt-exit-nonzero",
		);
		await deps.quarantine.clearPending();
	}
	deps.persist(state);
	started = true;
	scheduleNextTick();
}
