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
 * The gated GPS/location module.
 *
 * THE PRIVACY FENCE IS A PRODUCT RULE, NOT A PHASE LIMITATION. Everything below
 * reads the CURRENT fix and nothing else: no history, no track log, no export,
 * no upload, and nothing written to disk. The only place a coordinate lives is
 * {@link sessions}, an in-memory map that holds AT MOST ONE fix per device and
 * is cleared the moment GNSS is switched off. `tests/modem-gps-fence.test.ts`
 * fails the build if a persistence or upload primitive appears in this module.
 *
 * THERE IS NO BACKGROUND POLLER, AND THAT IS PART OF THE FENCE. The state
 * machine is advanced by `readModemGps`, i.e. only while an operator is actually
 * looking at the card. A device nobody is watching produces no fix at all, so
 * "we only hold a position while it is on screen" is true by construction rather
 * than by a retention policy someone has to enforce.
 *
 * THE CAPABILITY CACHE EXISTS BECAUSE THE WIRE BUILD IS SYNCHRONOUS.
 * `buildModemsWireMessage` cannot await an mmcli read, so this follows the
 * `band-capability.ts` / `policy-route-check.ts` precedent: an async read writes
 * a snapshot and a sync getter serves it.
 */

import type {
	CapabilityEvidence,
	GnssFixState,
	ModemGpsRefusal,
	ModemGpsStatus,
	SetModemGpsOutput,
} from "@ceraui/rpc/schemas";
import { IMPLEMENTED_MODEM_CAPABILITY_MODULES } from "./capability-evidence.ts";
import { withCapabilityModuleMutation } from "./capability-mutation.ts";
import {
	advanceGnssFixState,
	GNSS_OFF,
	type GnssRead,
} from "./gps-fix-state.ts";
import {
	type LocationCliRunner,
	type LocationStatus,
	readLocationFix,
	readLocationStatus,
	setLocationGnss,
} from "./mmcli-location.ts";
import { resolveModemIdentityAnchor } from "./mutation-identity.ts";

export type ModemGpsSnapshot = {
	readonly capability: CapabilityEvidence;
	readonly status: ModemGpsStatus;
};

const capabilityCache = new Map<string, ModemGpsSnapshot>();

/**
 * The ONLY place a coordinate is retained, and it is memory-only.
 *
 * Keyed on `stable_key` so a re-enumeration under a new mmcli index keeps the
 * same session rather than silently restarting the bounded wait.
 */
const sessions = new Map<string, GnssFixState>();

export function resetModemGpsState(): void {
	capabilityCache.clear();
	sessions.clear();
}

function toWireStatus(status: LocationStatus): ModemGpsStatus {
	return {
		capabilities: [...status.capabilities],
		enabledSources: [...status.enabledSources],
		gnssCapable: status.gnssCapable,
		gnssEnabled: status.gnssEnabled,
	};
}

function recordCapability(
	stableKey: string,
	status: LocationStatus,
): ModemGpsStatus {
	const wire = toWireStatus(status);
	capabilityCache.set(stableKey, {
		capability: status.gnssCapable ? "present" : "absent",
		status: wire,
	});
	return wire;
}

/** The capability half of the evidence, for `capability-evidence.ts`. */
export function gpsEvidence(stableKey: string | undefined): CapabilityEvidence {
	if (stableKey === undefined) return "unknown";
	return capabilityCache.get(stableKey)?.capability ?? "unknown";
}

function sessionState(stableKey: string): GnssFixState {
	return sessions.get(stableKey) ?? GNSS_OFF;
}

function advance(
	stableKey: string,
	event: Parameters<typeof advanceGnssFixState>[1],
): GnssFixState {
	const next = advanceGnssFixState(sessionState(stableKey), event);
	if (next.kind === "off") {
		// Nothing to retain. Deleting rather than storing `off` is what makes the
		// "a fix never outlives the receiver" property observable in the map.
		sessions.delete(stableKey);
	} else {
		sessions.set(stableKey, next);
	}
	return next;
}

export type ModemGpsReadOutcome =
	| { success: true; status: ModemGpsStatus; state: GnssFixState }
	| { success: false; error: ModemGpsRefusal };

export type ModemGpsDeps = {
	readonly now: () => number;
	readonly runCli?: LocationCliRunner;
	/**
	 * Resolves the device to the SAME `stable_key` the wire producer and the
	 * mutation lease use, so the row an operator is looking at, the session that
	 * holds their fix, and the lease that guards the toggle are one device.
	 */
	readonly resolveIdentity?: (
		deviceId: string,
	) => Promise<{ stableKey: string } | undefined>;
};

