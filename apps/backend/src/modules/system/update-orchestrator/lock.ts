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
	// Positively read as loaded, inactive, dead and clean: a finished run that
	// systemd has already garbage-collected, or one that never ran. Only the
	// receipt can tell those apart, so only this shape may consult it.
	| { readonly kind: "inactive-clean" }
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

	if (activeState === "failed" || subState === "failed")
		return unsuccessfulExit(exitCodeOf(mainCodeRaw || "0", mainStatusRaw));

	// Inactive alone does not distinguish a fresh unit from a completed run.
	if (mainCodeRaw === "" || mainCodeRaw === "0") return { kind: "absent" };
	const exitCode = exitCodeOf(mainCodeRaw, mainStatusRaw);
	return exitCode === 0 ? { kind: "succeeded" } : unsuccessfulExit(exitCode);
}

const exitCodeOf = (mainCodeRaw: string, mainStatusRaw: string): number =>
	processExitCode(
		Number.parseInt(mainCodeRaw, 10),
		Number.parseInt(mainStatusRaw || "0", 10),
	);

// The script's refusal code means the same whichever lifecycle systemd leaves
// behind: a unit with SuccessExitStatus=75 would read inactive/dead, not failed.
function unsuccessfulExit(exitCode: number): SlotSyncProbeState {
	return exitCode === SLOT_SYNC_REFUSE_EXIT_CODE
		? { kind: "refused", exitCode }
		: { kind: "failed", exitCode };
}

const PROBE_PROPERTIES = [
	"LoadState",
	"ActiveState",
	"SubState",
	"ExecMainCode",
	"ExecMainStatus",
] as const;

const isUnset = (value: string | undefined): boolean =>
	value === "" || value === "0";

// The unit writes its receipt before `rauc status mark-good other`, which can
// still fail, so both shapes that consult the receipt must be read positively:
// systemctl exit 0, every property present (the parser defaults missing ones
// into success), and a loaded, inactive/dead unit whose exit record is either
// a clean CLD_EXITED 0 or wholly unset. Anything else is `absent`, which fails.
// Running/failed/refused keep the parser's verdict: none of them settles.
export function classifySlotSyncProbe(result: {
	readonly exitCode: number;
	readonly stdout: string;
}): SlotSyncProbeState {
	const parsed = parseSlotSyncProbe(result.stdout);
	if (parsed.kind !== "absent" && parsed.kind !== "succeeded") return parsed;
	const properties = parseProperties(result.stdout);
	const lines = result.stdout.split("\n");
	// parseProperties keeps the last duplicate, so a repeated key could hide a
	// contradicting value; count raw lines instead of trusting the map.
	const readable =
		result.exitCode === 0 &&
		PROBE_PROPERTIES.every(
			(key) => lines.filter((line) => line.startsWith(`${key}=`)).length === 1,
		) &&
		properties.get("LoadState") === "loaded" &&
		properties.get("ActiveState") === "inactive" &&
		properties.get("SubState") === "dead";
	if (!readable) return { kind: "absent" };
	const code = properties.get("ExecMainCode");
	const status = properties.get("ExecMainStatus");
	if (code === "1" && status === "0") return { kind: "succeeded" };
	if (isUnset(code) && isUnset(status)) return { kind: "inactive-clean" };
	return { kind: "absent" };
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
	return classifySlotSyncProbe(result);
}

export async function resetSlotSyncFailure(): Promise<void> {
	await spawnWithTimeout(["systemctl", "reset-failed", SLOT_SYNC_UNIT], {
		timeoutMs: SPAWN_TIMEOUT_MS,
	});
}
