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
  WHICH interface answers the connectivity check, and HOW each one is asked.

  Split out of `gateways.ts` for the same reason `connectivity-candidates.ts`
  was: that module owns the effects (spawning `ip`, installing a route, raising
  and retracting the notification) and these own the decisions, so the election
  is unit-testable with no board, no DNS and no sockets. The probe pair is
  INJECTED for exactly that reason.
*/

import { isIP } from "node:net";
import { logger } from "../../helpers/logger.ts";

import {
	type AptReachability,
	defaultAptReachabilityDeps,
	deriveVerdict,
	probeAptReachability,
} from "../system/apt-reachability.ts";
import type { ProbeCandidate } from "./connectivity-candidates.ts";
import { checkConnectivityViaDevice } from "./device-bound-probe.ts";
import { checkConnectivity } from "./internet.ts";
import { observeRepository, observeUplinkPool } from "./uplink-observation.ts";

/** The two ways a probe can be steered, injected so the binding is provable. */
export type ConnectivityProbes = {
	readonly probeRepository: (ifname: string) => Promise<AptReachability>;
	probeViaSourceIp: (addr: string, ip: string) => Promise<boolean>;
	probeViaDevice: (addr: string, ifname: string) => Promise<boolean>;
};

export const defaultConnectivityProbes: ConnectivityProbes = {
	probeRepository: (ifname) =>
		probeAptReachability({ ...defaultAptReachabilityDeps, ifname }),
	probeViaSourceIp: (addr, ip) => checkConnectivity(addr, ip),
	probeViaDevice: (addr, ifname) => checkConnectivityViaDevice(addr, ifname),
};

/** One candidate's OWN verdict — never shared with an address-sharing sibling. */
export type CandidateProbeResult = {
	candidate: ProbeCandidate;
	reachable: boolean;
	readonly repository: AptReachability;
};

export type ConnectivityElection = {
	elected: ProbeCandidate | undefined;
	results: CandidateProbeResult[];
	readonly family?: 4 | 6;
};

export const CONNECTIVITY_FAMILY_STAGGER_MS = 250;

export type ConnectivityAddressProbe = (addr: string) => Promise<boolean>;

/**
 * Race at most one address from each family, preferring IPv4 and launching IPv6
 * after a short stagger. A source-address binding may dial only its own family;
 * device-bound probes intentionally pass no local address because
 * `curl --interface` has no separate family concept.
 */
export function raceConnectivityAddresses(
	addrs: readonly string[],
	probe: ConnectivityAddressProbe,
	localAddress?: string,
): Promise<boolean> {
	const localFamily =
		localAddress === undefined ? undefined : isIP(localAddress);
	const ipv4 = addrs.find((addr) => isIP(addr) === 4);
	const ipv6 = addrs.find((addr) => isIP(addr) === 6);
	const targets = [
		...(localFamily === undefined || localFamily === 4
			? ipv4
				? [{ addr: ipv4, delayMs: 0 }]
				: []
			: []),
		...(localFamily === undefined || localFamily === 6
			? ipv6
				? [
						{
							addr: ipv6,
							delayMs: ipv4 ? CONNECTIVITY_FAMILY_STAGGER_MS : 0,
						},
					]
				: []
			: []),
	];

	if (targets.length === 0) return Promise.resolve(false);

	return new Promise((resolve, reject) => {
		let remaining = targets.length;
		let active = 0;
		let settled = false;
		const errors: unknown[] = [];
		let staggerTimer: ReturnType<typeof setTimeout> | undefined;

		const runProbe = async (addr: string): Promise<void> => {
			if (settled) return;
			active++;
			try {
				if (await probe(addr)) {
					settled = true;
					if (staggerTimer) clearTimeout(staggerTimer);
				}
			} catch (error) {
				errors.push(error);
			} finally {
				active--;
				remaining--;
				if (active === 0 && (settled || remaining === 0)) {
					if (!settled && errors.length > 0) reject(new AggregateError(errors));
					else resolve(settled);
				}
			}
		};

		for (const target of targets) {
			if (target.delayMs === 0) {
				void runProbe(target.addr);
			} else {
				staggerTimer = setTimeout(
					() => void runProbe(target.addr),
					target.delayMs,
				);
			}
		}
	});
}

