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
 * Policy-route self-check (Wave-3, Todo 12).
 *
 * A read-only diagnostic that confirms the SRTLA source-routing the
 * NetworkManager dispatcher (`90-srtla-wifi-routing`) is supposed to install for
 * each bonded uplink actually landed. The ground-truth rule shape the dispatcher
 * creates is:
 *
 *     ip rule add from <IP> table <T> priority 100
 *     ip route add default via <GW> dev <IFACE> table <T>
 *
 * which surface in `ip rule show` as `<prio>: from <IP> lookup <T>` and in
 * `ip route show table <T>` as a `default via …` line. This module reads both,
 * DERIVES iface→table by matching each rule's `from <srcip>` back to the live
 * netif map's IPs (NEVER hardcoding a table number — the dispatcher's table
 * assignment is an implementation detail we discover, not one we assume), and
 * flags any enabled, IP-bearing bonded (modem/wifi) interface that is either
 * missing its source rule OR whose table has no default route.
 *
 * Safety contract (load-bearing — this runs inside the 5 s netif poll):
 *   - The whole check is gated on `isRealDevice()`. On a dev/emulated host it
 *     NEVER spawns `ip`; it returns the mock seam's simulation (default: null →
 *     no flags), so the isRealDevice() gate always short-circuits BEFORE Bun.spawn.
 *   - EVERY failure mode — spawn error, non-zero exit, malformed/unparseable
 *     output, a missing table — degrades to `null`. `null` means "couldn't
 *     determine" and attaches NO flags; it never throws into the netif loop.
 *
 * The pure parsers/derivation are exported so they can be unit-tested over
 * captured fixture strings; the effectful surface is injected via
 * {@link PolicyRouteCheckDeps} so the gate + failure modes are testable without
 * hardware.
 */

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { resolveMockPolicyRouteMissing } from "../../mocks/providers/policy-route.ts";
import { isRealDevice } from "../system/device-detection.ts";

/** A single `from <src> lookup <table>` entry parsed from `ip rule show`. */
export type PolicyRule = {
	/** The rule's source selector: a specific IP, or `"all"`. */
	src: string;
	/** The routing table the rule dispatches to (numeric or well-known name). */
	table: string;
};

/** An enabled, IP-bearing bonded (modem/wifi) interface to verify. */
export type PolicyRouteCandidate = {
	name: string;
	ip: string;
};

/** Minimal live-netif shape this check reads (name → ip/enabled). */
export type NetifSnapshot = Record<
	string,
	{ ip?: string; enabled: boolean } | undefined
>;

/**
 * Interfaces whose source-routing the SRTLA dispatcher installs: WiFi (`wlan*`)
 * and cellular modems (`usb*`, `wwan*`, `wwp*`, … — any `ww*` net device).
 * Ethernet (`eth*`), loopback and virtual bridges are deliberately excluded —
 * they are not part of the bonded uplink set the dispatcher source-routes.
 */
const BONDED_MODEM_OR_WIFI_RE = /^(?:wlan|usb|ww)/;

// A safe routing-table token to hand to `ip route show table <t>`: digits or a
// well-known name. Guards the argv against a leading-`-` flag-injection even
// though Bun.spawn is shell-free — a table token that fails this is treated as
// having no default route rather than being queried.
const SAFE_TABLE_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

// `from <src> lookup <table>` — `src` is an IP or `all`; `table` is a number or
// a well-known name (local/main/default). The priority prefix is ignored.
const IP_RULE_LINE_RE = /from\s+(\S+)\s+lookup\s+(\S+)/;

/**
 * Parse `ip rule show` output into its `from <src> lookup <table>` rules.
 *
 * Returns `null` when NOT A SINGLE rule line is parseable — a real `ip rule show`
 * ALWAYS carries at least the three base rules (`from all lookup local/main/
 * default`), so zero matches means the output is malformed/unavailable and the
 * caller must degrade rather than conclude "no rules → flag everything".
 */
