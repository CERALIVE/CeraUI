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
  THE per-port Ethernet role: uplink, or shared-LAN router.

  It is deliberately a LEAF — persistence plus one pure candidate rule, and
  nothing that touches NetworkManager. The transition lives in
  `ethernet-role-transition.ts`, which imports the NM helpers; keeping the two
  apart is what lets `network-interfaces.ts` read the persisted role (to stamp
  the bond gate) without pulling the whole nmcli graph into the netif poll. The
  same split `wifi-adapter-mode.ts` has from its own transition module.
*/

import { type EthernetRole, ethernetRoleSchema } from "@ceraui/rpc/schemas";

import { getConfig, saveConfig } from "../config.ts";

export const ETHERNET_ROLE_DEFAULT: EthernetRole = "uplink";

/*
  Which interfaces may be given a role AT ALL.

  This is the ONE place in the network modules where an interface NAME is a
  legitimate input, and the reason is that it answers a different question from
  every rule around it. `usb-net-classifier.ts` refuses names because it decides
  what a device IS — and this bench's twin dongles prove a name cannot carry
  that. This decides which SOCKET an operator may declare a role for, and the
  NetworkManager profile the role drives is itself bound by
  `connection.interface-name`, so the name is the shared handle by construction.

  `enx*` is INCLUDED: a USB ethernet adapter is a wired port an operator may
  legitimately hand to LAN clients. Nothing is gated on the classification —
  the role is default-absent, so a router-cellular dongle is untouched unless
  somebody deliberately declares one for it.
*/
const ETHERNET_IFNAME_RE = /^(?:eth|en)/;

export function isEthernetRoleCandidate(ifname: string): boolean {
	return ETHERNET_IFNAME_RE.test(ifname);
}

/** Every stated role, keyed by interface name. */
export function getPersistedEthernetRoles(): Readonly<
	Record<string, EthernetRole>
> {
	return getConfig().eth_roles ?? {};
}

/**
 * The port's effective role. Absence resolves to `uplink`, so an untouched
 * device behaves exactly as it did before roles existed.
 */
export function getEthernetRole(ifname: string): EthernetRole {
	return getPersistedEthernetRoles()[ifname] ?? ETHERNET_ROLE_DEFAULT;
}

export function isSharedLanPort(ifname: string): boolean {
	return getEthernetRole(ifname) === "shared-lan";
}

/**
 * Record the operator's choice.
 *
 * Persisted BEFORE NetworkManager is touched, on `wifi-adapter-mode.ts`'s
 * terms: the persisted value is what the boot reconciler re-applies, so a
 * device that loses power mid-transition comes back trying for the operator's
 * role rather than silently keeping the one it was leaving.
 */
export function persistEthernetRole(ifname: string, role: EthernetRole): void {
	const config = getConfig();
	config.eth_roles = { ...(config.eth_roles ?? {}), [ifname]: role };
	saveConfig();
}

/**
 * Restore a previous role after a failed transition.
 *
 * `undefined` REMOVES the key rather than writing the default: a port that had
 * never been given a role must not acquire one because an attempt failed.
 */
export function restoreEthernetRole(
	ifname: string,
	previous: EthernetRole | undefined,
): void {
	const config = getConfig();
	const next = { ...(config.eth_roles ?? {}) };
	if (previous === undefined) {
		delete next[ifname];
	} else {
		next[ifname] = previous;
	}
	config.eth_roles = next;
	saveConfig();
}

/**
 * The role to publish on this interface's netif row, or `undefined` when the
 * row is not an ethernet port and therefore makes no claim.
 */
export function ethernetRoleForWire(ifname: string): EthernetRole | undefined {
	if (!isEthernetRoleCandidate(ifname)) return undefined;
	return getEthernetRole(ifname);
}

export function isEthernetRole(value: unknown): value is EthernetRole {
	return ethernetRoleSchema.safeParse(value).success;
}
