import {
	type AptSpaceDeps,
	defaultAptSpaceDeps,
} from "./apt-space-admission.ts";
import { AptPreflightError } from "./apt-space-parser.ts";
import {
	PendingPackageSuccessError,
	pendingPackageSuccess,
} from "./update-orchestrator/pending-success-fence.ts";

export async function runLegacyPackageEffects<Value>(
	run: () => Promise<Value>,
	blocked: () => Value,
): Promise<Value> {
	try {
		return await run();
	} catch (error) {
		if (
			error instanceof PendingPackageSuccessError ||
			(error instanceof AptPreflightError &&
				error.cause instanceof PendingPackageSuccessError)
		)
			return blocked();
		throw error;
	}
}

export const pendingAwareAptSpaceDeps: AptSpaceDeps = {
	...defaultAptSpaceDeps,
	run: (argv, options) => {
		pendingPackageSuccess.assertEffectsAllowed();
		return defaultAptSpaceDeps.run(argv, options);
	},
	stat: (path) => defaultAptSpaceDeps.stat(path),
	statfs: (path) => defaultAptSpaceDeps.statfs(path),
};
