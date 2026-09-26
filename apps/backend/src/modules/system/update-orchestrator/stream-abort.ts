/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The I/O half of D8's "abort-network" action (Todo 37) — the privileged
 * `systemctl` calls `runtime.ts`'s `admitAndPrepareStreamStart` dispatches once
 * it has decided (after its own forced-fresh wire-state re-check) that it is
 * genuinely safe to interrupt the in-flight operation.
 *
 * Both functions are BEST-EFFORT: D8 says `downloading`/`os-staging` are
 * ALLOWED regardless of whether the abort itself succeeds (the admitted stream
 * start must never be blocked by a `systemctl` hiccup), so neither throws on a
 * non-zero exit — it logs and lets the caller proceed. See the accepted-risk
 * comment on `admitAndPrepareStreamStart` for why an occasional interrupted
 * dpkg run (a DIFFERENT, narrower risk than this file's job) is fine to leave
 * to Todo 27's `ceralive-dpkg-recover.service` rather than engineered away here.
 */

import { logger } from "../../../helpers/logger.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { SOFTWARE_UPDATE_UNIT } from "../software-update-service-contract.ts";

const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;

/** The RAUC D-Bus service unit name, matching `rauc.service` on the image. */
export const RAUC_SERVICE_UNIT = "rauc.service";

/**
 * Stops the detached apt unit (Todo 35's single-flock `apt-get -d && apt-get
 * install` script). `systemctl stop` sends SIGTERM to the whole transient
 * unit's cgroup (default `KillMode=control-group`), which tears down the
 * wrapping `flock`/`sh -ec` shell AND its `apt-get` child together — safe to
 * call ONLY while still genuinely downloading (the caller has already done
 * the forced-fresh re-check before reaching here).
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

/**
 * RAUC 1.13-class has no clean "cancel this install" verb, so the in-flight
 * bundle install is killed with SIGTERM and the service is restarted so it is
 * available again for the next staging attempt. The install only ever writes
 * to the INACTIVE (target) slot — never the booted one — so a kill mid-write
 * leaves that slot marked bad; the next attempt reuses already-downloaded
 * blocks via Todo 22's adaptive block-hash-index verity bundles rather than
 * re-downloading from scratch.
 */
export async function killAndRestartRaucForStream(): Promise<void> {
	const killResult = await spawnWithTimeout(
		["systemctl", "kill", "--signal=SIGTERM", RAUC_SERVICE_UNIT],
		{ timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS },
	);
	if (killResult.exitCode !== 0) {
		logger.warn(
			"update-orchestrator: killing rauc.service for an admitted stream start did not exit cleanly",
			{ exitCode: killResult.exitCode, stderr: killResult.stderr },
		);
	}
	const restartResult = await spawnWithTimeout(
		["systemctl", "restart", RAUC_SERVICE_UNIT],
		{ timeoutMs: SYSTEMD_COMMAND_TIMEOUT_MS },
	);
	if (restartResult.exitCode !== 0) {
		logger.warn(
			"update-orchestrator: restarting rauc.service after an admitted-stream kill did not exit cleanly",
			{ exitCode: restartResult.exitCode, stderr: restartResult.stderr },
		);
	}
}
