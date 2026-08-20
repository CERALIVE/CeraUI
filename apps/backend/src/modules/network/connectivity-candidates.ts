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
  Which interfaces the Internet connectivity check may probe, and which
  interface the kernel's elected default route currently egresses through.

  Pure and rune-free: `gateways.ts` owns the effectful half (spawning `ip`,
  issuing the probes, raising/retracting the notification) and this module owns
  the decisions, so the candidate rules are unit-testable without a board.
*/

import {
	getNetifErrorMsg,
	NETIF_ERR_DUPIPV4,
	type NetworkInterface,
} from "./network-interfaces.ts";

/**
 * How a probe must be steered at a candidate — and the two are NOT
 * interchangeable.
 *
 * `source-ip` is the historic form: bind the socket's local address and let the
 * kernel's policy routing pick the egress. It cannot name a device, so it is
 * meaningless for the duplicate-IP twins, which share one address.
 *
 * `device` is `SO_BINDTODEVICE` (via `curl --interface`): egress is pinned to
 * ONE physical interface regardless of which of them holds the address. This is
 * the same mechanism `router-cellular-admin.ts` already needed to address the
 * twins' identical `192.168.8.1` admin gateways separately.
 */
export type ProbeBinding =
	| { readonly kind: "source-ip"; readonly ip: string }
	| { readonly kind: "device"; readonly ifname: string };

/** An interface the connectivity check may legitimately probe, and how. */
export type ProbeCandidate = {
	name: string;
	ip: string;
	binding: ProbeBinding;
};

/**
 * Why this interface must NOT be used as a connectivity-probe source, or
 * `undefined` when it is eligible.
 *
 * Two conditions disqualify an interface, and both are conditions of the
 * DEVICE rather than choices of the operator:
 *
 *  - it carries a netif error flag (`NETIF_ERR_DUPIPV4` — the duplicate-MAC
 *    HiLink pair both leasing `192.168.8.100`; `NETIF_ERR_HOTSPOT` — a radio
 *    broadcasting rather than associated), or
 *  - it holds no address at all, so there is no source address to bind and the
 *    probe would silently fall back to the current default route (a modem with
 *    no SIM, a radio with no lease).
 *
 * `enabled === false` is deliberately NOT disqualifying. It is overloaded: the
 * error flags above set it, but so does the operator toggling a link out of the
 * BOND — and "do not send bonded video over this link" is not "this link may
 * not be used to check whether the device has Internet". Excluding it here
 * would silently widen this fix into a behaviour change for every
 * operator-disabled interface. The two error flags already imply `enabled ===
 * false`, so nothing dup-IP or hotspot escapes through this.
 */
export function probeExclusionReason(
	entry: NetworkInterface | undefined,
): string | undefined {
	if (!entry) return "interface not present";

	const error = getNetifErrorMsg(entry);
	if (error) return error;

	if (!entry.ip) return "no address";

	return undefined;
}

/**
 * Whether an interface may be probed when the probe is pinned to the DEVICE
 * rather than to a source address — the same split todo 11 made for bond
 * membership, asked of the connectivity check.
 *
 * A duplicate IPv4 address is disqualifying for {@link probeExclusionReason}
 * and NOT here, and that difference is the entire point: the flag means "this
 * address names a pair", which a device-bound probe never consults. Every other
 * netif error (a broadcasting hotspot radio) still disqualifies, and an
 * addressless interface still does too — it has no lease, so it has no route to
 * carry the probe and no address for a later default-route election to use.
 */
export function deviceBoundProbeExclusionReason(
	entry: NetworkInterface | undefined,
): string | undefined {
	if (!entry) return "interface not present";

	const error = getNetifErrorMsg({
		...entry,
		error: entry.error & ~NETIF_ERR_DUPIPV4,
	});
	if (error) return error;

	if (!entry.ip) return "no address";

	return undefined;
}

/**
 * How this interface must be probed, or `undefined` when it may not be probed
 * at all. A duplicate-IP interface is bound BY DEVICE; everything else keeps
 * the unchanged source-address binding.
 */
export function probeBindingFor(
	name: string,
	entry: NetworkInterface | undefined,
): ProbeBinding | undefined {
	if (deviceBoundProbeExclusionReason(entry) !== undefined) return undefined;
	if (!entry?.ip) return undefined;

	if ((entry.error & NETIF_ERR_DUPIPV4) !== 0) {
		return { kind: "device", ifname: name };
	}
	return { kind: "source-ip", ip: entry.ip };
}

