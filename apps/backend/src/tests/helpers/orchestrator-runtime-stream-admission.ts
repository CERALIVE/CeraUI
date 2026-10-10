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

import type { OrchestratorRuntimeDeps } from "../../modules/system/update-orchestrator/runtime.ts";
import { fakeDeps } from "./orchestrator-runtime-harness.ts";

export function abortSpyDeps(
	overrides: Partial<OrchestratorRuntimeDeps> = {},
): {
	deps: OrchestratorRuntimeDeps;
	calls: { stop: number; kill: number };
} {
	const calls = { stop: 0, kill: 0 };
	const deps = fakeDeps({
		stopPackageInstallUnit: async () => {
			calls.stop++;
		},
		killAndRestartRaucForStream: async () => {
			calls.kill++;
		},
		...overrides,
	});
	return { deps, calls };
}
