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
 * A persisted `downloading` whose unit is PROVEN gone is neither replayed nor
 * retried: the interrupted plan is dropped and fresh discovery decides whether
 * anything is still left to install (adjudicateInterruptedDownload()).
 */

import type { UpdateState } from "@ceraui/rpc/schemas";
import type { InstallUnitVerdict } from "../software-updates.ts";
import { reduceOrchestrator } from "./reducer.ts";
import type { OrchestratorState } from "./types.ts";

export interface OrchestratorResumeDeps {
	readonly recoverSoftwareUpdateIfRunning: () => Promise<boolean>;
	/**
	 * What the recovery call's own probe established. Without it a download
	 * can never be proved interrupted, so it stays deferred (the safe side).
	 */
	readonly lastInstallUnitVerdict?: () => InstallUnitVerdict;
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

export type DownloadResumeDecision =
	/** A unit was reattached or the wire already carries its outcome. */
	| { readonly kind: "unit-observed" }
	/** No unit by our name exists and nothing on the wire says otherwise. */
	| { readonly kind: "unit-absent"; readonly state: OrchestratorState }
	/** The probe did not run or failed: absence is unproven, ask again later. */
	| {
			readonly kind: "undecided";
			readonly cause: "probe-failed" | "not-probed";
			readonly error?: unknown;
	  };

// The persisted phase can lag a short commit, so a missing unit says nothing
// about dpkg: the transaction may have finished, half-finished, or never run.
// Replaying the stored plan would act on that stale intent (an empty plan even
// fails the launcher), so a proven absence only returns to `idle` with the
// package check due, and discovery decides from the system as it is now. A
// `false` from recovery is not proof: it also means "never looked" (updates
// disabled), and treating that as absence once let a stream start skip the
// commit-stage probe while a surviving unit could be running dpkg.
export async function adjudicateInterruptedDownload(
	persisted: OrchestratorState,
	deps: OrchestratorResumeDeps,
): Promise<DownloadResumeDecision> {
	let recovered: boolean;
	try {
		recovered = await deps.recoverSoftwareUpdateIfRunning();
	} catch (error) {
		return { kind: "undecided", cause: "probe-failed", error };
	}
	const wire = deps.getUpdateState();
	if (
		recovered ||
		wire.kind === "installing" ||
		wire.kind === "downloading" ||
		wire.kind === "success" ||
		wire.kind === "failed"
	) {
		return { kind: "unit-observed" };
	}
	if (deps.lastInstallUnitVerdict?.() !== "absent") {
		return { kind: "undecided", cause: "not-probed" };
	}
	return {
		kind: "unit-absent",
		state: reduceOrchestrator(persisted, {
			type: "DOWNLOAD_RESUME_UNIT_ABSENT",
			now: deps.now(),
		}),
	};
}

export async function resumeOrchestratorState(
	persisted: OrchestratorState,
	deps: OrchestratorResumeDeps,
): Promise<OrchestratorState> {
	if (persisted.phase === "committing") {
		return resumeCommitting(persisted, deps);
	}
	if (persisted.phase === "downloading") {
		const decision = await adjudicateInterruptedDownload(persisted, deps);
		return decision.kind === "unit-absent" ? decision.state : persisted;
	}
	return persisted;
}
