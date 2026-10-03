import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../../../helpers/run.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { updatePinController } from "../update-transport/pin.ts";
import {
	UPDATE_TRANSPORT_RULE_PRIORITY,
	UPDATE_TRANSPORT_TABLE_BASE,
} from "../update-transport/pin-rules.ts";
import { OS_UPDATE_STATE_DIR } from "./os-manifest.ts";
import { proveOsGuardKernelOwnership } from "./os-stage-guard-lock.ts";
import {
	isOsStageGuardJobIdle,
	observeOsStageGuard,
} from "./os-stage-guard-observation.ts";
import { osInstallClientsGone } from "./os-stage-install-clients.ts";
import { observeRaucStage } from "./os-stage-observation.ts";
import { acquireOsOrphanLock } from "./os-stage-orphan-lock.ts";
import { drainRetainedOsStagePin } from "./os-stage-pin-retention.ts";
import { writeOsUnlaunchedWitness } from "./os-stage-unlaunched-witness.ts";

async function outcomesAbsent(): Promise<boolean> {
	for (const name of ["os-staged.json", "activation-armed"]) {
		try {
			await lstat(join(OS_UPDATE_STATE_DIR, name));
			return false;
		} catch (cause) {
			if (
				!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
			)
				throw cause;
		}
	}
	return true;
}

/** Real boards answer a never-created pin table with exit 2, not an empty list. */
export async function updatePinsClean(runner: typeof run): Promise<boolean> {
	for (const family of [[], ["-6"]]) {
		const rules = await runner("ip", [...family, "rule", "show"]);
		const priority = new RegExp(`^\\s*${UPDATE_TRANSPORT_RULE_PRIORITY}:`);
		if (rules.split("\n").some((row) => priority.test(row))) return false;
		for (const offset of [0, 1]) {
			const table = String(UPDATE_TRANSPORT_TABLE_BASE + offset);
			let routes: string;
			try {
				routes = await runner("ip", [
					...family,
					"-j",
					"route",
					"show",
					"table",
					table,
				]);
			} catch (cause) {
				const stderr: unknown =
					cause instanceof Error && "stderr" in cause
						? cause.stderr
						: undefined;
				if (
					typeof stderr === "string" &&
					stderr.includes("FIB table does not exist")
				)
					continue;
				throw cause;
			}
			if (z.array(z.unknown()).parse(JSON.parse(routes)).length) return false;
		}
	}
	return true;
}

export const defaultOsUnlaunchedEffects = {
	run: spawnWithTimeout,
	observe: observeRaucStage,
	cliGone: () => osInstallClientsGone(),
	drain: drainRetainedOsStagePin,
	sweep: () => updatePinController.sweep(),
	pinClean: () => updatePinsClean(run),
	outcomesAbsent,
	lock: acquireOsOrphanLock,
	kernel: proveOsGuardKernelOwnership,
	witness: writeOsUnlaunchedWitness,
	now: () => performance.now(),
	sleep: (ms: number) => Bun.sleep(ms),
	jobIdle: () => isOsStageGuardJobIdle(spawnWithTimeout),
	inspect: (attemptId: string) =>
		observeOsStageGuard(spawnWithTimeout, attemptId),
};
