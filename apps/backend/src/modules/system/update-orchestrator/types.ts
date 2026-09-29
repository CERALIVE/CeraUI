/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Pure types for the update orchestrator (Todo 36).
 *
 * This module and its siblings `reducer.ts`/`admission.ts`/`schedule.ts` contain
 * NO I/O — no file access, no process spawning, no `Date.now()`/`Math.random()`
 * calls. Every timestamp and random jitter value is computed by the effects
 * layer (`runtime.ts`/`resume.ts`/`persistence.ts`/`lock.ts`) and passed in as
 * plain data. This split is load-bearing: the reducer and the D8 admission
 * matrix are the single most safety-critical property this task delivers, and
 * a pure function is exhaustively unit-testable without mocking the OS.
 */

// The full phase set from the plan (Todo 36), verbatim and in the plan's own
// order. A flat, single `phase` field (rather than parallel packages/OS
// sub-machines) is a deliberate simplification: the single update lock means
// at most ONE disruptive operation (commit, OS staging, slot-sync) is ever
// live at a time, so one discriminator can represent "what the orchestrator is
// doing right now" without losing safety-relevant information. The trade-off
// (documented in full in the Todo-36 notepad entry) is that a package update
// and an OS update cannot be tracked as simultaneously "known available" —
// packages are prioritised, and the OS-check timer simply defers its attempt
// while a package-path phase is active, and vice versa.
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

// Lock-associated transaction phases. This is NOT D8's refusal set:
// `restarting-services` refuses without holding the lock, whereas OS staging
// and syncing allow a start. Exported to keep lock and admission tests separate.
export const LOCK_HOLDING_PHASES: readonly OrchestratorPhase[] = [
	"committing",
	"os-staging",
	"syncing",
];

export interface OrchestratorProgress {
	readonly percent: number;
	readonly etaSeconds: number;
}

// One check-cadence clock. `nextAttemptAt` is the STORED result of a schedule.ts
// decision (jitter/backoff already applied with a real RNG in the effects
// layer) — the reducer never invents a random delay itself, it only threads the
// already-computed value through so the whole state machine stays deterministic
// given its inputs.
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
	// Only meaningful while an active, monitorable operation is running
	// (downloading/committing/restarting-services/os-staging/syncing); null
	// otherwise. This is the exact field admitStreamStart reads for a refusal's
	// `percent`/`etaSeconds`.
	readonly progress: OrchestratorProgress | null;
	// Set on entry to `quarantined`/`failed`; cleared by RESET.
	readonly failureReason: string | null;
	readonly packageCheck: OrchestratorScheduleClock;
	readonly osCheck: OrchestratorScheduleClock;
	// system.allowCellularOnce(id) grants exactly one pending OS update
	// (identified by its manifest id/version) permission to stage over a
	// metered-only uplink. Consumed (cleared) the moment that staging attempt is
	// made, successful or not — "one-time" means one ATTEMPT, not one success.
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
// Every event carries `now` (caller-supplied) rather than the reducer calling
// Date.now() itself — the reducer stays a pure function of (state, event).

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
	// available -> awaiting-idle happens the moment an update is known
	// available and the automatic pipeline wants to proceed (or an operator
	// calls installUpdatesNow) — see the "single combined unit" note below.
	| { readonly type: "AWAIT_IDLE_FOR_INSTALL"; readonly now: number }
	// awaiting-idle -> downloading records launch ACCEPTANCE, not unit creation.
	// It can be deferred or still preparing; the stream-live check is not a
	// starting-stream fence. Once a capable-image unit exists, download and
	// commit run inside one flock. Wire progress can lag dpkg, so D8 reads
	// fresh wire state and probes the unit before issuing a stop. See root
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
	// Dispatched by the downloading abort-network arm after issuing the unit
	// stop. This is not a download failure; it cannot cancel a launch without
	// a unit yet (root AGENTS.md D8 Known gaps (b), (g)).
	| { readonly type: "DOWNLOAD_ABORTED_FOR_STREAM"; readonly now: number }
	// A fresh wire read or the poll found `installing` or `success`: dpkg has
	// run. A successful completion callback can also enter this phase before
	// `COMMIT_SUCCEEDED`. D8 refuses starts in this phase.
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
	// Resume-only: the detached unit's outcome could NOT be established (it was
	// never found, or its state was inconclusive) after a crash/restart. This is
	// deliberately DISTINCT from COMMIT_FAILED: dpkg is not known to have run at
	// all, so there is no confirmed-bad version to quarantine/pin — see
	// resume.ts. It still requires an explicit RESET, same as quarantined.
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
	// Companion to DOWNLOAD_ABORTED_FOR_STREAM for the os-staging phase.
	| { readonly type: "OS_STAGING_ABORTED_FOR_STREAM"; readonly now: number }
	| { readonly type: "OS_ACTIVATION_ARMED"; readonly now: number }
	// Dispatched by the RESUME path on backend start when the persisted phase
	// was os-activation-armed and the booted slot has actually changed — i.e.
	// the device really did reboot into the staged slot since last observed.
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
	// Manual/auto retry after a terminal failure once conditions allow it again
	// (e.g. a newer candidate, or an operator acknowledgement — Todo 38's job to
	// decide WHEN; this event is the mechanism).
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

// What the orchestrator must DO to its own in-flight operation when a stream
// is admitted to start. "none" covers every phase with nothing in flight to
// act on (idle/checking/available/awaiting-idle/settled/os-available/
// os-staged/os-activation-armed/os-verifying/sync-eligible/synced/quarantined/
// failed) as well as the two refused phases (committing/restarting-services),
// for which onStreamStart is never actually consulted by a caller that
// correctly checked admitStreamStart first — it still returns a defined,
// non-throwing answer so the function stays total.
export type StreamStartAction = "abort-network" | "continue-local" | "none";