/**
 * Prefer device-bound repository HTTPS over generic HTTP. Record order breaks
 * ties; a repository outage never removes the first ordinary working uplink.
 *
 * `addrs` are the externally-resolved connectivity-check addresses and nothing
 * else — no gateway, no admin API, no LAN address is ever a probe target, so a
 * dongle that answers its own `192.168.8.1` cannot pass for a working uplink.
 *
 * Because a device-bound candidate is probed through `SO_BINDTODEVICE`, two
 * interfaces holding the SAME address get two INDEPENDENT verdicts: a WAN outage
 * behind one twin marks that twin unreachable and leaves its sibling alone,
 * where a source-address probe could only have answered for the pair.
 */
export async function electConnectivityCandidate(
	addrs: readonly string[],
	candidates: readonly ProbeCandidate[],
	probes: ConnectivityProbes = defaultConnectivityProbes,
): Promise<ConnectivityElection> {
	const results: CandidateProbeResult[] = [];
	let fallback:
		| { readonly candidate: ProbeCandidate; readonly family: 4 | 6 }
		| undefined;

	const observe = async (
		candidate: ProbeCandidate,
	): Promise<CandidateProbeResult & { readonly family: 4 | 6 | undefined }> => {
		const repository = await observeRepository(candidate.name, probes);
		const family =
			repository.ipv4 === "ok" ? 4 : repository.ipv6 === "ok" ? 6 : undefined;
		if (family !== undefined) {
			return { candidate, reachable: true, repository, family };
		}
		const localAddress =
			candidate.binding.kind === "source-ip" ? candidate.binding.ip : undefined;
		let reachableFamily: 4 | 6 | undefined;
		let observationFailed = false;
		const reachable = await raceConnectivityAddresses(
			addrs,
			async (addr) => {
				const success =
					candidate.binding.kind === "device"
						? await probes.probeViaDevice(addr, candidate.binding.ifname)
						: await probes.probeViaSourceIp(addr, candidate.binding.ip);
				if (success) reachableFamily ??= isIP(addr) === 6 ? 6 : 4;
				return success;
			},
			localAddress,
		).catch((error: unknown) => {
			if (!(error instanceof AggregateError)) throw error;
			logger.warn("Generic uplink observation unavailable", {
				ifname: candidate.name,
				error,
			});
			observationFailed = true;
			return false;
		});
		if (observationFailed)
			return {
				candidate,
				reachable: false,
				repository: deriveVerdict([]),
				family: undefined,
			};
		return { candidate, reachable, repository, family: reachableFamily };
	};
	const firstCandidate = candidates[0];
	if (!firstCandidate) return { elected: undefined, results };
	const first = await observe(firstCandidate);
	if (first.repository.ipv4 === "ok" || first.repository.ipv6 === "ok") {
		return {
			elected: first.candidate,
			results: [first],
			family: first.repository.ipv4 === "ok" ? 4 : 6,
		};
	}
	const observations = [
		first,
		...(await observeUplinkPool(candidates.slice(1), observe)),
	];

	for (const { candidate, reachable, repository, family } of observations) {
		results.push({ candidate, reachable, repository });
		if (
			family !== undefined &&
			(repository.ipv4 === "ok" || repository.ipv6 === "ok")
		) {
			return { elected: candidate, results, family };
		}
		if (family !== undefined && fallback === undefined) {
			fallback = { candidate, family };
		}
	}

	return {
		elected: fallback?.candidate,
		results,
		...(fallback ? { family: fallback.family } : {}),
	};
}

export function describeBinding(candidate: ProbeCandidate): string {
	return candidate.binding.kind === "device"
		? `bound to device ${candidate.binding.ifname}`
		: `from ${candidate.binding.ip}`;
}

export function logConnectivityElection(election: ConnectivityElection): void {
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
}
