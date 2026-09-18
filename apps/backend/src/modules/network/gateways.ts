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
import { run } from "../../helpers/run.ts";
import { getms } from "../../helpers/time.ts";
import { isRealDevice } from "../system/device-detection.ts";
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
	type ConnectivityProbes,
	defaultConnectivityProbes,
	describeBinding,
	electConnectivityCandidate,
	raceConnectivityAddresses,
} from "./connectivity-election.ts";
import { setDefaultRoute } from "./default-route.ts";
import { dnsCacheResolve, dnsCacheValidate } from "./dns.ts";
import { CONNECTIVITY_CHECK_DOMAIN, checkConnectivity } from "./internet.ts";
import { getNetworkInterfaces } from "./network-interfaces.ts";
import { isUplinkClientSteeringEligible } from "./uplink-health/state.ts";

export {
	buildRouteAddArgv,
	GatewayRouteError,
	type GwDeps,
	parseDefaultRouteLine,
	setDefaultRoute,
} from "./default-route.ts";

export const UPDATE_GW_INT = 2000;

export const NO_INTERNET_NOTIFICATION = "no_internet";

let updateGwInFlight: Promise<boolean> | undefined;
let updateGwLastRun = 0;
let updateGwQueue = true;

export function queueUpdateGw() {
	updateGwQueue = true;
	void updateGwWrapper();
}

/**
 * Which interface the kernel's active default route egresses through, or
 * `undefined` when it cannot be determined. Never throws: an unreadable routing
 * table must not be mistaken for an excluded interface.
 */
async function resolveDefaultRouteInterface(
	family: 4 | 6,
): Promise<string | undefined> {
	try {
		return parseDefaultRouteInterface(
			await run("ip", [
				...(family === 6 ? ["-6"] : []),
				"route",
				"show",
				"default",
			]),
		);
	} catch (err) {
		logger.debug(`Could not read the default route: ${err}`);
		return undefined;
	}
}

export type GatewayElectionDeps = {
	readonly isRealDevice: () => Promise<boolean>;
	readonly resolve: () => ReturnType<typeof dnsCacheResolve>;
	readonly validateDns: () => void;
	readonly checkConnectivity: typeof checkConnectivity;
	readonly interfaces: typeof getNetworkInterfaces;
	readonly eligible: (ifname: string) => boolean;
	readonly defaultInterface: typeof resolveDefaultRouteInterface;
	readonly installRoute: (ifname: string, family: 4 | 6) => Promise<void>;
	readonly probes: ConnectivityProbes;
};

function defaultGatewayElectionDeps(): GatewayElectionDeps {
	return {
		isRealDevice,
		resolve: () => dnsCacheResolve(CONNECTIVITY_CHECK_DOMAIN),
		validateDns: () => {
			void dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);
		},
		checkConnectivity,
		interfaces: getNetworkInterfaces,
		eligible: isUplinkClientSteeringEligible,
		defaultInterface: resolveDefaultRouteInterface,
		installRoute: (ifname, family) => setDefaultRoute(ifname, { family }),
		probes: defaultConnectivityProbes,
	};
}

export async function updateGw(
	deps: GatewayElectionDeps = defaultGatewayElectionDeps(),
): Promise<boolean> {
	if (!(await deps.isRealDevice())) return true;
	let addrs: Array<string> = [];
	let fromCache = false;
	try {
		const resolveResult = await deps.resolve();
		addrs = resolveResult.addrs;
		fromCache = resolveResult.fromCache;
	} catch (err) {
		logger.warn(`Failed to resolve ${CONNECTIVITY_CHECK_DOMAIN}: ${err}`);
	}

	const defaultReachable = await raceConnectivityAddresses(
		addrs,
		deps.checkConnectivity,
	);
	if (defaultReachable) {
		if (!fromCache) deps.validateDns();

		logger.info("Internet reachable via the default route");
		notificationRemove(NO_INTERNET_NOTIFICATION);
	}

	const netif = deps.interfaces();
	const candidates = eligibleProbeCandidates(netif).filter((candidate) =>
		deps.eligible(candidate.name),
	);

	const defaultIf = await deps.defaultInterface(4);
	// Keep the current default ahead of equal-ranked peers to avoid route churn.
	candidates.sort(
		(a, b) => Number(b.name === defaultIf) - Number(a.name === defaultIf),
	);
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
	} else if (!defaultReachable) {
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

	const election = await electConnectivityCandidate(
		addrs,
		candidates,
		deps.probes,
	);
	for (const { candidate, reachable, repository } of election.results) {
		logger.info(
			`Internet ${reachable ? "reachable" : "unreachable"} via ${candidate.name} (${describeBinding(candidate)})`,
			{
				repository: repository.verdict,
				ipv4: repository.ipv4,
				ipv6: repository.ipv6,
			},
		);
	}

	const goodIf = election.elected?.name;
	if (goodIf && !fromCache && addrs.length > 0) deps.validateDns();

	if (goodIf) {
		// Connectivity and route application are distinct claims; retract only the former.
		notificationRemove(NO_INTERNET_NOTIFICATION);
		if (election.family === undefined) {
			logger.warn(
				"Using connectivity-only host uplink; repository HTTPS unavailable",
				{ ifname: goodIf },
			);
		}

		try {
			const family = election.family ?? 4;
			const activeIf =
				family === 4 ? defaultIf : await deps.defaultInterface(family);
			if (activeIf !== goodIf) await deps.installRoute(goodIf, family);
		} catch (err) {
			logger.warn("Default-route application failed", {
				ifname: goodIf,
				error: err,
			});
			return false;
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

	return defaultReachable;
}

export function updateGwWrapper(
	force = false,
	deps: GatewayElectionDeps = defaultGatewayElectionDeps(),
): Promise<boolean> {
	if (updateGwInFlight) return updateGwInFlight;
	// Do nothing if no request is queued
	if (!force && !updateGwQueue) return Promise.resolve(false);

	// Rate limit
	const ts = getms();
	const to = updateGwLastRun + UPDATE_GW_INT;
	if (!force && ts < to) return Promise.resolve(false);

	// Proceeding, update status
	updateGwLastRun = ts;
	updateGwQueue = false;

	updateGwInFlight = updateGw(deps)
		.catch((error: unknown) => {
			logger.warn("Gateway election failed", { error });
			return false;
		})
		.then((result) => {
			if (!result) updateGwQueue = true;
			return result;
		})
		.finally(() => {
			updateGwInFlight = undefined;
		});
	return updateGwInFlight;
}
