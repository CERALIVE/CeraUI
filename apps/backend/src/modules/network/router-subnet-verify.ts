import { netdevLifetimeFence } from "./netdev-lifetime.ts";
import { readProvenRouterSubnetRecord } from "./router-subnet-hygiene.ts";
import {
	fullDhcpRecordsMatch,
	type HilinkDhcpRecord,
	isCompleteHilinkDhcpRecord,
	subnetOf,
} from "./router-subnet-plan.ts";
import { planFromPreState } from "./router-subnet-rollback.ts";
import {
	sameBootRouterSubnetWitness,
	subnetNetdev,
} from "./router-subnet-witness.ts";

type Verification =
	| { readonly isCurrent: () => boolean }
	| { readonly error: "read_failed" | "state_mismatch" };

function acceptableOriginal(
	record: HilinkDhcpRecord,
	targetAddress: string,
): boolean {
	return (
		isCompleteHilinkDhcpRecord(record) &&
		record.dhcpStatus === "1" &&
		record.primaryDns !== targetAddress &&
		record.secondaryDns !== targetAddress
	);
}

export function routerSubnetCheckProof(
	preState: Readonly<Record<string, unknown>>,
	ifname: string | undefined,
) {
	const plan = planFromPreState(preState);
	const witness = sameBootRouterSubnetWitness(preState);
	if (
		plan === undefined ||
		preState.originalDhcpComplete === false ||
		witness === undefined ||
		ifname === undefined ||
		subnetOf(plan.current.address, plan.current.netmask) === undefined ||
		!acceptableOriginal(plan.current, plan.target.address)
	)
		return undefined;
	// A port is not a dongle identity. The same-boot proof is checked at
	// dispatch, including between the session GET and the settings GET.
	return {
		plan,
		ifname,
		isCurrent: netdevLifetimeFence(ifname, subnetNetdev(witness)),
	};
}

/** Check the original DHCP record without invoking renewal or rollback. */
export async function verifyRouterSubnet(
	preState: Readonly<Record<string, unknown>>,
	resolvedIfname: string | undefined,
): Promise<Verification> {
	const proof = routerSubnetCheckProof(preState, resolvedIfname);
	if (proof === undefined) return { error: "read_failed" };
	const { plan, ifname, isCurrent } = proof;
	const record = await readProvenRouterSubnetRecord(
		ifname,
		`http://${plan.current.address.trim()}`,
		isCurrent,
	).catch(() => undefined);
	if (record === undefined || !isCurrent()) return { error: "read_failed" };
	return fullDhcpRecordsMatch(record, plan.current)
		? { isCurrent }
		: { error: "state_mismatch" };
}
