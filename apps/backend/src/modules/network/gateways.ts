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
import {
	decideConnectivityClaim,
	deviceBoundProbeExclusionReason,
	eligibleProbeCandidates,
	parseDefaultRouteInterface,
	probeExclusionReason,
} from "./connectivity-candidates.ts";
import {
	describeBinding,
	electConnectivityCandidate,
} from "./connectivity-election.ts";
import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { CONNECTIVITY_CHECK_DOMAIN, checkConnectivity } from "./internet.ts";
import { getNetworkInterfaces } from "./network-interfaces.ts";

export const UPDATE_GW_INT = 2000;

export const NO_INTERNET_NOTIFICATION = "no_internet";

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

/*
  THE TWIN-GATEWAY CASE: two interfaces, ONE gateway address.

  Both HiLink twins run the same factory firmware, so both hand the host a lease
  whose gateway is `192.168.8.1` — the SAME address, on the SAME subnet, from two
  physically distinct dongles. `ip route show default` on the bench really does
  print two `default via 192.168.8.1` lines that differ only in their `dev`
  clause.

  So NOTHING here may identify an uplink by an address:

   - the ELECTION reads a PER-INTERFACE table (`ip route show table <ifname>`),
     so the line it gets back is already the one belonging to that device;
   - `parseDefaultRouteLine` tokenizes that line and `buildRouteAddArgv` replays
     EVERY token, so the `dev <ifname>` clause survives into `ip route add`
     verbatim and the installed route names the device, not just the gateway.
     Two twins therefore produce two DIFFERENT argvs from two identical `via`
     addresses;
   - the PROBE that decides which interface won never dials `192.168.8.1` at all
     — see {@link electConnectivityCandidate}. It targets the externally-resolved
     connectivity address with the socket bound to one device.

  Reaching a twin's admin gateway and reaching the Internet through that twin are
  separate assertions, and a SIM-less dongle answers the first while
  captive-portalling the second (board-measured). Neither may stand in for the
  other.
*/
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
	void updateGwWrapper();
}

/**
 * Which interface the kernel's active default route egresses through, or
 * `undefined` when it cannot be determined. Never throws: an unreadable routing
 * table must not be mistaken for an excluded interface.
 */
async function resolveDefaultRouteInterface(): Promise<string | undefined> {
	try {
		return parseDefaultRouteInterface(
			await run("ip", ["route", "show", "default"]),
		);
	} catch (err) {
		logger.debug(`Could not read the default route: ${err}`);
		return undefined;
	}
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
			if (!fromCache) void dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

			logger.info("Internet reachable via the default route");
			notificationRemove(NO_INTERNET_NOTIFICATION);

			return true;
		}
	}

	const netif = getNetworkInterfaces();
	const candidates = eligibleProbeCandidates(netif);

	const defaultIf = await resolveDefaultRouteInterface();
	const claim = decideConnectivityClaim({
		candidateCount: candidates.length,
		defaultIfname: defaultIf,
		defaultExclusionReason: defaultIf
			? probeExclusionReason(netif[defaultIf])
			: undefined,
	});

	if (claim.kind === "suppressed") {
		logger.info(
			`Default route is on ${claim.ifname} (${claim.reason}) — not a connectivity verdict; re-electing from ${candidates.length} eligible interface(s)`,
		);
	} else {
		notificationBroadcast(
			NO_INTERNET_NOTIFICATION,
			"warning",
			claim.message,
			10,
			true,
			false,
		);
	}

	for (const name in netif) {
		const reason = deviceBoundProbeExclusionReason(netif[name]);
		if (reason) {
			logger.warn(
				`Not probing internet connectivity via ${name} (${netif[name]?.ip}): ${reason}`,
			);
		}
	}

	const election = await electConnectivityCandidate(addrs, candidates);
	for (const { candidate, reachable } of election.results) {
		logger.info(
			`Internet ${reachable ? "reachable" : "unreachable"} via ${candidate.name} (${describeBinding(candidate)})`,
		);
	}

	const goodIf = election.elected?.name;
	if (goodIf && !fromCache) void dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

	if (goodIf) {
		// The notification claims the DEVICE has no Internet, and an eligible
		// interface just proved otherwise — so retract it here, before and
		// independently of installing a route. `setDefaultRoute` reads a
		// per-interface routing table, and the shipped image provisions those only
		// for modem*/wlan*: on a board reaching the Internet through eth0 it fails
		// with "table id value is invalid", which used to leave "No Internet
		// connectivity" standing over a working link.
		notificationRemove(NO_INTERNET_NOTIFICATION);

		try {
			await setDefaultRoute(goodIf);
		} catch (err) {
			logger.warn(`Error updating the default route via ${goodIf}: ${err}`);
		}

		return true;
	}

	// Deliberately NO notification here: the withheld claim stays withheld. A
	// failed candidate probe is not evidence — it steers by source address, which
	// selects a route only where the kernel supports policy routing (see
	// ConnectivityClaim). Log it so the state is still diagnosable.
	if (claim.kind === "suppressed") {
		logger.warn(
			`No eligible interface answered the connectivity check while the default route sits on ${claim.ifname} (${claim.reason}); not claiming the device is offline`,
		);
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
