/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The effects/runtime layer (Todo 36) — the three operator RPC actions and the
 * invariant the plan calls out explicitly: `installUpdatesNow` bypasses IDLE
 * but NEVER bypasses the D8 stream-admission block.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { UpdateQuarantine } from "../../modules/system/update-orchestrator/quarantine.ts";
import {
	defaultOrchestratorRuntimeDeps,
	type OrchestratorRuntimeDeps,
} from "../../modules/system/update-orchestrator/runtime.ts";
import { withMemoryPersistence } from "./orchestrator-memory-persistence.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export const quarantineDirs: string[] = [];

export function testQuarantine(): UpdateQuarantine {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-orchestrator-runtime-"));
	quarantineDirs.push(dir);
	return new UpdateQuarantine(join(dir, "quarantine.json"));
}

export function fakeDeps(
	overrides: Partial<OrchestratorRuntimeDeps> = {},
): OrchestratorRuntimeDeps {
	return withMemoryPersistence({
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		now: () => 1_000_000,
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
		runPackageCheck: async () => null,
		startPackageInstall: () => ({ started: true }),
		getPackageInstallWireState: () => ({ kind: "idle" }) as UpdateState,
		isCommitStageRunning: async () => false,
		checkOsManifest: async () => ({
			available: false,
			rateLimited: false,
			failed: false,
			reason: "",
		}),
		startSlotSync: async () => {
			// Package fixtures must not dispatch the host mirror service.
		},
		inspectSlotSync: async () => ({ kind: "absent" }),
		resetSlotSyncFailure: async () => {
			// The absent fixture unit has no host failure record to reset.
		},
		recoverSoftwareUpdateIfRunning: async () => false,
		persist: () => {
			// withMemoryPersistence owns authoritative fixture storage.
		},
		...overrides,
	});
}
