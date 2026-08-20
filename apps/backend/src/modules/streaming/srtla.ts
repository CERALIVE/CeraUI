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

import { isSameSubnet } from "../../helpers/ip-addresses.ts";
import killall from "../../helpers/killall.ts";
import { logger } from "../../helpers/logger.ts";

import { resolveModemPhysicalIdentity } from "../modems/physical-identity-source.ts";
import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { queueUpdateGw } from "../network/gateways.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	isDupIpOnly,
	type NetworkInterface,
} from "../network/network-interfaces.ts";
import { setup } from "../setup.ts";
import { type BondEntry, isMappableEntry } from "./bind-map.ts";
import {
	type BindMapPublication,
	defaultBindMapWriterDeps,
	defaultSidecarPath,
	publishBondMapping,
} from "./bind-map-writer.ts";
import { registerSrtlaBond } from "./link-telemetry.ts";

export async function resolveSrtla(addr: string) {
	let srtlaAddr = addr;

	let addrs: string[] | undefined;
	let fromCache: boolean | undefined;
	try {
		const res = await dnsCacheResolve(addr, "a");
		addrs = res.addrs;
		fromCache = res.fromCache;
	} catch (_err) {
		queueUpdateGw();
		throw `Failed to resolve SRTLA addr ${addr}`;
	}

	if (fromCache) {
		const cachedAddr = addrs[Math.floor(Math.random() * addrs.length)];
		if (cachedAddr) srtlaAddr = cachedAddr;
		queueUpdateGw();
	} else {
		/* At the moment we don't check that the SRTLA connection was established before
       validating the DNS result. The caching DNS resolver checks for invalid
       results from captive portals, etc, so all results *should* be good already */
		void dnsCacheValidate(addr);
	}

	return srtlaAddr;
}

export function srtlaBindMapPath(): string {
	return setup.bind_map_file ?? defaultSidecarPath(setup.ips_file ?? "");
}

/**
 * Describe one bonded link the way the sidecar needs it.
 *
 * The `link_id` is MINTED BY TODO 10's identity module, never here — one id
 * authority, or the bind-map writer and the telemetry registry would attribute
 * the same operator's link to two different devices. A resolver failure falls
 * back to the ifname-anchored identity the resolver itself would have produced,
 * so a link always carries a stable id rather than none.
 */
function describeBondEntry(ifname: string, ip: string): BondEntry {
	try {
		const record = resolveModemPhysicalIdentity(ifname);
		return {
			ip,
			iface: ifname,
			linkId: record.linkId,
			...(record.idPath !== undefined ? { idPath: record.idPath } : {}),
		};
	} catch (error) {
		logger.warn("bind-map: identity resolution failed for a bonded link", {
			ifname,
			error,
		});
		return { ip, iface: ifname, linkId: `lnk_${ifname}` };
	}
}

/**
 * A duplicate-IP link joins the bond ONLY when it can be described.
 *
 * Without a row the sender cannot tell it from its twin, so admitting it would
 * put a second identical line in the IP list that the legacy path silently
 * collapses — the exact silent loss this contract exists to end.
 */
function admitEntry(int: NetworkInterface, entry: BondEntry): boolean {
	return !isDupIpOnly(int) || isMappableEntry(entry);
}

function collectBondEntries(
	accept: (name: string, int: NetworkInterface) => boolean,
): BondEntry[] {
	const entries: BondEntry[] = [];
	const networkInterfaces = getNetworkInterfaces();
	for (const name in networkInterfaces) {
		const networkInterface = networkInterfaces[name];
		if (!networkInterface?.ip) continue;
		if (!accept(name, networkInterface)) continue;
		const entry = describeBondEntry(name, networkInterface.ip);
		if (!admitEntry(networkInterface, entry)) continue;
		entries.push(entry);
	}
	return entries;
}

export function genSrtlaBondEntries(): BondEntry[] {
	return collectBondEntries(isBondCandidate);
}

/**
 * The local-subnet variant, now equally interface-aware.
 *
 * It deliberately keeps its own membership rule — reaching a receiver on the
 * LAN is a routing question, not a bonding one, so it does not consult the
 * bond toggle — but it must still describe each link, or a same-subnet pair of
 * twins would collapse exactly as the bonded pair used to.
 */
export function genSrtlaBondEntriesForLocalIpAddress(
	ipAddress: string,
): BondEntry[] {
	return collectBondEntries(
		(_name, int) =>
			int.netmask !== undefined &&
			int.ip !== undefined &&
			isSameSubnet(ipAddress, int.ip, int.netmask),
	);
}

export function genSrtlaIpList(): string[] {
	return genSrtlaBondEntries().map((entry) => entry.ip);
}

export function genSrtlaIpListForLocalIpAddress(ipAddress: string): string[] {
	return genSrtlaBondEntriesForLocalIpAddress(ipAddress).map(
		(entry) => entry.ip,
	);
}

/**
 * Publish the IP list and its sidecar, then keep the telemetry registry in step.
 *
 * ADR-003 §5.1 publication order lives in `publishBondMapping`; the SIGHUP is
 * the caller's, because only the caller knows whether a sender is running.
 */
export async function publishSrtlaBond(
	entries: readonly BondEntry[],
): Promise<BindMapPublication> {
	const publication = await publishBondMapping(
		entries,
		defaultBindMapWriterDeps(setup.ips_file ?? "", srtlaBindMapPath()),
	);
	// Keys the telemetry registry on the ids just published, so a rendered row
	// follows its PHYSICAL device across a reload rather than a file position,
	// and keeps the legacy conn_id -> interface fallback in step with it.
	registerSrtlaBond(entries);
	lastBond = { entries: [...entries], publication };
	return publication;
}

/**
 * What the writer last put on disk.
 *
 * The spawn path needs BOTH halves: whether a usable sidecar exists (so it may
 * pass `--bind-map`) and exactly which rows were published (so it can name the
 * collision group when it may not).
 */
export interface PublishedBond {
	readonly entries: readonly BondEntry[];
	readonly publication: BindMapPublication;
}

let lastBond: PublishedBond | undefined;

export function getLastPublishedBond(): PublishedBond | undefined {
	return lastBond;
}

export function resetPublishedBond(): void {
	lastBond = undefined;
}

export async function setSrtlaIpList(
	entries: readonly BondEntry[],
): Promise<BindMapPublication> {
	return publishSrtlaBond(entries);
}

export function restartSrtla() {
	void killall(["-HUP", "srtla_send"]);
}
