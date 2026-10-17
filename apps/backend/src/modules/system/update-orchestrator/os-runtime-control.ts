import {
	acquireOsStageControlLease,
	borrowOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { readOsStageJob } from "./os-stage-job-files.ts";
import {
	isOsStageReady,
	proveOsWriterQuiescent,
	reconcileOsStageStartup,
} from "./os-stage-startup.ts";

export async function acquireRuntimeOsStageControl(
	acquire?: typeof acquireOsStageControlLease,
): Promise<OsStageControlLease> {
	return (acquire ?? acquireOsStageControlLease)();
}

export async function proveRuntimeOsWriterQuiescent(
	lease?: OsStageControlLease,
): Promise<boolean> {
	if (!lease) return proveOsWriterQuiescent();
	if (!lease.held()) return false;
	if (await readOsStageJob())
		await reconcileOsStageStartup({
			acquireControl: async () => borrowOsStageControlLease(lease),
		});
	return lease.held() && (await isOsStageReady());
}
