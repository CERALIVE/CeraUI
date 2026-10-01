/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Returning the same state for an unrecognized pair lets dispatch skip unchanged
 * persistence/publication and avoids applying stale events to an unrelated phase.
 */

import type {
	OrchestratorEvent,
	OrchestratorScheduleClock,
	OrchestratorState,
} from "./types.ts";

function enter(
	state: OrchestratorState,
	now: number,
	patch: Partial<OrchestratorState>,
): OrchestratorState {
	return { ...state, ...patch, enteredAt: now };
}

function clockAfterSuccess(
	now: number,
	nextAttemptAt: number,
): OrchestratorScheduleClock {
	return {
		lastAttemptAt: now,
		lastSuccessAt: now,
		consecutiveFailures: 0,
		lastFailureWasRateLimited: false,
		nextAttemptAt,
	};
}

function clockAfterFailure(
	clock: OrchestratorScheduleClock,
	now: number,
	rateLimited: boolean,
	nextAttemptAt: number,
): OrchestratorScheduleClock {
	return {
		lastAttemptAt: now,
		lastSuccessAt: clock.lastSuccessAt,
		consecutiveFailures: clock.consecutiveFailures + 1,
		lastFailureWasRateLimited: rateLimited,
		nextAttemptAt,
	};
}

function clockAtAttemptStart(
	clock: OrchestratorScheduleClock,
	now: number,
): OrchestratorScheduleClock {
	return { ...clock, lastAttemptAt: now };
}

export function reduceOrchestrator(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (state.phase) {
		case "idle":
			return reduceIdle(state, event);
		case "checking":
			return reduceChecking(state, event);
		case "available":
			return reduceAvailable(state, event);
		case "downloading":
			return reduceDownloading(state, event);
		case "awaiting-idle":
			return reduceAwaitingIdle(state, event);
		case "committing":
			return reduceCommitting(state, event);
		case "restarting-services":
			return reduceRestartingServices(state, event);
		case "settled":
			return reduceSettled(state, event);
		case "os-available":
			return reduceOsAvailable(state, event);
		case "os-staging":
			return reduceOsStaging(state, event);
		case "os-staged":
			return reduceOsStaged(state, event);
		case "os-activation-armed":
			return reduceOsActivationArmed(state, event);
		case "os-verifying":
			return reduceOsVerifying(state, event);
		case "sync-eligible":
			return reduceSyncEligible(state, event);
		case "syncing":
			return reduceSyncing(state, event);
		case "synced":
			return reduceSynced(state, event);
		case "quarantined":
			return reduceQuarantined(state, event);
		case "failed":
			return reduceFailed(state, event);
	}
}

function reduceIdle(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "PACKAGE_CHECK_STARTED":
			return enter(state, event.now, {
				phase: "checking",
				packageCheck: clockAtAttemptStart(state.packageCheck, event.now),
			});
		case "OS_CHECK_STARTED":
			return enter(state, event.now, {
				phase: "checking",
				failureReason: null,
				osCheck: clockAtAttemptStart(state.osCheck, event.now),
			});
		case "SYNC_ELIGIBILITY_CONFIRMED":
			return enter(state, event.now, { phase: "sync-eligible" });
		case "CELLULAR_OVERRIDE_GRANTED":
			return { ...state, cellularOverrideId: event.id };
		default:
			return state;
	}
}

