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
 * Moving a dongle's LAN subnet, and getting it back if that goes wrong.
 *
 * This is the one operation in the router-admin surface that can cost the path
 * to the device it is mutating: the write lands on the dongle, the host's lease
 * is still on the OLD subnet, and until DHCP renews there is no route to the new
 * address at all. So it is a STATE MACHINE with a proven exit, not a write with a
 * hopeful log line:
 *
 *   preflight → (journal armed) → drift re-check → write → renew → confirm
 *                                                            ↓ not reachable
 *                                              locate → restore → renew → confirm
 *
 * ── THE THREE THINGS THAT MAKE IT RECOVERABLE ───────────────────────────────
 *
 * 1. THE PRE-STATE IS DURABLE BEFORE THE WRITE. The caller arms todo 25's
 *    journal with the whole `/api/dhcp/settings` record plus the ifname and the
 *    target, so a power cut between the write and the confirmation leaves a
 *    record startup replay can act on — and the registered rollback handler
 *    below is what replay then runs. This module does NOT own a second
 *    mutation-safety mechanism; it consumes that one.
 *
 * 2. THE OLD ADDRESS IS RETAINED, and probed. After a failed confirmation the
 *    device is at exactly one of two addresses — the new one (the write landed,
 *    the host could not follow) or the old one (the write never landed) — and
 *    which is unknowable without asking. `locateDevice` asks BOTH, re-renewing
 *    between rounds, which is the only thing that can tell those two apart.
 *
 * 3. THE ROLLBACK IS CANCELLED ONLY AFTER REACHABILITY IS RECONFIRMED. Not after
 *    the vendor answers OK, not after the restore POST returns: after a session
 *    opens against the address the device is supposed to be on AND its record
 *    reads back as expected. A restore that cannot be proven leaves the entry
 *    `failed`, which blocks the device until an operator acknowledges — the
 *    fail-closed direction, because a dongle at an unknown address is exactly
 *    what the journal exists for.
 *
 * ── AND IT IS OPTIONAL ──────────────────────────────────────────────────────
 *
 * Nothing on the bonding path calls this. See `router-subnet-plan.ts` for why
 * the collision it cleans up is not a bonding fault in the first place.
 */

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { hilinkDhcpSettingsBody } from "./hilink-documents.ts";
import {
	HILINK_DHCP_SETTINGS_PATH,
	hilinkHeaders,
	openHilinkSession,
} from "./hilink-session.ts";
import {
	defaultRouterAdminProbeDeps,
	dialectForVidPid,
	parseDefaultGateways,
	type RouterAdminProbeDeps,
} from "./router-cellular-admin.ts";
import {
	dhcpRecordsMatch,
	type HilinkDhcpRecord,
	parseHilinkDhcpSettings,
	planSubnetRewrite,
	type SubnetPlanRefusal,
	subnetOf,
} from "./router-subnet-plan.ts";

/**
 * Six rounds at two seconds. Bounded on purpose: a dongle re-applies a LAN
 * change in a couple of seconds and a NetworkManager lease follows within one
 * renewal, so a window that has not produced a session by then is reporting a
 * real failure rather than being impatient — and an unbounded wait here is a
 * mutation that never resolves and a lease that is never released.
 */
export const SUBNET_CONFIRM_ATTEMPTS = 6;
export const SUBNET_CONFIRM_DELAY_MS = 2_000;

export type SubnetRewriteDeps = RouterAdminProbeDeps & {
	/** Re-lease this interface so the host follows the device onto its new subnet. */
	renewDhcpLease: (ifname: string) => Promise<void>;
	/** `ip -4 -o addr show` → stdout. MAY reject. */
	runIpAddrShow: () => Promise<string>;
	wait: (ms: number) => Promise<void>;
};

