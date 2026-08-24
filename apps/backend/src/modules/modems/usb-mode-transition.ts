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
 * The `modems.setUsbMode` dispatch body — everything the RPC procedure does AFTER
 * its three entry gates (provisioning / emulated / streaming) have passed and the
 * `"modem-transition"` lifecycle lease is HELD.
 *
 * THE ORDER IS THE CONTRACT, and it is ordered by blast radius:
 *
 *   1. IDENTIFY   — a real udev/sysfs enumeration resolves the physical device
 *                   behind the requested modem id: its VID:PID, model, firmware
 *                   revision, current composition mode, `ID_PATH`-derived
 *                   `stable_key`, and the physical UID the transition needs to
 *                   re-find it AFTER it re-enumerates.
 *   2. CERTIFY    — the SKU is looked up in `@ceralive/modem-control`'s certified
 *                   catalog and the requested `from → to` must be a PERMITTED
 *                   transition of that entry. A miss is `uncertified`.
 *   3. DISPATCH   — and only now is the transition engine touched at all.
 *
 * Steps 1 and 2 are pure reads. **Nothing in this module may call the transition
 * engine before step 3**, which is what makes the Phase-A TIER-A guarantee
 * ("an entry refusal fires ZERO engine calls") provable with a spy rather than
 * asserted in a comment. The engine itself re-checks its own preconditions twice
 * (entry + in-actor) — our catalog check does not replace that, it precedes it, so
 * a doomed request never reaches a component that serialises behind real hardware.
 *
 * WHY THE CATALOG GATE IS THE ONE REAL DEVICES HIT TODAY. The shipped catalog
 * carries exactly one synthetic bench SKU: no real modem has a reviewed evidence
 * bundle yet (Phase-A Must-NOT-Have 7 — no catalog entry without one). So on a
 * provisioned board the honest answer for every attached modem is `uncertified`,
 * and that is a FIRST-CLASS rendered state, not a stopgap.
 *
 * WHY THE ENGINE IS A SEAM. `UsbModeTransition` needs MUTATION ports — MM
 * inhibit/uninhibit, an AT sender, an NM quiesce/activate adapter. CeraUI's only
 * D-Bus surface today is the deliberately mutation-FREE audited transport
 * (`dbus-audit-transport.ts`), so there is nothing to build them from and
 * {@link defaultUsbModeDispatchDeps} resolves no engine. That state is reported
 * as the typed `engine_unavailable` reason — never as a silent success, and never
 * as a fake transition. Wiring a real engine is a matter of supplying
 * `createEngine`; every gate, mapping and postcondition path above it is live.
 */

