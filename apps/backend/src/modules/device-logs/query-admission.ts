import { JournalReadError } from "./reader.ts";
import {
	getLogState,
	historyClearAwaitingSettlement,
	historyClearing,
} from "./settings.ts";
import { waitForAdmission } from "./sharing-admission.ts";

// FIFO within each class, including replacements waiting for their own socket.
// Only a class head with no running owner can enter. Owners never wait for
// another slot, so a blocked head cannot create a circular wait. With continued
// reaps and open history, neither eligible head can starve: viewers go first,
// but after two viewer grants while downloads wait, the next eligible download
// goes first. Each download grant resets the streak, so a full download-only
// pool gives its first freed slot to a waiting viewer.
// At most two readers and one per owner; only settlement (including child reap)
// releases a slot. Clear wakes queued requests without releasing any owner.

export interface InteractiveAdmission {
	readonly interactive: AbortSignal;
	readonly timeoutMs?: number;
}

type Admission = AbortSignal | InteractiveAdmission;

interface Slot {
	readonly interactive: boolean;
	readonly controller: AbortController;
	readonly settled: Promise<void>;
}
interface Waiter {
	readonly conn: object;
	ready: ReturnType<typeof Promise.withResolvers<void>>;
}
const SLOT_COUNT = 2;
const MAX_VIEWER_HANDOFFS = 2;
const ADMISSION_DEADLINE = Symbol("journal slot wait expired");
const running = new Map<object, Slot>();
const viewers = new Set<Waiter>();
const downloads = new Set<Waiter>();
let viewerHandoffs = 0;

function eligibleHead(queue: Set<Waiter>): Waiter | undefined {
	const head = queue.values().next().value;
	return head && !running.has(head.conn) ? head : undefined;
}

function nextWaiter(): Waiter | undefined {
	const viewer = eligibleHead(viewers);
	const download = eligibleHead(downloads);
	if (viewer && (!download || viewerHandoffs < MAX_VIEWER_HANDOFFS))
		return viewer;
	return download;
}

function wakeNext(): void {
	if (running.size < SLOT_COUNT) nextWaiter()?.ready.resolve();
}

export async function withQuerySlot<T>(
	conn: object,
	run: (signal: AbortSignal) => Promise<T>,
	admission?: Admission,
): Promise<T | { readonly ok: false; readonly error: "BUSY" | "READ_FAILED" }> {
	// Download pages pass their own cancellation signal; RPCs opt into a
	// separate interactive wait budget.
	const interactive = !(admission instanceof AbortSignal);
	let waitSignal =
		admission instanceof AbortSignal ? admission : admission?.interactive;
	if (waitSignal?.aborted) throw new JournalReadError("READ_FAILED");

	const timeoutMs =
		admission instanceof AbortSignal ? undefined : admission?.timeoutMs;
	const epoch = getLogState().historyEpoch;
	const waiter: Waiter = { conn, ready: Promise.withResolvers<void>() };
	const queue = interactive ? viewers : downloads;
	const controller = new AbortController();
	const settled = Promise.withResolvers<void>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	queue.add(waiter);
	try {
		if (timeoutMs !== undefined && waitSignal) {
			const deadline = new AbortController();
			timer = setTimeout(
				() => deadline.abort(ADMISSION_DEADLINE),
				timeoutMs,
			).unref();
			waitSignal = AbortSignal.any([deadline.signal, waitSignal]);
		}
		for (;;) {
			if (epoch !== getLogState().historyEpoch)
				throw new JournalReadError("READ_FAILED");
			if (waitSignal?.aborted) {
				if (
					waitSignal.reason === ADMISSION_DEADLINE &&
					[...running].some(
						([owner, slot]) => owner !== conn && slot.interactive,
					)
				)
					return { ok: false, error: "BUSY" };
				throw new JournalReadError("READ_FAILED");
			}
			if (historyClearAwaitingSettlement()) return { ok: false, error: "BUSY" };
			const gate = historyClearing();
			if (gate) {
				await waitForAdmission(gate, waitSignal);
				continue;
			}
			const previous = running.get(conn);
			if (previous) {
				previous.controller.abort();
			} else if (running.size < SLOT_COUNT && nextWaiter() === waiter) {
				running.set(conn, {
					interactive,
					controller,
					settled: settled.promise,
				});
				viewerHandoffs =
					interactive && downloads.size > 0
						? Math.min(viewerHandoffs + 1, MAX_VIEWER_HANDOFFS)
						: 0;
				break;
			} else if (!waitSignal) {
				return { ok: false, error: "BUSY" };
			}
			await waitForAdmission(waiter.ready.promise, waitSignal);
			waiter.ready = Promise.withResolvers<void>();
		}
	} finally {
		clearTimeout(timer);
		queue.delete(waiter);
		if (downloads.size === 0) viewerHandoffs = 0;
		wakeNext();
	}
	try {
		// Replacements already queued on this owner must see the new holder too.
		for (const queue of [viewers, downloads]) {
			for (const pending of queue) {
				if (pending.conn === conn) pending.ready.resolve();
			}
		}
		const result = await run(controller.signal);
		if (controller.signal.aborted) throw new JournalReadError("READ_FAILED");
		return result;
	} finally {
		running.delete(conn);
		settled.resolve();
		wakeNext();
	}
}

export async function abortLogQueries(): Promise<void> {
	const slots = [...running.values()];
	for (const slot of slots) slot.controller.abort();
	// Clear has already bumped the epoch. Do not make stale waiters join reap.
	for (const queue of [viewers, downloads]) {
		for (const waiter of queue) waiter.ready.resolve();
	}
	await Promise.all(slots.map((slot) => slot.settled));
}