export function parseIpRules(stdout: string): PolicyRule[] | null {
	const rules: PolicyRule[] = [];
	for (const line of stdout.split("\n")) {
		const m = line.match(IP_RULE_LINE_RE);
		if (m?.[1] && m[2]) {
			rules.push({ src: m[1], table: m[2] });
		}
	}
	return rules.length > 0 ? rules : null;
}

/** Does `ip route show table <t>` output contain a default route? */
export function parseHasDefaultRoute(stdout: string): boolean {
	return stdout.split("\n").some((line) => line.trim().startsWith("default"));
}

/** Is this a bonded uplink interface (WiFi or cellular-modem class)? */
export function isBondedModemOrWifiIface(name: string): boolean {
	return BONDED_MODEM_OR_WIFI_RE.test(name);
}

/**
 * Collect the interfaces to verify: enabled, IP-bearing, and of the bonded
 * modem/wifi class. Everything else (disabled links, addressless links,
 * ethernet/loopback/bridges) is out of scope for the source-routing check.
 */
export function collectPolicyRouteCandidates(
	netif: NetifSnapshot,
): PolicyRouteCandidate[] {
	const candidates: PolicyRouteCandidate[] = [];
	for (const name in netif) {
		const entry = netif[name];
		if (!entry) continue;
		if (!entry.enabled) continue;
		if (!entry.ip) continue;
		if (!isBondedModemOrWifiIface(name)) continue;
		candidates.push({ name, ip: entry.ip });
	}
	return candidates;
}

/**
 * Derive the set of interface names that are missing their policy route.
 *
 * For each candidate: the iface→table binding is DISCOVERED by matching the
 * candidate's IP to a rule's `from <srcip>` — no table number is assumed. An
 * iface with no matching source rule, or one whose discovered table has no
 * default route (`tableHasDefault(table) === false`), is flagged.
 */
export function derivePolicyRouteMissing(
	candidates: PolicyRouteCandidate[],
	rules: PolicyRule[],
	tableHasDefault: (table: string) => boolean,
): Set<string> {
	const flagged = new Set<string>();
	for (const iface of candidates) {
		const rule = rules.find((r) => r.src === iface.ip);
		if (!rule) {
			flagged.add(iface.name);
			continue;
		}
		if (!tableHasDefault(rule.table)) {
			flagged.add(iface.name);
		}
	}
	return flagged;
}

/**
 * Effectful collaborators, injected so the gate + failure modes are testable
 * without hardware. The defaults talk to the real OS via Bun.spawn.
 */
export type PolicyRouteCheckDeps = {
	/** Real-device gate — the spawn path runs ONLY when this resolves true. */
	isRealDevice: () => Promise<boolean>;
	/** Whether the dev/mock subsystem is active (drives the simulation seam). */
	shouldUseMocks: () => boolean;
	/** Dev/mock simulation of the flagged set (default: null → no flags). */
	resolveMockPolicyRouteMissing: () => Set<string> | null;
	/** `ip rule show` → stdout. MAY reject; the caller degrades to null. */
	runIpRuleShow: () => Promise<string>;
	/** `ip route show table <t>` → stdout. MAY reject; the caller degrades. */
	runIpRouteShowTable: (table: string) => Promise<string>;
};

/** Run an argv-only `ip` query via Bun.spawn and resolve its stdout. */
async function spawnIp(argv: readonly string[]): Promise<string> {
	const proc = Bun.spawn(["ip", ...argv], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`ip ${argv.join(" ")} exited with code ${proc.exitCode}`);
	}
	return stdout;
}

export const defaultPolicyRouteCheckDeps: PolicyRouteCheckDeps = {
	isRealDevice: () => isRealDevice(),
	shouldUseMocks,
	resolveMockPolicyRouteMissing,
	runIpRuleShow: () => spawnIp(["rule", "show"]),
	runIpRouteShowTable: (table) => spawnIp(["route", "show", "table", table]),
};

