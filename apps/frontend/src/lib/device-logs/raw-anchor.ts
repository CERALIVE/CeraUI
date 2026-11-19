/** The boundary from a frontend message's moment to its device log window. */
import {
	type DeviceEvent,
	type EventFamily,
	type EventListInput,
	eventListOutputSchema,
	type LogAroundInput,
	type LogAroundOutput,
	logAroundOutputSchema,
	logBootInfoSchema,
	logQueryWithoutContinuationSchema,
} from "@ceraui/rpc/schemas";

// Input defaults must not turn a partial reply into a different boot or filter.
const queryShape = logQueryWithoutContinuationSchema.shape;
const queryReply = logQueryWithoutContinuationSchema.safeExtend({
	sources: queryShape.sources.unwrap(),
	levels: queryShape.levels.unwrap(),
	boot: queryShape.boot.unwrap(),
	direction: queryShape.direction.unwrap(),
	limit: queryShape.limit.unwrap(),
});
const aroundReply = logAroundOutputSchema.options[0]
	.safeExtend({ olderQuery: queryReply, newerQuery: queryReply })
	.or(logAroundOutputSchema.options[1]);

const EVENT_PAGE = 200;
// Bounds the walk over a long or slowly answering event history; each read
// also has its own RPC timeout.
const EVENT_LOOKUP_MS = 10_000;

interface Logs {
	boots(): Promise<unknown>;
	around(input: LogAroundInput): Promise<unknown>;
}

interface Events {
	list(input: EventListInput): Promise<unknown>;
}

export interface RawAnchor {
	readonly at: number;
	readonly bootId?: string;
	readonly eventId?: string;
}

/** The timeline event a message emitted. An unidentified outcome cannot select an exact event. */
export interface EventMatch {
	readonly family: EventFamily;
	readonly code: string;
	readonly id?: string;
}

export interface RawMoment {
	readonly at?: number;
	readonly bootId?: string;
	readonly event?: EventMatch;
}

export async function locateAround(
	logs: Logs,
	request: RawAnchor,
	signal: AbortSignal = new AbortController().signal,
): Promise<LogAroundOutput | null> {
	try {
		let bootId = request.bootId;
		if (bootId === undefined) {
			const reply = await logs.boots();
			if (signal.aborted) return null;
			bootId = logBootInfoSchema
				.array()
				.parse(reply)
				.find((boot) => boot.current)?.bootId;
		}
		if (bootId === undefined) {
			console.error("System Logs could not find the running boot.");
			return { ok: false, error: "READ_FAILED" };
		}
		const reply = await logs.around({
			bootId,
			at: request.at,
			...(request.eventId === undefined ? {} : { eventId: request.eventId }),
		});
		if (signal.aborted) return null;
		return aroundReply.parse(reply);
	} catch (error) {
		if (signal.aborted) return null;
		console.error("System Logs could not open the message's raw logs:", error);
		return { ok: false, error: "READ_FAILED" };
	}
}

/**
 * The newest stored event that matches, reading older pages. `undefined` when
 * the stored history ends without it or the walk is cancelled; a cursor that
 * does not move back is a broken reply and throws.
 */
async function newestEvent(
	events: Events,
	match: EventMatch,
	signal: AbortSignal,
): Promise<DeviceEvent | undefined> {
	let beforeSeq: number | null = null;
	do {
		if (signal.aborted) return undefined;
		const reply = await events.list({
			families: [match.family],
			limit: EVENT_PAGE,
			...(beforeSeq === null ? {} : { beforeSeq }),
		});
		if (signal.aborted) return undefined;
		const page = eventListOutputSchema.parse(reply);
		const found = page.events.find(
			(event) => event.code === match.code && event.params.id === match.id,
		);
		if (found !== undefined) return found;
		const next = page.nextBeforeSeq;
		if (next !== null && beforeSeq !== null && next >= beforeSeq)
			throw new Error(
				`The event list cursor did not move back from ${beforeSeq} (next ${next}).`,
			);
		beforeSeq = next;
	} while (beforeSeq !== null);
	return undefined;
}

/**
 * Places a message's moment: the exact entry of the event it emitted, else a
 * window around its own time. `null` without a cancellation means neither is
 * known, so Raw logs open at the newest entries.
 */
export async function locateMoment(
	sources: { readonly logs: Logs; readonly events: Events },
	moment: RawMoment,
	signal: AbortSignal = new AbortController().signal,
): Promise<LogAroundOutput | null> {
	let event: DeviceEvent | undefined;
	const match = moment.event;
	if (match?.id) {
		const deadline = new AbortController();
		const timeout = Promise.withResolvers<undefined>();
		const timer = setTimeout(() => {
			deadline.abort();
			if (!signal.aborted)
				console.warn(
					"System Logs stopped looking for the message's event at the lookup deadline.",
				);
			timeout.resolve(undefined);
		}, EVENT_LOOKUP_MS);
		try {
			event = await Promise.race([
				newestEvent(
					sources.events,
					match,
					AbortSignal.any([signal, deadline.signal]),
				),
				timeout.promise,
			]);
		} catch (error) {
			if (signal.aborted) return null;
			console.error("System Logs could not find the message's event:", error);
			return { ok: false, error: "READ_FAILED" };
		} finally {
			clearTimeout(timer);
		}
		if (signal.aborted) return null;
	}
	if (event !== undefined)
		return locateAround(
			sources.logs,
			{ at: event.at, bootId: event.bootId, eventId: event.id },
			signal,
		);
	if (moment.at === undefined) return null;
	return locateAround(
		sources.logs,
		{
			at: moment.at,
			...(moment.bootId === undefined ? {} : { bootId: moment.bootId }),
		},
		signal,
	);
}
