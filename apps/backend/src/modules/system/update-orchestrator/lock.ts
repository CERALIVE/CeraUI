/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The slot-sync unit owns its lock. A queued systemd job is not a lock verdict;
 * inspect the unit's result rather than adding a backend-owned flock.
 */

import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { SOFTWARE_UPDATE_LOCK } from "../software-update-service-contract.ts";
import { processExitCode } from "../software-update-service-state.ts";

export { SOFTWARE_UPDATE_LOCK };

export const SLOT_SYNC_UNIT = "ceralive-slot-sync.service";
// The script's own documented convention (`readonly EX_REFUSE=75` in
// ceralive-slot-sync.sh) for "a pre-flight gate refused" — includes, but is
// not limited to, the update lock being held by a concurrent apt commit.
export const SLOT_SYNC_REFUSE_EXIT_CODE = 75;

const SPAWN_TIMEOUT_MS = 10_000;

export type SlotSyncProbeState =
	| { readonly kind: "absent" }
	| { readonly kind: "running" }
	| { readonly kind: "succeeded" }
	| { readonly kind: "refused"; readonly exitCode: number }
	| { readonly kind: "failed"; readonly exitCode: number };

function parseProperties(output: string): Map<string, string> {
	const properties = new Map<string, string>();
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		properties.set(line.slice(0, separator), line.slice(separator + 1));
	}
	return properties;
}

export function parseSlotSyncProbe(output: string): SlotSyncProbeState {
	const properties = parseProperties(output);
	if (properties.get("LoadState") !== "loaded") return { kind: "absent" };

	const activeState = properties.get("ActiveState") ?? "inactive";
	const subState = properties.get("SubState") ?? "dead";
	const mainCodeRaw = properties.get("ExecMainCode") ?? "";
	const mainStatusRaw = properties.get("ExecMainStatus") ?? "";

	if (
		activeState === "activating" ||
		activeState === "active" ||
		activeState === "reloading" ||
		activeState === "deactivating"
	) {
		return { kind: "running" };
	}

	if (activeState === "failed" || subState === "failed") {
		const exitCode = processExitCode(
			Number.parseInt(mainCodeRaw || "0", 10),
			Number.parseInt(mainStatusRaw || "0", 10),
		);
		return exitCode === SLOT_SYNC_REFUSE_EXIT_CODE
			? { kind: "refused", exitCode }
			: { kind: "failed", exitCode };
	}

	// Inactive alone does not distinguish a fresh unit from a completed run.
	if (mainCodeRaw === "" || mainCodeRaw === "0") return { kind: "absent" };
	const exitCode = processExitCode(
		Number.parseInt(mainCodeRaw, 10),
		Number.parseInt(mainStatusRaw || "0", 10),
	);
	return exitCode === 0 ? { kind: "succeeded" } : { kind: "failed", exitCode };
}

export async function startSlotSync(): Promise<void> {
	await spawnWithTimeout(["systemctl", "start", "--no-block", SLOT_SYNC_UNIT], {
		timeoutMs: SPAWN_TIMEOUT_MS,
	});
}

export async function inspectSlotSync(): Promise<SlotSyncProbeState> {
	const result = await spawnWithTimeout(
		[
			"systemctl",
			"show",
			SLOT_SYNC_UNIT,
			"--property=LoadState,ActiveState,SubState,ExecMainCode,ExecMainStatus",
			"--no-pager",
		],
		{ timeoutMs: SPAWN_TIMEOUT_MS },
	);
	return parseSlotSyncProbe(result.stdout);
}

export async function resetSlotSyncFailure(): Promise<void> {
	await spawnWithTimeout(["systemctl", "reset-failed", SLOT_SYNC_UNIT], {
		timeoutMs: SPAWN_TIMEOUT_MS,
	});
}
