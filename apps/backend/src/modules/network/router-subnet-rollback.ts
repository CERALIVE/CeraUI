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

import { registerMutationRollback } from "../modems/mutation-rollback.ts";
import {
	restoreSubnet,
	type SubnetRewritePlan,
} from "./router-subnet-hygiene.ts";
import type { HilinkDhcpRecord } from "./router-subnet-plan.ts";

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
	plan: SubnetRewritePlan,
): Readonly<Record<string, unknown>> {
	return {
		ifname: plan.ifname,
		adminUrl: plan.adminUrl,
		current: { ...plan.current },
		target: { ...plan.target },
	};
}

export async function restoreRouterSubnet(
	_stableKey: string,
	preState: Readonly<Record<string, unknown>>,
): Promise<"restored" | "failed"> {
	const plan = planFromPreState(preState);
	if (plan === undefined) return "failed";
	return (await restoreSubnet(plan)) ? "restored" : "failed";
}

registerMutationRollback("router-subnet", { rollback: restoreRouterSubnet });