/**
 * The real-device branch: spawn + parse + derive. Any thrown/rejected spawn or a
 * malformed parse bubbles to {@link checkPolicyRoutes}'s catch, which degrades to
 * null — so this never has to null-guard the failure paths itself.
 */
async function runRealPolicyRouteCheck(
	candidates: PolicyRouteCandidate[],
	deps: PolicyRouteCheckDeps,
): Promise<Set<string> | null> {
	const rules = parseIpRules(await deps.runIpRuleShow());
	if (rules === null) return null; // malformed → degrade (no flags)

	// Discover the distinct tables the candidates' source rules dispatch to, then
	// query each once for a default route. Only safe table tokens are queried.
	const candidateIps = new Set(candidates.map((c) => c.ip));
	const tables = new Set(
		rules
			.filter((r) => candidateIps.has(r.src) && SAFE_TABLE_RE.test(r.table))
			.map((r) => r.table),
	);

	const tableHasDefault = new Map<string, boolean>();
	for (const table of tables) {
		const routeOut = await deps.runIpRouteShowTable(table);
		tableHasDefault.set(table, parseHasDefaultRoute(routeOut));
	}

	return derivePolicyRouteMissing(candidates, rules, (table) =>
		tableHasDefault.get(table) ?? false,
	);
}

/**
 * Check the bonded interfaces' policy routes.
 *
 * @returns the set of interface names flagged `policy_route_missing`, or `null`
 *   when the check could not run or determine a result (dev/emulated host, spawn
 *   failure, malformed output). `null` attaches NO flags and NEVER throws.
 */
export async function checkPolicyRoutes(
	netif: NetifSnapshot,
	deps: PolicyRouteCheckDeps = defaultPolicyRouteCheckDeps,
): Promise<Set<string> | null> {
	try {
		// Gate: on a dev/emulated host NEVER spawn `ip`. The mock seam lets dev/e2e
		// simulate a fault; the default (no fault / mocks inactive) is null.
		if (!(await deps.isRealDevice())) {
			return deps.shouldUseMocks()
				? deps.resolveMockPolicyRouteMissing()
				: null;
		}

		const candidates = collectPolicyRouteCandidates(netif);
		if (candidates.length === 0) return new Set();

		return await runRealPolicyRouteCheck(candidates, deps);
	} catch (err) {
		// Any failure degrades to null — this must never crash the netif loop.
		logger.debug("policy-route self-check degraded to null", { err });
		return null;
	}
}

// ─── Cached flag set consumed by the (synchronous) netif payload assembly ─────

// Last computed result. `null` = indeterminate (dev/emulated or a failure) →
// nothing is flagged. A Set (possibly empty) = an authoritative real-device read.
let flaggedIfaces: Set<string> | null = null;

/**
 * Recompute the cached policy-route flags from the current netif snapshot. Runs
 * on the netif poll cadence; awaits {@link checkPolicyRoutes} (which owns all the
 * degrade-to-null handling) and stores the result. Never throws.
 */
export async function refreshPolicyRouteFlags(
	netif: NetifSnapshot,
	deps: PolicyRouteCheckDeps = defaultPolicyRouteCheckDeps,
): Promise<void> {
	flaggedIfaces = await checkPolicyRoutes(netif, deps);
}

/** Is this interface currently flagged `policy_route_missing`? */
export function isPolicyRouteMissing(ifname: string): boolean {
	return flaggedIfaces?.has(ifname) ?? false;
}

/** The full cached flag set (read-only) — `null` when indeterminate. */
export function getPolicyRouteFlags(): ReadonlySet<string> | null {
	return flaggedIfaces;
}

/** Clear the cached flags (test isolation). */
export function resetPolicyRouteFlags(): void {
	flaggedIfaces = null;
}
