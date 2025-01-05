/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

import { execP } from "../helpers/exec.ts";
import { getms } from "../helpers/time.ts";

import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { checkConnectivity, CONNECTIVITY_CHECK_DOMAIN } from "./internet.ts";
import { notificationBroadcast, notificationRemove } from "./notifications.ts";
import {
	getNetworkInterfaces,
	netIfGetErrorMsg,
} from "./network-interfaces.ts";

export const UPDATE_GW_INT = 2000;

let updateGwLock = false;
let updateGwLastRun = 0;
let updateGwQueue = true;

async function clear_default_gws() {
	try {
		while (1) {
			await execP("ip route del default");
		}
	} catch (err) {
		return;
	}
}

export function queueUpdateGw() {
	updateGwQueue = true;
	updateGwWrapper();
}

async function updateGw() {
	let addrs: Array<string>;
	let fromCache = false;
	try {
		const resolveResult = await dnsCacheResolve(CONNECTIVITY_CHECK_DOMAIN);
		addrs = resolveResult.addrs;
		fromCache = resolveResult.fromCache;
	} catch (err) {
		console.log(`Failed to resolve ${CONNECTIVITY_CHECK_DOMAIN}: ${err}`);
		return false;
	}

	for (const addr of addrs) {
		if (await checkConnectivity(addr)) {
			if (!fromCache) dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

			console.log("Internet reachable via the default route");
			notificationRemove("no_internet");

			return true;
		}
	}

	notificationBroadcast(
		"no_internet",
		"warning",
		"No Internet connectivity via the default connection, re-checking all connections...",
		10,
		true,
		false,
	);

	const netif = getNetworkInterfaces();
	let goodIf;
	for (const addr of addrs) {
		for (const i in netif) {
			const networkInterface = netif[i]!;
			const error = netIfGetErrorMsg(networkInterface);
			if (error) {
				console.log(
					`Not probing internet connectivity via ${i} (${networkInterface.ip}): ${error}`,
				);
				continue;
			}

			console.log(
				`Probing internet connectivity via ${i} (${networkInterface.ip})`,
			);
			if (await checkConnectivity(addr, networkInterface.ip)) {
				console.log(`Internet reachable via ${i} (${networkInterface.ip})`);
				if (!fromCache) dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

				goodIf = i;
				break;
			}
		}
	}

	if (goodIf) {
		try {
			const gw = (await execP(`ip route show table ${goodIf} default`)).stdout;
			await clear_default_gws();

			const route = `ip route add ${gw}`;
			await execP(route);

			console.log(`Set default route: ${route}`);
			notificationRemove("no_internet");

			return true;
		} catch (err) {
			console.log(`Error updating the default route: ${err}`);
		}
	}

	return false;
}

export async function updateGwWrapper() {
	// Do nothing if no request is queued
	if (!updateGwQueue) return;

	// Rate limit
	const ts = getms();
	const to = updateGwLastRun + UPDATE_GW_INT;
	if (ts < to) return;

	// Don't allow simultaneous execution
	if (updateGwLock) return;

	// Proceeding, update status
	updateGwLastRun = ts;
	updateGwLock = true;
	updateGwQueue = false;

	const r = await updateGw();
	if (!r) {
		updateGwQueue = true;
	}
	updateGwLock = false;
}
