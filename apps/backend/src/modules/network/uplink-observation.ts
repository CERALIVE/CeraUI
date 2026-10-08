import { logger } from "../../helpers/logger.ts";
import {
	type AptReachability,
	deriveVerdict,
} from "../system/apt-reachability.ts";
import type { ConnectivityProbes } from "./connectivity-election.ts";

export const UPLINK_OBSERVATION_POOL_SIZE = 4;

export async function observeUplinkPool<T, R>(
	inputs: readonly T[],
	observe: (input: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	await Promise.all(
		Array.from(
			{ length: Math.min(inputs.length, UPLINK_OBSERVATION_POOL_SIZE) },
			async () => {
				while (next < inputs.length) {
					const index = next++;
					const input = inputs[index];
					if (input !== undefined) results[index] = await observe(input);
				}
			},
		),
	);
	return results;
}

export async function observeRepository(
	ifname: string,
	probes: ConnectivityProbes,
): Promise<AptReachability> {
	try {
		return await probes.probeRepository(ifname);
	} catch (cause) {
		// Observation boundary: even a non-Error rejection is UNKNOWN, not link failure.
		const error =
			cause instanceof Error
				? cause
				: new Error("Repository observer rejected", { cause });
		logger.warn("Repository uplink observation unavailable", { ifname, error });
		return deriveVerdict([]);
	}
}
