import { cancelDisruptiveRetries } from "../modules/system/disruptive-retry.ts";
import { logger } from "./logger.ts";

export interface BackendShutdownDeps {
	/** Cancels background retry owners so none starts work during teardown. */
	readonly stopRecoveryRetries?: () => void;
	readonly gracefulShutdown: () => Promise<void>;
	readonly stopSrtIngest: () => Promise<void>;
	readonly stopDmesgWatchers: () => void;
	readonly stopUplinkShaper?: () => Promise<void>;
	readonly stopGatewayRoutes?: () => Promise<void>;
	readonly exit: (code: number) => void;
}

let shuttingDown = false;

async function settleCleanup(
	name: string,
	cleanup: () => Promise<void> | void,
): Promise<void> {
	try {
		await cleanup();
	} catch (error) {
		logger.error(`shutdown: ${name} cleanup failed`, { err: error });
	}
}

export function resetShutdownForTest(): void {
	shuttingDown = false;
}

export function handleTerminationSignal(
	signal: NodeJS.Signals,
	deps: BackendShutdownDeps,
): void {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelDisruptiveRetries();
	logger.info(`received ${signal}; shutting down streaming processes`);
	void (async () => {
		if (deps.stopRecoveryRetries)
			await settleCleanup("recovery retries", deps.stopRecoveryRetries);
		if (deps.stopGatewayRoutes)
			await settleCleanup("host route preference", deps.stopGatewayRoutes);
		await settleCleanup("SRT ingest", deps.stopSrtIngest);
		await settleCleanup("dmesg watchers", deps.stopDmesgWatchers);
		if (deps.stopUplinkShaper)
			await settleCleanup("uplink shaper", deps.stopUplinkShaper);
		await settleCleanup("streaming processes", deps.gracefulShutdown);
		deps.exit(0);
	})();
}
