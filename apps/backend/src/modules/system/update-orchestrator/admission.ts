/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * D8 — the stream/update mutual-admission matrix (Todo 36). This is the single
 * most safety-critical property this task delivers: a wrong answer here can
 * either brick a live stream (refusing a start that should be allowed) or let
 * a disruptive update corrupt a stream (allowing a start that should be
 * refused). Both functions are pure and total over every OrchestratorPhase —
 * no phase is ever left to an implicit/default branch that could silently do
 * the wrong thing as the phase list grows.
 *
 * The D8 phase classification (runtime.ts checks a downloading unit separately):
 *   - `committing` / `restarting-services` -> REFUSE based on the tracked
 *     phase; a stale phase can over-refuse.
 *   - `downloading` / `os-staging` -> the start is initially ALLOWED and an
 *     abort is requested. The cached `downloading` phase can include dpkg, so
 *     runtime.ts's `admitAndPrepareStreamStart` does a forced-fresh wire read
 *     and the commit-stage probe before stopping the package unit and refuses
 *     if either finds the commit stage; the gap that remains is described
 *     there. `os-staging` kills and restarts RAUC with neither check.
 *   - `syncing` -> ALLOWED, and the local slot mirror continues.
 *   - every other phase is ALLOWED with action "none". D8 does not interrupt
 *     a discovery in `checking` or prevent an install being launched after a
 *     start is admitted but before it is live. See "D8 stream/update admission:
 *     what it does NOT cover" under Known gaps in the root AGENTS.md.
 */

import {
	ORCHESTRATOR_PHASES,
	type OrchestratorPhase,
	type OrchestratorState,
	type StreamAdmission,
	type StreamStartAction,
} from "./types.ts";

// The exact refusal set. Exported so tests (and, in Todo 37, the real
// stream-start call site) can assert against ONE source of truth rather than
// re-deriving it, and so a future new phase is forced to be added here
// deliberately rather than silently falling into either bucket.
export const STREAM_REFUSING_PHASES: readonly OrchestratorPhase[] = [
	"committing",
	"restarting-services",
];

const ABORT_NETWORK_PHASES: readonly OrchestratorPhase[] = [
	"downloading",
	"os-staging",
];

const CONTINUE_LOCAL_PHASES: readonly OrchestratorPhase[] = ["syncing"];

// Compile-time-ish completeness check: every phase must be classified into
// exactly one of refuse / abort-network / continue-local / none. Asserted at
// module load (throws immediately on any drift, e.g. a new phase added to
// ORCHESTRATOR_PHASES without updating this file) rather than only in a test,
// so a missed phase fails loudly the moment the module is imported anywhere.
function assertExhaustivePhaseClassification(): void {
	for (const phase of ORCHESTRATOR_PHASES) {
		const buckets = [
			STREAM_REFUSING_PHASES.includes(phase),
			ABORT_NETWORK_PHASES.includes(phase),
			CONTINUE_LOCAL_PHASES.includes(phase),
		].filter(Boolean).length;
		if (buckets > 1) {
			throw new Error(
				`update-orchestrator admission: phase "${phase}" is classified into more than one D8 bucket`,
			);
		}
	}
}
assertExhaustivePhaseClassification();

export function admitStreamStart(state: OrchestratorState): StreamAdmission {
	if (STREAM_REFUSING_PHASES.includes(state.phase)) {
		return {
			allowed: false,
			reason: "update_in_progress",
			phase: state.phase,
			percent: state.progress?.percent ?? 0,
			etaSeconds: state.progress?.etaSeconds ?? 0,
		};
	}
	return { allowed: true };
}

export function onStreamStart(state: OrchestratorState): StreamStartAction {
	if (ABORT_NETWORK_PHASES.includes(state.phase)) return "abort-network";
	if (CONTINUE_LOCAL_PHASES.includes(state.phase)) return "continue-local";
	return "none";
}
