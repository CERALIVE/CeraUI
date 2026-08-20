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

import type { ProbeCandidate } from "./connectivity-candidates.ts";
import { checkConnectivityViaDevice } from "./device-bound-probe.ts";
import { checkConnectivity } from "./internet.ts";

/** The two ways a probe can be steered, injected so the binding is provable. */
export type ConnectivityProbes = {
	probeViaSourceIp: (addr: string, ip: string) => Promise<boolean>;
	probeViaDevice: (addr: string, ifname: string) => Promise<boolean>;
};

export const defaultConnectivityProbes: ConnectivityProbes = {
	probeViaSourceIp: (addr, ip) => checkConnectivity(addr, ip),
	probeViaDevice: (addr, ifname) => checkConnectivityViaDevice(addr, ifname),
};

/** One candidate's OWN verdict — never shared with an address-sharing sibling. */
export type CandidateProbeResult = {
	candidate: ProbeCandidate;
	reachable: boolean;
};

export type ConnectivityElection = {
	elected: ProbeCandidate | undefined;
	results: CandidateProbeResult[];
};

async function probeCandidate(
	addr: string,
	candidate: ProbeCandidate,
	probes: ConnectivityProbes,
): Promise<boolean> {
	return candidate.binding.kind === "device"
		? probes.probeViaDevice(addr, candidate.binding.ifname)
		: probes.probeViaSourceIp(addr, candidate.binding.ip);
}

/**
 * Probe each candidate with ITS OWN binding until one answers, and report every
 * verdict reached along the way.
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

	for (const addr of addrs) {
		for (const candidate of candidates) {
			const reachable = await probeCandidate(addr, candidate, probes);
			results.push({ candidate, reachable });
			if (reachable) return { elected: candidate, results };
		}
	}

	return { elected: undefined, results };
}

export function describeBinding(candidate: ProbeCandidate): string {
	return candidate.binding.kind === "device"
		? `bound to device ${candidate.binding.ifname}`
		: `from ${candidate.binding.ip}`;
}