const defaultDeps: ModemGpsDeps = { now: () => Date.now() };

function identityOf(
	deps: ModemGpsDeps,
): (deviceId: string) => Promise<{ stableKey: string } | undefined> {
	return deps.resolveIdentity ?? resolveModemIdentityAnchor;
}

/**
 * Read status plus the current fix, advancing the bounded state machine.
 *
 * A modem with GNSS OFF is not asked for a fix at all — `--location-get` on a
 * disabled receiver is a refusal, and reporting that refusal as `no-fix` would
 * tell an operator their antenna is searching when nothing is switched on.
 */
export async function readModemGps(
	deviceId: string,
	deps: ModemGpsDeps = defaultDeps,
): Promise<ModemGpsReadOutcome> {
	const identity = await identityOf(deps)(deviceId);
	if (identity === undefined) {
		return { success: false, error: "unknown_modem" };
	}
	const read = await readLocationStatus(deviceId, deps.runCli);
	if (!read.ok) {
		return { success: false, error: read.reason };
	}

	const stableKey = identity.stableKey;
	const status = recordCapability(stableKey, read.status);

	if (!read.status.gnssEnabled) {
		return {
			success: true,
			status,
			state: advance(stableKey, { kind: "gnss-disabled" }),
		};
	}

	const at = deps.now();
	const fix = await readLocationFix(deviceId, at, deps.runCli);
	const outcome: GnssRead = !fix.ok
		? { outcome: "unavailable", reason: fix.reason }
		: fix.fix === undefined
			? { outcome: "no-fix" }
			: { outcome: "fix", fix: fix.fix };

	return {
		success: true,
		status,
		state: advance(stableKey, { kind: "read", at, read: outcome }),
	};
}

/**
 * Switch GNSS on or off under the capability-module mutation lease.
 *
 * LEASE-ONLY, NOT JOURNALED, and that classification is enforced by the type
 * system rather than by this comment: `gps` is absent from
 * `JOURNALED_CAPABILITY_MODULES`, so the request arm it takes here cannot carry
 * a `preState`. The reason is that `Location.Setup` touches no bearer — there is
 * no bond link a rollback would have to restore.
 */
export async function setModemGps(
	deviceId: string,
	enabled: boolean,
	deps: ModemGpsDeps = defaultDeps,
): Promise<SetModemGpsOutput> {
	const identity = await identityOf(deps)(deviceId);
	if (identity === undefined) {
		return { success: false, error: "unknown_modem" };
	}
	const stableKey = identity.stableKey;

	// PROVE the capability before asking the gate about it. The gate fails closed
	// on `unknown`, and a modem nothing has read yet IS unknown — so without this
	// read the very first toggle on a perfectly capable modem would be refused
	// `module_unavailable` and the operator would have no way to make it true.
	// This is the `band-lock` ordering: read, record, then take the lease.
	const probe = await readLocationStatus(deviceId, deps.runCli);
	if (!probe.ok) {
		return { success: false, error: probe.reason };
	}
	recordCapability(stableKey, probe.status);
	if (!probe.status.gnssCapable) {
		return { success: false, error: "unsupported" };
	}

	const guarded = await withCapabilityModuleMutation<SetModemGpsOutput>(
		{
			module: "gps",
			stableKey,
			implemented: IMPLEMENTED_MODEM_CAPABILITY_MODULES,
		},
		async () => {
			const applied = await setLocationGnss(deviceId, enabled, deps.runCli);
			if (!applied.ok) {
				return {
					confirmed: true,
					value: {
						success: false,
						error: applied.reason,
						...(applied.detail === undefined ? {} : { detail: applied.detail }),
					} satisfies SetModemGpsOutput,
				};
			}

			const status = recordCapability(stableKey, applied.status);
			// Enabling STARTS the bounded wait; disabling clears the session, which
			// is what drops any held coordinates. Both are keyed on what the modem
			// reports after the call, never on what was requested.
			const state = applied.status.gnssEnabled
				? advance(stableKey, { kind: "gnss-enabled", at: deps.now() })
				: advance(stableKey, { kind: "gnss-disabled" });

			return {
				confirmed: true,
				value: { success: true, status, state } satisfies SetModemGpsOutput,
			};
		},
	);

	if (!guarded.ok) {
		return { success: false, mutationRefusal: guarded.refusal };
	}
	return guarded.value;
}
