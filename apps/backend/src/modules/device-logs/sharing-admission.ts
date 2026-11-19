import {
	getLogState,
	historyClearAwaitingSettlement,
	historyClearing,
} from "./settings.ts";

/** Run the reservation in the same turn as the final signal and epoch check. */
export async function withHistoryAdmission<T>(
	signal: AbortSignal | undefined,
	admit: (epoch: number) => T,
): Promise<T | undefined> {
	const epoch = getLogState().historyEpoch;
	for (;;) {
		if (
			signal?.aborted ||
			epoch !== getLogState().historyEpoch ||
			historyClearAwaitingSettlement()
		)
			return;
		const gate = historyClearing();
		if (!gate) return admit(epoch);
		await waitForAdmission(gate, signal);
	}
}

export async function waitForAdmission(
	ready: Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	if (!signal) return ready;
	if (signal.aborted) return;
	const aborted = Promise.withResolvers<void>();
	const onAbort = () => aborted.resolve();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([ready, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
