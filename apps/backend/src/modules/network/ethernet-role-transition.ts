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
  The Ethernet role transition, and the boot reconciliation of the operator's
  persisted choice.

  EVERY EXIT PATH ENDS IN A TERMINAL FRAME, with exactly one publisher per path
  — the `wifi-adapter-mode-transition.ts` contract, applied to a wired port. A
  refusal decided here publishes here; an admitted transition publishes a pending
  frame and then exactly one terminal frame once NetworkManager has answered.

  ROLLBACK IS PERSIST-FIRST. The role is written before NetworkManager is
  touched (so a device that dies mid-transition comes back trying for the
  operator's role) and RESTORED the moment NM refuses, so a failed flip leaves
  neither the config nor the netif flags half-applied.
*/

import type { EthernetRole, EthernetRoleError } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	ETHERNET_ROLE_DEFAULT,
	getEthernetRole,
	getPersistedEthernetRoles,
	isEthernetRoleCandidate,
	persistEthernetRole,
	restoreEthernetRole,
} from "./ethernet-role.ts";
import {
	type EthernetRoleOutcomePublisher,
	publishEthernetRoleOutcome,
} from "./ethernet-role-outcome.ts";
import {
	applySharedLanBondGate,
	getNetworkInterfaces,
	triggerNetworkInterfacesChange,
} from "./network-interfaces.ts";
import { nmConnect, nmConnSetFields, nmDeviceProp } from "./network-manager.ts";

/**
 * `shared` is what makes NetworkManager run DHCP + DNS + NAT on the port;
 * `auto` restores the ordinary DHCP-client uplink. Nothing else on the profile
 * is touched — the operator's addressing, DNS and route settings are theirs.
 */
const IPV4_METHOD_FOR_ROLE: Record<EthernetRole, string> = {
	uplink: "auto",
	"shared-lan": "shared",
};

export interface EthernetRoleTransitionDeps {
	readonly listInterfaces: () => Record<string, unknown>;
	readonly resolveConnection: (ifname: string) => Promise<string | undefined>;
	readonly setFields: (
		uuid: string,
		fields: Record<string, string>,
	) => Promise<boolean>;
	readonly activate: (uuid: string) => Promise<boolean>;
	readonly persistRole: (ifname: string, role: EthernetRole) => void;
	readonly restoreRole: (
		ifname: string,
		previous: EthernetRole | undefined,
	) => void;
	readonly readPersistedRole: (ifname: string) => EthernetRole | undefined;
	readonly publishOutcome: EthernetRoleOutcomePublisher;
	readonly refreshInterfaces: () => void;
}

/**
 * The device's active connection for this interface.
 *
 * `nmcli` prints NOTHING for a device NetworkManager holds no connection on, so
 * an empty read is "no profile to configure" rather than a failed one — the
 * caller answers `no_connection` and writes nothing.
 */
async function resolveDeviceConnection(
	ifname: string,
): Promise<string | undefined> {
	const values = await nmDeviceProp(ifname, "GENERAL.CON-UUID");
	const uuid = values?.[0]?.trim();
	return uuid ? uuid : undefined;
}

function refreshNetifRoleFlags(): void {
	applySharedLanBondGate(getNetworkInterfaces());
	triggerNetworkInterfacesChange();
}

export const defaultEthernetRoleDeps: EthernetRoleTransitionDeps = {
	listInterfaces: getNetworkInterfaces,
	resolveConnection: resolveDeviceConnection,
	setFields: nmConnSetFields,
	activate: nmConnect,
	persistRole: persistEthernetRole,
	restoreRole: restoreEthernetRole,
	readPersistedRole: (ifname) => getPersistedEthernetRoles()[ifname],
	publishOutcome: publishEthernetRoleOutcome,
	refreshInterfaces: refreshNetifRoleFlags,
};

export interface SetEthernetRoleResult {
	success: boolean;
	applied?: EthernetRole;
	error?: EthernetRoleError;
}

function refuse(
	name: string,
	error: EthernetRoleError,
	deps: EthernetRoleTransitionDeps,
): SetEthernetRoleResult {
	deps.publishOutcome(name, { success: false, error });
	return { success: false, error };
}