function reduceChecking(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "CHECK_SUCCEEDED_NONE": {
			const clockPatch =
				event.kind === "packages"
					? { packageCheck: clockAfterSuccess(event.now, event.nextAttemptAt) }
					: { osCheck: clockAfterSuccess(event.now, event.nextAttemptAt) };
			return enter(state, event.now, {
				phase: "idle",
				failureReason: null,
				...clockPatch,
			});
		}
		case "CHECK_SUCCEEDED_PACKAGES":
			return enter(state, event.now, {
				phase: "available",
				packageCheck: clockAfterSuccess(event.now, event.nextAttemptAt),
			});
		case "CHECK_SUCCEEDED_OS":
			return enter(state, event.now, {
				phase: "os-available",
				failureReason: null,
				osCheck: clockAfterSuccess(event.now, event.nextAttemptAt),
			});
		case "CHECK_FAILED": {
			const clockPatch =
				event.kind === "packages"
					? {
							packageCheck: clockAfterFailure(
								state.packageCheck,
								event.now,
								event.rateLimited,
								event.nextAttemptAt,
							),
						}
					: {
							osCheck: clockAfterFailure(
								state.osCheck,
								event.now,
								event.rateLimited,
								event.nextAttemptAt,
							),
						};
			return enter(state, event.now, {
				phase: "idle",
				failureReason: event.kind === "os" ? event.reason : state.failureReason,
				...clockPatch,
			});
		}
		default:
			return state;
	}
}

function reduceAvailable(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "AWAIT_IDLE_FOR_INSTALL":
			return enter(state, event.now, {
				phase: "awaiting-idle",
				failureReason: null,
			});
		case "PACKAGE_CHECK_STARTED":
			// A re-check while an update is already known available (manual
			// system.checkUpdatesNow, or the schedule firing again) is legitimate —
			// it re-validates the candidate is still current.
			return enter(state, event.now, {
				phase: "checking",
				packageCheck: clockAtAttemptStart(state.packageCheck, event.now),
			});
		default:
			return state;
	}
}

// Launch-acceptance limits: root AGENTS.md D8 Known gaps (f)-(g).
function reduceAwaitingIdle(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "INSTALL_UNIT_STARTED":
			return enter(state, event.now, {
				phase: "downloading",
				progress: { percent: 0, etaSeconds: 0 },
			});
		default:
			return state;
	}
}

function reduceDownloading(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "DOWNLOAD_PROGRESS":
			return { ...state, progress: event.progress };
		case "COMMIT_PHASE_ENTERED":
			return enter(state, event.now, {
				phase: "committing",
				progress: state.progress,
			});
		// A failure while the phase is still `downloading` goes to `failed`, not
		// `quarantined`: the wire has not established a failed dpkg commit.
		case "DOWNLOAD_FAILED":
			return enter(state, event.now, {
				phase: "failed",
				progress: null,
				failureReason: event.reason,
			});
		case "DOWNLOAD_ABORTED_FOR_STREAM":
			return enter(state, event.now, { phase: "available", progress: null });
		// Straight back to `awaiting-idle`, not `available`: the install was
		// already approved and was interrupted, not declined, so it must not
		// wait on `packagesAuto` again. The idle gate still applies.
		case "DOWNLOAD_RESUME_UNIT_ABSENT":
			return enter(state, event.now, {
				phase: "awaiting-idle",
				progress: null,
			});
		default:
			return state;
	}
}

function reduceCommitting(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "COMMIT_PROGRESS":
			return { ...state, progress: event.progress };
		case "COMMIT_SUCCEEDED":
			return enter(state, event.now, {
				phase: "restarting-services",
				progress: null,
			});
		// A failed commit quarantines the pending candidate; the legacy-unit
		// adoption race can misattribute a different unit's outcome here (root
		// AGENTS.md D8 Known gaps (d)).
		case "COMMIT_FAILED":
			return enter(state, event.now, {
				phase: "quarantined",
				progress: null,
				failureReason: event.reason,
			});
		// An unresolved outcome does not establish a bad candidate to pin.
		case "COMMIT_RESUME_UNRESOLVED":
			return enter(state, event.now, {
				phase: "failed",
				progress: null,
				failureReason: event.reason,
			});
		default:
			return state;
	}
}

function reduceRestartingServices(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "SERVICES_RESTARTED":
			return enter(state, event.now, { phase: "settled", progress: null });
		default:
			return state;
	}
}

