/**
 * Closed-loop test harness: feed the REAL subscription store the frames the
 * device socket delivers, and hold `rpc.streaming.*` replies so a test settles
 * them in the order a slow or racing device would.
 */
import { flushSync } from "svelte";

import { handleMessageForTest } from "$lib/rpc/subscriptions.svelte";

let seq = 0;

/**
 * Deliver one broadcast as the socket does: `{ [type]: payload, seq }` through
 * the real JSON serializer (an `undefined` field never arrives), stamped with
 * the next `seq`, then handed to the real subscription handler. Returns the
 * payload exactly as the handler received it.
 */
export function ingest(type: string, payload: unknown): unknown {
	seq += 1;
	const frame = JSON.parse(JSON.stringify({ [type]: payload, seq })) as Record<
		string,
		unknown
	>;
	// The transport dispatches only the types a frame carries.
	if (Object.hasOwn(frame, type))
		handleMessageForTest(type, frame[type], frame.seq as number);
	flushSync();
	return frame[type];
}

/** Deliver one broadcast's exact bytes, `seq` included, as the socket does. */
export function ingestFrame(bytes: string): void {
	const { seq, ...frame } = JSON.parse(bytes) as Record<string, unknown>;
	for (const [type, payload] of Object.entries(frame))
		handleMessageForTest(type, payload, seq as number | undefined);
	flushSync();
}

export interface HeldCall {
	readonly method: string;
	readonly input: unknown;
	resolve(value: unknown): void;
	reject(reason: unknown): void;
}

export interface HeldRpc {
	/** Stands in for `rpc.streaming`: every method call is recorded and held. */
	readonly streaming: Record<
		string,
		(input?: unknown, onSent?: () => void) => Promise<unknown>
	>;
	readonly calls: readonly HeldCall[];
	/** The next call of `method` not yet returned here, already made or still to come. */
	next(method: string): Promise<HeldCall>;
}

export function heldRpc(): HeldRpc {
	const calls: HeldCall[] = [];
	const handedOut = new Map<string, number>();
	const waiters: Array<{
		method: string;
		index: number;
		take(call: HeldCall): void;
	}> = [];
	const callsOf = (method: string) =>
		calls.filter((call) => call.method === method);

	function dispatch(
		method: string,
		input: unknown,
		onSent: unknown,
	): Promise<unknown> {
		const reply = Promise.withResolvers<unknown>();
		const call: HeldCall = {
			method,
			input,
			resolve: reply.resolve,
			reject: reply.reject,
		};
		calls.push(call);
		const index = callsOf(method).length - 1;
		const waiter = waiters.findIndex(
			(entry) => entry.method === method && entry.index === index,
		);
		if (waiter !== -1) waiters.splice(waiter, 1)[0]?.take(call);
		// The real client reports the request as sent once it is on the socket.
		if (typeof onSent === "function") onSent();
		return reply.promise;
	}

	const streaming = new Proxy({} as HeldRpc["streaming"], {
		get: (_target, method) =>
			typeof method === "string" && method !== "then"
				? (input?: unknown, onSent?: unknown) => dispatch(method, input, onSent)
				: undefined,
	});

	return {
		streaming,
		calls,
		next(method) {
			const index = handedOut.get(method) ?? 0;
			handedOut.set(method, index + 1);
			const made = callsOf(method)[index];
			if (made) return Promise.resolve(made);
			return new Promise((take) => waiters.push({ method, index, take }));
		},
	};
}
