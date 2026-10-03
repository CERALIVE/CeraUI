/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Persistence for the update orchestrator's own state (Todo 36):
 * `/data/ceralive/update-state/agent.json`, atomic write (reuses the SAME
 * `writeFileAtomicSync` convention as Todo 31/33/etc — sibling temp file,
 * fsync, atomic rename), read+validated with the shared Zod schema so a
 * corrupt or foreign file is never silently trusted.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	type UpdateOrchestratorPersistedState,
	updateOrchestratorPersistedStateSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";
import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../../../helpers/config-loader.ts";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import { initialOrchestratorState, type OrchestratorState } from "./types.ts";

export const ORCHESTRATOR_STATE_FILE = "/data/ceralive/update-state/agent.json";

let statePath = ORCHESTRATOR_STATE_FILE;

export class OrchestratorRecoveryLoadError extends Error {
	override readonly name = "OrchestratorRecoveryLoadError";
	constructor(readonly terminalState: OrchestratorState) {
		super(
			"Invalid OS recovery metadata; persisted update state requires maintenance",
		);
	}
}

export function setOrchestratorStateFilePathForTest(path: string | null): void {
	statePath = path ?? ORCHESTRATOR_STATE_FILE;
}

export function orchestratorStateFilePath(): string {
	return statePath;
}

export function toPersisted(
	state: OrchestratorState,
): UpdateOrchestratorPersistedState {
	return {
		schema: 1,
		phase: state.phase,
		enteredAt: state.enteredAt,
		progress: state.progress,
		failureReason: state.failureReason,
		packageCheck: state.packageCheck,
		osCheck: state.osCheck,
		cellularOverrideId: state.cellularOverrideId,
		...(state.osStageDiscoveryRetryAt !== undefined
			? { osStageDiscoveryRetryAt: state.osStageDiscoveryRetryAt }
			: {}),
		...(state.osStageRecovery
			? { osStageRecovery: state.osStageRecovery }
			: {}),
	};
}

export function fromPersisted(
	persisted: UpdateOrchestratorPersistedState,
): OrchestratorState {
	return {
		phase: persisted.phase,
		enteredAt: persisted.enteredAt,
		progress: persisted.progress,
		failureReason: persisted.failureReason,
		packageCheck: persisted.packageCheck,
		osCheck: persisted.osCheck,
		cellularOverrideId: persisted.cellularOverrideId,
		...(persisted.osStageDiscoveryRetryAt !== undefined
			? { osStageDiscoveryRetryAt: persisted.osStageDiscoveryRetryAt }
			: {}),
		...(persisted.osStageRecovery
			? { osStageRecovery: persisted.osStageRecovery }
			: {}),
	};
}

/**
 * Returns `null` when no valid persisted state exists (first boot, missing
 * file, or a corrupt/foreign file that fails schema validation) — the caller
 * (resume.ts) treats that as "start fresh from idle", never as a reason to
 * throw or to guess a state. Invalid present OS recovery metadata is different:
 * it throws a typed terminal snapshot so startup cannot erase a prior failure.
 */
export async function loadOrchestratorState(
	filePath = statePath,
): Promise<OrchestratorState | null> {
	const present = await Bun.file(filePath).exists();
	if (!present) return null;
	const result = await loadJsonConfig(
		filePath,
		z.record(z.string(), z.unknown()),
	);
	if (!result.loaded || result.invalidFields.length > 0) return null;
	const parsed = updateOrchestratorPersistedStateSchema.safeParse(result.data);
	if (!parsed.success) {
		if (
			!Object.hasOwn(result.data, "osStageRecovery") &&
			!Object.hasOwn(result.data, "osStageDiscoveryRetryAt")
		)
			return null;
		const legacy = updateOrchestratorPersistedStateSchema.safeParse({
			...result.data,
			osStageRecovery: undefined,
			osStageDiscoveryRetryAt: undefined,
		});
		const terminal = legacy.success
			? fromPersisted(legacy.data)
			: initialOrchestratorState(0);
		throw new OrchestratorRecoveryLoadError({
			...terminal,
			phase: terminal.phase === "quarantined" ? "quarantined" : "failed",
			progress: null,
			failureReason: terminal.failureReason ?? "os_stage_recovery_invalid",
		});
	}
	return fromPersisted(parsed.data);
}

export function saveOrchestratorState(
	state: OrchestratorState,
	filePath = statePath,
	syncParent: (filePath: string) => void = syncOrchestratorDirectory,
): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	writeFileAtomicSync(filePath, JSON.stringify(toPersisted(state)));
	syncParent(filePath);
}
