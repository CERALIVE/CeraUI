import { logger } from "../../helpers/logger.ts";
import { markBootDegraded } from "./readiness.ts";
import { pendingPackageSuccess } from "./update-orchestrator/pending-success-fence.ts";

export type CommitExitHook = (() => void) | (() => Promise<boolean>);

/** Settlement is separate: resume must read the outcome without waiting on itself. */
export async function finishSoftwareUpdateRestart(
	onCommitSucceeded: CommitExitHook | undefined,
	exit: () => void,
	/** The success's claim, confirmed again at each later point of use. */
	still: () => boolean = () => true,
): Promise<void> {
	const withheld = () => {
		markBootDegraded("software-update-unproven");
		logger.error(
			"Software update restart withheld; the claimed success no longer holds",
		);
	};
	if (!still()) return withheld();
	try {
		const permission =
			onCommitSucceeded && pendingPackageSuccess.invoke(onCommitSucceeded);
		if (permission !== undefined && !(await permission)) {
			markBootDegraded("update-orchestrator-maintenance");
			logger.error(
				"Software update restart withheld; durable success unproven",
			);
			return;
		}
	} catch (error) {
		// Completion boundary: unknown persistence failures must retain this process.
		markBootDegraded("update-orchestrator-maintenance");
		logger.error(
			"Software update restart withheld; success persistence failed",
			{
				error,
			},
		);
		if (!(await pendingPackageSuccess.waitForDurability())) return;
	}
	if (!still()) return withheld();
	// Intentionally outside the persistence catch: a deliberate exit cannot be swallowed.
	exit();
}
