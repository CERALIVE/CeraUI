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

import fs from "node:fs";

import type WebSocket from "ws";

import { isSameSubnet } from "../../helpers/ip-addresses.ts";
import killall from "../../helpers/killall.ts";

import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { queueUpdateGw } from "../network/gateways.ts";
import { getNetworkInterfaces } from "../network/network-interfaces.ts";
import { setup } from "../setup.ts";
import { getSocketSenderId } from "../ui/websocket-server.ts";

import { startError } from "./streaming.ts";

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
		throw("Failed to resolve SRTLA addr " + addr);
	}

	if (fromCache) {
		const cachedAddr = addrs[Math.floor(Math.random() * addrs.length)];
		if (cachedAddr) srtlaAddr = cachedAddr;
		queueUpdateGw();
	} else {
		/* At the moment we don't check that the SRTLA connection was established before
       validating the DNS result. The caching DNS resolver checks for invalid
       results from captive portals, etc, so all results *should* be good already */
		dnsCacheValidate(addr);
	}

	return srtlaAddr;
}

export function setSrtlaIpList(addresses: string[]) {
	const list = addresses.join("\n");
	fs.writeFileSync(setup.ips_file, list);
}

export function restartSrtla() {
	killall(["-HUP", "srtla_send"]);
}

export function genSrtlaIpList() {
	const list: Array<string> = [];

	const networkInterfaces = getNetworkInterfaces();
	for (const i in networkInterfaces) {
		const networkInterface = networkInterfaces[i];
		if (networkInterface?.enabled && networkInterface.ip) {
			list.push(networkInterface.ip);
		}
	}

	return list;
}

export function genSrtlaIpListForLocalIpAddress(ipAddress: string) {
	const list: Array<string> = [];

	const networkInterfaces = getNetworkInterfaces();
	for (const i in networkInterfaces) {
		const networkInterface = networkInterfaces[i];
		if (
			networkInterface?.ip &&
			networkInterface.netmask &&
			isSameSubnet(ipAddress, networkInterface.ip, networkInterface.netmask)
		) {
			list.push(networkInterface.ip);
		}
	}

	return list;
}
