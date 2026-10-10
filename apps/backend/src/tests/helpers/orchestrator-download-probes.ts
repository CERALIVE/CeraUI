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

import type { OrchestratorRuntimeDeps } from "../../modules/system/update-orchestrator/runtime.ts";

export type ProbeOutcome = "attached" | "absent" | "not-probed" | "throws";

export function scriptedProbe(outcomes: readonly ProbeOutcome[]) {
	const calls = { count: 0 };
	let last: "attached" | "absent" | "not-probed" = "not-probed";
	return {
		calls,
		deps: {
			recoverSoftwareUpdateIfRunning: async () => {
				const outcome =
					outcomes[Math.min(calls.count, outcomes.length - 1)] ?? "not-probed";
				calls.count++;
				last = "not-probed";
				if (outcome === "throws") throw new Error("systemctl show: unreadable");
				last = outcome;
				return outcome === "attached";
			},
			lastInstallUnitVerdict: () => last,
		} as Partial<OrchestratorRuntimeDeps>,
	};
}

export function gatedProbe(
	outcomes: readonly ProbeOutcome[],
	gatedCall: number,
) {
	const scripted = scriptedProbe(outcomes);
	const recover = scripted.deps.recoverSoftwareUpdateIfRunning;
	let release: () => void = () => {
		// Replaced synchronously by the promise executor before use.
	};
	let markEntered: () => void = () => {
		// Replaced synchronously by the promise executor before use.
	};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	return {
		calls: scripted.calls,
		release: () => release(),
		entered,
		deps: {
			...scripted.deps,
			recoverSoftwareUpdateIfRunning: async () => {
				if (scripted.calls.count + 1 === gatedCall) {
					markEntered();
					await gate;
				}
				return (await recover?.()) ?? false;
			},
		} as Partial<OrchestratorRuntimeDeps>,
	};
}
