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

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { writeTextFile } from "../../helpers/text-files.ts";
import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { getNetworkInterfaces } from "../network/network-interfaces.ts";
import { buildRelaysMsg, getRelays } from "../remote/remote-relays.ts";
import { setup } from "../setup.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { getIsStreaming } from "./streaming.ts";
import { bcrptExec } from "./streamloop.ts";

let bcrpt: ChildProcess | undefined;
let bcrptLowMtuDetected = false;

const bcrptDir = setup.bcrpt_path ?? "/var/run/bcrpt";
const bcrptSourceIpsFile = `${bcrptDir}/source_ips`;
const bcrptServerIpsFile = `${bcrptDir}/server_ips`;
const bcrptKeyFile = `${bcrptDir}/key`;

const bcrptIpsToRelays: Record<string, string> = {};
let bcrptRelaysRtt: Record<string, number> = {};
let bcrptRetryCount = 0;
const MAX_BCRPT_RETRIES = 5;
const INITIAL_RETRY_DELAY = 1000;

// Getter functions for safe external access
export function hasLowMtu(): boolean {
	return bcrptLowMtuDetected;
}

export function getRelayRtt(relayId: string): number | undefined {
	return bcrptRelaysRtt[relayId];
}

export function getAllRelaysRtt(): Record<string, number> {
	// generate a copy to prevent external code modification
	return { ...bcrptRelaysRtt };
}

export async function updateBcrptSourceIps() {
	await generateBcrptSourceIps();
	reloadBcrpt();
}

async function generateBcrptSourceIps() {
	let contents = "";
	const netif = getNetworkInterfaces();
	for (const i in netif) {
		// Skip hotspots and unusable interfaces with duplicate IPs
		if (netif[i] === undefined || netif[i].error || !netif[i].ip) continue;
		contents += `${netif[i].ip}\n`;
	}
	await writeTextFile(bcrptSourceIpsFile, contents);
}

export async function updateBcrptServerConfig() {
	await generateBcrptServerIpsFile();
	await generateBcrptKeyFile();
	reloadBcrpt();
}

export async function updateBcrptServerIps() {
	await generateBcrptServerIpsFile();
	reloadBcrpt();
}

async function generateBcrptServerIpsFile() {
	let contents = "";
	const relaysCache = getRelays();
	if (!getIsStreaming() && relaysCache) {
		for (const s in relaysCache.servers) {
			const server = relaysCache.servers[s];
			if (!server) continue;
			const port = server.bcrp_port;
			if (!port) continue;

			const { addrs, fromCache } = await dnsCacheResolve(server.addr);
			for (const ip of addrs) {
				const addr = `${ip}:${port}`;
				bcrptIpsToRelays[addr] = s;
				contents += `${addr}\n`;
			}
			if (!fromCache) {
				dnsCacheValidate(server.addr);
			}
		}
	}

	await writeTextFile(bcrptServerIpsFile, contents);
}

async function generateBcrptKeyFile() {
	let key = "";
	const relaysCache = getRelays();
	if (relaysCache?.bcrp_key) {
		key = relaysCache.bcrp_key;
	}
	await writeTextFile(bcrptKeyFile, key);
}

function reloadBcrpt() {
	if (bcrpt) {
		bcrpt.kill("SIGHUP");
	}
}

export async function startBcrpt() {
	if (!fs.existsSync(bcrptDir)) {
		fs.mkdirSync(bcrptDir);
	}

	try {
		await generateBcrptSourceIps();
		await generateBcrptServerIpsFile();
		await generateBcrptKeyFile();
		// Reset retry counter on successful config generation
		bcrptRetryCount = 0;
	} catch (_err) {
		if (bcrptRetryCount >= MAX_BCRPT_RETRIES) {
			console.error(
				`Failed to generate BCRPT config after ${MAX_BCRPT_RETRIES} attempts. Giving up.`,
			);
			return;
		}

		bcrptRetryCount++;
		const delay = INITIAL_RETRY_DELAY * 2 ** (bcrptRetryCount - 1); // Exponential backoff
		console.warn(
			`BCRPT config generation failed (attempt ${bcrptRetryCount}/${MAX_BCRPT_RETRIES}). Retrying in ${delay}ms...`,
		);
		setTimeout(startBcrpt, delay);
		return;
	}

	const args = [bcrptSourceIpsFile, bcrptServerIpsFile, bcrptKeyFile];
	bcrpt = spawn(bcrptExec, args);

	bcrpt.stdout?.on("data", (data) => {
		try {
			const stats = JSON.parse(data.toString("utf8"));

			const rtts: Record<string, number> = {};
			for (const addr in stats.rtt) {
				const relayId = bcrptIpsToRelays[addr];
				if (!relayId) continue;
				const rtt = stats.rtt[addr].max_min;
				if (rtts[relayId] === undefined) {
					rtts[relayId] = rtt;
				} else {
					rtts[relayId] = Math.max(rtt, rtts[relayId]);
				}
			}
			bcrptRelaysRtt = rtts;

			for (const conn in stats.mtu) {
				if (!bcrptLowMtuDetected && stats.mtu[conn] < 1336) {
					bcrptLowMtuDetected = true;
					console.log(
						"Detected low MTU network. Using reduced SRT packet size",
					);
				}
			}

			broadcastMsg("relays", buildRelaysMsg());
		} catch (err) {
			console.log(err);
			console.log(data.toString("utf8"));
		}
	});

	bcrpt.stderr?.on("data", (data) => {
		console.log(`bcrpt: ${data}`);
	});

	bcrpt.on("error", (err) => {
		console.error("bcrpt process error:", err);
	});

	bcrpt.on("close", (code, signal) => {
		let reason: string;
		if (code != null) {
			reason = `with code ${code}`;
		} else {
			reason = `because of signal ${signal}`;
		}
		if (bcrptRetryCount >= MAX_BCRPT_RETRIES) {
			console.error(
				`BCRPT process failed ${MAX_BCRPT_RETRIES} times. Stopping restart attempts.`,
			);
			return;
		}

		bcrptRetryCount++;
		const delay = INITIAL_RETRY_DELAY * 2 ** (bcrptRetryCount - 1);
		console.log(
			`bcrpt exited unexpectedly ${reason}. Restarting in ${delay}ms (attempt ${bcrptRetryCount}/${MAX_BCRPT_RETRIES})...`,
		);
		setTimeout(startBcrpt, delay);
	});
}
