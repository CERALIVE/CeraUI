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
 * The effectful half of the sharing-coexistence diagnostic.
 *
 * Read-only by construction: every collaborator below reads, and there is no
 * apply, no rollback and no mutation anywhere in this module — a failed read
 * degrades ONE check to `unknown` and never anything else. It runs on its own
 * slow cadence rather than the 5 s netif poll because `nft list ruleset` is the
 * most expensive read on this path and the least urgent question on the device.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../../../helpers/logger.ts";
import { run } from "../../../helpers/run.ts";
import { isRealDevice } from "../../system/device-detection.ts";
import { getNetworkInterfaces } from "../network-interfaces.ts";
import {
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
} from "../network-manager.ts";
import { subnetCidr } from "../uplink-steering/subnet.ts";
import {
	deriveSharingDiag,
	type NmSharedZone,
	type SharingDiagInputs,
} from "./checks.ts";
import { publishSharingDiag } from "./status.ts";

export const SHARING_DIAG_INTERVAL_MS = 30_000;

const NM_MAIN_CONF = "/etc/NetworkManager/NetworkManager.conf";
const NM_CONF_D = "/etc/NetworkManager/conf.d";
const SECTION_RE = /^\[([^\]]+)\]\s*$/;
const FIREWALL_BACKEND_RE = /^\s*firewall-backend\s*=\s*(\S+)\s*$/;

export interface SharingDiagDeps {
	readonly isRealDevice: () => Promise<boolean>;
	readonly readFirewallBackend: () => Promise<string | null | undefined>;
	readonly readIpRuleShow: () => Promise<string | undefined>;
	readonly readNftRuleset: () => Promise<string | undefined>;
	readonly readSharedZones: () => Promise<readonly NmSharedZone[] | undefined>;
	readonly now: () => number;
}

export const defaultSharingDiagDeps: SharingDiagDeps = {
	isRealDevice: () => isRealDevice(),
	readFirewallBackend,
	readIpRuleShow: () => readCommand("ip", ["rule", "show"]),
	readNftRuleset: () => readCommand("nft", ["list", "ruleset"]),
	readSharedZones,
	now: () => Date.now(),
};

/**
 * Collect the four readings and publish the verdict.
 *
 * Gated on `isRealDevice()`: a dev/emulated host spawns NOTHING and leaves the
 * pre-check all-`unknown` status standing, which is the honest answer for a box
 * that has no nftables ruleset to have an opinion about.
 */
export async function refreshSharingDiag(
	deps: SharingDiagDeps = defaultSharingDiagDeps,
): Promise<void> {
	try {
		if (!(await deps.isRealDevice())) return;
		const [firewallBackend, ipRuleShow, nftRuleset, sharedZones] =
			await Promise.all([
				deps.readFirewallBackend(),
				deps.readIpRuleShow(),
				deps.readNftRuleset(),
				deps.readSharedZones(),
			]);
		const inputs: SharingDiagInputs = {
			firewallBackend,
			ipRuleShow,
			nftRuleset,
			sharedZones,
		};
		publishSharingDiag(deriveSharingDiag(inputs, deps.now()));
	} catch (error) {
		logger.debug("sharing-diag refresh degraded", { err: error });
	}
}

let timer: ReturnType<typeof setInterval> | undefined;

export async function initSharingDiag(): Promise<void> {
	if (timer !== undefined) return;
	timer = setInterval(() => {
		void refreshSharingDiag();
	}, SHARING_DIAG_INTERVAL_MS);
	timer.unref?.();
	await refreshSharingDiag();
}

export function stopSharingDiag(): void {
	if (timer !== undefined) clearInterval(timer);
	timer = undefined;
}

async function readCommand(
	bin: string,
	args: string[],
): Promise<string | undefined> {
	try {
		return await run(bin, args);
	} catch (error) {
		logger.debug(`sharing-diag: ${bin} read failed`, { err: error });
		return undefined;
	}
}

/**
 * Read the PINNED `firewall-backend` out of NetworkManager's own configuration.
 *
 * `null` — every file read cleanly and none states the key. That is a PRE-PIN
 * image, which is a normal, non-error state; the caller reports it as degraded
 * with its own reason and never as a mismatch. It is deliberately NOT resolved
 * to NetworkManager's compiled-in default: what that default is depends on the
 * daemon's build and on whether it found an `nft` binary at start-up, so
 * substituting one would be a claim this reader cannot support.
 *
 * `undefined` — nothing could be read at all, so no verdict is owed.
 */
async function readFirewallBackend(): Promise<string | null | undefined> {
	let readAny = false;
	let value: string | undefined;

	const paths = [NM_MAIN_CONF, ...(await confDropInPaths())];
	for (const path of paths) {
		let text: string;
		try {
			text = await Bun.file(path).text();
		} catch {
			continue;
		}
		readAny = true;
		const found = parseFirewallBackend(text);
		if (found !== undefined) value = found;
	}

	if (!readAny) return undefined;
	return value ?? null;
}

export function parseFirewallBackend(text: string): string | undefined {
	let section = "";
	let value: string | undefined;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = SECTION_RE.exec(line);
		if (header?.[1]) {
			section = header[1].toLowerCase();
			continue;
		}
		if (section !== "main") continue;
		const match = FIREWALL_BACKEND_RE.exec(line);
		if (match?.[1]) value = match[1].toLowerCase();
	}
	return value;
}

async function confDropInPaths(): Promise<string[]> {
	try {
		const entries = await readdir(NM_CONF_D);
		return entries
			.filter((entry) => entry.endsWith(".conf"))
			.sort()
			.map((entry) => join(NM_CONF_D, entry));
	} catch {
		return [];
	}
}

/**
 * Enumerate the NetworkManager profiles that are ACTIVE in `ipv4.method shared`.
 *
 * The prefix comes from the interface's LIVE address, never from the profile:
 * NetworkManager picks a shared subnet itself unless `ipv4.addresses` is set, so
 * the profile usually states none — and `10.42.0.0/24` is a default, not a fact.
 * An interface that has not leased its gateway address yet carries no prefix and
 * is reported as indeterminate rather than as missing NAT.
 *
 * A per-profile read that fails withholds the WHOLE enumeration: a connection
 * whose method could not be read might be the shared one, so reporting the rest
 * as complete would be a claim about profiles nobody managed to look at.
 */
async function readSharedZones(): Promise<readonly NmSharedZone[] | undefined> {
	const lines = await nmConnsGet("UUID,ACTIVE,DEVICE");
	if (lines === undefined) return undefined;

	const interfaces = getNetworkInterfaces();
	const zones: NmSharedZone[] = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		const [uuid = "", active = "", device = ""] = nmcliParseSep(line);
		if (active !== "yes" || uuid === "" || device === "" || device === "--")
			continue;
		const fields = await nmConnGetFields(uuid, ["ipv4.method"] as const);
		if (fields === undefined) return undefined;
		if (fields[0] !== "shared") continue;
		zones.push({ ifname: device, ipv4Cidr: liveCidr(interfaces[device]) });
	}
	return zones;
}

function liveCidr(
	entry: { ip?: string; netmask?: string } | undefined,
): string | undefined {
	if (!entry?.ip || !entry.netmask) return undefined;
	try {
		return subnetCidr(entry.ip, entry.netmask);
	} catch {
		return undefined;
	}
}