export const defaultSubnetRewriteDeps: SubnetRewriteDeps = {
	...defaultRouterAdminProbeDeps,
	// Disconnect + connect rather than `device reapply`: reapply re-asserts the
	// EXISTING addresses, which is precisely the stale lease that has to go.
	renewDhcpLease: async (ifname) => {
		await run("nmcli", ["device", "disconnect", ifname]).catch(() => "");
		await run("nmcli", ["device", "connect", ifname]);
	},
	runIpAddrShow: () => run("ip", ["-4", "-o", "addr", "show"]),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** `ip -4 -o addr show` → the /24 each interface currently holds. */
export function parseHostSubnets(stdout: string): ReadonlyMap<string, string> {
	const subnets = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const match = /^\d+:\s+(\S+)\s+inet\s+(\S+)\/(\d+)/.exec(line.trim());
		const ifname = match?.[1];
		const address = match?.[2];
		if (ifname === undefined || address === undefined) continue;
		if (match?.[3] !== "24" || subnets.has(ifname)) continue;
		const subnet = subnetOf(address, "255.255.255.0");
		if (subnet !== undefined) subnets.set(ifname, subnet);
	}
	return subnets;
}

export type SubnetRewriteRefusal =
	| SubnetPlanRefusal
	| "unsupported"
	| "unreachable"
	| "unreadable"
	| "state_drifted";

export type SubnetRewritePlan = {
	readonly ifname: string;
	readonly adminUrl: string;
	readonly current: HilinkDhcpRecord;
	readonly target: HilinkDhcpRecord;
};

export type SubnetRewriteResult =
	| { readonly status: "applied"; readonly record: HilinkDhcpRecord }
	| {
			readonly status: "refused";
			readonly reason: SubnetRewriteRefusal;
			readonly conflict?: string;
	  }
	| { readonly status: "reverted"; readonly detail: string }
	| { readonly status: "blocked"; readonly detail: string };

async function readRecord(
	ifname: string,
	adminUrl: string,
	deps: RouterAdminProbeDeps,
): Promise<HilinkDhcpRecord | undefined> {
	const session = await openHilinkSession(ifname, adminUrl, deps);
	if (session === undefined) return undefined;
	const [body] = await deps.fetchViaInterface(
		ifname,
		[`${adminUrl}${HILINK_DHCP_SETTINGS_PATH}`],
		hilinkHeaders(session),
	);
	return body === undefined ? undefined : parseHilinkDhcpSettings(body);
}

async function writeRecord(
	ifname: string,
	adminUrl: string,
	record: HilinkDhcpRecord,
	deps: RouterAdminProbeDeps,
): Promise<boolean> {
	const session = await openHilinkSession(ifname, adminUrl, deps);
	if (session === undefined) return false;
	await deps.postViaInterface(
		ifname,
		`${adminUrl}${HILINK_DHCP_SETTINGS_PATH}`,
		hilinkDhcpSettingsBody(record),
		hilinkHeaders(session),
	);
	return true;
}

/**
 * Find the device among the addresses it could be on, renewing between rounds.
 *
 * Answers with the address whose record matched `expected`, so "something
 * answered at that address" is never mistaken for "the device is there with the
 * settings we believe" — on a shared factory subnet the something could be the
 * OTHER twin.
 */
async function locateDevice(
	ifname: string,
	candidates: readonly { url: string; expected: HilinkDhcpRecord }[],
	deps: SubnetRewriteDeps,
): Promise<string | undefined> {
	for (let attempt = 0; attempt < SUBNET_CONFIRM_ATTEMPTS; attempt += 1) {
		for (const candidate of candidates) {
			const record = await readRecord(ifname, candidate.url, deps).catch(
				() => undefined,
			);
			if (
				record !== undefined &&
				dhcpRecordsMatch(record, candidate.expected)
			) {
				return candidate.url;
			}
		}
		await deps.wait(SUBNET_CONFIRM_DELAY_MS);
		await deps.renewDhcpLease(ifname).catch(() => undefined);
	}
	return undefined;
}

/**
 * Everything that can be decided before the device is touched.
 *
 * It is a separate call because the pre-state it reads is what the caller arms
 * the durable journal with — the journal cannot be armed with a record nobody
 * has read yet, and the write must not happen before it is armed.
 */
export async function prepareSubnetRewrite(
	ifname: string,
	vidPid: string,
	targetAddress: string,
	deps: SubnetRewriteDeps = defaultSubnetRewriteDeps,
): Promise<
	| { readonly ok: true; readonly plan: SubnetRewritePlan }
	| {
			readonly ok: false;
			readonly reason: SubnetRewriteRefusal;
			readonly conflict?: string;
	  }
