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

/** The timeline event a message emitted: its family, code and `params.id`; with no id, the newest event with that code. */
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

async function newestEvent(
	events: Events,
	match: EventMatch,
	signal: AbortSignal,
): Promise<DeviceEvent | undefined> {
	let beforeSeq: number | null = null;
	do {
		const page = eventListOutputSchema.parse(
			await events.list({
				families: [match.family],
				limit: EVENT_PAGE,
				...(beforeSeq === null ? {} : { beforeSeq }),
			}),
		);
		if (signal.aborted) return undefined;
		const found = page.events.find(
			(event) =>
				event.code === match.code &&
				(match.id === undefined || event.params.id === match.id),
		);
		if (found !== undefined) return found;
		beforeSeq = page.nextBeforeSeq;
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
	if (moment.event !== undefined) {
		try {
			event = await newestEvent(sources.events, moment.event, signal);
		} catch (error) {
			if (signal.aborted) return null;
			console.error("System Logs could not find the message's event:", error);
			return { ok: false, error: "READ_FAILED" };
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
