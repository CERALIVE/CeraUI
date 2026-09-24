/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The pure orchestrator state-transition function (Todo 36).
 *
 * `reduceOrchestrator` is TOTAL: it never throws, and any (phase, event) pair
 * it does not explicitly recognise is a no-op that returns the SAME state
 * object (referential equality preserved, so effects layers can cheaply detect
 * "nothing changed"). This is deliberate — an unexpected or stale event (e.g. a
 * COMMIT_SUCCEEDED arriving after a resume already moved the phase on) must
 * never crash the orchestrator or silently corrupt an unrelated phase.
 *
 * No I/O of any kind happens here. Every timestamp is the event's own `now`;
 * every scheduling delay is pre-computed by schedule.ts and threaded through
 * the event, never invented here.
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
				osCheck: clockAtAttemptStart(state.osCheck, event.now),
			});
		case "CELLULAR_OVERRIDE_GRANTED":
			return { ...state, cellularOverrideId: event.id };
		default:
			return state;
	}
}

// `checking` does not remember which cadence started it (both are equally
// non-disruptive, network-only probes; D8 leaves "checking" unmentioned, i.e.
// allowed+none regardless). The OUTCOME event tells us which result kind
// applies and updates the matching clock.
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
			return enter(state, event.now, { phase: "idle", ...clockPatch });
		}
		case "CHECK_SUCCEEDED_PACKAGES":
			return enter(state, event.now, {
				phase: "available",
				packageCheck: clockAfterSuccess(event.now, event.nextAttemptAt),
			});
		case "CHECK_SUCCEEDED_OS":
			return enter(state, event.now, {
				phase: "os-available",
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
			return enter(state, event.now, { phase: "idle", ...clockPatch });
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

// See types.ts's INSTALL_UNIT_STARTED doc: idle (real or operator-bypassed)
// has been reached and no stream is live, so the ONE combined download+commit
// unit is launched. Nothing may abort from `awaiting-idle` itself — there is
// no process running yet to abort, matching D8 leaving it unmentioned
// (allowed + "none").
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
		// A failure purely in the download/discovery-simulation portion, before
		// any dpkg step ran — `failed`, never `quarantined`: nothing was
		// installed, so there is no bad version to pin.
		case "DOWNLOAD_FAILED":
			return enter(state, event.now, {
				phase: "failed",
				progress: null,
				failureReason: event.reason,
			});
		// D8: a stream starting during `downloading` is ALLOWED, and the update
		// aborts over network. This is not a failure of the update — it goes back
		// to `available` so the schedule/operator can retry once the stream ends.
		case "DOWNLOAD_ABORTED_FOR_STREAM":
			return enter(state, event.now, { phase: "available", progress: null });
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
		// A failed commit is QUARANTINE, never a bare "failed" — Todo 38 pins the
		// installed (bad) version so it is not retried automatically.
		case "COMMIT_FAILED":
			return enter(state, event.now, {
				phase: "quarantined",
				progress: null,
				failureReason: event.reason,
			});
		// An UNRESOLVED resume (dpkg's outcome could not be established at all) is
		// a bare "failed", never "quarantined" — there is no confirmed-bad version
		// here to pin, only genuine uncertainty an operator must investigate.
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

// `settled` is a real, observable resting phase (a notification-worthy "the
// install finished" moment) rather than an instantaneous alias for `idle` — but
// no NEW check may start from it. The effects layer promptly (not necessarily
// synchronously) acknowledges it back to `idle`, at which point the normal
// check-scheduling gate (phase === "idle") applies again.
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
			});
		case "OS_CHECK_STARTED":
			return enter(state, event.now, {
				phase: "checking",
				osCheck: clockAtAttemptStart(state.osCheck, event.now),
			});
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
		// D8: allowed + abort, same as the package download leg.
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
		// A sync failure means the MIRROR failed, not that the running slot or the
		// just-verified OS version is bad — the slot-sync script itself leaves the
		// OTHER slot marked bad and this orchestrator never touches the booted
		// slot, so `failed` (not `quarantined`) is correct: nothing here should
		// pin/refuse the current, still-good, running version.
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
		case "RESET":
			return enter(state, event.now, { phase: "idle", failureReason: null });
		default:
			return state;
	}
}
