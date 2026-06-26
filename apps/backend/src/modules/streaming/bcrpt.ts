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

import { mkdir } from "node:fs/promises";
import { logger } from "../../helpers/logger.ts";
import { writeTextFile } from "../../helpers/text-files.ts";
import {
	INITIAL_RETRY_DELAY,
	MAX_BCRPT_RETRIES,
} from "../../helpers/timing-constants.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	getAllMockRelaysRtt,
	getMockRelayRtt,
} from "../../mocks/providers/relays.ts";
import { dnsCacheResolve, dnsCacheValidate } from "../network/dns.ts";
import { getNetworkInterfaces } from "../network/network-interfaces.ts";
import { buildRelaysMsg, getRelays } from "../remote/remote-relays.ts";
import { setup } from "../setup.ts";
import { notificationBroadcast } from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { getIsStreaming } from "./streaming.ts";
import { bcrptExec } from "./streamloop.ts";

let bcrpt: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let bcrptLowMtuDetected = false;

const bcrptDir = setup.bcrpt_path ?? "/var/run/bcrpt";
const bcrptSourceIpsFile = `${bcrptDir}/source_ips`;
const bcrptServerIpsFile = `${bcrptDir}/server_ips`;
const bcrptKeyFile = `${bcrptDir}/key`;

const bcrptIpsToRelays: Record<string, string> = {};
let bcrptRelaysRtt: Record<string, number> = {};
let bcrptRetryCount = 0;

// Getter functions for safe external access
export function hasLowMtu(): boolean {
	return bcrptLowMtuDetected;
}

export function getRelayRtt(relayId: string): number | undefined {
	if (shouldUseMocks()) {
		return getMockRelayRtt(relayId);
	}
	return bcrptRelaysRtt[relayId];
}

export function getAllRelaysRtt(): Record<string, number> {
	if (shouldUseMocks()) {
		return getAllMockRelaysRtt();
	}
	// generate a copy to prevent external code modification
	return { ...bcrptRelaysRtt };
}

// BCRPT down = bonded relay path down: operator-relevant, so notify, not log-only.
export function notifyBcrptPermanentFailure(
	detail: string,
	err?: unknown,
): void {
	logger.error(`BCRPT permanently unavailable: ${detail}`, { err });
	notificationBroadcast(
		"bcrpt_failed",
		"error",
		"Bonded relay (BCRPT) is unavailable. Bonded relay streaming won't work until the device recovers or restarts.",
		0,
		true,
		true,
	);
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
			void dnsCacheValidate(server.addr);
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
	// Bun.file(dir).exists() is false for directories, so it cannot guard this;
	// mkdir({ recursive: true }) ensures the working dir idempotently.
	await mkdir(bcrptDir, { recursive: true });

	// Check if we're using the mock BCRPT (development) or real binary (production)
	const isMockBcrpt = bcrptExec.includes("mocks/bcrpt");

	try {
		await generateBcrptSourceIps();
		await generateBcrptServerIpsFile();
		await generateBcrptKeyFile();

		// For production BCRPT binary, check if we have a valid key
		if (!isMockBcrpt) {
			const relaysCache = getRelays();
			if (!relaysCache?.bcrp_key || relaysCache.bcrp_key.trim() === "") {
				logger.warn(
					"BCRPT: No valid key available. Skipping BCRPT startup until relay configuration is available.",
				);
				return;
			}
		}

		// Reset retry counter on successful config generation
		bcrptRetryCount = 0;
	} catch (err) {
		if (bcrptRetryCount >= MAX_BCRPT_RETRIES) {
			notifyBcrptPermanentFailure(
				`config generation failed after ${MAX_BCRPT_RETRIES} attempts`,
				err,
			);
			return;
		}

		bcrptRetryCount++;
		const delay = INITIAL_RETRY_DELAY * 2 ** (bcrptRetryCount - 1); // Exponential backoff
		logger.warn(
			`BCRPT config generation failed (attempt ${bcrptRetryCount}/${MAX_BCRPT_RETRIES}). Retrying in ${delay}ms...`,
			{ err },
		);
		setTimeout(startBcrpt, delay);
		return;
	}

	const args = [bcrptSourceIpsFile, bcrptServerIpsFile, bcrptKeyFile];

	if (isMockBcrpt) {
		logger.info("Starting BCRPT in development mode (using mock)");
	} else {
		logger.info(
			"Starting BCRPT in production mode (using apt-installed binary)",
		);
	}

	try {
		bcrpt = Bun.spawn([bcrptExec, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		notifyBcrptPermanentFailure("failed to spawn the BCRPT process", err);
		return;
	}

	const proc = bcrpt;
	void consumeBcrptStdout(proc);
	void consumeBcrptStderr(proc);
	void handleBcrptExit(proc);
}

async function consumeBcrptStdout(
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
) {
	const decoder = new TextDecoder();
	for await (const chunk of proc.stdout) {
		const data = decoder.decode(chunk);
		try {
			const stats = JSON.parse(data);

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
					logger.info(
						"Detected low MTU network. Using reduced SRT packet size",
					);
				}
			}

			broadcastMsg("relays", buildRelaysMsg());
		} catch (err) {
			logger.debug("BCRPT stdout parse error", { err, data });
		}
	}
}

async function consumeBcrptStderr(
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
) {
	const decoder = new TextDecoder();
	for await (const chunk of proc.stderr) {
		logger.debug(`bcrpt stderr: ${decoder.decode(chunk)}`);
	}
}

async function handleBcrptExit(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
	await proc.exited;

	const code = proc.exitCode;
	const signal = proc.signalCode;
	let reason: string;
	if (code != null) {
		reason = `with code ${code}`;
	} else {
		reason = `because of signal ${signal}`;
	}
	if (bcrptRetryCount >= MAX_BCRPT_RETRIES) {
		notifyBcrptPermanentFailure(
			`process exited ${reason} and failed ${MAX_BCRPT_RETRIES} times; not restarting`,
		);
		return;
	}

	bcrptRetryCount++;
	const delay = INITIAL_RETRY_DELAY * 2 ** (bcrptRetryCount - 1);
	logger.warn(
		`bcrpt exited unexpectedly ${reason}. Restarting in ${delay}ms (attempt ${bcrptRetryCount}/${MAX_BCRPT_RETRIES})...`,
	);
	setTimeout(startBcrpt, delay);
}