function reduceSettled(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "SETTLE_ACKNOWLEDGED":
			return enter(state, event.now, { phase: "idle" });
		default:
			return state;
	}
}

function reduceOsAvailable(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "OS_STAGING_STARTED":
			return enter(state, event.now, {
				phase: "os-staging",
				progress: { percent: 0, etaSeconds: 0 },
				failureReason: null,
				cellularOverrideId: null,
			});
		case "OS_CHECK_STARTED":
			return enter(state, event.now, {
				phase: "checking",
				osCheck: clockAtAttemptStart(state.osCheck, event.now),
			});
		// `os-available` is the ONLY phase in which the D12 install gate can hold
		// a candidate for one-time approval, so the grant must land here too —
		// reducing it from `idle` alone made the operator's approval a no-op.
		case "CELLULAR_OVERRIDE_GRANTED":
			return { ...state, cellularOverrideId: event.id };
		default:
			return state;
	}
}

function reduceOsStaging(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "OS_STAGING_PROGRESS":
			return { ...state, progress: event.progress };
		case "OS_STAGED":
			return enter(state, event.now, { phase: "os-staged", progress: null });
		case "OS_STAGING_FAILED":
			return enter(state, event.now, {
				phase: "failed",
				progress: null,
				failureReason: event.reason,
			});
		case "OS_STAGING_ABORTED_FOR_STREAM":
			return enter(state, event.now, {
				phase: "os-available",
				progress: null,
			});
		default:
			return state;
	}
}

function reduceOsStaged(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "OS_ACTIVATION_ARMED":
			return enter(state, event.now, { phase: "os-activation-armed" });
		default:
			return state;
	}
}

function reduceOsActivationArmed(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "OS_REBOOT_OBSERVED":
			return enter(state, event.now, { phase: "os-verifying" });
		default:
			return state;
	}
}

function reduceOsVerifying(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "OS_VERIFIED":
			return enter(state, event.now, { phase: "sync-eligible" });
		case "OS_ROLLBACK_DETECTED":
			return enter(state, event.now, {
				phase: "quarantined",
				failureReason: event.reason,
			});
		default:
			return state;
	}
}

function reduceSyncEligible(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "SYNC_STARTED":
			return enter(state, event.now, {
				phase: "syncing",
				progress: { percent: 0, etaSeconds: 0 },
			});
		case "SYNC_SKIPPED":
			return enter(state, event.now, { phase: "idle", progress: null });
		default:
			return state;
	}
}

function reduceSyncing(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "SYNC_SUCCEEDED":
			return enter(state, event.now, { phase: "synced", progress: null });
		// A failed mirror is not evidence that the running version is bad.
		case "SYNC_FAILED":
			return enter(state, event.now, {
				phase: "failed",
				progress: null,
				failureReason: event.reason,
			});
		default:
			return state;
	}
}

function reduceSynced(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "SYNC_SETTLED":
			return enter(state, event.now, { phase: "idle" });
		default:
			return state;
	}
}

function reduceQuarantined(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "RESET":
			return enter(state, event.now, { phase: "idle", failureReason: null });
		default:
			return state;
	}
}

function reduceFailed(
	state: OrchestratorState,
	event: OrchestratorEvent,
): OrchestratorState {
	switch (event.type) {
		case "HISTORICAL_COMMIT_ADJUDICATED":
			if (
				state.failureReason !== "commit_unit_absent_on_resume" ||
				event.decision !==
					"historical_outcome_unresolved_current_slot_unapplied" ||
				!/^[a-f0-9]{64}$/.test(event.receiptId)
			)
				return state;
			return enter(state, event.now, {
				phase: "idle",
				failureReason: null,
				progress: null,
				packageCheck: { ...state.packageCheck, nextAttemptAt: null },
				osCheck: { ...state.osCheck, nextAttemptAt: null },
				cellularOverrideId: null,
			});
		case "RESET":
			return enter(state, event.now, { phase: "idle", failureReason: null });
		default:
			return state;
	}
}
