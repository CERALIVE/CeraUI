import { logger } from "./logger.ts";

export interface BackendShutdownDeps {
	readonly gracefulShutdown: () => Promise<void>;
	readonly stopSrtIngest: () => Promise<void>;
	readonly stopDmesgWatchers: () => void;
	readonly exit: (code: number) => void;
}

let shuttingDown = false;

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
		await deps.stopSrtIngest();
		deps.stopDmesgWatchers();
		await deps.gracefulShutdown();
		deps.exit(0);
	})();
}