/**
 * Apply the role to NetworkManager: rewrite `ipv4.method`, then re-activate so
 * the change takes effect. NM bakes the method into the ACTIVATION, so a write
 * with no re-activation leaves the port running its previous method while the
 * profile claims otherwise.
 */
async function applyRoleToNetworkManager(
	ifname: string,
	role: EthernetRole,
	deps: EthernetRoleTransitionDeps,
): Promise<EthernetRoleError | undefined> {
	const uuid = await deps.resolveConnection(ifname);
	if (!uuid) return "no_connection";

	const written = await deps.setFields(uuid, {
		"ipv4.method": IPV4_METHOD_FOR_ROLE[role],
	});
	if (!written) return "apply_failed";

	const activated = await deps.activate(uuid);
	if (!activated) return "apply_failed";

	return undefined;
}

export async function setEthernetRole(
	name: string,
	role: EthernetRole,
	deps: EthernetRoleTransitionDeps = defaultEthernetRoleDeps,
): Promise<SetEthernetRoleResult> {
	if (!isEthernetRoleCandidate(name)) return refuse(name, "not_ethernet", deps);
	if (deps.listInterfaces()[name] === undefined) {
		return refuse(name, "unknown_interface", deps);
	}

	const previous = deps.readPersistedRole(name);
	if ((previous ?? ETHERNET_ROLE_DEFAULT) === role) {
		// Already there: nothing is dispatched, so no NM answer will ever settle
		// and this branch owes the terminal frame itself. The role is still
		// recorded — the operator has now stated it explicitly.
		deps.persistRole(name, role);
		deps.refreshInterfaces();
		deps.publishOutcome(name, { success: true, role });
		return { success: true, applied: role };
	}

	deps.persistRole(name, role);
	deps.publishOutcome(name, { pending: true, role });

	const failure = await applyRoleToNetworkManager(name, role, deps);
	if (failure !== undefined) {
		deps.restoreRole(name, previous);
		deps.refreshInterfaces();
		return refuse(name, failure, deps);
	}

	deps.refreshInterfaces();
	deps.publishOutcome(name, { success: true, role });
	return { success: true, applied: role };
}

/**
 * Re-apply every stated `shared-lan` role at boot.
 *
 * IDEMPOTENT: it compares against the persisted role and re-asserts the SAME
 * NetworkManager method, so running it twice writes the same value twice and
 * dispatches nothing new. An `uplink` entry is skipped entirely — that is the
 * default, and rewriting `ipv4.method auto` onto every ordinary port at boot
 * would touch profiles the operator never asked us to touch.
 *
 * FAIL-SOFT: it never throws and never rejects. A port that is not present, or
 * whose NM profile could not be rewritten, is LOGGED and left alone — the role
 * is deliberately NOT cleared, because a device that has not finished
 * enumerating must not be read as a refusal that discards the operator's choice.
 */
export async function reconcileEthernetRoles(
	deps: EthernetRoleTransitionDeps = defaultEthernetRoleDeps,
	readRoles: () => Readonly<
		Record<string, EthernetRole>
	> = getPersistedEthernetRoles,
): Promise<void> {
	try {
		const roles = readRoles();
		const shared = Object.keys(roles).filter(
			(ifname) => roles[ifname] === "shared-lan",
		);
		if (shared.length === 0) return;

		const interfaces = deps.listInterfaces();

		for (const ifname of shared) {
			if (interfaces[ifname] === undefined) {
				logger.debug(
					`ethernet role reconcile: ${ifname} is not present; leaving shared-lan pending`,
				);
				continue;
			}

			// Per port, so one interface that throws cannot cost every other its
			// reconciliation.
			try {
				const failure = await applyRoleToNetworkManager(
					ifname,
					"shared-lan",
					deps,
				);
				if (failure !== undefined) {
					logger.warn(
						`ethernet role reconcile: ${ifname} could not be restored to shared-lan (${failure})`,
					);
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error(
					`ethernet role reconcile: ${ifname} threw restoring shared-lan: ${message}`,
				);
			}
		}

		deps.refreshInterfaces();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`ethernet role reconcile failed: ${message}`);
	}
}

export { getEthernetRole };
