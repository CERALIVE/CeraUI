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
 * What startup replay does with a LAN-subnet rewrite that never finished.
 *
 * It registers the `router-subnet` handler on todo 25's rollback registry, so a
 * crash between the write and the confirmation is recovered by exactly the code
 * the live failure path already runs (`restoreSubnet`) rather than by a second,
 * replay-only implementation that nothing exercises until the day it is needed.
 *
 * The journaled pre-state is UNTRUSTED input here — it was written by a previous
 * process, possibly a previous BUILD — so it is parsed rather than cast, and a
 * document this build cannot read answers `failed`. That is the fail-closed
 * direction: the device stays blocked until an operator acknowledges, which is
 * the correct posture for a dongle whose address we can no longer derive.
 */

import { readdirSync } from "node:fs";
import { z } from "zod";
import {
	type MutationRollbackHandler,
	registerMutationRollback,
} from "../modems/mutation-rollback.ts";
import { readSystemBootId } from "../streaming/armed-stream-marker.ts";
import { type NetdevWitness, netdevLifetimeFence } from "./netdev-lifetime.ts";
import {
	type LiveSubnetRewritePlan,
	restoreSubnet,
	type SubnetRewritePlan,
} from "./router-subnet-hygiene.ts";
import type { HilinkDhcpRecord } from "./router-subnet-plan.ts";
import {
	journaledRouterSubnetWitness,
	subnetNetdev,
} from "./router-subnet-witness.ts";
import { isSafeIfname } from "./safe-ifname.ts";

const RECORD_FIELDS = [
	"address",
	"netmask",
	"dhcpStatus",
	"startAddress",
	"endAddress",
	"leaseTime",
	"dnsStatus",
	"primaryDns",
	"secondaryDns",
] as const;

function readRecord(value: unknown): HilinkDhcpRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const source = value as Record<string, unknown>;
	const record: Record<string, string> = {};
	for (const field of RECORD_FIELDS) {
		const member = source[field];
		if (typeof member !== "string") return undefined;
		record[field] = member;
	}
	return record as unknown as HilinkDhcpRecord;
}

/** The journaled pre-state, back as the plan `restoreSubnet` takes. */
export function planFromPreState(
	preState: Readonly<Record<string, unknown>>,
): SubnetRewritePlan | undefined {
	const ifname = preState.ifname;
	const adminUrl = preState.adminUrl;
	const current = readRecord(preState.current);
	const target = readRecord(preState.target);
	if (typeof ifname !== "string" || ifname === "") return undefined;
	if (typeof adminUrl !== "string" || adminUrl === "") return undefined;
	if (current === undefined || target === undefined) return undefined;
	return { ifname, adminUrl, current, target };
}

/** The pre-state a rewrite journals. Shaped so replay can rebuild the plan. */
export function preStateFor(
	plan: SubnetRewritePlan | LiveSubnetRewritePlan,
): Readonly<Record<string, unknown>> {
	return {
		ifname: plan.ifname,
		adminUrl: plan.adminUrl,
		current: { ...plan.current },
		target: { ...plan.target },
		...(plan.originalDhcpComplete === false
			? { originalDhcpComplete: false }
			: {}),
		...("isCurrent" in plan && {
			netdev: {
				bootId: plan.bootId,
				ifindex: plan.isCurrent.issued.ifindex ?? null,
				node: plan.isCurrent.issued.node ?? null,
			},
		}),
	};
}

async function restoreSameBoot(
	preState: Readonly<Record<string, unknown>>,
	witness: NetdevWitness,
): Promise<"restored" | "failed"> {
	const plan = planFromPreState(preState);
	if (plan === undefined || !isSafeIfname(plan.ifname)) return "failed";

	// A rename is not a new lifetime. Search the kernel's current names only
	// when the journaled locator no longer denotes the issuing netdev.
	let ifname = plan.ifname;
	let isCurrent = netdevLifetimeFence(ifname, witness);
	if (!isCurrent()) {
		const candidates = readdirSync("/sys/class/net")
			.filter((name) => name !== ifname && isSafeIfname(name))
			.map((name) => ({ name, proof: netdevLifetimeFence(name, witness) }))
			.filter(({ proof }) => proof());
		const [candidate] = candidates;
		if (candidates.length !== 1 || candidate === undefined) return "failed";
		ifname = candidate.name;
		isCurrent = candidate.proof;
	}
	return (await restoreSubnet({ ...plan, ifname }, undefined, isCurrent)) &&
		isCurrent()
		? "restored"
		: "failed";
}

function rollbackIfAuthoritative(
	preState: Readonly<Record<string, unknown>>,
): Promise<"restored" | "failed"> | undefined {
	const parsed = journaledRouterSubnetWitness.safeParse(preState.netdev);
	const bootId = z.uuid().safeParse(readSystemBootId());
	if (!parsed.success || !bootId.success) return Promise.resolve("failed");
	if (parsed.data.bootId !== bootId.data) return undefined;
	return restoreSameBoot(preState, subnetNetdev(parsed.data));
}

export async function restoreRouterSubnet(
	_stableKey: string,
	preState: Readonly<Record<string, unknown>>,
): Promise<"restored" | "failed"> {
	const plan = planFromPreState(preState);
	if (plan === undefined) return "failed";
	return (await restoreSubnet(plan)) ? "restored" : "failed";
}

export const routerSubnetRollback: MutationRollbackHandler = {
	rollbackIfAuthoritative,
	rollback: restoreRouterSubnet,
};
registerMutationRollback("router-subnet", routerSubnetRollback);
