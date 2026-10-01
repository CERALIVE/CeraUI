/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Keep time and effects outside the state model so transitions can be tested
 * without mocking the OS.
 */

// This phase models the orchestrator's workflow, not independent legacy launches
// (root AGENTS.md, "D8 stream/update admission: what it does NOT cover").
export const ORCHESTRATOR_PHASES = [
	"idle",
	"checking",
	"available",
	"downloading",
	"awaiting-idle",
	"committing",
	"restarting-services",
	"settled",
	"os-available",
	"os-staging",
	"os-staged",
	"os-activation-armed",
	"os-verifying",
	"sync-eligible",
	"syncing",
	"synced",
	"quarantined",
	"failed",
] as const;
export type OrchestratorPhase = (typeof ORCHESTRATOR_PHASES)[number];

// Keep lock tests separate from D8's refusal-set tests.
export const LOCK_HOLDING_PHASES: readonly OrchestratorPhase[] = [
	"committing",
	"os-staging",
	"syncing",
];

export interface OrchestratorProgress {
	readonly percent: number;
	readonly etaSeconds: number;
}

export interface OrchestratorScheduleClock {
	readonly lastAttemptAt: number | null;
	readonly lastSuccessAt: number | null;
	readonly consecutiveFailures: number;
	readonly lastFailureWasRateLimited: boolean;
	readonly nextAttemptAt: number | null;
}

export function initialScheduleClock(): OrchestratorScheduleClock {
	return {
		lastAttemptAt: null,
		lastSuccessAt: null,
		consecutiveFailures: 0,
		lastFailureWasRateLimited: false,
		nextAttemptAt: null,
	};
}

export interface OrchestratorState {
	readonly phase: OrchestratorPhase;
	readonly enteredAt: number;
	readonly progress: OrchestratorProgress | null;
	readonly failureReason: string | null;
	readonly packageCheck: OrchestratorScheduleClock;
	readonly osCheck: OrchestratorScheduleClock;
	// One-time approval is spent on an attempt, not on success.
	readonly cellularOverrideId: string | null;
}

export function initialOrchestratorState(now: number): OrchestratorState {
	return {
		phase: "idle",
		enteredAt: now,
		progress: null,
		failureReason: null,
		packageCheck: initialScheduleClock(),
		osCheck: initialScheduleClock(),
		cellularOverrideId: null,
	};
}

// ─── Reducer events ───────────────────────────────────────────────────────

export type CheckKind = "packages" | "os";

export type OrchestratorEvent =
	| { readonly type: "PACKAGE_CHECK_STARTED"; readonly now: number }
	| { readonly type: "OS_CHECK_STARTED"; readonly now: number }
	| {
			readonly type: "CHECK_SUCCEEDED_NONE";
			readonly now: number;
			readonly kind: CheckKind;
			readonly nextAttemptAt: number;
	  }
	| {
			readonly type: "CHECK_SUCCEEDED_PACKAGES";
			readonly now: number;
			readonly nextAttemptAt: number;
	  }
	| {
			readonly type: "CHECK_SUCCEEDED_OS";
			readonly now: number;
			readonly nextAttemptAt: number;
	  }
	| {
			readonly type: "CHECK_FAILED";
			readonly now: number;
			readonly kind: CheckKind;
			readonly rateLimited: boolean;
			readonly reason: string;
			readonly nextAttemptAt: number;
	  }
	| { readonly type: "AWAIT_IDLE_FOR_INSTALL"; readonly now: number }
	// Records launch acceptance, not unit creation. See root
	// AGENTS.md D8 Known gaps (b), (f), (g) for the uncovered windows.
	| { readonly type: "INSTALL_UNIT_STARTED"; readonly now: number }
	| {
			readonly type: "DOWNLOAD_PROGRESS";
			readonly now: number;
			readonly progress: OrchestratorProgress;
	  }
	| {
			readonly type: "DOWNLOAD_FAILED";
			readonly now: number;
			readonly reason: string;
	  }
	// Records a stop request, not cancellation (root AGENTS.md D8 Known gaps (b), (g)).
	| { readonly type: "DOWNLOAD_ABORTED_FOR_STREAM"; readonly now: number }
	// Resume-only: a persisted `downloading` whose unit is gone after a restart.
	// The phase can lag a short commit, so this proves nothing about dpkg; it
	// only schedules a fresh, idempotent apt run (resume.ts).
	| { readonly type: "DOWNLOAD_RESUME_UNIT_ABSENT"; readonly now: number }
	| { readonly type: "COMMIT_PHASE_ENTERED"; readonly now: number }
	| {
			readonly type: "COMMIT_PROGRESS";
			readonly now: number;
			readonly progress: OrchestratorProgress;
	  }
	| { readonly type: "COMMIT_SUCCEEDED"; readonly now: number }
	| {
			readonly type: "COMMIT_FAILED";
			readonly now: number;
			readonly reason: string;
	  }
	// Uncertainty is not evidence of a bad candidate to quarantine. The missing-unit
	// reason can be cleared by HISTORICAL_COMMIT_ADJUDICATED or RESET (reducer.ts).
	| {
			readonly type: "COMMIT_RESUME_UNRESOLVED";
			readonly now: number;
			readonly reason: string;
	  }
	| { readonly type: "SERVICES_RESTARTED"; readonly now: number }
	| { readonly type: "SETTLE_ACKNOWLEDGED"; readonly now: number }
	| { readonly type: "OS_STAGING_STARTED"; readonly now: number }
	| {
			readonly type: "OS_STAGING_PROGRESS";
			readonly now: number;
			readonly progress: OrchestratorProgress;
	  }
	| { readonly type: "OS_STAGED"; readonly now: number }
	| {
			readonly type: "OS_STAGING_FAILED";
			readonly now: number;
			readonly reason: string;
	  }
	| { readonly type: "OS_STAGING_ABORTED_FOR_STREAM"; readonly now: number }
	| { readonly type: "OS_ACTIVATION_ARMED"; readonly now: number }
	| { readonly type: "OS_REBOOT_OBSERVED"; readonly now: number }
	| { readonly type: "OS_VERIFIED"; readonly now: number }
	| {
			readonly type: "OS_ROLLBACK_DETECTED";
			readonly now: number;
			readonly reason: string;
	  }
	| { readonly type: "SYNC_ELIGIBILITY_CONFIRMED"; readonly now: number }
	| { readonly type: "SYNC_SKIPPED"; readonly now: number }
	| { readonly type: "SYNC_STARTED"; readonly now: number }
	| { readonly type: "SYNC_SUCCEEDED"; readonly now: number }
	| {
			readonly type: "SYNC_FAILED";
			readonly now: number;
			readonly reason: string;
	  }
	| { readonly type: "SYNC_SETTLED"; readonly now: number }
	| {
			readonly type: "CELLULAR_OVERRIDE_GRANTED";
			readonly now: number;
			readonly id: string;
	  }
	| {
			readonly type: "HISTORICAL_COMMIT_ADJUDICATED";
			readonly now: number;
			readonly decision: "historical_outcome_unresolved_current_slot_unapplied";
			readonly receiptId: string;
	  }
	| { readonly type: "RESET"; readonly now: number };

// ─── D8 stream admission ───────────────────────────────────────────────────

export type StreamAdmission =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason: "update_in_progress";
			readonly phase: OrchestratorPhase;
			readonly percent: number;
			readonly etaSeconds: number;
	  };

export type StreamStartAction = "abort-network" | "continue-local" | "none";
