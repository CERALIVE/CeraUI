import { logger } from "../../helpers/logger.ts";
import {
	type AptReachability,
	deriveVerdict,
} from "../system/apt-reachability.ts";
import type { ConnectivityProbes } from "./connectivity-election.ts";

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
