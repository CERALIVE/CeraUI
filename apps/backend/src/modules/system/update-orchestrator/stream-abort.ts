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
import { abortAptTransferForStream } from "../apt-transfer-abort.ts";
import { SOFTWARE_UPDATE_UNIT } from "../software-update-service-contract.ts";
import { OsStageError } from "./os-stage-error.ts";
import { parseOsStageSystemdProperties } from "./os-stage-systemd.ts";

const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;

export const RAUC_SERVICE_UNIT = "rauc.service";
export const RAUC_ESCALATION_FIRST_LOOK_MS = 1_000;
export const RAUC_ESCALATION_GRACE_MS = 8_000;

export interface RaucEscalationScheduler {
	readonly now: () => number;
	readonly schedule: (task: () => Promise<void>, delayMs: number) => () => void;
}

const escalationScheduler: RaucEscalationScheduler = {
	now: () => performance.now(),
	schedule: (task, delayMs) => {
		const timer = setTimeout(() => void task(), delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

type RaucIdentity = {
	readonly mainPid: string;
	readonly invocationId: string;
};

// One lifetime also fences replies from a replaced, already-running observation.
let pendingEscalation: { cancel: () => void } | null = null;

function scheduleRaucEscalation(
	run: typeof spawnWithTimeout,
	scheduler: RaucEscalationScheduler,
	lifetime: { cancel: () => void },
): void {
	if (pendingEscalation !== lifetime) return;
	const warn = (error: unknown) => {
		logger.warn(
			"update-orchestrator: detached RAUC termination escalation failed",
			{
				error: error instanceof Error ? error : String(error),
			},
		);
	};
	try {
		const started = scheduler.now();
		const look = async (remembered?: RaucIdentity): Promise<void> => {
			let nextLook = false;
			try {
				if (pendingEscalation !== lifetime) return;
				const result = await run(
					[
						"systemctl",
						"show",
						"-p",
						"ActiveState",
						"-p",
						"MainPID",
						"-p",
						"InvocationID",
						RAUC_SERVICE_UNIT,
					],
					{ timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS },
				);
				if (pendingEscalation !== lifetime) return;
				const properties = parseOsStageSystemdProperties(result.stdout);
				if (result.exitCode !== 0 || !properties?.get("ActiveState"))
					throw new OsStageError("rauc_recovery_unproven");
				if (properties.get("ActiveState") !== "deactivating") return;
				const mainPid = properties.get("MainPID") ?? "";
				const invocationId = properties.get("InvocationID") ?? "";
				if (
					!/^[1-9]\d*$/.test(mainPid) ||
					Number(mainPid) <= 1 ||
					Number(mainPid) > 2_147_483_647 ||
					!/^[a-f0-9]{32}$/.test(invocationId)
				)
					throw new OsStageError("rauc_recovery_unproven");
				if (!remembered) {
					lifetime.cancel = scheduler.schedule(
						() => look({ mainPid, invocationId }),
						Math.max(0, started + RAUC_ESCALATION_GRACE_MS - scheduler.now()),
					);
					nextLook = true;
					return;
				}
				if (
					mainPid !== remembered.mainPid ||
					invocationId !== remembered.invocationId
				)
					return;
				const killed = await run(
					[
						"systemctl",
						"kill",
						"--signal=SIGKILL",
						"--kill-whom=all",
						RAUC_SERVICE_UNIT,
					],
					{ timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS },
				);
				if (killed.exitCode !== 0)
					throw new OsStageError("rauc_recovery_unproven", { cause: killed });
				logger.info("update-orchestrator: escalated stuck RAUC termination", {
					mainPid,
					invocationId,
					reason: "same daemon still deactivating after grace",
				});
			} catch (error) {
				warn(error);
			} finally {
				if (!nextLook && pendingEscalation === lifetime)
					pendingEscalation = null;
			}
		};
		lifetime.cancel = scheduler.schedule(
			() => look(),
			RAUC_ESCALATION_FIRST_LOOK_MS,
		);
	} catch (error) {
		if (pendingEscalation === lifetime) pendingEscalation = null;
		warn(error);
	}
}

/**
 * Keep the fresh-read/probe guard in the caller: stopping dpkg risks a
 * half-installed package.
 */
export async function stopPackageInstallUnitForStream(): Promise<void> {
	abortAptTransferForStream();
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
	scheduler: RaucEscalationScheduler = escalationScheduler,
): Promise<void> {
	pendingEscalation?.cancel();
	const lifetime: { cancel: () => void } = { cancel: () => undefined };
	pendingEscalation = lifetime;
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
	scheduleRaucEscalation(run, scheduler, lifetime);
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
