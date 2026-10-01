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
 * A persisted `downloading` with no unit left is retried instead; see
 * resumeDownloading() for why that is not a replay.
 */

import type { UpdateState } from "@ceraui/rpc/schemas";
import { logger } from "../../../helpers/logger.ts";
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

// Unlike an uncertain COMMIT, a DOWNLOAD may be retried. The persisted phase
// can lag a short commit (dpkg may already have run when the board died), but
// the retry is a fresh apt run, not a replay of the old one: nothing else runs
// after a reboot, apt repairs a half-installed package, and an already applied
// version is a no-op. Staying in `downloading` instead wedged the orchestrator
// with no unit left to report an outcome.
async function resumeDownloading(
	persisted: OrchestratorState,
	deps: OrchestratorResumeDeps,
): Promise<OrchestratorState> {
	let recovered: boolean;
	try {
		recovered = await deps.recoverSoftwareUpdateIfRunning();
	} catch (error) {
		// An unreadable probe proves nothing about the unit; the standalone
		// recovery retry may still reattach, so keep the phase as it is.
		logger.warn(
			"update-orchestrator: download resume could not probe the install unit; phase kept",
			{ error },
		);
		return persisted;
	}
	const wire = deps.getUpdateState();
	// A live unit, or a finished one whose outcome the tick will read, keeps
	// the existing poll path.
	if (
		recovered ||
		wire.kind === "installing" ||
		wire.kind === "downloading" ||
		wire.kind === "success" ||
		wire.kind === "failed"
	) {
		return persisted;
	}
	logger.warn(
		"update-orchestrator: persisted download has no install unit after restart; retrying the install",
		{ wire: wire.kind, enteredAt: persisted.enteredAt },
	);
	return reduceOrchestrator(persisted, {
		type: "DOWNLOAD_RESUME_UNIT_ABSENT",
		now: deps.now(),
	});
}

export async function resumeOrchestratorState(
	persisted: OrchestratorState,
	deps: OrchestratorResumeDeps,
): Promise<OrchestratorState> {
	if (persisted.phase === "committing") {
		return resumeCommitting(persisted, deps);
	}
	if (persisted.phase === "downloading") {
		return resumeDownloading(persisted, deps);
	}
	return persisted;
}
