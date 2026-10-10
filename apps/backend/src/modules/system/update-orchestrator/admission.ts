/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Cached-phase admission; downloading-unit evidence is checked in runtime.ts.
 * See "D8 stream/update admission: what it does NOT cover" under Known gaps in
 * the root AGENTS.md and docs/DEVICE-UPDATES.md's D8 section before changing it.
 */

import {
	ORCHESTRATOR_PHASES,
	type OrchestratorPhase,
	type OrchestratorState,
	type StreamAdmission,
	type StreamStartAction,
} from "./types.ts";

export const STREAM_REFUSING_PHASES: readonly OrchestratorPhase[] = [
	"committing",
	"restarting-services",
];

const ABORT_NETWORK_PHASES: readonly OrchestratorPhase[] = [
	"downloading",
	"os-staging",
];

const CONTINUE_LOCAL_PHASES: readonly OrchestratorPhase[] = ["syncing"];

// This checks overlapping buckets, not missing classifications. An unlisted
// phase defaults to allowed/action "none"; classify new phases deliberately.
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
