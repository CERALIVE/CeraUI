import { z } from "zod";
import { readSystemBootId } from "../streaming/armed-stream-marker.ts";
import { type NetdevWitness, readNetdevWitness } from "./netdev-lifetime.ts";

export const journaledRouterSubnetWitness = z.object({
	bootId: z.uuid(),
	ifindex: z.number().int().positive().nullable(),
	node: z
		.string()
		.regex(/^\d+:\d+$/)
		.nullable(),
});

export type RouterSubnetWitness = z.infer<typeof journaledRouterSubnetWitness>;

export function captureRouterSubnetWitness(
	ifname: string,
): RouterSubnetWitness | undefined {
	const live = readNetdevWitness(ifname);
	const parsed = journaledRouterSubnetWitness.safeParse({
		bootId: readSystemBootId(),
		ifindex: live.ifindex,
		node: live.node,
	});
	return live.present === true && parsed.success ? parsed.data : undefined;
}

export function sameBootRouterSubnetWitness(
	preState: Readonly<Record<string, unknown>>,
) {
	const parsed = journaledRouterSubnetWitness.safeParse(preState.netdev);
	if (!parsed.success) return undefined;
	const { bootId, ifindex, node } = parsed.data;
	return ifindex !== null && node !== null && bootId === readSystemBootId()
		? { bootId, ifindex, node }
		: undefined;
}

export function subnetNetdev(witness: RouterSubnetWitness): NetdevWitness {
	return {
		ifindex: witness.ifindex ?? undefined,
		node: witness.node ?? undefined,
		present: true,
	};
}
