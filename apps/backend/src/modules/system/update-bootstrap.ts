import { logger } from "../../helpers/logger.ts";
import { markBootDegraded } from "./readiness.ts";

export type UpdateBootstrap = {
	/** Watches a surviving unit at once; `owned` settles with startup's verdict. */
	readonly observe?: (owned: Promise<boolean>) => void;
	readonly start: () => Promise<boolean>;
	readonly recover: () => Promise<void>;
	readonly periodic: () => void;
};

/** Only adjudicated startup can hand package evidence to the standalone owner. */
export async function runUpdateBootstrap(
	bootstrap: UpdateBootstrap,
): Promise<void> {
	const verdict = Promise.withResolvers<boolean>();
	bootstrap.observe?.(verdict.promise);
	let admitted = false;
	try {
		admitted = await bootstrap.start();
	} finally {
		verdict.resolve(admitted);
	}
	if (!admitted) {
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
