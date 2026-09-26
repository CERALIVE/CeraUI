/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The shared `/run/lock/ceralive-update.lock` (Todo 36). This orchestrator is
 * the FIRST consumer that actually invokes `ceralive-slot-sync` from CeraUI's
 * side (Todo 26 built the script; its own header comment names "the future
 * lagged-mirror orchestrator... the CeraUI update agent" as its caller).
 *
 * There is no separate "acquire the lock" primitive to import here: Todo 35's
 * OWN mechanism is "wrap the privileged command in `flock -x
 * SOFTWARE_UPDATE_LOCK ...` inside the systemd-run invocation" (see
 * `software-update-service-contract.ts::expectedAptAllScript`), and
 * `ceralive-slot-sync run` takes the SAME lock path NON-BLOCKINGLY (`flock -n
 * -x`) INSIDE its own script (image-building-pipeline
 * `mkosi/runtime/ceralive-slot-sync.sh`, read-only reference). Both share the
 * identical `SOFTWARE_UPDATE_LOCK` constant re-exported below rather than a
 * second literal path — the "small helper" this task reuses IS that shared
 * constant plus the systemd-run/flock WRAPPING TECHNIQUE, not a new
 * lock-acquisition function, because there is nothing for a Node/Bun-side
 * `flock()` call to do: every lock-holding operation is a SEPARATE process
 * (a detached apt unit, or the slot-sync unit) that takes and releases the OS
 * lock itself.
 *
 * `systemctl start --no-block` returns immediately once the unit is queued —
 * it does NOT wait for (or report) the lock outcome. The lock is INSIDE the
 * unit's `run` subcommand, so a "lock busy" refusal only becomes observable
 * once the unit finishes and is probed (`inspectSlotSync`), reported as exit
 * code 75 (`EX_REFUSE`, the script's own documented convention) with
 * `ActiveState=failed`.
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

/**
 * `ceralive-slot-sync.service` is `Type=oneshot` with NO `RemainAfterExit` —
 * a SUCCESSFUL run returns to `ActiveState=inactive`/`SubState=dead` (exactly
 * like "never started"), so `succeeded` is distinguished ONLY by
 * `ExecMainCode`/`ExecMainStatus` still being readable and zero. A FAILED run
 * (any non-zero exit, including the refused-gate exit 75) transitions systemd
 * into `ActiveState=failed` and STAYS there until the unit is started again —
 * this is what lets `refused`/`failed` be told apart from a fresh "absent"
 * unit at all.
 */
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

	// inactive/dead. Never started (mainCodeRaw empty) vs a previous SUCCESSFUL
	// run (ExecMainCode=1/CLD_EXITED, ExecMainStatus=0) are both possible here.
	if (mainCodeRaw === "" || mainCodeRaw === "0") return { kind: "absent" };
	const exitCode = processExitCode(
		Number.parseInt(mainCodeRaw, 10),
		Number.parseInt(mainStatusRaw || "0", 10),
	);
	return exitCode === 0 ? { kind: "succeeded" } : { kind: "failed", exitCode };
}

/**
 * Fires the unit and returns as soon as systemd has QUEUED it — `--no-block`
 * means this call says nothing about the lock outcome (see module doc).
 */
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

/** Mirrors Todo 35's terminal-cleanup step so a failed/refused run does not
 * leave the unit stuck in `ActiveState=failed` for the next attempt. */
export async function resetSlotSyncFailure(): Promise<void> {
	await spawnWithTimeout(["systemctl", "reset-failed", SLOT_SYNC_UNIT], {
		timeoutMs: SPAWN_TIMEOUT_MS,
	});
}
