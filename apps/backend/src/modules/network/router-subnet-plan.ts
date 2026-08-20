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
 * Deciding whether a dongle's LAN subnet MAY be moved, and to what — purely.
 *
 * Two same-model router dongles ship one factory LAN subnet between them, so the
 * host leases the SAME address twice and both answer their admin API on the same
 * gateway. Moving one of them onto its own subnet is genuine hygiene: it makes
 * every address-steered operation on this box able to name a device again.
 *
 * ── IT IS HYGIENE, AND IT IS NEVER A BONDING PREREQUISITE ───────────────────
 *
 * Bonding already works across the collision, and it does NOT work because of
 * anything in this file: `bind-map.ts` describes each uplink by INTERFACE, and
 * `srtla_send` binds `SO_BINDTODEVICE`, so a twin pair on one subnet bonds with
 * no rewrite at all. Nothing on the bonding path may ever call into this module,
 * and nothing here may ever be phrased as a precondition for going live — an
 * optional cleanup that presents itself as a requirement is how an operator ends
 * up performing a risky mutation before every stream.
 *
 * ── WHY THE PLAN IS PURE, AND WHY IT REFUSES MORE THAN IT ACCEPTS ───────────
 *
 * The write behind this plan can cost the only path to the device that must
 * receive the next write. So every question that can be settled BEFORE anything
 * is touched is settled here, against captured documents, with no session and no
 * transport: is the target well-formed, is it actually a change, does it collide
 * with a subnet this host already holds, and can the existing record even be
 * re-hosted without guessing.
 *
 * Only /24 is accepted. Re-hosting a DHCP pool across an arbitrary prefix length
 * means deciding which bits of a start/end address are the host part, and a wrong
 * guess writes a pool that does not contain the addresses it is meant to serve.
 * A refusal is recoverable; a silently mis-derived pool is a dongle nobody can
 * reach. Every shipped router dongle on this bench is /24.
 */

import { xmlValue } from "./vendor-xml.ts";

/** The `/api/dhcp/settings` record, verbatim. Every member is echoed on write. */
export type HilinkDhcpRecord = {
	readonly address: string;
	readonly netmask: string;
	readonly dhcpStatus: string;
	readonly startAddress: string;
	readonly endAddress: string;
	readonly leaseTime: string;
	readonly dnsStatus: string;
	readonly primaryDns: string;
	readonly secondaryDns: string;
};

export type SubnetPlanRefusal =
	| "unsupported_netmask"
	| "invalid_target"
	| "no_change"
	| "subnet_conflict";

export type SubnetPlan =
	| { readonly ok: true; readonly target: HilinkDhcpRecord }
	| {
			readonly ok: false;
			readonly reason: SubnetPlanRefusal;
			/** The interface already holding the target subnet, when that is why. */
			readonly conflict?: string;
	  };

const SUPPORTED_NETMASK = "255.255.255.0";
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function octets(address: string): readonly number[] | undefined {
	const match = IPV4_RE.exec(address.trim());
	if (match === null) return undefined;
	const parsed = match.slice(1, 5).map(Number);
	return parsed.every((part) => part >= 0 && part <= 255) ? parsed : undefined;
}

/**
 * The /24 an address belongs to, as `a.b.c.0`. `undefined` for anything this
 * module refuses to reason about — a malformed address or a non-/24 mask.
 */
