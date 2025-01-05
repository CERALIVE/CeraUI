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
import { spawnSync } from "node:child_process";

import WebSocket from "ws";

import { setup } from "./setup.ts";
import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { queueUpdateGw } from "./gateways.ts";
import { getSocketSenderId } from "./websocket-server.ts";
import { getNetworkInterfaces } from "./network-interfaces.ts";
import { startError } from "./streaming.ts";

export async function resolveSrtla(addr: string, conn: WebSocket) {
	let srtlaAddr = addr;
	try {
		var { addrs, fromCache } = await dnsCacheResolve(addr, "a");
	} catch (err) {
		const senderId = getSocketSenderId(conn) ?? "unknown sender";
		startError(conn, "failed to resolve SRTLA addr " + addr, senderId);
		queueUpdateGw();
		return;
	}

	if (fromCache) {
		srtlaAddr = addrs[Math.floor(Math.random() * addrs.length)]!;
		queueUpdateGw();
	} else {
		/* At the moment we don't check that the SRTLA connection was established before
       validating the DNS result. The caching DNS resolver checks for invalid
       results from captive portals, etc, so all results *should* be good already */
		dnsCacheValidate(addr);
	}

	return srtlaAddr;
}

export function genSrtlaIpList() {
	let list = "";
	let count = 0;

	const netif = getNetworkInterfaces();
	for (let i in netif) {
		const networkInterface = netif[i]!;
		if (networkInterface.enabled) {
			list += networkInterface.ip + "\n";
			count++;
		}
	}
	fs.writeFileSync(setup.ips_file, list);

	return count;
}

export function updateSrtlaIps() {
	genSrtlaIpList();
	spawnSync("killall", ["-HUP", "srtla_send"]);
}
