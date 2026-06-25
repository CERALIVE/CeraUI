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

import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import { getms } from "../../helpers/time.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { CONNECTIVITY_CHECK_DOMAIN, checkConnectivity } from "./internet.ts";
import {
	getNetifErrorMsg,
	getNetworkInterfaces,
} from "./network-interfaces.ts";

export const UPDATE_GW_INT = 2000;

let updateGwLock = false;
let updateGwLastRun = 0;
let updateGwQueue = true;

async function clear_default_gws() {
	try {
		while (true) {
			await run("ip", ["route", "del", "default"]);
		}
	} catch (_err) {
		return;
	}
}

/**
 * Split a default-route line from `ip route show ... default` into a well-formed
 * `ip route add` argv. The `gw` string (e.g. `"default via 192.168.1.1 dev eth0"`)
 * is tokenized on whitespace into SEPARATE argv elements — security-critical: it
 * is never passed back as one re-interpolated shell token.
 */
export function buildRouteAddArgv(gw: string): string[] {
	const tokens = gw
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	return ["route", "add", ...tokens];
}

/**
 * Validate the line from `ip route show … default` before turning it into an
 * `ip route add` argv. An empty/garbled line (no leading `default`, or neither
 * a `via` nor `dev` clause) is drift: it fails loud instead of building a
 * meaningless `ip route add` that would clear the default route and install
 * nothing.
 */
export function parseDefaultRouteLine(gw: string): ParseResult<string[]> {
	const tokens = gw
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	if (tokens[0] !== "default") {
		return parseFail(
			"parseDefaultRouteLine",
			"route line does not start with 'default'",
			gw,
		);
	}
	if (!tokens.includes("via") && !tokens.includes("dev")) {
		return parseFail(
			"parseDefaultRouteLine",
			"route line has neither a 'via' nor a 'dev' clause",
			gw,
		);
	}
	return parseOk(buildRouteAddArgv(gw));
}

export type GwDeps = {
	runner: typeof run;
	clearDefaultGws: () => Promise<void>;
};

export async function setDefaultRoute(
	goodIf: string,
	deps: Partial<GwDeps> = {},
): Promise<void> {
	const runner = deps.runner ?? run;
	const clearGws = deps.clearDefaultGws ?? clear_default_gws;

	const gw = await runner("ip", [
		"route",
		"show",
		"table",
		argMatch(ID_RE, goodIf),
		"default",
	]);

	await clearGws();

	const parsed = parseDefaultRouteLine(gw);
	if (!parsed.ok) {
		logParseError(parsed);
		throw new Error(`setDefaultRoute: ${parsed.reason}`);
	}
	await runner("ip", parsed.value);

	logger.info(`Set default route: ip ${parsed.value.join(" ")}`);
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
		logger.warn(`Failed to resolve ${CONNECTIVITY_CHECK_DOMAIN}: ${err}`);
		return false;
	}

	for (const addr of addrs) {
		if (await checkConnectivity(addr)) {
			if (!fromCache) dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

			logger.info("Internet reachable via the default route");
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
	let goodIf: string | undefined;
	for (const addr of addrs) {
		for (const i in netif) {
			const networkInterface = netif[i];
			if (!networkInterface) continue;

			const error = getNetifErrorMsg(networkInterface);
			if (error) {
				logger.warn(
					`Not probing internet connectivity via ${i} (${networkInterface.ip}): ${error}`,
				);
				continue;
			}

			logger.info(
				`Probing internet connectivity via ${i} (${networkInterface.ip})`,
			);
			if (await checkConnectivity(addr, networkInterface.ip)) {
				logger.info(`Internet reachable via ${i} (${networkInterface.ip})`);
				if (!fromCache) dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

				goodIf = i;
				break;
			}
		}
	}

	if (goodIf) {
		try {
			await setDefaultRoute(goodIf);
			notificationRemove("no_internet");

			return true;
		} catch (err) {
			logger.warn(`Error updating the default route: ${err}`);
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
