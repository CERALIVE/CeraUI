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
 * `modem_shadow` orchestration (Phase B).
 *
 * Runs the `@ceralive/modem-control` READ-ONLY observer BESIDE the live mmcli path.
 * mmcli stays authoritative for actual modem control — shadow only WATCHES: on every
 * observer snapshot it maps both sides to the normalized {@link ShadowModemState} and
 * logs redacted divergences.
 *
 * MUTATION-FREE by construction and by guard: the observer is the narrow
 * `ModemObservationPort` (no mutation verb), and its transport is additionally
 * wrapped in {@link createAuditingTransport}, which FAILS CLOSED — any non-read call
 * (including `Signal.Setup`) is refused and never reaches the bus. See
 * `dbus-audit-transport.ts`.
 *
 * The composition root (`cellular-stack.ts`) is untouched: `modem_backend` still
 * selects the ACTIVE backend (default mmcli). `modem_shadow` is orthogonal — a
 * parallel observer that never becomes the control path. Production deps are built
 * lazily (`shadow-wiring.ts`) so the D-Bus transport never loads on the default path.
 */

import type {
	ModemObservationPort,
	ObservationList,
} from "@ceralive/modem-control";
import type { DbusTransport } from "@ceralive/modem-control/transport";

import { logger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";
import { createAuditingTransport } from "./dbus-audit-transport.ts";
import {
	classifyShadowDivergences,
	logShadowDivergences,
	type ShadowModemState,
} from "./shadow-divergence.ts";

export interface ShadowModeDeps {
	/** Build the raw D-Bus transport (production: the package's system-bus transport). */
	readonly createTransport: () => DbusTransport;
	/** Build the read-only observer over a transport (production: `createMmDbusObserver`). */
	readonly createObserver: (transport: DbusTransport) => ModemObservationPort;
	/** Read the current mmcli-reported modem states (the authoritative live side). */
	readonly readMmcliStates: () => readonly ShadowModemState[];
	/** Map an observer snapshot to normalized states (secret-dropping). */
	readonly mapObservation: (
		list: ObservationList,
	) => readonly ShadowModemState[];
	/** Divergence log sink (tests). Defaults to the redacted `logger.warn`. */
	readonly log?: (msg: string, meta: unknown) => void;
	/** Notified (member key) when the audit guard refuses a non-read call. */
	readonly onRefusal?: (member: string) => void;
}

interface RunningShadow {
	readonly observer: ModemObservationPort;
	readonly unobserve: () => void;
}

// Process-wide singleton, mirroring the composition-root singleton posture.
let running: RunningShadow | null = null;

/** Whether the shadow observer is currently running. */
export function isModemShadowRunning(): boolean {
	return running !== null;
}

/**
 * Start the read-only shadow observer beside mmcli. Idempotent: a second call while
 * one is running is a no-op. Never mutates the bus — the auditing transport refuses
 * every non-read call. A refused call flips an OBSERVABLE default warning unless the
 * caller supplies its own `onRefusal`.
 */
export async function startModemShadow(deps: ShadowModeDeps): Promise<void> {
	if (running !== null) {
		return;
	}

	const onRefusal =
		deps.onRefusal ??
		((member: string) =>
			logger.warn(
				`modem shadow refused a non-read D-Bus call (mutation-free invariant): ${member}`,
			));
	const audit = createAuditingTransport(deps.createTransport(), { onRefusal });
	const observer = deps.createObserver(audit);

	const compare = (list: ObservationList): void => {
		try {
			const dbusStates = deps.mapObservation(list);
			const mmcliStates = deps.readMmcliStates();
			const divergences = classifyShadowDivergences(mmcliStates, dbusStates);
			logShadowDivergences(divergences, { log: deps.log });
		} catch (err) {
			// Shadow must never destabilize the live path — swallow after logging.
			logger.debug(`modem shadow: divergence pass failed: ${err}`);
		}
	};

	const unobserve = observer.observe(compare);
	running = { observer, unobserve };

	const first = await observer.start();
	compare(first);
}

/** Stop the shadow observer and release its transport. Idempotent. */
export async function stopModemShadow(): Promise<void> {
	const current = running;
	running = null;
	if (current === null) {
		return;
	}
	current.unobserve();
	try {
		await current.observer.stop();
	} catch (err) {
		logger.debug(`modem shadow: stop() failed: ${err}`);
	}
}

/** Test seam: synchronously drop the running reference without awaiting teardown. */
export function resetModemShadow(): void {
	running?.unobserve();
	running = null;
}

/**
 * Start shadow mode iff `config.modem_shadow` is enabled. A no-op otherwise — so an
 * absent key (old config) and the default path never load the D-Bus transport.
 * Production deps are lazily imported so the package graph stays off the default path.
 */
export async function startModemShadowIfEnabled(): Promise<void> {
	if (getConfig().modem_shadow !== true) {
		return;
	}
	const { buildProductionShadowDeps } = await import("./shadow-wiring.ts");
	await startModemShadow(buildProductionShadowDeps());
}
