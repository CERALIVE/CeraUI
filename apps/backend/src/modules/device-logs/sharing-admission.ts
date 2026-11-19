import { getLogState, historyClearing } from "./settings.ts";

/** Run the reservation in the same turn as the final signal and epoch check. */
export async function withHistoryAdmission<T>(
	signal: AbortSignal | undefined,
	admit: (epoch: number) => T,
): Promise<T | undefined> {
	const epoch = getLogState().historyEpoch;
	for (;;) {
		if (signal?.aborted || epoch !== getLogState().historyEpoch) return;
		const gate = historyClearing();
		if (!gate) return admit(epoch);
		if (!signal) {
			await gate;
			continue;
		}
		const aborted = Promise.withResolvers<void>();
		const onAbort = () => aborted.resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([gate, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
}
