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

/*
 * The three procedures that WRITE to a router-mode dongle's own admin API.
 *
 * They live beside `modems.procedure.ts` rather than in it because that file is
 * already several times over this repo's 250-pure-LOC ceiling — a defect todo 25
 * recorded and carried — and todo 22 Stage B would have added a third of its size
 * again. They build from the SAME exported `modemProcedure`, so the cellular
 * readiness gate stays uniform: a router write during the init window must refuse
 * for exactly the reason every other modem procedure does.
 *
 * All three route through todo 25's mutation interlock and NONE of them owns a
 * mutation-safety mechanism of its own. The split between them is exactly whether
 * the write can cost the LAN path to the device that must receive the next one:
 *
 *   mobile data / roaming    lease only  — proven writes, neither can cost the link
 *   network mode             lease only  — a radio-mode selection, likewise
 *   LAN subnet               JOURNALED   — the one write that moves the address
 *                                          every later request is sent to
 */

import {
	type SetRouterNetModeOutput,
	setRouterControlInputSchema,
	setRouterControlOutputSchema,
	setRouterNetModeInputSchema,
	setRouterNetModeOutputSchema,
	setRouterSubnetInputSchema,
	setRouterSubnetOutputSchema,
} from "@ceraui/rpc/schemas";

import { routerCellularIfnameForWireId } from "../../modules/modems/modem-wire-producer.ts";
import { modemStableKeyForIfname } from "../../modules/modems/mutation-identity.ts";
import {
	withJournaledModemMutation,
	withModemMutation,
} from "../../modules/modems/mutation-lease.ts";
import { refreshRouterAdminState } from "../../modules/network/network-interfaces.ts";
import type { RouterAdminCapabilities } from "../../modules/network/router-capabilities.ts";
import {
	applyRouterCellularControl,
	applyRouterNetMode,
} from "../../modules/network/router-cellular-control.ts";
import { getRouterCellularMarker } from "../../modules/network/router-cellular-scan.ts";
import {
	executeSubnetRewrite,
	prepareSubnetRewrite,
} from "../../modules/network/router-subnet-hygiene.ts";
// Imported for its SIDE EFFECT as well as its helper: loading it is what
// registers the `router-subnet` rollback on todo 25's registry, so a rewrite that
// crashed mid-flight has a handler waiting when startup replay reaches it.
import { preStateFor } from "../../modules/network/router-subnet-rollback.ts";
import { modemProcedure } from "./modems.procedure.ts";

/**
 * Resolve a `router-ethernet` wire id to the interface and marker behind it.
 *
 * Resolved from the SYNTHETIC ALLOCATION, not from `modemsState`: a router dongle
 * has no ModemManager entry at all, so the mmcli map cannot answer for it and
 * would hand back `undefined` for every one of these devices. Shared by the two
 * Stage-B write procedures so neither can invent a best-guess interface for an id
 * the classifier does not currently hold; `setRouterControlProcedure` keeps its
 * own byte-identical inline resolution because this todo MOVED that procedure and
 * did not change it.
 */
function resolveRouterTarget(
	device: string,
): { ifname: string; vidPid: string } | undefined {
	const ifname = routerCellularIfnameForWireId(Number(device));
	if (ifname === undefined || ifname === "") return undefined;
	const marker = getRouterCellularMarker(ifname);
	return marker === undefined ? undefined : { ifname, vidPid: marker.vid_pid };
}

/**
 * Change one setting on a router-mode dongle via its own HTTP admin API.
 *
 * The `device` here is the wire id of a `router-ethernet` row, and the ONLY
 * devices that can be acted on are the ones the classifier currently holds a
 * marker for — an id naming anything else is refused rather than routed to a
 * best-guess interface.
 *
 * Nothing about this path is optimistic. `applyRouterCellularControl` re-reads
 * the device after writing and answers `not_applied` when the setting did not
 * move, and the refreshed roster is broadcast so every client adopts the state
 * the DEVICE reported rather than the one the operator requested.
 */
export const setRouterControlProcedure = modemProcedure
	.input(setRouterControlInputSchema)
	.output(setRouterControlOutputSchema)
	.handler(async ({ input }) => {
		// Resolved from the SYNTHETIC ALLOCATION, not from `modemsState`: a router
		// dongle has no ModemManager entry at all, so the mmcli map cannot answer
		// for it and would hand back `undefined` for every one of these devices.
		const ifname = routerCellularIfnameForWireId(Number(input.device));
		if (ifname === undefined || ifname === "") {
			return { success: false, error: "unknown_device" };
		}
		const marker = getRouterCellularMarker(ifname);
		if (marker === undefined) {
			return { success: false, error: "unknown_device" };
		}

		// A router-admin write is a mutation like any other and takes the lease. It
		// is NOT journaled: the only writes reachable here are the two whose effect
		// was observed on real hardware, neither of which can cost the link, and
		// arming a rollback for a kind that has none would block the device on a
		// refusal that changed nothing.
		const guarded = await withModemMutation(
			modemStableKeyForIfname(ifname),
			() =>
				applyRouterCellularControl(
					ifname,
					marker.vid_pid,
					input.control,
					input.value,
				),
		);
		if (!guarded.ok) {
			return { success: false, mutationRefusal: guarded.refusal };
		}
		const result = guarded.value;
		if (result.status === "refused") {
			return { success: false, error: result.reason };
		}

		await refreshRouterAdminState();
		return { success: true, controls: result.controls };
	});