/**
 * Every interface the connectivity check may probe, in record order, each
 * carrying the binding it must be probed with.
 *
 * An empty result is a real, distinct state — every interface the device has is
 * unusable as a probe source — and its caller must say so rather than blaming
 * "the default connection".
 */
export function eligibleProbeCandidates(
	netif: Record<string, NetworkInterface | undefined>,
): ProbeCandidate[] {
	const candidates: ProbeCandidate[] = [];
	for (const name in netif) {
		const entry = netif[name];
		const binding = probeBindingFor(name, entry);
		if (!binding) continue;
		// `probeBindingFor` already proved it, but narrow for the compiler.
		if (!entry?.ip) continue;
		candidates.push({ name, ip: entry.ip, binding });
	}
	return candidates;
}

/**
 * The two messages are two DIFFERENT claims, and there is deliberately no third
 * one for "every interface failed" — see {@link ConnectivityClaim}.
 */
export const NO_INTERNET_MSGS = {
	defaultFailed:
		"No Internet connectivity via the default connection, re-checking all connections...",
	noEligible:
		"No connection is available to check for Internet access — every interface is unusable (no address, duplicate address, or hotspot).",
} as const;

/**
 * What the device may honestly say once a probe through the current default
 * route has failed.
 *
 * `suppressed` is the case this module exists for. The kernel elects a default
 * route from whatever DHCP hands it, including an interface this device has
 * ALREADY excluded — a dup-IP HiLink dongle's lease installs a metric-0 default
 * that outranks eth0's metric 101. That route failing is a fact about the
 * excluded interface, not about the device's connectivity.
 *
 * `suppressed` NEVER escalates to a claim, even when every candidate probe then
 * fails too, because a failed candidate probe is not proof of anything: the
 * per-interface probe steers by SOURCE ADDRESS, which only selects a route on a
 * board whose kernel supports policy routing. Board-measured on RK3588 with
 * `ip rule show` answering "Operation not supported": `curl --interface eth0`
 * (device-bound) returns 204 while the same request bound to eth0's ADDRESS
 * times out, and `ip route get <addr> from 192.168.78.132` still resolves via
 * the excluded dongle. Claiming "no connection is reachable" from that would
 * swap one false alarm for another. The excluded interfaces are already
 * surfaced, with their reasons, on the Network page.
 */
export type ConnectivityClaim =
	| { kind: "no-eligible"; message: string }
	| { kind: "default-failed"; message: string }
	| { kind: "suppressed"; ifname: string; reason: string };

export function decideConnectivityClaim(args: {
	candidateCount: number;
	defaultIfname: string | undefined;
	defaultExclusionReason: string | undefined;
}): ConnectivityClaim {
	const { candidateCount, defaultIfname, defaultExclusionReason } = args;

	// Nothing is probeable, so "the default connection failed" is the wrong
	// sentence even when the default route IS eligible — there is no re-check to
	// promise. This outranks every other arm.
	if (candidateCount === 0) {
		return { kind: "no-eligible", message: NO_INTERNET_MSGS.noEligible };
	}

	if (defaultIfname !== undefined && defaultExclusionReason !== undefined) {
		return {
			kind: "suppressed",
			ifname: defaultIfname,
			reason: defaultExclusionReason,
		};
	}

	return { kind: "default-failed", message: NO_INTERNET_MSGS.defaultFailed };
}

/**
 * The interface the kernel's ACTIVE default route egresses through, from the
 * output of `ip route show default`.
 *
 * `ip` prints default routes in metric order, so the FIRST `default` line is
 * the one the kernel actually uses — a route with no `metric` clause is metric
 * 0 and therefore outranks every explicit metric. Board-confirmed: a HiLink
 * dongle's DHCP lease installs `default via 192.168.8.1 dev enx0c5b8f279a64`
 * with no metric, ahead of `eth0`'s metric 101.
 *
 * Returns `undefined` for empty/garbled output or a line with no `dev` clause —
 * an unknown default interface must never be mistaken for an excluded one.
 */
export function parseDefaultRouteInterface(output: string): string | undefined {
	for (const line of output.split("\n")) {
		const tokens = line
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0);
		if (tokens[0] !== "default") continue;

		const devIndex = tokens.indexOf("dev");
		if (devIndex === -1) continue;

		const ifname = tokens[devIndex + 1];
		if (!ifname) continue;

		return ifname;
	}
	return undefined;
}
