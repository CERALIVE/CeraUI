/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Backend-start resume reconciliation (Todo 36, G17: the backend may be
 * restarted by its OWN package upgrade). Every phase must be handled
 * gracefully on resume; `committing` is the SAFETY-CRITICAL one:
 *
 *   dpkg MUST NEVER run twice for the same transaction.
 *
 * This module therefore NEVER spawns a new apt/dpkg invocation. For
 * `committing` it queries Todo 35's EXISTING, already-boot-wired recovery
 * mechanism (`recoverSoftwareUpdateIfRunning` — probes the detached
 * `ceralive-software-update.service` unit's live systemd state and re-attaches
 * to it if still running, or reports its already-finished exit code; it never
 * re-invokes apt-get) and reads the SAME derived `getUpdateState()` the rest
 * of the backend already trusts. The resume decision is a pure MAPPING of
 * those two read-only observations onto the persisted orchestrator phase.
 *
 * Every other "in-flight operation" phase (`os-staging`, `syncing`,
 * `os-activation-armed`) has no equivalent live-recovery mechanism to query
 * yet (OS staging is Todo 39's job; a slot-sync run's own liveness is only
 * observable via `inspectSlotSync`, which the runtime's normal tick loop
 * already re-polls). Resume therefore leaves them UNCHANGED rather than
 * guessing — the conservative choice is always to re-observe on the next tick,
 * never to re-issue a privileged action from an ambiguous restart.
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
	// etaSeconds is honestly unknown across a resume boundary (no timing history
	// survives a process restart) — 0 rather than a fabricated estimate.
	return { percent, etaSeconds: 0 };
}

async function resumeCommitting(
	persisted: OrchestratorState,
	deps: OrchestratorResumeDeps,
): Promise<OrchestratorState> {
	const now = deps.now();
	// Read-only: reattaches to the detached unit's OWN process if it is still
	// running, or reads its already-recorded exit outcome. Never spawns apt.
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
	// The unit was genuinely ABSENT (recoverSoftwareUpdateIfRunning found
	// nothing to reattach to) — never started, or already garbage-collected
	// with nothing to show. Rather than guess "it must have succeeded" (which
	// could silently leave a half-applied transaction unresolved) or blindly
	// retry (which could double-run dpkg if some OTHER path already started
	// it), this resolves to a typed, operator-visible UNRESOLVED outcome that
	// requires an explicit RESET before any further automatic action. This is
	// deliberately COMMIT_RESUME_UNRESOLVED, not COMMIT_FAILED: dpkg is not
	// known to have run at all, so there is no confirmed-bad version to
	// quarantine/pin (quarantined) — only genuine uncertainty (failed).
	if (!recovered) {
		return reduceOrchestrator(persisted, {
			type: "COMMIT_RESUME_UNRESOLVED",
			now,
			reason: "commit_unit_absent_on_resume",
		});
	}
	// recovered === true but the wire state is neither installing/downloading
	// nor a terminal success/failure (e.g. still "idle" or "checking" —
	// shouldn't happen given recoverSoftwareUpdateIfRunning's own contract, but
	// the reducer/resume path must stay total). Same conservative treatment.
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
	// Every other phase (including the other lock-holding phases os-staging and
	// syncing) resumes as a structural pass-through: no new privileged effect is
	// triggered by resume itself. The runtime's normal scheduler/tick loop is
	// what re-observes and continues (or times out) an in-flight operation.
	return persisted;
}
