import { logger } from "../../helpers/logger.ts";

export interface DisruptiveRetryClock {
	readonly schedule: (run: () => Promise<void>, ms: number) => () => void;
}

const defaultClock: DisruptiveRetryClock = {
	schedule: (run, ms) => {
		const timer = setTimeout(() => {
			void run();
		}, ms);
		timer.unref();
		return () => clearTimeout(timer);
	},
};
let clock = defaultClock;
let controller = new AbortController();
const cancellations = new Set<() => void>();

export function disruptiveShutdownSignal(): AbortSignal {
	return controller.signal;
}

export function retryDisruptiveEvidence(
	observe: (signal: AbortSignal) => Promise<boolean>,
): () => void {
	const signal = controller.signal;
	let cancelled = false;
	let delay = 2_000;
	let cancelTimer: (() => void) | undefined;
	const cancel = () => {
		cancelled = true;
		cancelTimer?.();
		cancellations.delete(cancel);
	};
	const schedule = () => {
		cancelTimer = clock.schedule(run, delay);
		delay = Math.min(delay * 2, 30_000);
	};
	const run = async () => {
		if (cancelled || signal.aborted) return cancel();
		try {
			if (await observe(signal)) return cancel();
		} catch (error) {
			logger.warn("Disruptive completion observation remains unknown", {
				error,
			});
		}
		if (cancelled || signal.aborted) return cancel();
		schedule();
	};
	cancellations.add(cancel);
	schedule();
	return cancel;
}

export function cancelDisruptiveRetries(): void {
	controller.abort();
	for (const cancel of [...cancellations]) cancel();
}

export function setDisruptiveRetryClockForTest(
	next: DisruptiveRetryClock | null,
): void {
	cancelDisruptiveRetries();
	controller = new AbortController();
	clock = next ?? defaultClock;
}
