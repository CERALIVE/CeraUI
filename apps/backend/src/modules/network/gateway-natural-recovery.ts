import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
import type { ProbeCandidate } from "./connectivity-candidates.ts";
import type { GatewayElectionDeps } from "./gateways.ts";
import { naturalUplinkRecovery } from "./natural-uplink-recovery.ts";

export async function recoverNaturalGateway(
	deps: Pick<
		GatewayElectionDeps,
		"routeRunner" | "releaseRoutes" | "probes" | "now"
	>,
	candidates: readonly ProbeCandidate[],
): Promise<boolean | undefined> {
	if (!deps.routeRunner || !deps.releaseRoutes) return undefined;
	try {
		const recovery = naturalUplinkRecovery(deps.routeRunner);
		if (!(await recovery.ready(candidates, deps.probes, deps.now ?? getms)))
			return undefined;
		const condition = recovery.releaseCondition;
		if (!condition) return false;
		await deps.releaseRoutes(condition);
		logger.info("Natural host uplink recovered; released owned preference");
		return true;
	} catch (cause) {
		const error =
			cause instanceof Error
				? cause
				: new Error("Natural recovery rejected", { cause });
		logger.warn("Natural host uplink recovery failed", { error });
		return false;
	}
}
