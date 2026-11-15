import { JournalReadError } from "./reader.ts";

interface Slot {
	readonly controller: AbortController;
	readonly settled: Promise<void>;
}
const running = new Map<object, Slot>();

export async function withQuerySlot<T>(
	conn: object,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T | { readonly ok: false; readonly error: "BUSY" | "READ_FAILED" }> {
	let previous = running.get(conn);
	while (previous) {
		previous.controller.abort();
		await previous.settled;
		previous = running.get(conn);
	}
	if (running.size >= 2) return { ok: false, error: "BUSY" };
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
