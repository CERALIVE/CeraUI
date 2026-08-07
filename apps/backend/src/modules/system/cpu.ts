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

/*
 * CPU topology — the DENOMINATOR `device-stats.cpuLoad1` was missing.
 *
 * A 1-minute load average is a count of runnable tasks, so it is meaningless
 * without the core count to divide it by: on an 8-core RK3588 a reported `1.00`
 * is roughly an eighth of the board, but it reads as saturation to anyone who
 * does not already know how many cores the board has. That was the operator
 * report this signal exists to answer.
 *
 * ITS OWN BROADCAST, not a sixth `device-stats` field. That payload is frozen by
 * the S1 lock and three tests assert its keys EXACTLY, so this follows the
 * precedent `encoder-load` and `fan` already set.
 *
 * A BOOT FACT, not a sample. Core count cannot change without a reboot on this
 * hardware, so it is resolved once and re-served from the post-auth
 * initial-state push — the same treatment `revisions.kernel` gets, for the same
 * reason. There is deliberately no polling loop.
 *
 * NOT `isRealDevice()`-gated, unlike `fan`/`encoder-load`. Those read
 * board-specific sysfs nodes that a dev host genuinely does not have; every host
 * has CPUs, so gating this one would leave the dev and CI paths rendering the
 * bare load average the fix replaced.
 *
 * NEVER ASSUMED. A host that cannot report its topology publishes `cores: null`
 * and the UI falls back to showing the raw load average. Substituting a plausible
 * count would fabricate the denominator the whole signal exists to supply.
 */

import { cpus } from "node:os";

import type { CpuInfo } from "@ceraui/rpc";

import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

export const CPU_EVENT = "cpu" as const;

/** The honest floor, shared so every caller reports the same object shape. */
export const CPU_UNKNOWN: CpuInfo = { cores: null };

export type CpuDeps = {
	/** Online CPU count. `cpus().length` in production — never a constant. */
	cpuCount: () => number;
};

export const defaultCpuDeps: CpuDeps = {
	cpuCount: () => cpus().length,
};

/**
 * A count is only usable as a divisor when it is a positive integer, so anything
 * else — a throwing reader, a zero-length list on a platform that cannot
 * enumerate CPUs, a non-integral value — degrades to `null` rather than to a
 * number that would silently distort every percentage derived from it.
 */
export function collectCpuInfo(deps: CpuDeps = defaultCpuDeps): CpuInfo {
	try {
		const count = deps.cpuCount();
		if (!Number.isInteger(count) || count <= 0) {
			logger.warn("cpu: unusable core count", { count });
			return CPU_UNKNOWN;
		}
		return { cores: count };
	} catch (err) {
		logger.warn("cpu: core-count read failed", { err });
		return CPU_UNKNOWN;
	}
}

let lastCpu: CpuInfo = CPU_UNKNOWN;

/** The resolved topology, for the post-auth initial-state push. */
export function getCpuInfo(): CpuInfo {
	return lastCpu;
}

export function initCpu(deps: CpuDeps = defaultCpuDeps): void {
	lastCpu = collectCpuInfo(deps);
	logger.debug("cpu: topology resolved", { cores: lastCpu.cores });
	broadcastMsg(CPU_EVENT, lastCpu, getms() - ACTIVE_TO);
}
