import { logger } from "../../../helpers/logger.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import type { OsStageSettlementEvidence } from "./os-stage-retry.ts";
import type { OrchestratorRuntimeDeps } from "./runtime.ts";

export async function readRuntimeOsSettlementEvidence(
	deps: OrchestratorRuntimeDeps,
	lease?: OsStageControlLease,
): Promise<OsStageSettlementEvidence | undefined> {
	try {
		const [
			raucOperation,
			rootSlots,
			receipt,
			healthy,
			bootId,
			activationArmed,
			writerQuiescent,
		] = await Promise.all([
			deps.inspectOsOperation(),
			deps.readRootSlots(),
			deps.readOsReceipt(),
			deps.readHealthyState(),
			deps.readBootId(),
			deps.readActivationArmed(),
			deps.proveOsWriterQuiescent(lease),
		]);
		return {
			raucOperation,
			writerQuiescent,
			rootSlots,
			healthyBootId: healthy?.boot_id ?? null,
			bootId,
			stagedReceiptPresent: receipt !== undefined,
			activationArmed,
		};
	} catch (error) {
		logger.warn("update-orchestrator: OS recovery evidence unreadable", {
			error,
		});
		return undefined;
	}
}