import {
	CERTIFIED_CATALOG,
	findPermittedTransition,
} from "@ceralive/modem-control";
import type {
	ModemMutationRefusal,
	UsbCompositionMode,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";
import { getIsStreaming } from "../streaming/streaming.ts";

import { withJournaledModemMutation } from "./mutation-lease.ts";
import { createTransitionEngine } from "./transition-engine.ts";
import {
	refuse,
	type UsbModeDispatchDeps,
	type UsbModeDispatchResult,
} from "./usb-mode-contract.ts";
import { executeTransition } from "./usb-mode-execute.ts";
import {
	confirmModemDataPath,
	defaultResolveConnectionId,
	defaultResolveIdentity,
	isMmTransitionMode,
	matchCertifiedEntry,
} from "./usb-mode-identity.ts";
import { defaultRuntimeCompositionQuery } from "./usb-mode-runtime.ts";

export const defaultUsbModeDispatchDeps: UsbModeDispatchDeps = {
	resolveIdentity: defaultResolveIdentity,
	catalog: CERTIFIED_CATALOG,
	queryRuntimeComposition: defaultRuntimeCompositionQuery,
	// Read through the SAME accessors the dispatch's own first and third gates
	// use, so the reason an offer is withheld and the reason a dispatch is
	// refused can never disagree about the state of one device.
	isProvisioningEnabled: () => getConfig().modem_provisioning === true,
	isBlockedByLiveState: () => getIsStreaming(),
	resolveConnectionId: defaultResolveConnectionId,
	// The physical-topology UID is what MM keys a Device inhibit on and is the one
	// identifier available without a mutation-capable D-Bus client.
	resolveInhibitUid: (identity) => Promise.resolve(identity.physicalUid),
	createEngine: (identity) =>
		createTransitionEngine({
			stableKey: identity.stableKey,
			ports: identity.ports,
		}),
	confirmDataPath: (ifname) => confirmModemDataPath(ifname),
	rediscover: async () => {
		// Lazy import mirrors `sim-autounlock.ts`: a static one would cycle with
		// modem-update-loop.ts.
		const { discoverModems } = await import("./modem-update-loop.ts");
		await discoverModems();
	},
	now: () => Date.now(),
};

let activeDeps: UsbModeDispatchDeps = defaultUsbModeDispatchDeps;

/** Test-only: swap the dispatch dependencies. NEVER call from production code. */
export function setUsbModeDispatchDeps(
	deps: Partial<UsbModeDispatchDeps>,
): void {
	activeDeps = { ...defaultUsbModeDispatchDeps, ...deps };
}

/** Test-only: restore the production dependencies. */
export function resetUsbModeDispatchDeps(): void {
	activeDeps = defaultUsbModeDispatchDeps;
}

/**
 * The deps the dispatch is CURRENTLY running with — shared with the pure-read
 * options path so the offered set and this gate cannot resolve identity or match
 * the catalog differently. A second deps instance is how they would drift.
 */
export function getUsbModeDispatchDeps(): UsbModeDispatchDeps {
	return activeDeps;
}

/**
 * Map a mutation-lease refusal onto this procedure's wire vocabulary. Every one
 * of them is a first-class refusal rather than a `transition_failed`, because a
 * device blocked pending acknowledgement and a transaction that broke call for
 * different operator actions.
 */
function refuseLease(refusal: ModemMutationRefusal): UsbModeDispatchResult {
	if (refusal === "identity_unresolved") {
		return refuse("transition_failed", "identity_unresolved");
	}
	if (refusal === "mutation_in_progress") {
		return refuse("transition_in_progress");
	}
	return { success: false, error: refusal };
}

/**
 * Run one USB-composition-mode transition. It TAKES this device's mutation lease
 * itself (identity has to be resolved before a per-device lease can be keyed), so
 * the caller only owns the provisioning / real-device / live-stream gates — a
 * second copy of a gate is how two copies drift apart.
 *
 * The rollback is ARMED — pre-state committed durably — before the first
 * connectivity-losing call, and is cancelled only after the engine's postcondition
 * AND a confirmed re-registration with a live data path. A dependency that THROWS
 * is deliberately NOT caught here: the journaled wrapper releases in a `finally`
 * on a throw as well as a return, and swallowing it would make that release path
 * untestable.
 */
export async function runUsbModeTransition(
	deviceId: string,
	target: UsbCompositionMode,
	deps: UsbModeDispatchDeps = activeDeps,
): Promise<UsbModeDispatchResult> {
	// ── 1. IDENTIFY ──────────────────────────────────────────────────────────
	const identity = await deps.resolveIdentity(deviceId);
	if (identity === undefined) {
		return refuse("transition_failed", "identity_unresolved");
	}

	// ── 2. CERTIFY (pure reads — zero engine calls past this point on refusal) ─
	// A non-MM target (`rndis` / `router-ethernet`) crosses the MM↔router line the
	// catalog schema forbids outright, so it can never be a permitted transition.
	if (!isMmTransitionMode(target)) return refuse("uncertified");
	const from = identity.currentMode;
	if (from === undefined || !isMmTransitionMode(from)) {
		return refuse("uncertified");
	}
	if (from === target) {
		// Already there. Nothing to transition, and re-running the transaction
		// would drop a healthy bond link for no change.
		return { success: true };
	}

	const entry = matchCertifiedEntry(deps.catalog, identity);
	if (entry === undefined) return refuse("uncertified");
	if (findPermittedTransition(entry, from, target) === undefined) {
		return refuse("uncertified");
	}

	// ── 3. DISPATCH ──────────────────────────────────────────────────────────
	// The mutation lease is taken FIRST, before the engine and the NM connection
	// are resolved: those reads are the opening steps of the transaction, and a
	// device already being mutated must be told so rather than being told its
	// engine could not be built. The journaled entry is armed by the same call,
	// so the pre-state is durable before any connectivity-losing step runs.
	const journaled = await withJournaledModemMutation(
		identity.stableKey,
		"usb-mode",
		{
			vidPid: identity.vidPid,
			model: identity.model,
			firmwareRevision: identity.firmwareRevision,
			mode: from,
			ifname: identity.ifname,
		},
		async (mutation) => {
			const engine = deps.createEngine(identity);
			if (engine === undefined) {
				logger.warn(
					`modems.setUsbMode(${deviceId} → ${target}): certified, but no transition engine is wired`,
					{ module: "modems", stableKey: identity.stableKey },
				);
				// Nothing was dispatched, so the pre-state is still current and the
				// armed entry is cancelled rather than left blocking the device.
				return {
					confirmed: true,
					value: refuse("transition_failed", "engine_unavailable"),
				};
			}

			const nmConnection = await deps.resolveConnectionId(identity.ifname);
			const inhibitUid = await deps.resolveInhibitUid(identity);
			if (nmConnection === undefined || inhibitUid === undefined) {
				return {
					confirmed: true,
					value: refuse("transition_failed", "identity_unresolved"),
				};
			}

			return executeTransition({
				deps,
				deviceId,
				engine,
				entry,
				from,
				identity,
				inhibitUid,
				mutation,
				nmConnection,
				target,
			});
		},
	);
	return journaled.ok ? journaled.value : refuseLease(journaled.refusal);
}
