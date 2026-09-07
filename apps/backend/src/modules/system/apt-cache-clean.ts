import { logger } from "../../helpers/logger.ts";
import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";

export async function cleanAptCache(
	run: typeof spawnWithTimeout = spawnWithTimeout,
): Promise<boolean> {
	try {
		const result = await run(["/usr/bin/apt-get", "clean"], {
			timeoutMs: 30_000,
		});
		if (result.exitCode === 0) return true;
		logger.warn("Software update archive cleanup failed", {
			exitCode: result.exitCode,
		});
	} catch (error) {
		logger.warn("Software update archive cleanup failed", {
			error: error instanceof Error ? error : String(error),
		});
	}
	return false;
}