export function subnetOf(address: string, netmask: string): string | undefined {
	if (netmask.trim() !== SUPPORTED_NETMASK) return undefined;
	const parts = octets(address);
	return parts === undefined
		? undefined
		: `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

/**
 * A dongle's LAN must be RFC1918. A public prefix here would have the device
 * answer for addresses it does not own and blackhole real traffic from the host.
 */
function isPrivate(parts: readonly number[]): boolean {
	const [a, b] = parts;
	if (a === undefined || b === undefined) return false;
	if (a === 10) return true;
	if (a === 192 && b === 168) return true;
	return a === 172 && b >= 16 && b <= 31;
}

/** Re-host one address onto a new /24, preserving its host octet. */
function rehost(address: string, prefix: readonly number[]): string {
	const parts = octets(address);
	const host = parts?.[3];
	return host === undefined
		? address
		: `${prefix[0]}.${prefix[1]}.${prefix[2]}.${host}`;
}

/**
 * Plan the rewrite, or say why there is not one.
 *
 * `otherSubnets` is every /24 this host currently holds on ANOTHER interface,
 * measured rather than assumed — the whole point of the operation is to stop two
 * devices sharing one, so moving onto a THIRD device's subnet would trade one
 * collision for another. The map is keyed by interface so the refusal can name
 * which one, because "conflict" with no name is not something an operator can act
 * on.
 *
 * Everything except the address family is CARRIED, not defaulted: the pool
 * bounds, lease time and DHCP/DNS enable flags are the operator's, and a subnet
 * move is not permission to reset them. A DNS entry pointing at the dongle ITSELF
 * follows the dongle; one pointing anywhere else is left exactly as it is,
 * because that is an upstream resolver the operator chose.
 */
export function planSubnetRewrite(
	current: HilinkDhcpRecord,
	targetAddress: string,
	otherSubnets: ReadonlyMap<string, string>,
): SubnetPlan {
	if (current.netmask.trim() !== SUPPORTED_NETMASK) {
		return { ok: false, reason: "unsupported_netmask" };
	}
	const prefix = octets(targetAddress);
	if (prefix === undefined || !isPrivate(prefix) || prefix[3] === 0) {
		return { ok: false, reason: "invalid_target" };
	}

	const targetSubnet = subnetOf(targetAddress, SUPPORTED_NETMASK);
	const currentSubnet = subnetOf(current.address, SUPPORTED_NETMASK);
	if (targetSubnet === undefined)
		return { ok: false, reason: "invalid_target" };
	if (targetSubnet === currentSubnet) return { ok: false, reason: "no_change" };

	for (const [ifname, subnet] of otherSubnets) {
		if (subnet === targetSubnet) {
			return { ok: false, reason: "subnet_conflict", conflict: ifname };
		}
	}

	const followsDevice = (dns: string): string =>
		dns.trim() === current.address.trim()
			? targetAddress.trim()
			: rehostOrKeep(dns, prefix, currentSubnet);

	return {
		ok: true,
		target: {
			...current,
			address: targetAddress.trim(),
			startAddress: rehost(current.startAddress, prefix),
			endAddress: rehost(current.endAddress, prefix),
			primaryDns: followsDevice(current.primaryDns),
			secondaryDns: followsDevice(current.secondaryDns),
		},
	};
}

/**
 * A DNS entry inside the subnet being moved moves with it; one outside is an
 * upstream resolver the operator chose and is left alone.
 */
function rehostOrKeep(
	dns: string,
	prefix: readonly number[],
	currentSubnet: string | undefined,
): string {
	const parts = octets(dns);
	if (parts === undefined || currentSubnet === undefined) return dns;
	return `${parts[0]}.${parts[1]}.${parts[2]}.0` === currentSubnet
		? rehost(dns, prefix)
		: dns;
}

/**
 * Read the device's own `/api/dhcp/settings` record.
 *
 * The address and the netmask are REQUIRED — without both there is no subnet to
 * reason about, and a record that cannot be read is not one this build may
 * replace. Everything else falls back to the vendor's own documented default,
 * because a write echoes the whole record and an empty tag would clear a setting
 * the operator never touched.
 */
export function parseHilinkDhcpSettings(
	body: string,
): HilinkDhcpRecord | undefined {
	const address = xmlValue(body, "DhcpIPAddress");
	const netmask = xmlValue(body, "DhcpLanNetmask");
	if (address === undefined || netmask === undefined) return undefined;
	const keep = (tag: string, fallback: string): string =>
		xmlValue(body, tag) ?? fallback;
	return {
		address,
		netmask,
		dhcpStatus: keep("DhcpStatus", "1"),
		startAddress: keep("DhcpStartIPAddress", ""),
		endAddress: keep("DhcpEndIPAddress", ""),
		leaseTime: keep("DhcpLeaseTime", "86400"),
		dnsStatus: keep("DnsStatus", "1"),
		primaryDns: keep("PrimaryDns", address),
		secondaryDns: keep("SecondaryDns", address),
	};
}

/** Whether a captured record is byte-equal to another — the drift check. */
export function dhcpRecordsMatch(
	a: HilinkDhcpRecord,
	b: HilinkDhcpRecord,
): boolean {
	return (
		a.address === b.address &&
		a.netmask === b.netmask &&
		a.startAddress === b.startAddress &&
		a.endAddress === b.endAddress
	);
}
