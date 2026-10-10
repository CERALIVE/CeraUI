import { logger } from "../../helpers/logger.ts";
import { markBootDegraded } from "./readiness.ts";

export type UpdateBootstrap = {
	readonly start: () => Promise<boolean>;
	readonly recover: () => Promise<void>;
	readonly periodic: () => void;
};

/** Only adjudicated startup can hand package evidence to the standalone owner. */
export async function runUpdateBootstrap(
	bootstrap: UpdateBootstrap,
): Promise<void> {
	if (!(await bootstrap.start())) {
		markBootDegraded("update-orchestrator-maintenance");
		logger.error(
			"Update bootstrap refused; legacy recovery requires maintenance",
			{
				subsystem: "update-orchestrator-maintenance",
			},
		);
		return;
	}
	await bootstrap.recover();
	bootstrap.periodic();
}
