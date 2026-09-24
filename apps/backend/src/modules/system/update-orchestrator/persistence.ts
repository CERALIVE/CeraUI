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
import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../../../helpers/config-loader.ts";
import type { OrchestratorState } from "./types.ts";

export const ORCHESTRATOR_STATE_FILE = "/data/ceralive/update-state/agent.json";

let statePath = ORCHESTRATOR_STATE_FILE;

export function setOrchestratorStateFilePathForTest(path: string | null): void {
	statePath = path ?? ORCHESTRATOR_STATE_FILE;
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
	};
}

/**
 * Returns `null` when no valid persisted state exists (first boot, missing
 * file, or a corrupt/foreign file that fails schema validation) — the caller
 * (resume.ts) treats that as "start fresh from idle", never as a reason to
 * throw or to guess a state.
 */
export async function loadOrchestratorState(
	filePath = statePath,
): Promise<OrchestratorState | null> {
	const present = await Bun.file(filePath).exists();
	if (!present) return null;
	const result = await loadJsonConfig(
		filePath,
		updateOrchestratorPersistedStateSchema,
	);
	if (!result.loaded || result.invalidFields.length > 0) return null;
	const parsed = updateOrchestratorPersistedStateSchema.safeParse(result.data);
	if (!parsed.success) return null;
	return fromPersisted(parsed.data);
}

export function saveOrchestratorState(
	state: OrchestratorState,
	filePath = statePath,
): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	writeFileAtomicSync(filePath, JSON.stringify(toPersisted(state)));
}
