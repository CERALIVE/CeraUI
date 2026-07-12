import { logger } from "./logger.ts";

export interface BackendShutdownDeps {
	readonly gracefulShutdown: () => Promise<void>;
	readonly stopSrtIngest: () => Promise<void>;
	readonly stopDmesgWatchers: () => void;
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
	logger.info(`received ${signal}; shutting down streaming processes`);
	void (async () => {
		await settleCleanup("SRT ingest", deps.stopSrtIngest);
		await settleCleanup("dmesg watchers", deps.stopDmesgWatchers);
		await settleCleanup("streaming processes", deps.gracefulShutdown);
		deps.exit(0);
	})();
}
