/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * D8 command effects. Nonzero exits are logged; spawn failures/timeouts throw.
 * See root AGENTS.md D8 Known gaps (g)-(h) and docs/DEVICE-UPDATES.md's D8
 * section before treating a returned call as cancellation or a completed start.
 */

import { logger } from "../../../helpers/logger.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { SOFTWARE_UPDATE_UNIT } from "../software-update-service-contract.ts";
import { OsStageError } from "./os-stage-error.ts";

const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;

export const RAUC_SERVICE_UNIT = "rauc.service";

/**
 * Keep the fresh-read/probe guard in the caller: stopping dpkg risks a
 * half-installed package.
 */
export async function stopPackageInstallUnitForStream(): Promise<void> {
	const result = await spawnWithTimeout(
		["systemctl", "stop", SOFTWARE_UPDATE_UNIT],
		{ timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS },
	);
	if (result.exitCode !== 0) {
		logger.warn(
			"update-orchestrator: stopping the in-flight package-install unit for an admitted stream start did not exit cleanly",
			{ exitCode: result.exitCode, stderr: result.stderr },
		);
	}
}

export async function killAndRestartRaucForStream(
	run = spawnWithTimeout,
): Promise<void> {
	const killResult = await run(
		["systemctl", "kill", "--signal=SIGTERM", RAUC_SERVICE_UNIT],
		{ timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS },
	);
	if (killResult.exitCode !== 0) {
		logger.warn(
			"update-orchestrator: killing rauc.service for an admitted stream start did not exit cleanly",
			{ exitCode: killResult.exitCode, stderr: killResult.stderr },
		);
	}
	const restartResult = await run(
		["systemctl", "restart", "--no-block", RAUC_SERVICE_UNIT],
		{ timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS },
	);
	if (restartResult.exitCode !== 0) {
		logger.warn(
			"update-orchestrator: submitting rauc.service restart after an admitted-stream kill did not exit cleanly",
			{ exitCode: restartResult.exitCode, stderr: restartResult.stderr },
		);
		throw new OsStageError("rauc_recovery_unproven", { cause: restartResult });
	}
}
