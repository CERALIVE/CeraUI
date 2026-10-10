import type { OsStageControlLease } from "../../modules/system/update-orchestrator/os-stage-control-lease.ts";

export async function acquireTestOsStageControl(): Promise<OsStageControlLease> {
	let held = true;
	return {
		held: () => held,
		[Symbol.asyncDispose]: async () => {
			held = false;
		},
	};
}
