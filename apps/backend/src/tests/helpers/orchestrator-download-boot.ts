/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Boot resume of a persisted `downloading` phase, replayed from the opi r5x
 * mains-cut drill (X1, 2026-09-30, `46.5-power/`): the cut hit dpkg while the
 * persisted phase still said `downloading`, the board rebooted with no install
 * unit, discovery reported the half-installed package as available again, and
 * the orchestrator sat in `downloading` refusing every check/install.
 *
 * Round 17 narrowed the recovery: only a probe that PROVED the unit gone drops
 * the attempt (to `idle`, check due, plan left on disk); a skipped or failed probe
 * keeps `downloading` and is re-asked on later ticks.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../../modules/system/update-orchestrator/quarantine.ts";
import {
	defaultOrchestratorRuntimeDeps,
	type OrchestratorRuntimeDeps,
	startUpdateOrchestrator,
} from "../../modules/system/update-orchestrator/runtime.ts";
import type {
	OrchestratorPhase,
	OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";
import {
	CPUPOWER_PLAN,
	DOWNLOADING_WIRE,
	DRILL_ENTERED_AT,
	DRILL_PENDING,
	persistedDownloading,
} from "./orchestrator-download-inputs.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export const dirs: string[] = [];

export function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-download-resume-"));
	dirs.push(dir);
	return dir;
}

export interface Boot {
	readonly quarantine: UpdateQuarantine;
	readonly persisted: OrchestratorPhase[];
	readonly installs: { count: number };
}

export async function boot(
	persisted: OrchestratorState,
	overrides: Partial<OrchestratorRuntimeDeps>,
): Promise<Boot> {
	const dir = tempDir();
	setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
	saveOrchestratorState(persisted);
	const quarantine = new UpdateQuarantine(
		join(dir, "quarantine.json"),
		async () => {
			// Persist quarantine evidence without changing host APT pins.
		},
	);
	await quarantine.savePending(DRILL_PENDING);
	const phases: OrchestratorPhase[] = [];
	const installs = { count: 0 };
	await startUpdateOrchestrator({
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: () => Promise.resolve() },
		now: () => DRILL_ENTERED_AT + 45_000,
		random: () => 0.5,
		loadSettings: async () => ({
			packagesAuto: true,
			systemAuto: true,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		isIdle: async () => true,
		isStreamLive: () => false,
		onlyMeteredCandidateExists: async () => false,
		isCommitStageRunning: async () => false,
		startPackageInstall: () => {
			installs.count++;
			return { started: true };
		},
		inspectSlotSync: async () => ({ kind: "absent" }),
		quarantine,
		persist: (state) => {
			phases.push(state.phase);
			saveOrchestratorState(state);
		},
		...overrides,
	});
	return { quarantine, persisted: phases, installs };
}

export async function bootAwaitingIdleWithCpupowerPlan() {
	let wire: UpdateState = { kind: "idle" };
	const b = await boot(
		{ ...persistedDownloading, phase: "awaiting-idle", progress: null },
		{
			recoverSoftwareUpdateIfRunning: async () => false,
			getPackageInstallWireState: () => wire,
			startPackageInstall: () => {
				wire = DOWNLOADING_WIRE;
				return { started: true };
			},
			restartStale: async () => true,
		},
	);
	await b.quarantine.savePending(CPUPOWER_PLAN);
	return {
		quarantine: b.quarantine,
		setWire: (next: UpdateState) => {
			wire = next;
		},
	};
}
