/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Reattach rather than replay an uncertain package transaction: replay could
 * run dpkg twice. Settlement can run `apt-get clean`; see docs/UPDATE-RECOVERY.md.
 */

import type { UpdateState } from "@ceraui/rpc/schemas";
import { reduceOrchestrator } from "./reducer.ts";
import type { OrchestratorState } from "./types.ts";

export interface OrchestratorResumeDeps {
	readonly recoverSoftwareUpdateIfRunning: () => Promise<boolean>;
	readonly getUpdateState: () => UpdateState;
	readonly now: () => number;
}

function estimateCommitProgress(
	state: Extract<UpdateState, { kind: "installing" | "downloading" }>,
) {
	const { total, unpacking, setting_up: settingUp } = state.progress;
	const percent =
		total > 0
			? Math.min(100, Math.round(((unpacking + settingUp) / (2 * total)) * 100))
			: 0;
	return { percent, etaSeconds: 0 };
}

async function resumeCommitting(
	persisted: OrchestratorState,
	deps: OrchestratorResumeDeps,
): Promise<OrchestratorState> {
	const now = deps.now();
	const recovered = await deps.recoverSoftwareUpdateIfRunning();
	const wire = deps.getUpdateState();

	if (wire.kind === "installing" || wire.kind === "downloading") {
		return { ...persisted, progress: estimateCommitProgress(wire) };
	}
	if (wire.kind === "success") {
		return reduceOrchestrator(persisted, { type: "COMMIT_SUCCEEDED", now });
	}
	if (wire.kind === "failed") {
		return reduceOrchestrator(persisted, {
			type: "COMMIT_FAILED",
			now,
			reason: wire.reason,
		});
	}
	// Absence proves neither success nor a bad candidate. Missing-unit clearance
	// uses HISTORICAL_COMMIT_ADJUDICATED or RESET; see reducer.ts and UPDATE-RECOVERY.md.
	if (!recovered) {
		return reduceOrchestrator(persisted, {
			type: "COMMIT_RESUME_UNRESOLVED",
			now,
			reason: "commit_unit_absent_on_resume",
		});
	}
	return reduceOrchestrator(persisted, {
		type: "COMMIT_RESUME_UNRESOLVED",
		now,
		reason: "commit_resume_inconclusive",
	});
}

export async function resumeOrchestratorState(
	persisted: OrchestratorState,
	deps: OrchestratorResumeDeps,
): Promise<OrchestratorState> {
	if (persisted.phase === "committing") {
		return resumeCommitting(persisted, deps);
	}
	return persisted;
}
