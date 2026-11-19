import { JournalReadError } from "./reader.ts";
import {
	getLogState,
	historyClearAwaitingSettlement,
	historyClearing,
} from "./settings.ts";
import { waitForAdmission } from "./sharing-admission.ts";

interface Slot {
	readonly controller: AbortController;
	readonly settled: Promise<void>;
}
const running = new Map<object, Slot>();

export async function withQuerySlot<T>(
	conn: object,
	run: (signal: AbortSignal) => Promise<T>,
	waitSignal?: AbortSignal,
): Promise<T | { readonly ok: false; readonly error: "BUSY" | "READ_FAILED" }> {
	const epoch = getLogState().historyEpoch;
	for (;;) {
		const gate = historyClearing();
		if (waitSignal?.aborted || epoch !== getLogState().historyEpoch)
			throw new JournalReadError("READ_FAILED");
		if (historyClearAwaitingSettlement()) return { ok: false, error: "BUSY" };
		if (gate) {
			await waitForAdmission(gate, waitSignal);
			continue;
		}
		const previous = running.get(conn);
		if (previous) {
			previous.controller.abort();
			await waitForAdmission(previous.settled, waitSignal);
			continue;
		}
		if (running.size < 2) break;
		if (!waitSignal) return { ok: false, error: "BUSY" };
		await waitForAdmission(
			Promise.race([...running.values()].map((slot) => slot.settled)),
			waitSignal,
		);
	}
	const controller = new AbortController();
	const settled = Promise.withResolvers<void>();
	running.set(conn, { controller, settled: settled.promise });
	try {
		const result = await run(controller.signal);
		if (controller.signal.aborted) throw new JournalReadError("READ_FAILED");
		return result;
	} finally {
		running.delete(conn);
		settled.resolve();
	}
}

export async function abortLogQueries(): Promise<void> {
	const slots = [...running.values()];
	for (const slot of slots) slot.controller.abort();
	await Promise.all(slots.map((slot) => slot.settled));
}
