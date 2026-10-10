/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { reduceOrchestrator } from "../../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";

export const KEY = "2026.10.0|3|stable|rock-5b-plus|ceralive-rock-5b-plus|u|d";

export const MIN = 60_000;

export function staging(
	attemptId: string,
	from: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "os-available",
	},
): OrchestratorState {
	return reduceOrchestrator(from, {
		type: "OS_STAGING_STARTED",
		now: 10,
		attempt: { candidateKey: KEY, attemptId },
	});
}

export function fail(
	state: OrchestratorState,
	attemptId: string,
	mode: "automatic" | "operator" | "unsafe",
	now = 1_000,
): OrchestratorState {
	return reduceOrchestrator(state, {
		type: "OS_STAGING_FAILED",
		now,
		reason: `reason-${mode}`,
		recovery: { attemptId, mode },
	});
}