/**
 * The capability block, widened from the module's readonly shape to the wire's.
 *
 * A structural copy rather than a cast: `modem-wire-producer.ts` can afford
 * `as RouterAdmin` because the broadcast re-validates, and an output schema does
 * not — a cast here would let a future readonly-only field reach a consumer that
 * Zod would then strip in silence.
 */
function toWireCapabilities(
	capabilities: RouterAdminCapabilities,
): SetRouterNetModeOutput["capabilities"] {
	const netMode = capabilities.net_mode;
	return {
		net_mode:
			netMode.state === "reported"
				? { ...netMode, modes: netMode.modes.map((mode) => ({ ...mode })) }
				: { ...netMode },
	};
}

/**
 * Select one of the radio modes the dongle's own firmware advertised.
 *
 * The capability gate is NOT here — it is inside `applyRouterNetMode`, which
 * re-reads `/api/net/net-mode-list` in the same cycle as the write. Gating at the
 * procedure would mean acting on the 30 s poll cache, and a capability read
 * minutes ago is not a statement about the firmware answering now.
 *
 * It takes the lease and is NOT journaled: a radio-mode selection cannot cost the
 * LAN path to the device, so there is nothing a rollback would have to restore
 * that the next write cannot simply set again.
 */
export const setRouterNetModeProcedure = modemProcedure
	.input(setRouterNetModeInputSchema)
	.output(setRouterNetModeOutputSchema)
	.handler(async ({ input }) => {
		const target = resolveRouterTarget(input.device);
		if (target === undefined) {
			return { success: false, error: "unknown_device" as const };
		}

		const guarded = await withModemMutation(
			modemStableKeyForIfname(target.ifname),
			() => applyRouterNetMode(target.ifname, target.vidPid, input.mode),
		);
		if (!guarded.ok) {
			return { success: false, mutationRefusal: guarded.refusal };
		}
		const result = guarded.value;
		if (result.status === "refused") {
			return result.code === undefined
				? { success: false, error: result.reason }
				: { success: false, error: result.reason, code: result.code };
		}

		await refreshRouterAdminState();
		return {
			success: true,
			capabilities: toWireCapabilities(result.capabilities),
		};
	});

/**
 * Move the dongle's LAN subnet — the OPTIONAL hygiene operation.
 *
 * This is the only router write that is JOURNALED, and the ordering is the whole
 * safety argument: the pre-state is read first, the durable entry is armed with
 * it BEFORE anything is written, and the entry is cancelled only once the device
 * has been reached again — at its new address on success, or at its old one after
 * an auto-restore. A rewrite that can prove neither leaves the entry `failed`,
 * so the device is fail-closed until an operator acknowledges.
 *
 * It is never a prerequisite for anything. A twin pair sharing one factory subnet
 * bonds without it.
 */
export const setRouterSubnetProcedure = modemProcedure
	.input(setRouterSubnetInputSchema)
	.output(setRouterSubnetOutputSchema)
	.handler(async ({ input }) => {
		const target = resolveRouterTarget(input.device);
		if (target === undefined) {
			return { status: "refused" as const, error: "unknown_device" as const };
		}

		// Preflight BEFORE the lease: it is all reads, and the pre-state it returns
		// is what the journal must be armed with. The record is re-read under the
		// lease inside `executeSubnetRewrite`, which refuses `state_drifted` if it
		// moved in between — so nothing is written against a plan that went stale.
		const prepared = await prepareSubnetRewrite(
			target.ifname,
			target.vidPid,
			input.address,
		);
		if (!prepared.ok) {
			return prepared.conflict === undefined
				? { status: "refused" as const, error: prepared.reason }
				: {
						status: "refused" as const,
						error: prepared.reason,
						conflict: prepared.conflict,
					};
		}
		const plan = prepared.plan;

		const guarded = await withJournaledModemMutation(
			modemStableKeyForIfname(plan.ifname),
			"router-subnet",
			preStateFor(plan),
			async (mutation) => {
				const outcome = await executeSubnetRewrite(
					plan,
					mutation.markExecuting,
				);
				return {
					// `blocked` is the ONLY outcome that leaves the entry armed: a
					// refusal changed nothing and a reverted rewrite was reconfirmed
					// at the old address, so neither leaves an outstanding risk the
					// journal exists to describe.
					confirmed: outcome.status !== "blocked",
					value: outcome,
					...(outcome.status === "blocked" ? { detail: outcome.detail } : {}),
				};
			},
		);
		if (!guarded.ok) {
			return {
				status: "refused" as const,
				mutationRefusal: guarded.refusal,
			};
		}

		const outcome = guarded.value;
		if (outcome.status === "refused") {
			return { status: "refused" as const, error: outcome.reason };
		}
		if (outcome.status === "applied") {
			await refreshRouterAdminState();
			return { status: "applied" as const };
		}
		await refreshRouterAdminState();
		return { status: outcome.status, detail: outcome.detail };
	});
