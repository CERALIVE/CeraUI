/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Persisted-config vs offered-set migration (boot reconcile).
//
// A device can carry a `pipeline` in config.json that the *current* hardware no
// longer offers (firmware swap, board re-flash, source-table change). Silently
// resetting it would discard the operator's intent; silently keeping it would
// let `start()` fail deep in the engine with an opaque error. Instead we
// reconcile at boot: validate the persisted pipeline against the offered set,
// and if it is gone, mark the migration state `unavailable`, log one actionable
// warning, and let the start path block with a structured error. The persisted
// value is never mutated — the operator picks a valid pipeline to clear it.

import { logger } from "../../helpers/logger.ts";

/** Stable structured error code returned to the client on a blocked start. */
export const PIPELINE_NOT_IN_OFFERED_SET =
	"pipeline_not_in_offered_set" as const;

export type PipelineMigrationState = "available" | "unavailable";

export type PipelineValidationResult =
	| { valid: true }
	| {
			valid: false;
			error: typeof PIPELINE_NOT_IN_OFFERED_SET;
			pipeline: string;
	  };

/**
 * Pure check: is `pipeline` present in the offered set?
 * Returns a structured result so callers never have to compose the error shape.
 */
export function validatePersistedPipeline(
	pipeline: string,
	offeredPipelines: readonly string[],
): PipelineValidationResult {
	if (offeredPipelines.includes(pipeline)) {
		return { valid: true };
	}
	return { valid: false, error: PIPELINE_NOT_IN_OFFERED_SET, pipeline };
}

// Module state: the boot reconcile verdict. Defaults to "available" so a fresh
// device with no persisted pipeline never blocks.
let migrationState: PipelineMigrationState = "available";

export function getPipelineMigrationState(): PipelineMigrationState {
	return migrationState;
}

export function isPersistedPipelineUnavailable(): boolean {
	return migrationState === "unavailable";
}

/**
 * Boot-time reconcile: validate the persisted pipeline against the offered set,
 * set the migration state, and log one warning when the pipeline is gone.
 *
 * A non-fatal, non-destructive operation — it NEVER mutates config and NEVER
 * gates boot. It only records the verdict the start path consults.
 */
export function reconcilePersistedPipeline(
	persistedPipeline: string | undefined,
	offeredPipelines: readonly string[],
): PipelineValidationResult {
	// No persisted pipeline (first boot / never configured): nothing to migrate.
	if (persistedPipeline === undefined) {
		migrationState = "available";
		return { valid: true };
	}

	const result = validatePersistedPipeline(persistedPipeline, offeredPipelines);
	if (result.valid) {
		migrationState = "available";
	} else {
		migrationState = "unavailable";
		logger.warn(
			`[config-migration] pipeline '${persistedPipeline}' not in offered set`,
		);
	}
	return result;
}

/**
 * Test-only: reset the module state between cases. Production code never calls
 * this — the state is established once at boot by reconcilePersistedPipeline.
 */
export function resetPipelineMigrationStateForTest(): void {
	migrationState = "available";
}