> {
	if (dialectForVidPid(vidPid) !== "hilink" || !(await deps.isRealDevice())) {
		return { ok: false, reason: "unsupported" };
	}
	let adminUrl: string | undefined;
	try {
		const gateway = parseDefaultGateways(
			await deps.runIpRouteShowDefault(),
		).get(ifname);
		adminUrl = gateway === undefined ? undefined : `http://${gateway}`;
	} catch {
		adminUrl = undefined;
	}
	if (adminUrl === undefined) return { ok: false, reason: "unreachable" };

	const current = await readRecord(ifname, adminUrl, deps).catch(
		() => undefined,
	);
	if (current === undefined) return { ok: false, reason: "unreadable" };

	const hostSubnets = new Map(
		await deps
			.runIpAddrShow()
			.then((stdout) => parseHostSubnets(stdout))
			.catch(() => new Map<string, string>()),
	);
	hostSubnets.delete(ifname);

	const plan = planSubnetRewrite(current, targetAddress, hostSubnets);
	if (!plan.ok) {
		return plan.conflict === undefined
			? { ok: false, reason: plan.reason }
			: { ok: false, reason: plan.reason, conflict: plan.conflict };
	}
	return { ok: true, plan: { ifname, adminUrl, current, target: plan.target } };
}

/**
 * Run the rewrite under an already-armed journal entry.
 *
 * `markExecuting` is called BEFORE the write, so the journal's own state
 * distinguishes "armed but never dispatched" from "may have landed" — which is
 * exactly what replay's rollback table branches on.
 */
export async function executeSubnetRewrite(
	plan: SubnetRewritePlan,
	markExecuting: () => Promise<void>,
	deps: SubnetRewriteDeps = defaultSubnetRewriteDeps,
): Promise<SubnetRewriteResult> {
	const { ifname, adminUrl, current, target } = plan;

	// Re-read under the lease. The preflight read happened before the lease was
	// held, so a record that moved in between is a state we did not plan against
	// and must not overwrite.
	const held = await readRecord(ifname, adminUrl, deps).catch(() => undefined);
	if (held === undefined) return { status: "refused", reason: "unreachable" };
	if (!dhcpRecordsMatch(held, current)) {
		return { status: "refused", reason: "state_drifted" };
	}

	await markExecuting();
	if (!(await writeRecord(ifname, adminUrl, target, deps))) {
		return { status: "refused", reason: "unreachable" };
	}
	await deps.renewDhcpLease(ifname).catch(() => undefined);

	const targetUrl = `http://${target.address}`;
	const confirmed = await locateDevice(
		ifname,
		[{ url: targetUrl, expected: target }],
		deps,
	);
	if (confirmed !== undefined) return { status: "applied", record: target };

	logger.warn("router subnet rewrite did not confirm; auto-restoring", {
		module: "network",
		ifname,
		target: target.address,
	});
	const restored = await restoreSubnet(plan, deps);
	return restored
		? {
				status: "reverted",
				detail: `the device never answered at ${target.address}; its previous LAN settings were restored and reconfirmed`,
			}
		: {
				status: "blocked",
				detail: `the device answered at neither ${target.address} nor ${current.address} after the LAN rewrite`,
			};
}

/**
 * Put the previous record back, and PROVE the device is reachable under it.
 *
 * Shared by the live failure path and by startup replay, so a crash mid-rewrite
 * recovers through exactly the code the live path already exercises.
 */
export async function restoreSubnet(
	plan: SubnetRewritePlan,
	deps: SubnetRewriteDeps = defaultSubnetRewriteDeps,
): Promise<boolean> {
	const { ifname, current, target } = plan;
	const oldUrl = `http://${current.address}`;
	const newUrl = `http://${target.address}`;

	const found = await locateDevice(
		ifname,
		[
			{ url: oldUrl, expected: current },
			{ url: newUrl, expected: target },
		],
		deps,
	);
	// Found on the OLD address holding the OLD record: the write never landed,
	// so there is nothing to undo and reachability is already reconfirmed.
	if (found === oldUrl) return true;
	if (found === undefined) return false;

	if (!(await writeRecord(ifname, newUrl, current, deps).catch(() => false))) {
		return false;
	}
	await deps.renewDhcpLease(ifname).catch(() => undefined);
	return (
		(await locateDevice(ifname, [{ url: oldUrl, expected: current }], deps)) !==
		undefined
	);
}
