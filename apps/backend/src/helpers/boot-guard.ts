/*
    CeraUI - web UI for the CeraLive project
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

/**
 * Boot fail-soft guards (S6 — highest production blast-radius).
 *
 * The `main.ts` boot chain is a top-level-`await` module: before this guard, a
 * single rejected awaited init (identity, control-channel, pipelines, RTMP
 * ingest) crashed the whole process — bricking boot in the field and, worse,
 * never binding the WS control server, the operator's only lifeline to the
 * device. These guards classify each init explicitly:
 *
 *   - {@link guardNonCritical}: an init that MAY fail. A throw/rejection is
 *     logged, recorded on the boot-readiness surface ({@link markBootDegraded}),
 *     and swallowed so boot continues. The device degrades to a
 *     readiness-reduced state instead of crashing.
 *   - {@link runCritical}: an init that MUST succeed (the config load, the WS
 *     control-server bind). A failure is logged loudly and re-thrown so the
 *     process aborts (systemd restarts it) rather than limping in a state where
 *     it cannot serve anything.
 *
 * Collaborators are injected (logger, markDegraded) so the contract is unit
 * testable without running the real boot.
 */

import { markBootDegraded } from "../modules/system/readiness.ts";
import { logger } from "./logger.ts";

export interface BootGuardLogger {
	info: (message: string, meta?: unknown) => void;
	error: (message: string, meta?: unknown) => void;
}

export interface BootGuardDeps {
	logger: BootGuardLogger;
	markDegraded: (subsystem: string) => void;
}

function defaultDeps(): BootGuardDeps {
	return { logger, markDegraded: markBootDegraded };
}

/**
 * Run a NON-CRITICAL boot init. Never throws. On failure: log the error, flag
 * the subsystem degraded on the readiness surface, and return `false` so boot
 * continues to the critical WS-server bind. Returns `true` on success.
 */
export async function guardNonCritical(
	subsystem: string,
	run: () => Promise<void> | void,
	overrides: Partial<BootGuardDeps> = {},
): Promise<boolean> {
	const deps: BootGuardDeps = { ...defaultDeps(), ...overrides };
	try {
		await run();
		return true;
	} catch (err) {
		deps.markDegraded(subsystem);
		deps.logger.error(
			`boot: non-critical init "${subsystem}" failed; continuing in readiness-reduced state`,
			{ err },
		);
		return false;
	}
}

/**
 * Run a CRITICAL boot init. On failure: log loudly and re-throw the original
 * error so the top-level-`await` module rejects and the process aborts — the
 * device cannot usefully serve without it, so a clean restart beats limping.
 */
export async function runCritical(
	subsystem: string,
	run: () => Promise<void> | void,
	overrides: Partial<BootGuardDeps> = {},
): Promise<void> {
	const deps: BootGuardDeps = { ...defaultDeps(), ...overrides };
	try {
		await run();
	} catch (err) {
		deps.logger.error(
			`boot: CRITICAL init "${subsystem}" failed; aborting boot`,
			{ err },
		);
		throw err instanceof Error ? err : new Error(String(err));
	}
}
